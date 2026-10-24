#!/bin/bash
# Nightly encrypted backup of the family-agent server, run as openclaw by
# family-agent-backup.timer. Installed to /home/openclaw/family-agent-backup.sh.
#
# Contents (one age-encrypted tar per night):
#   openclaw-backup.tar.gz   `openclaw backup create` (config, auth, sessions, memory, workspace)
#   secrets/                 ~/.secrets: family-agent/, anthropic.env, gateway.env
#   family-agent-state/      ~/family-agent/state (state.json, Outlook token inside, encrypted)
#
# Encrypted to the laptop's age public key in ~/.backup/recipient.txt; the server
# cannot read its own backups. Pushed over SSH with a write-only-to-this-repo deploy
# key (~/.backup/deploy_key) to a private GitHub repo, as a single orphan commit
# holding the newest KEEP files, so old backups do not pile up in git history.
set -euo pipefail
umask 077
KEEP=14
B="$HOME/.backup"
# SSH over port 443: outbound port 22 to github.com times out from this server.
REPO_URL="ssh://git@ssh.github.com:443/henrijantti/family-agent-backup.git"
export PATH="$HOME/.npm-global/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin"
export GIT_SSH_COMMAND="ssh -i $B/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$B/known_hosts"

recipient="$(cat "$B/recipient.txt")"
stamp="$(date +%Y-%m-%dT%H%M%S%z)"
work="$(mktemp -d /var/tmp/fab.XXXXXX)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/payload/secrets" "$work/oc"
set -a; . "$HOME/.secrets/gateway.env"; set +a
openclaw backup create --output "$work/oc" --verify >/dev/null
mv "$work"/oc/*.tar.gz "$work/payload/openclaw-backup.tar.gz"
cp -a "$HOME/.secrets/family-agent" "$HOME/.secrets/anthropic.env" "$HOME/.secrets/gateway.env" "$work/payload/secrets/"
cp -a "$HOME"/.secrets/telegram-*.env "$HOME"/.secrets/telegram-*.token "$work/payload/secrets/" 2>/dev/null || true
cp -a "$HOME/family-agent/state" "$work/payload/family-agent-state"

[ -d "$B/repo/.git" ] || git clone -q "$REPO_URL" "$B/repo" 2>/dev/null || { mkdir -p "$B/repo" && git -C "$B/repo" init -q && git -C "$B/repo" remote add origin "$REPO_URL"; }
cd "$B/repo"
# An existing clone may still point at an older URL (e.g. port 22).
git remote set-url origin "$REPO_URL"
git config user.name "family-agent server"
git config user.email "family-agent-backup@localhost"
tar -czf - -C "$work/payload" . | age -r "$recipient" -o "backup-$stamp.tar.gz.age"

# Keep the newest KEEP backups; publish them as one fresh orphan commit.
ls -1 backup-*.tar.gz.age | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -f
git checkout -q --orphan next
git add -A .
git commit -q -m "backup $stamp ($(ls -1 backup-*.tar.gz.age | wc -l) kept)"
git branch -q -D main 2>/dev/null || true
git branch -q -m main
git push -q --force origin main
git gc -q --prune=now
echo "backup ok: backup-$stamp.tar.gz.age $(stat -c %s "backup-$stamp.tar.gz.age") bytes"
