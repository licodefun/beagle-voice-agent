#!/bin/bash
# One-time setup for Noor's Beagle voice agent on THIS host.
# The host must have ordinary UDP egress (a Mac, a Linux box, a VPS).
# Muse's own VM blocks outbound UDP, so do not expect live calls there.
set -eu
cd "$(dirname "$0")"

echo "== checks =="
command -v node >/dev/null || { echo "install Node.js 20+ first"; exit 1; }
node -e "process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)" || { echo "Node.js 20+ required"; exit 1; }
command -v ffmpeg >/dev/null || { echo "install ffmpeg first (brew install ffmpeg / apt install ffmpeg)"; exit 1; }
command -v python3 >/dev/null || { echo "install python3 first"; exit 1; }
echo "node $(node --version), ffmpeg ok, python3 ok"

echo "== node dependencies (includes the Beagle CLI daemon, peer-webrtc, lan) =="
npm install

echo "== python worker venv (ASR / LLM host / TTS) =="
python3 -m venv .venv
.venv/bin/pip install --upgrade pip >/dev/null
.venv/bin/pip install -r requirements-local.lock

echo "== models (one-time download, ~1.6 GB total) =="
mkdir -p models/piper/en/en_US/lessac/low models/piper/zh/zh_CN/huayan/medium runtime
if [ ! -d models/whisper-base ]; then
  .venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("Systran/faster-whisper-base", local_dir="models/whisper-base")
snapshot_download("Qwen/Qwen2.5-1.5B-Instruct-GGUF", allow_patterns=["*q4_k_m.gguf"], local_dir="models/qwen-dl")
PY
  mv models/qwen-dl/*q4_k_m.gguf models/qwen2.5-1.5b-instruct-q4_k_m.gguf
  rm -rf models/qwen-dl
fi
# Piper voices
dl() { [ -f "$2" ] || curl -fL -o "$2" "https://huggingface.co/rhasspy/piper-voices/resolve/main/$1"; }
dl en/en_US/lessac/low/en_US-lessac-low.onnx models/piper/en/en_US/lessac/low/en_US-lessac-low.onnx
dl en/en_US/lessac/low/en_US-lessac-low.onnx.json models/piper/en/en_US/lessac/low/en_US-lessac-low.onnx.json
dl zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx models/piper/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx
dl zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json models/piper/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json

echo "== llama.cpp CPU runtime =="
if [ ! -x runtime/llama-b12211/llama-server ]; then
  echo "Download the official llama.cpp release for your OS from https://github.com/ggml-org/llama.cpp/releases (tag b12211 used by Rio),"
  echo "unpack it so that runtime/llama-b12211/llama-server exists, then re-run this script's remaining steps by hand."
  echo "(On macOS use the macos-arm64 or macos-x64 tarball; on Linux the ubuntu-x64 tarball.)"
fi

cat <<'NEXT'

Setup done. Next steps:
  1. Start the Beagle daemon (shares the ~/.agentnet identity):
       npx beagle            # local UI + API on http://localhost:8766
  2. Make friends (calls are friend-only):
       - Wei adds Noor in his Beagle app:  Sw1d4dJQVyxC1VY1RyqcBg5oc8z7HgGT4r4qMpWBXDozt8BaEJ3s
         then accept his request in the local UI (auto-accept is OFF), or
       - to reach Rio, send him a friend request and wait for him to accept:
         Rio's address: LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d
  3. First one-way test call to an accepted friend's userid:
       node agent.js call <userid> --say "Hi, this is Noor." --hold 60
  4. Two-way conversation (inbound listener; add --call <userid> to dial out):
       ./run-conversation.sh
       ./run-conversation.sh --call <userid>
NEXT
