#!/bin/bash
# Run Noor's Beagle voice agent on THIS host (Muse's VM).
#
# Network reality on this VM (verified 2026-11-09):
# - Outbound UDP is blocked at the kernel (send EPERM) — Carrier DHT/UDP and
#   UDP TURN cannot work here.
# - Direct outbound TCP is refused by Muse's egress policy unless the user
#   allows it: Muse settings -> Permissions -> Direct network protocols ->
#   other_tcp: Deny -> Ask (the gateway itself prints these instructions).
# - With other_tcp allowed, this launcher uses the TCP fallbacks Beagle
#   already has: Carrier TCP relay pool (all bootstraps) for sessions and
#   TURN-over-TCP (BVA_RELAY=tcp) for media. Signaling + push + Express
#   offline delivery ride HTTPS and work regardless.
set -eu
cd "$(dirname "$0")"
mkdir -p out
export DECENT_TCP_MAX_RELAYS="${DECENT_TCP_MAX_RELAYS:-15}"
export BVA_RELAY="${BVA_RELAY:-tcp}"

if ! curl -s -m 3 http://localhost:8766/api/diag >/dev/null 2>&1; then
  echo "starting beagle daemon (identity ~/.agentnet, TCP relay pool x$DECENT_TCP_MAX_RELAYS)..."
  nohup ./node_modules/.bin/beagle > out/daemon.log 2>&1 &
  for i in $(seq 1 30); do
    curl -s -m 2 http://localhost:8766/api/diag >/dev/null 2>&1 && break
    sleep 2
  done
fi
curl -s http://localhost:8766/api/diag | head -c 200; echo
echo "starting conversational listener (accepted friends only; --call <userid> to dial out)..."
exec ./run-conversation.sh "$@" 2>&1 | tee out/conversation-live.log
