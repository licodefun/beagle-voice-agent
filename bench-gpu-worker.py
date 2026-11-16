#!/usr/bin/env python3
"""Drive a PRIVATE local-worker.py (stdin mode) through fixture turns and
print per-stage timings + backend tags. Env flags pass through, e.g.:
  BVA_GPU_ASR=1 BVA_GPU_LLM=1 .venv/bin/python bench-gpu-worker.py
Run from the project root."""
import base64, io, json, os, subprocess, sys, wave

WEI = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh'

def pcm_b64(path):
    import av, numpy as np
    container = av.open(path)
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    chunks = []
    for frame in container.decode(audio=0):
        for converted in resampler.resample(frame): chunks.append(converted.to_ndarray().reshape(-1))
    for converted in resampler.resample(None): chunks.append(converted.to_ndarray().reshape(-1))
    container.close()
    return base64.b64encode(np.concatenate(chunks).astype('<i2').tobytes()).decode()

env = dict(os.environ)
proc = subprocess.Popen(['.venv/bin/python', 'local-worker.py'], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=open('/tmp/bench-worker.err', 'wb'), env=env, text=True)
def send(req):
    proc.stdin.write(json.dumps(req) + '\n'); proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line: raise RuntimeError('worker exited')
        d = json.loads(line)
        if d.get('id') == req['id'] or 'ready' in d: return d

first = send({'id': 'boot'})
print('worker ready:', first)
en = pcm_b64('tests/fixtures/latency-en.wav'); zh = pcm_b64('tests/fixtures/latency-zh.wav')
reqs = [
    ('EN turn (auto)', {'id': 't1', 'op': 'turn', 'pcm': en, 'trustedPeerId': WEI}),
    ('ZH turn (auto)', {'id': 't2', 'op': 'turn', 'pcm': zh, 'trustedPeerId': WEI}),
    ('EN turn again',  {'id': 't3', 'op': 'turn', 'pcm': en, 'trustedPeerId': WEI}),
    ('chat op (LLM only)', {'id': 't4', 'op': 'chat', 'text': 'What is Beagle?', 'trustedPeerId': WEI}),
]
for label, req in reqs:
    r = send(req)
    st = r.get('stages', {})
    print(f"{label}: text={r.get('text')!r} reply={str(r.get('reply'))[:60]!r}")
    print(f"   stages={st} elapsed={r.get('elapsedMs')}ms src={r.get('replySource')}")
proc.stdin.close(); proc.terminate()
