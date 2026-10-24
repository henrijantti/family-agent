#!/bin/bash
# Installs OpenClaw on the family-agent server. Run as root over Tailscale SSH,
# from a copy of this server/ folder, after 00-base-hardening.sh:
#   sudo bash setup-openclaw.sh
# Idempotent: safe to re-run. Needs /home/openclaw/.secrets/anthropic.env first
# (ANTHROPIC_API_KEY=..., created by hand, mode 600, owner openclaw).
#
# Layout:
#   /opt/node                         Node runtime (root-owned, checksum-verified)
#   ~openclaw/.npm-global             OpenClaw npm package (openclaw-owned)
#   ~openclaw/.openclaw/openclaw.json config (from openclaw.json5)
#   ~openclaw/.secrets/*.env          API key + gateway token (600)
#   rootless Docker as openclaw       sandbox containers; openclaw is NOT in the docker group
#   tailscale serve (root)            https://<magicdns>/ -> 127.0.0.1:18789, tailnet only
set -euo pipefail

OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.10.6}"
NODE_VERSION="${NODE_VERSION:-24.22.1}"
OC_USER=openclaw
OC_HOME=/home/openclaw
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
id "$OC_USER" >/dev/null || { echo "user $OC_USER missing; run 00-base-hardening.sh"; exit 1; }
[ -s "$OC_HOME/.secrets/anthropic.env" ] || { echo "missing $OC_HOME/.secrets/anthropic.env"; exit 1; }
OC_UID="$(id -u "$OC_USER")"

as_oc() {
  runuser -u "$OC_USER" -- env -i HOME="$OC_HOME" USER="$OC_USER" LOGNAME="$OC_USER" \
    XDG_RUNTIME_DIR="/run/user/$OC_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$OC_UID/bus" \
    DOCKER_HOST="unix:///run/user/$OC_UID/docker.sock" \
    PATH="$OC_HOME/.npm-global/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin" \
    bash -c "cd ~ && $1"
}

echo "== Node $NODE_VERSION"
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL --proto '=https' -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL --proto '=https' -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "/opt/node-v$NODE_VERSION"
  mkdir -p "/opt/node-v$NODE_VERSION"
  tar -xJf "$tmp/$tarball" -C "/opt/node-v$NODE_VERSION" --strip-components=1 --no-same-owner
  ln -sfn "/opt/node-v$NODE_VERSION" /opt/node
  rm -rf "$tmp"
fi
/opt/node/bin/node --version

echo "== rootless Docker for $OC_USER"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q uidmap dbus-user-session slirp4netns docker-ce-rootless-extras >/dev/null
grep -q "^$OC_USER:" /etc/subuid || usermod --add-subuids 200000-265535 "$OC_USER"
grep -q "^$OC_USER:" /etc/subgid || usermod --add-subgids 200000-265535 "$OC_USER"
# Ubuntu restricts unprivileged user namespaces; its apparmor package ships a
# `rootlesskit` profile that allows them. Do not add a second profile for the
# same binary: two profiles on one path cancel out and rootlesskit fails.
apparmor_parser -r /etc/apparmor.d/rootlesskit
loginctl enable-linger "$OC_USER"
for _ in $(seq 1 30); do [ -S "/run/user/$OC_UID/bus" ] && break; sleep 1; done
if [ ! -f "$OC_HOME/.config/systemd/user/docker.service" ]; then
  as_oc "dockerd-rootless-setuptool.sh install --force"
fi
as_oc "systemctl --user enable --now docker.service"
for _ in $(seq 1 30); do as_oc "docker info >/dev/null 2>&1" && break; sleep 1; done
as_oc "docker info --format 'rootless docker {{.ServerVersion}}, security: {{.SecurityOptions}}'"

echo "== OpenClaw $OPENCLAW_VERSION"
install -d -m 755 -o "$OC_USER" -g "$OC_USER" /var/tmp/openclaw-compile-cache
as_oc "npm config set prefix ~/.npm-global"
as_oc 'openclaw --version 2>/dev/null' | grep -qF "$OPENCLAW_VERSION" || \
  as_oc "npm install -g --no-fund --no-audit openclaw@$OPENCLAW_VERSION --allow-scripts=openclaw"
# Verify registry signatures and provenance attestations of the installed tree.
as_oc "cd ~/.npm-global/lib/node_modules/openclaw && npm audit signatures"
as_oc "openclaw --version"

echo "== sandbox image"
as_oc "docker image inspect openclaw-sandbox:bookworm-slim >/dev/null 2>&1" || as_oc "docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD [\"sleep\", \"infinity\"]
DOCKERFILE"

echo "== install policy"
install -m 755 -o root -g root "$HERE/openclaw-install-policy" /usr/local/bin/openclaw-install-policy
sed -i 's/\r$//' /usr/local/bin/openclaw-install-policy

echo "== secrets + config"
install -d -m 700 -o "$OC_USER" -g root "$OC_HOME/.secrets"
if [ ! -s "$OC_HOME/.secrets/gateway.env" ]; then
  umask 077
  printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$OC_HOME/.secrets/gateway.env"
fi
chown "$OC_USER":root "$OC_HOME/.secrets/"*.env
chmod 600 "$OC_HOME/.secrets/"*.env
install -d -m 700 -o "$OC_USER" -g "$OC_USER" "$OC_HOME/.openclaw"
install -m 600 -o "$OC_USER" -g "$OC_USER" "$HERE/openclaw.json5" "$OC_HOME/.openclaw/openclaw.json"
sed -i 's/\r$//' "$OC_HOME/.openclaw/openclaw.json"

echo "== gateway service"
install -d -m 755 -o "$OC_USER" -g "$OC_USER" "$OC_HOME/.config/systemd/user"
install -m 644 -o "$OC_USER" -g "$OC_USER" "$HERE/systemd/openclaw-gateway.service" \
  "$OC_HOME/.config/systemd/user/openclaw-gateway.service"
sed -i 's/\r$//' "$OC_HOME/.config/systemd/user/openclaw-gateway.service"
as_oc "systemctl --user daemon-reload && systemctl --user enable openclaw-gateway.service && systemctl --user restart openclaw-gateway.service"
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:18789/ 2>/dev/null && break; sleep 2; done
as_oc "systemctl --user --no-pager status openclaw-gateway.service | head -5"

echo "== tailscale serve (tailnet only, never funnel)"
# Serve needs HTTPS certificates enabled for the tailnet (admin console > DNS).
if [ "$(tailscale status --json | jq -r '.CertDomains // [] | length')" = 0 ]; then
  echo "SKIPPED: enable HTTPS Certificates at https://login.tailscale.com/admin/dns, then re-run."
else
  tailscale serve --bg --yes --https=443 http://127.0.0.1:18789
  tailscale serve status
fi
