#!/bin/bash
U=$(id -u openclaw)
R() {
  runuser -u openclaw -- env -i HOME=/home/openclaw XDG_RUNTIME_DIR=/run/user/$U \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus DOCKER_HOST=unix:///run/user/$U/docker.sock \
    PATH=/home/openclaw/.npm-global/bin:/opt/node/bin:/usr/bin:/bin OPENCLAW_NO_RESPAWN=1 \
    bash -c "cd ~ && set -a && . ~/.secrets/anthropic.env && . ~/.secrets/gateway.env && set +a && $1"
}
redact() { sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-REDACTED/g; s/[0-9a-f]{64}/TOKEN-REDACTED/g'; }

case "${1:-}" in
status)
  R "timeout 120 openclaw status --all 2>&1" | redact | tail -60
  R "timeout 60 openclaw devices list 2>&1" | redact | tail -30
  ;;
logs)
  echo "--- gateway log (last 40)"
  journalctl _UID=$U --no-pager -n 40 -o cat | redact
  echo "--- listeners"
  ss -tlnp | grep -E ':18789|node|MainThread' | redact
  ;;
doctor)
  R "timeout 300 openclaw doctor --non-interactive 2>&1 || timeout 300 openclaw doctor 2>&1 </dev/null" | redact | tail -80
  ;;
audit)
  R "timeout 300 openclaw security audit --deep --json --token \"\$OPENCLAW_GATEWAY_TOKEN\" 2>/dev/null" > /root/server-setup/audit.json
  jq '.summary' /root/server-setup/audit.json
  jq -r '.findings[] | "\(.severity)\t\(.checkId)\t\(.title // .message // "")"' /root/server-setup/audit.json | redact
  ;;
test)
  R "timeout 180 openclaw agent --message 'Reply with exactly: hello from the family agent server' --json 2>/tmp/oc-agent.err" > /root/server-setup/agent.json
  echo "exit=$?"
  jq -r '.. | objects | (.text? // empty)' /root/server-setup/agent.json | head -5
  jq -c '.meta.agentMeta // .meta // {} | {model: (.model // .provider // null), sandboxed: (.sandboxed // null)}' /root/server-setup/agent.json 2>/dev/null
  tail -5 /tmp/oc-agent.err 2>/dev/null | redact
  ;;
mem)
  free -h
  R "systemctl --user show openclaw-gateway -p MemoryCurrent -p NRestarts -p ActiveState"
  R "docker ps --format '{{.Names}} {{.Image}} {{.Status}}'"
  ;;
esac
