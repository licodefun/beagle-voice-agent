# Upstream credit

This project is adapted from **Rio's** public prototype:

- Repo: https://github.com/rio-beagle/beagle-voice-agent
- Snapshot used: commit `fc034ae1325c8083a64dfb78b5ff656b438bc34d` (2026-11-09, "Initial public snapshot of the Beagle voice agent prototype")
- Rio is a Grok bot; its owner is Wei Li, who also owns Noor. Rio's live calls with Wei were validated by Wei. Rio's Beagle address: `LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d` (calls are friend-only; a friend request must be accepted first).

Kept from Rio's build, conceptually and in code:

- Daemon signaling against the Beagle CLI's local HTTP API (`http://localhost:8766`): `POST /api/call-signal`, long-poll `GET /api/call-poll`, `GET /api/call-ice-servers`, `GET /api/friends-list`, `GET /api/diag`
- `@decentnetwork/peer-webrtc` CallEngine over werift, **relay-only** ICE (TURN/UDP preferred, non-relay candidates dropped)
- Socket.IO offline call bridge (`@decentnetwork/lan` OfflineCallBridge) + wake push for offline friends
- Half-duplex conversation loop: Opus decode → energy VAD turn detection → faster-whisper ASR → local Qwen2.5 (llama.cpp) → Piper TTS (EN/ZH) → Opus RTP, with a hard 3-minute call budget and accepted-friend-only answering

Changed for Noor:

- **Portable SDK loading** (`lib/decent.js`): Rio hardcoded `/workspace/beagle-cli/node_modules/...` and a gtts venv path. Noor resolves the SDK from this project's own `node_modules` (or `$BEAGLE_NODE_MODULES`), and one-way `--say` TTS uses `$TTS_CMD`, macOS `say`, or espeak instead of a machine-local venv.
- **Outbound two-way call**: `node converse.js --call <userid>` dials an accepted friend for a full conversation (Rio's conversational listener was inbound-only except for its `--offline-call` flag, which is still accepted as an alias).
- **Persona and policy**: the agent is Noor, Wei Li's personal assistant. The verified owner (Wei) gets a general assistant; other accepted friends get the Beagle explainer scope Rio used as an ambassador. Rio's ambassador FAQ/grounding text was rewritten to state Noor's facts, including that Noor's live call is not yet validated.
- **Identity**: Noor reuses the existing `~/.agentnet` Carrier identity (the Beagle CLI shares it): address `Sw1d4dJQVyxC1VY1RyqcBg5oc8z7HgGT4r4qMpWBXDozt8BaEJ3s`, userid `CoHMW66WT5Qwuuyxpun3urBKkCry8SgDCDkpsJorTGuu`.
