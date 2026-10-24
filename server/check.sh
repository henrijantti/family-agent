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
approval-test)
  # Run after every gateway or plugin change, before calling it fixed: the email
  # agent asks to send a dummy draft, the mail-approval card must reach Henri's
  # mail bot chat, and this script denies it. Nothing can be sent (the draft id
  # doesn't exist, and the card is denied). Henri sees one card, marked denied;
  # tell him first, so he leaves it alone (an Allow still sends nothing).
  F=/home/openclaw/family-agent/state/mail-approvals.jsonl
  before=$(R "wc -l < $F 2>/dev/null || echo 0")
  R "timeout 240 openclaw agent --agent email --message 'Approval self-test from the server: call mail_send once with draftId SELFTESTxxxxxxxx01, then reply with the tool result in one line.' >/tmp/approval-test.out 2>&1" &
  agent=$!
  id=""
  for _ in $(seq 1 30); do
    sleep 4
    # The plain-text table truncates ids; the JSON has them whole.
    id=$(R "timeout 30 openclaw approvals pending --json 2>/dev/null" | jq -r '[.. | objects | select((.id? // "") | tostring | startswith("plugin:"))][0].id // empty' 2>/dev/null)
    [ -n "$id" ] && break
  done
  if [ -z "$id" ]; then echo "FAIL: no approval request within 2 minutes (plugin not loaded or no route)"; wait $agent; exit 1; fi
  echo "approval request: $id"
  R "timeout 30 openclaw approvals resolve '$id' deny" | redact | tail -3
  wait $agent
  after=$(R "wc -l < $F 2>/dev/null || echo 0")
  # This test's own row, so a real approval at the same moment can't be mistaken for it.
  last=$(R "cat $F 2>/dev/null" | jq -r 'select(.draftId == "SELFTESTxxxxxxxx01") | .decision' 2>/dev/null | tail -1)
  echo "agent said: $(tail -1 /tmp/approval-test.out 2>/dev/null | redact | cut -c1-200)"
  if [ "$after" -gt "$before" ] && [ "$last" = deny ]; then
    echo "OK: card created, denied, recorded (mail-approvals.jsonl +$((after - before)), last decision deny)"
  else
    echo "FAIL: no deny row recorded (before $before, after $after, last '$last')"; exit 1
  fi
  echo "Check Henri's mail bot chat for the card: the delivery itself can only be seen there or in the gateway log:"
  journalctl _UID="$U" --no-pager --since "-5 min" -o cat | grep -iE 'approval|telegram' | redact | tail -5
  ;;
esac
