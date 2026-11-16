#!/usr/bin/env python3
"""Replay call ba397e13's recorded audio through ASR configs.

Two audio variants:
- clean16k: the 48k recording resampled properly to 16k (what the offline
  transcription used).
- live8k: an emulation of what the live pipeline actually fed whisper —
  conversation.js averages every 24-byte window of the 48k stereo decode
  into ONE sample, producing an 8 kHz stream that the worker then treats
  as 16 kHz (2x speed/pitch). If this variant reproduces the live garbling
  under live settings, the downsample is a root cause, not just decoding.
"""
import io, json, subprocess, sys, time
import numpy as np
import av
from faster_whisper import WhisperModel

WAV = 'records/call-ba397e13-d4f9-45fb-a9d7-699f86ac-wei.wav'
KNOWN = ['诶，这下挺快的', '你好像没听懂我说什么', '我没有祝福你啊', '不对，那你挂掉吧', 'You can hang up now']

def load_clean16k(path):
    container = av.open(path)
    resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
    chunks = []
    for frame in container.decode(audio=0):
        for c in resampler.resample(frame): chunks.append(c.to_ndarray().reshape(-1))
    for c in resampler.resample(None): chunks.append(c.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype(np.float32)

def load_live8k(path):
    # 48k stereo int16 -> session boxcar: one sample per 12 int16 values.
    raw = subprocess.run(['ffmpeg','-v','error','-i',path,'-ar','48000','-ac','2','-f','s16le','pipe:1'],
                         capture_output=True, check=True).stdout
    s = np.frombuffer(raw, dtype='<i2').astype(np.float32)
    n = (len(s) // 12) * 12
    return (s[:n].reshape(-1, 12).mean(axis=1) / 32768.0).astype(np.float32)

def speech_spans(audio, rate=16000, min_silence=0.45, thresh=0.012, min_speech=0.3):
    frame = 320  # 20 ms
    spans, start, silence = [], None, 0.0
    for i in range(0, len(audio) - frame, frame):
        rms = float(np.sqrt(np.mean(audio[i:i+frame] ** 2)))
        t = i / rate
        if rms >= thresh:
            if start is None: start = t
            silence = 0.0
        elif start is not None:
            silence += frame / rate
            if silence >= min_silence:
                if t - silence - start >= min_speech: spans.append((start, t - silence))
                start = None
    if start is not None: spans.append((start, len(audio) / rate))
    return spans

model = WhisperModel('models/whisper-small', device='cpu', compute_type='int8', cpu_threads=4)
clean = load_clean16k(WAV)
live = load_live8k(WAV)
spans = speech_spans(clean)
print('spans (s):', [(round(a,1), round(b,1)) for a, b in spans], flush=True)

CONFIGS = {
    'L_live(beam1,auto)': dict(beam_size=1, language=None, condition_on_previous_text=False),
    'B3(beam3,auto)': dict(beam_size=3, language=None, condition_on_previous_text=False),
    'B5(beam5,auto)': dict(beam_size=5, language=None, condition_on_previous_text=False),
    'B5+ZH(beam5,zh)': dict(beam_size=5, language='zh', condition_on_previous_text=False),
    'B5+ZH+CP': dict(beam_size=5, language='zh', condition_on_previous_text=True),
}
BASE = dict(vad_filter=True, hotwords='Noor, Wei Li, Beagle', temperature=0, without_timestamps=True, max_new_tokens=96)

def run(audio, rate_label, a, b, cfg):
    seg = audio[int(a * (8000 if rate_label == 'live8k' else 16000)):int(b * (8000 if rate_label == 'live8k' else 16000))]
    t0 = time.monotonic()
    segments, info = model.transcribe(seg, **{**BASE, **cfg})
    segments = [s for s in segments if s.no_speech_prob < .8 and s.avg_logprob > -1.2]
    text = ''.join(s.text for s in segments).strip()
    return text, info.language, round(time.monotonic() - t0, 2)

for variant, audio, cfgs in [('clean16k', clean, list(CONFIGS)), ('live8k', live, ['L_live(beam1,auto)', 'B5+ZH(beam5,zh)'])]:
    for name in cfgs:
        cfg = dict(CONFIGS[name])
        print(f"\n== {variant} / {name} ==", flush=True)
        total = 0.0
        for i, (a, b) in enumerate(spans):
            c = dict(cfg)
            if name.startswith('B5+ZH') and i == len(spans) - 1 and len(spans) >= 5:
                c['language'] = None  # tail span is the English line; lock would be wrong there
            text, lang, dt = run(audio, variant, a, b, c)
            total += dt
            known = KNOWN[i] if i < len(KNOWN) else ''
            print(f"  span{i+1} [{a:.1f}-{b:.1f}s] ({dt}s, det={lang}) heard: {text!r}  known: {known!r}", flush=True)
        print(f"  total decode time: {total:.1f}s", flush=True)
