#!/bin/bash
# Publishes a small status.json (no secrets, no family or mail content) to the
# `status` branch of the private backup repo every 15 minutes, so cloud sessions
# can see the server's state without the laptop. Run as openclaw by
# family-agent-status.timer; installed to /home/openclaw/family-agent-status.sh.
# Uses the backup deploy key. The branch holds one orphan commit, force-pushed.
set -euo pipefail
umask 077
export PATH="$HOME/.npm-global/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
B="$HOME/.backup"
REPO_URL="ssh://git@ssh.github.com:443/henrijantti/family-agent-backup.git"
DIR="$B/status-repo"
export GIT_SSH_COMMAND="ssh -i $B/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$B/known_hosts"

unit() { # name, result, last exit (ISO), active state of a user unit
  local u="$1" r t a
  r="$(systemctl --user show "$u" -p Result --value 2>/dev/null || true)"
  t="$(systemctl --user show "$u" -p ExecMainExitTimestamp --value 2>/dev/null || true)"
  a="$(systemctl --user is-active "$u" 2>/dev/null || true)"
  jq -n --arg u "$u" --arg r "$r" --arg t "$t" --arg a "$a" '{unit: $u, result: $r, lastExit: $t, active: $a}'
}

crons="$(timeout 60 openclaw cron list --json 2>/dev/null | jq '[.jobs[]? | {name: (.displayName // .name), agent: .agentId, enabled, lastRunStatus: (.lastRunStatus // .state.lastRunStatus), lastDelivery: (.lastDeliveryStatus // .state.lastDeliveryStatus), consecutiveErrors: (.state.consecutiveErrors // 0), lastRunAt: ((.lastRunAtMs // .state.lastRunAtMs) | if . then (./1000 | todate) else null end), nextRunAt: ((.nextRunAtMs // .state.nextRunAtMs) | if . then (./1000 | todate) else null end)}]' 2>/dev/null || echo null)"
alerts="$(ls -1 "$HOME/.local/state/family-agent-health" 2>/dev/null | jq -R . | jq -s . || echo '[]')"

mkdir -p "$DIR"
[ -d "$DIR/.git" ] || git -C "$DIR" init -q
git -C "$DIR" remote get-url origin >/dev/null 2>&1 || git -C "$DIR" remote add origin "$REPO_URL"
jq -n \
  --arg at "$(date -Is)" \
  --arg head "$(git -C "$HOME/family-agent" rev-parse --short HEAD 2>/dev/null || echo ?)" \
  --arg openclaw "$(openclaw --version 2>/dev/null | head -1 || echo ?)" \
  --argjson memFreeMb "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" \
  --argjson diskPct "$(df --output=pcent / | tail -1 | tr -dc 0-9)" \
  --argjson uptimeH "$(awk '{print int($1/3600)}' /proc/uptime)" \
  --argjson units "$(for u in family-agent-tick.service family-agent-backup.service family-agent-health.service openclaw-gateway.service; do unit "$u"; done | jq -s .)" \
  --argjson crons "$crons" \
  --argjson alerts "$alerts" \
  '{at: $at, head: $head, openclaw: $openclaw, memFreeMb: $memFreeMb, diskPct: $diskPct, uptimeH: $uptimeH, units: $units, crons: $crons, openHealthAlerts: $alerts}' > "$DIR/status.json"

cd "$DIR"
git checkout -q --orphan next 2>/dev/null || git checkout -q next
git add status.json
git -c user.name="family-agent server" -c user.email="family-agent-backup@localhost" commit -q -m "status $(date -Is)"
git branch -q -D status 2>/dev/null || true
git branch -q -m status
git push -q --force origin status
