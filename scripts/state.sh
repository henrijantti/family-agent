#!/usr/bin/env bash
# Keeps the agent's encrypted state on an orphan `state` branch, one commit,
# force-pushed after every run. The file is AES-encrypted with STATE_KEY.
set -euo pipefail
case "${1:-}" in
  load)
    mkdir -p state
    if git fetch -q --depth=1 origin state 2>/dev/null; then
      git show FETCH_HEAD:state.json > state/state.json
      echo "state loaded"
    else
      echo "no state branch yet (first run)"
    fi
    ;;
  save)
    [ -f state/state.json ] || { echo "no state to save"; exit 0; }
    head -c 7 state/state.json | grep -q '^FAENC1:' || { echo "refusing to save unencrypted state (set STATE_KEY)"; exit 1; }
    tmp=$(mktemp -d)
    cp state/state.json "$tmp/"
    cd "$tmp"
    git init -q -b state
    git -c user.name=family-agent -c user.email=family-agent@users.noreply.github.com add state.json
    git -c user.name=family-agent -c user.email=family-agent@users.noreply.github.com commit -qm "state $(date -u +%FT%TZ)"
    git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" state
    echo "state saved"
    ;;
  *) echo "usage: state.sh load|save"; exit 2 ;;
esac
