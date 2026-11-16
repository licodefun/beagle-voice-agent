"""Spoken-reply shaping for the call path: loudness leveling and a hard
length cap. Kept separate from local-worker.py so the policies are
unit-testable without loading models."""
import io, wave
import numpy as np

def normalize_wav_bytes(data, max_gain_db=12.0, makeup=1.5, knee=0.7, ceiling=0.95):
    """Level a PCM16 WAV for call playback. Piper output already peaks at
    1.00, but the bulk of the speech sits low (median |sample| ~0.06,
    p90 ~0.3), which is why Wei heard the replies as 'a bit small':
    peak normalization alone changes nothing. So: (1) peak-normalize
    genuinely quiet renders toward full scale (gain capped at +12 dB so
    near-silence is not blown up); (2) apply a fixed make-up gain
    (~+3.5 dB) and bend only the loudest samples through a tanh soft
    limiter into a 0.95 ceiling — the bulk passes through purely gained
    and nothing hard-clips."""
    try:
        with wave.open(io.BytesIO(data), 'rb') as wav:
            params = wav.getparams(); frames = wav.readframes(wav.getnframes())
        if params.sampwidth != 2 or not frames: return data
        s = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
        if not s.size: return data
        peak = float(np.max(np.abs(s)))
        if peak <= 0: return data
        if peak < 0.99:
            s = s * min(0.99 / peak, 10 ** (max_gain_db / 20.0))
        y = s * makeup
        a = np.abs(y)
        over = a > knee
        if np.any(over):
            y = y.copy()
            y[over] = np.sign(y[over]) * (knee + (ceiling - knee) * np.tanh((a[over] - knee) / (ceiling - knee)))
        out = np.clip(y, -1.0, 1.0)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wav:
            wav.setparams(params); wav.writeframes((out * 32767).astype('<i2').tobytes())
        return buf.getvalue()
    except Exception:
        return data

def cap_spoken(text, en_chars=130, zh_chars=32):
    """Hard length cap for spoken call replies. One uncapped sentence cost
    13.2 s of LLM time and 8+ s of speech on 2026-11-12. Cut at the last
    clause boundary inside the cap when one exists past the halfway mark."""
    zh = sum(1 for c in text if '一' <= c <= '鿿')
    cap = zh_chars if zh * 2 > len(text) else en_chars
    if len(text) <= cap: return text
    cut = text[:cap]
    boundary = max(cut.rfind(sep) for sep in (',', '，', ';', '；', '、', ' '))
    if boundary >= cap // 2: cut = cut[:boundary]
    return cut.strip().rstrip(',，;；、')
