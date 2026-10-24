#!/bin/bash
# Base hardening for the family-agent server (Ubuntu 26.04, UpCloud).
# Run as root over Tailscale SSH (from a 100.x address) on a fresh server
# that has already joined the tailnet with `tailscale up --ssh`:
#   bash 00-base-hardening.sh
# After this, the server is reachable only over Tailscale. The UpCloud web
# console is the emergency way in.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
TS_IP="$(tailscale ip -4)"

case "${SSH_CONNECTION:-}" in
  100.*) ;;
  *) echo "ABORT: run this over Tailscale SSH (session must come from a 100.x address)"; exit 1 ;;
esac

echo "== timezone + automatic security updates (reboot 03:30)"
timedatectl set-timezone Europe/Helsinki
apt-get update -q
apt-get install -y -q unattended-upgrades apt-listchanges >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
systemctl enable --now unattended-upgrades

echo "== openclaw system user (no sudo, not in docker group)"
id openclaw >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/openclaw --shell /bin/bash openclaw
chmod 750 /home/openclaw

echo "== 2 GB swap"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -p /etc/sysctl.d/99-swappiness.conf

echo "== Docker Engine (official apt repo)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin jq >/dev/null
systemctl enable --now docker

echo "== safety net: undo firewall + sshd changes in 5 min unless cancelled"
cat > /root/lockdown-rollback.sh <<'EOF'
#!/bin/bash
ufw --force disable
rm -f /etc/ssh/sshd_config.d/10-lockdown.conf /etc/systemd/system/ssh.socket.d/10-tailscale.conf /etc/systemd/system/ssh.service.d/10-tailscale.conf
systemctl daemon-reload
systemctl restart ssh.socket 2>/dev/null || systemctl restart ssh.service
EOF
chmod 700 /root/lockdown-rollback.sh
systemd-run --unit=lockdown-rollback --on-active=5min /root/lockdown-rollback.sh

echo "== ufw: only tailscale0 + Tailscale direct UDP"
apt-get install -y -q ufw >/dev/null
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
ufw --force enable

echo "== sshd: keys only, Tailscale IP only, after tailscaled"
cat > /etc/ssh/sshd_config.d/10-lockdown.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
ListenAddress ${TS_IP}
EOF
mkdir -p /etc/systemd/system/ssh.socket.d /etc/systemd/system/ssh.service.d
cat > /etc/systemd/system/ssh.socket.d/10-tailscale.conf <<'EOF'
[Unit]
After=tailscaled.service
Wants=tailscaled.service

[Socket]
# Bind even if tailscale0 has no address yet at boot
FreeBind=yes
EOF
cat > /etc/systemd/system/ssh.service.d/10-tailscale.conf <<'EOF'
[Unit]
After=tailscaled.service
Wants=tailscaled.service
EOF
sshd -t
systemctl daemon-reload
if systemctl is-enabled ssh.socket >/dev/null 2>&1; then
  systemctl restart ssh.socket
else
  systemctl restart ssh.service
fi

cat <<EOF

Done. Now, from another device on the tailnet, check:
  tailscale ssh root@$(hostname) hostname     -> works
  ssh root@<public-ip>                        -> times out
Then cancel the rollback within 5 minutes:
  systemctl stop lockdown-rollback.timer && rm /root/lockdown-rollback.sh
EOF
