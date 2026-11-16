#!/bin/bash
# Start the shared warm worker service (local-worker.py --serve 8768): the
# single ASR/LLM/TTS stack used by the listener and by outbound dialers.
# Before this service existed, every --call dialer spawned a second COLD
# stack beside the warm listener stack (call 9f36a3a6, 2026-11-12).
cd /home/hatch/workspace/beagle-voice-agent || exit 1
export HOME=/home/hatch BVA_PROFILE=fast
# 4090 GPU API primary for ASR + LLM (Wei's go, 2026-11-16); local CPU
# stack stays loaded as per-stage fallback. GPU TTS stays OFF: qwen3tts
# measured ~6 s/sentence vs Piper ~1 s. BVA_GPU_TTS=1 enables it anyway.
export BVA_GPU_ASR=1 BVA_GPU_LLM=1 BVA_GPU_LLM_MODEL=qwen3:14b
if pgrep -f "local-worker.py --serve" >/dev/null 2>&1; then
  echo "worker service already running"
  exit 0
fi
setsid .venv/bin/python -u local-worker.py --serve 8768 >> out/worker-service.log 2>&1 < /dev/null &
echo "worker service starting"
