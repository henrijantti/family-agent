#!/usr/bin/env bash
# Keeps the agent's encrypted state on orphan branches, one commit each,
# force-pushed after every run. Files are AES-encrypted with STATE_KEY.
#   state        state.json (written by the GitHub-hosted runs)
#   state-wilma  wilma-session.json + wilma-snapshot.json (written by the home runner)
set -euo pipefail

fetch_files() { # branch file...
  local branch=$1; shift
  mkdir -p state
  if git fetch -q --depth=1 origin "$branch" 2>/dev/null; then
    for f in "$@"; do git show "FETCH_HEAD:$f" > "state/$f" 2>/dev/null || rm -f "state/$f"; done
    echo "$branch loaded"
  else
    echo "no $branch branch yet (first run)"
  fi
}

push_files() { # branch file...
  local branch=$1; shift
  local files=()
  for f in "$@"; do
    [ -f "state/$f" ] || continue
    head -c 7 "state/$f" | grep -q '^FAENC1:' || { echo "refusing to save unencrypted state/$f (set STATE_KEY)"; exit 1; }
    files+=("$f")
  done
  [ ${#files[@]} -gt 0 ] || { echo "nothing to save"; return 0; }
  local tmp; tmp=$(mktemp -d)
  for f in "${files[@]}"; do cp "state/$f" "$tmp/"; done
  (
    cd "$tmp"
    git init -q -b "$branch"
    git -c user.name=family-agent -c user.email=family-agent@users.noreply.github.com add .
    git -c user.name=family-agent -c user.email=family-agent@users.noreply.github.com commit -qm "$branch $(date -u +%FT%TZ)"
    git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$branch"
  )
  rm -rf "$tmp"
  echo "$branch saved"
}

case "${1:-}" in
  load)
    fetch_files state state.json
    fetch_files state-wilma wilma-snapshot.json
    ;;
  save) push_files state state.json ;;
  load-wilma) fetch_files state-wilma wilma-session.json wilma-snapshot.json ;;
  save-wilma) push_files state-wilma wilma-session.json wilma-snapshot.json ;;
  *) echo "usage: state.sh load|save|load-wilma|save-wilma"; exit 2 ;;
esac
