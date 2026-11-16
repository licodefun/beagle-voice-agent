#!/bin/bash
# Start the conversational listener (answers inbound calls from accepted friends).
cd /home/hatch/workspace/beagle-voice-agent || exit 1
export BVA_RELAY=tcp HOME=/home/hatch NODE_USE_ENV_PROXY=1
# The listener's backend is the shared warm worker service; make sure it is
# up first (its port only accepts once models are warm). Dialers spawned
# elsewhere rely on the same service via LocalBackend's default.
if ! (exec 3<>/dev/tcp/127.0.0.1/8768) 2>/dev/null; then
  bash ./start-worker.sh >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    (exec 3<>/dev/tcp/127.0.0.1/8768) 2>/dev/null && break
    sleep 2
  done
fi
setsid node converse.js >> out/listen1.log 2>&1 < /dev/null &
echo "listener started"
