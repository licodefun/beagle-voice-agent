#!/bin/bash
# Explicit operator action: temporarily replace old listener, restore it on exit.
# Portable version: runs from wherever this repo is checked out.
set -eu
cd "$(dirname "$0")"
mkdir -p out
if command -v flock >/dev/null 2>&1; then
  exec 9>out/listener-switch.lock
  flock -n 9 || { echo 'another conversational listener holds the lock'; exit 1; }
fi
mapfile -t prior < <(pgrep -f 'node agent.js listen' || true)
restore() { for pid in "${prior[@]}"; do kill -CONT "$pid" 2>/dev/null || true; done; }
trap restore EXIT
for pid in "${prior[@]}"; do kill -STOP "$pid" 2>/dev/null || true; done
node converse.js "$@"
