#!/bin/bash
# Start a one-shot outbound dialer with the SAME environment as the
# listener. BVA_RELAY=tcp is load-bearing: without it the relay list is
# UDP-first, werift's UDP TURN allocation fails silently under this VM's
# egress policy, the peer connection emits zero ICE candidates, and the
# call "connects" at the signaling layer but never carries media
# (live proof: calls 974D0AF6 and 27896DC9, 2026-11-16 — zero candidates
# sent, pc stuck at connecting, callee heard nothing).
cd /home/hatch/workspace/beagle-voice-agent || exit 1
export BVA_RELAY=tcp HOME=/home/hatch NODE_USE_ENV_PROXY=1
exec node converse.js --call "$1"
