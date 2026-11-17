#!/bin/bash
# Start the text agent (autonomous Beagle text replies + "call me" dials
# for the owner). Same env discipline as start-listener.sh.
cd /home/hatch/workspace/beagle-voice-agent || exit 1
export BVA_RELAY=tcp HOME=/home/hatch NODE_USE_ENV_PROXY=1
setsid node text-agent.js >> out/text-agent.log 2>&1 < /dev/null &
echo "text agent started"
