#!/bin/bash
# Runs the family agent CLI on the server with secrets from files.
# Installed to /home/openclaw/family-agent-run.sh; run as the openclaw user:
#   ~/family-agent-run.sh check
#   ~/family-agent-run.sh week-preview
# One file per secret in ~/.secrets/family-agent/ (dir 700, files 600);
# empty files are skipped, so optional secrets stay unset.
set -euo pipefail
SECRETS="$HOME/.secrets/family-agent"
REPO="$HOME/family-agent"

for f in "$SECRETS"/*; do
  [ -f "$f" ] && [ -s "$f" ] || continue
  name="$(basename "$f")"
  [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
  export "$name=$(cat "$f")"
done
# Wilma logs in live from the server (Helsinki Wilma lets the server's address in).
export PATH="/opt/node/bin:$PATH"

cd "$REPO"
exec npm run --silent agent -- "$@"
