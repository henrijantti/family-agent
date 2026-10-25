#!/bin/bash
# Post-deploy test questions (Henri 2026-10-25), run as openclaw after every deploy,
# once the gateway answers again. Installed to /home/openclaw/family-agent-smoke.sh.
#
# Asks henri and email a few read-only questions in throwaway sessions (not Henri's
# DM, not the family group) and checks the reply has the expected shape, which shows
# the agent runs and its tools answer. Prints one line per question and exits 1 when
# any fails. --notify also sends Henri one private Telegram message (Chief of staff
# bot, the health script's token and chat id) when something failed; nothing on success.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
NOTIFY=0; [ "${1:-}" = "--notify" ] && NOTIFY=1
RUN="smoke-$(date +%Y%m%d%H%M%S)"
RULE="Tämä on palvelimen automaattinen testikysymys deployn jälkeen. Älä lähetä viestejä kenellekään, älä käytä message- tai sessions_send-työkalua, älä muuta mitään. Vastaa vain tähän yhdellä rivillä."

# agent | question | regex the reply must match. No family case: the family agent
# has the `message` tool for the group, and only the prompt would keep it from posting.
CASES=(
  "henri|Kutsu reminder_list ja vastaa muodossa: MUISTUTUKSIA <lukumäärä>|MUISTUTUKSIA [0-9]+"
  "henri|Kutsu holiday_plan ja vastaa muodossa: SEURAAVA LOMA <loman nimi>|SEURAAVA LOMA [^ ]+"
  "henri|Lue perheen kalenterista huomisen tapahtumat ja vastaa muodossa: TAPAHTUMIA <lukumäärä>|TAPAHTUMIA [0-9]+"
  "email|Listaa saapuneet viestit lukemalla postilaatikkoa ja vastaa muodossa: POSTIA <viestien lukumäärä>|POSTIA [0-9]+"
)

fails=()
for c in "${CASES[@]}"; do
  IFS='|' read -r agent q want <<< "$c"
  # shellcheck source=/dev/null
  out="$(set -a; . "$HOME/.secrets/gateway.env"; set +a; timeout 240 openclaw agent --agent "$agent" --session-id "$RUN-$agent" --message "$RULE $q" --json 2>/dev/null)"
  reply="$(printf '%s' "$out" | jq -r '[.. | objects | (.text? // empty) | strings] | unique | join(" ")' 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
  if printf '%s' "$reply" | grep -Eq "$want"; then
    printf 'OK   %-7s %s\n' "$agent" "$reply"
  else
    printf 'FAIL %-7s %s\n' "$agent" "${reply:-<no reply>}"
    fails+=("$agent: ${q%% ja vastaa*} (vastaus: ${reply:-ei vastausta})")
  fi
done

[ "${#fails[@]}" = 0 ] && exit 0
if [ "$NOTIFY" = 1 ]; then
  token="$(tr -d '[:space:]' < "${HEALTH_TOKEN_FILE:-$HOME/.secrets/telegram-assistant-bot.token}")"
  chat="$(tr -d '[:space:]' < "${HEALTH_CHAT_FILE:-$HOME/.secrets/health-chat-id}")"
  text="$(printf '⚠️ Deployn jälkeinen testi epäonnistui\n\n%s\n\nKatson asiaa seuraavaksi; sinun ei tarvitse tehdä mitään.' "$(printf '• %s\n' "${fails[@]}")")"
  curl -fsS -m 20 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" || true
fi
exit 1
