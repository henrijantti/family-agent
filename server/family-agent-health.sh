#!/bin/bash
# Health check for the family-agent server, run as openclaw every 10 minutes by
# family-agent-health.timer. Installed to /home/openclaw/family-agent-health.sh.
#
# Sends Henri one short private Telegram message per problem (never the family
# group), at most once per problem every 6 hours, and one message when it is fixed.
# Bot token and Henri's chat id come from files under ~/.secrets (not in git):
#   HEALTH_TOKEN_FILE  default ~/.secrets/telegram-assistant.token (Chief of staff bot)
#   HEALTH_CHAT_FILE   default ~/.secrets/health-chat-id
# --dry prints the messages instead of sending them.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
STATE="$HOME/.local/state/family-agent-health"
REPEAT_MIN=360
MIN_FREE_MB=600
MAX_DISK_PCT=85
mkdir -p "$STATE"

send() {
  if [ "$DRY" = 1 ]; then printf -- '--- message\n%s\n' "$1"; return; fi
  local token chat
  token="$(tr -d '[:space:]' < "${HEALTH_TOKEN_FILE:-$HOME/.secrets/telegram-assistant.token}")" || return
  chat="$(tr -d '[:space:]' < "${HEALTH_CHAT_FILE:-$HOME/.secrets/health-chat-id}")" || return
  curl -sS -m 20 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" --data-urlencode "disable_notification=false"
}

# problem <key> <text>: alert now unless the same alert went out in the last 6 h.
problem() {
  local f="$STATE/$1"
  if [ -f "$f" ] && [ -z "$(find "$f" -mmin +"$REPEAT_MIN")" ]; then return; fi
  printf '%s\n' "$2" > "$f"
  send "$(printf '⚠️ Palvelinhälytys\n\n%s\n\nKatson asiaa seuraavaksi; sinun ei tarvitse tehdä mitään.' "$2")"
}

# ok <key>: if <key> was alerting, say once that it is fixed.
ok() {
  local f="$STATE/$1"
  [ -f "$f" ] || return
  send "$(printf '✅ Korjaantui\n\n%s' "$(head -1 "$f")")"
  rm -f "$f"
}

check() { # check <key> <text> <command...>: the command succeeds when healthy
  local key="$1" text="$2"; shift 2
  if "$@"; then ok "$key"; else problem "$key" "$text"; fi
}

unit_ok() { # last run of a oneshot unit succeeded (or it never ran)
  local r; r="$(systemctl --user show "$1" -p Result --value 2>/dev/null)"
  [ -z "$r" ] || [ "$r" = success ]
}
gateway_up() { [ "$(systemctl --user is-active openclaw-gateway 2>/dev/null)" = active ]; }
mem_ok() { [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -ge "$MIN_FREE_MB" ]; }
disk_ok() { [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -le "$MAX_DISK_PCT" ]; }
tick_recent() { # the tick ran in the last 40 minutes
  local t; t="$(systemctl --user show family-agent-tick.service -p ExecMainExitTimestampMonotonic --value 2>/dev/null)"
  [ -n "$t" ] && [ "$t" != 0 ] || return 0
  [ $(( $(awk '{print int($1)}' /proc/uptime) - t / 1000000 )) -le 2400 ]
}
backup_recent() { # a backup succeeded in the last 26 hours (skips the first day after boot)
  local up; up="$(awk '{print int($1)}' /proc/uptime)"
  [ "$up" -lt 93600 ] && return 0
  unit_ok family-agent-backup.service && [ -n "$(find "$HOME/.backup/repo" -maxdepth 1 -name '*.age' -mmin -1560 2>/dev/null | head -1)" ]
}
crons_ok() { # no OpenClaw cron job whose last run failed
  local bad
  bad="$(timeout 60 openclaw cron list --json 2>/dev/null | jq -r '[.. | objects | select(has("lastStatus") or has("lastRunStatus")) | select((.lastStatus // .lastRunStatus) | tostring | test("error|fail"; "i"))] | length' 2>/dev/null)"
  [ -z "$bad" ] || [ "$bad" = 0 ]
}

check tick "Perheagentin ajo epäonnistui (viimeisin ajo päättyi virheeseen)" unit_ok family-agent-tick.service
check tick-stale "Perheagentti ei ole ajanut 40 minuuttiin" tick_recent
check gateway "OpenClaw-palvelu ei ole käynnissä (botit eivät vastaa)" gateway_up
check backup "Yön varmuuskopio ei onnistunut" backup_recent
check crons "Jokin ajastettu tehtävä (esim. aamukooste) päättyi virheeseen" crons_ok
check memory "Palvelimen muisti on vähissä (alle $MIN_FREE_MB Mt vapaana)" mem_ok
check disk "Palvelimen levy on yli $MAX_DISK_PCT % täynnä" disk_ok
exit 0
