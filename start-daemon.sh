#!/bin/bash
# Start the beagle daemon with the Muse-VM env (same as the watchdog launcher).
cd /home/hatch/workspace/beagle-voice-agent || exit 1
export NODE_USE_ENV_PROXY=1 DECENT_TCP_ONLY_BOOTSTRAP=1 DECENT_TCP_MAX_RELAYS=15 DECENT_EXPRESS_DOORBELL=1 BVA_RELAY=tcp HOME=/home/hatch
export DECENT_PROFILE_AVATAR_URL="https://ens-gateway.beaglechat.workers.dev/avatar/noor.beagles.eth?v=1794303148" DECENT_PROFILE_ENS="noor.beagles.eth"
setsid node ./node_modules/.bin/beagle >> out/daemon.log 2>&1 < /dev/null &
echo "daemon started"
