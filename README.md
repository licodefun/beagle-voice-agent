# Noor: Beagle voice agent

Wei Li's personal voice agent on Beagle — it can **call a Beagle client and hold a two-way voice conversation**, the same capability Rio (Wei's Grok bot) demonstrated. Adapted from Rio's public prototype; see [UPSTREAM.md](UPSTREAM.md) for credit and the full list of changes.

**Status (2026-11-09): built and offline-tested. Live call not yet validated for Noor** — see "Why the first live call has to run on your Mac" below.

## Who's who

| Who | Beagle identity |
|---|---|
| **Noor** (this agent) | Address `Sw1d4dJQVyxC1VY1RyqcBg5oc8z7HgGT4r4qMpWBXDozt8BaEJ3s` · userid `CoHMW66WT5Qwuuyxpun3urBKkCry8SgDCDkpsJorTGuu` |
| **Wei** (owner) | userid `7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh` (from Rio's public repo) |
| **Rio** (Grok bot) | Address `LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d` — friend-only; he must accept a request before anyone can call or message him. No public share/QR link exists. |

Calls are **friend-only** on Beagle: no friend handshake, no call. Auto-accept is OFF on Noor's identity.

## How it works

```
Beagle app (friend)  ⇄  TURN relay (UDP, relay-only)  ⇄  werift + @decentnetwork/peer-webrtc CallEngine
                                                              │  signaling via local daemon
Beagle CLI daemon  http://localhost:8766  (@decentnetwork/beagle 0.1.132, embedded peer,
  /api/call-signal · /api/call-poll · /api/call-ice-servers · /api/friends-list · /api/diag)
                                                              │  + Socket.IO offline bridge + wake push
Conversation loop (half-duplex):  Opus RTP → decode → energy VAD (450 ms endpoint)
  → faster-whisper base ASR (EN/中文 autodetect) → local Qwen2.5-1.5B (llama.cpp, offline)
  → Piper TTS (EN/ZH) → Opus RTP back on the same call
```

- Signaling rides the daemon's HTTP API; offline friends are reached through the SDK's Socket.IO bridge + wake push (`@decentnetwork/lan` OfflineCallBridge).
- Media is **relay-only**: non-relay ICE candidates are dropped, so calls work through NAT without exposing host addresses.
- Safety rails, same as Rio's: accepted-friend allowlist re-checked at answer time, one call at a time, **hard 3-minute cap including setup**, no tools/internet exposed to callers, owner-only context gated by verified peer userid (never by anything a caller says).
- Everything conversational runs **locally** — no API keys, no cloud ASR/LLM/TTS, call audio never leaves the host.
- The daemon **shares the existing `~/.agentnet` Carrier identity** (that's why Noor's address above is the same one as the Muse Beagle connector). One process owns the identity at a time: run either the beagle daemon or agentnet, not both.

Note the SDK link: https://decent.network/sdk is dead (404). The live docs are https://decent.network/sdks and https://beagle.chat/en/.

## Run it (on a host with normal UDP — e.g. Wei's Mac)

```sh
./setup.sh                       # node deps + python venv + models (~1.6 GB, one time)

# Terminal 1 — Beagle daemon (identity + signaling + friends UI)
npx beagle                       # http://localhost:8766

# Terminal 2 — two-way conversational agent
./run-conversation.sh            # listen: an accepted friend can call Noor and talk
./run-conversation.sh --call 7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh   # Noor dials Wei for a two-way talk

# Simpler one-way test (greeting only, no conversation)
node agent.js call <userid> --say "Hi, this is Noor." --hold 60
node agent.js listen             # answer friends with a greeting and record what they say
```

Friend handshake first (once):

1. **Wei ⇄ Noor:** in your Beagle app, add Noor's address `Sw1d4dJQVyxC1VY1RyqcBg5oc8z7HgGT4r4qMpWBXDozt8BaEJ3s`, then accept the request in the daemon's local UI (or from the app side). Noor's userid becomes callable once you're friends; your userid above is already configured as the owner in `grounding.py`.
2. **Noor ⇄ Rio:** send a friend request to Rio's address `LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d` (Beagle app/CLI add-friend flow with that full address) — Rio's side has to accept before Noor can call him, and vice versa. Ask Rio over X/text to accept.

## Why the first live call has to run on your Mac

Muse's VM **blocks all outbound UDP** (verified again 2026-11-09: the beagle daemon starts fine on :8766 and serves identity/friends/ICE, but Carrier reports `joinNetwork failed (send EPERM 13.58.208.50:33445)` — the DHT bootstrap is UDP, and TURN media is UDP). The identical folder runs live on any normal host; that's also how Rio's build works (on the Grok host). Nothing about the code is VM-specific — `lib/decent.js` resolves the SDK from this project's own `node_modules` instead of Rio's hard-coded `/workspace/beagle-cli/...` paths.

## Tests (offline, never call anyone)

```sh
node --test tests/conversation.test.js     # 16/16 pass (2026-11-09, incl. real werift RTP + offline-signaling routing)
python3 -m unittest discover -s tests -p 'test_*.py'   # 13/13 pass (policy + owner-gating)
node tests/local-integration.js            # needs models: full local ASR→LLM→TTS→Opus round trip
```

## Files

- `agent.js` — one-way adapter: call a friend and play a greeting (`--say`/`--play`), or listen, greet, and record.
- `converse.js` — two-way conversational agent: inbound listener + `--call <userid>` outbound conversation.
- `lib/engine.js` / `lib/ice.js` — daemon signaling + relay-only werift peer connections.
- `lib/offline-signaling.js` — daemon (online) + Socket.IO/push (offline) combined signaling.
- `lib/conversation.js` / `lib/turns.js` / `lib/playback.js` — Opus decode, VAD turn-taking, bounded RTP playback.
- `lib/local-backend.js` + `local-worker.py` — local whisper/Qwen/Piper worker (JSON-lines).
- `beagle_faq.py` / `grounding.py` / `local_policy.py` — grounded Beagle facts, owner gating + clock, bilingual sentence policy.
- `setup.sh` — one-time install for a new host.
