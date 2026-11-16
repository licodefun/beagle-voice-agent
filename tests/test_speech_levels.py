import io, unittest, wave
import numpy as np
from speech_levels import normalize_wav_bytes, cap_spoken

def make_wav(peak, seconds=0.5, rate=22050):
    n = int(rate * seconds)
    t = np.arange(n) / rate
    samples = (np.sin(2 * np.pi * 220 * t) * peak * 32767).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(samples.tobytes())
    return buf.getvalue()

def wav_stats(data):
    with wave.open(io.BytesIO(data), 'rb') as wav:
        frames = wav.readframes(wav.getnframes())
    s = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32767
    return float(np.max(np.abs(s))), float(np.sqrt(np.mean(s ** 2)))

class NormalizeTests(unittest.TestCase):
    def test_never_exceeds_ceiling(self):
        for peak in (0.2, 0.5, 0.95, 1.0):
            out_peak, _ = wav_stats(normalize_wav_bytes(make_wav(peak)))
            self.assertLessEqual(out_peak, 0.96)

    def test_quiet_signal_gets_much_louder(self):
        _, rms_in = wav_stats(make_wav(0.2))
        _, rms_out = wav_stats(normalize_wav_bytes(make_wav(0.2)))
        self.assertGreater(rms_out, rms_in * 2.5)

    def test_full_scale_bulk_raised_without_clipping(self):
        # Piper-like case: peaks already at ~1.0 but the bulk is quiet.
        _, rms_in = wav_stats(make_wav(0.95))
        out_peak, rms_out = wav_stats(normalize_wav_bytes(make_wav(0.95)))
        self.assertGreater(rms_out, rms_in * 1.15)
        self.assertLessEqual(out_peak, 0.96)

    def test_silence_unchanged(self):
        data = make_wav(0.0)
        self.assertEqual(normalize_wav_bytes(data), data)

    def test_very_quiet_stays_quiet(self):
        # Peak-stage gain is capped at +12 dB; make-up adds only 1.5x.
        out_peak, _ = wav_stats(normalize_wav_bytes(make_wav(0.01)))
        self.assertLess(out_peak, 0.065)

    def test_garbage_passthrough(self):
        self.assertEqual(normalize_wav_bytes(b'not a wav'), b'not a wav')

class CapTests(unittest.TestCase):
    def test_short_reply_unchanged(self):
        self.assertEqual(cap_spoken('Sure, I can help with that.'), 'Sure, I can help with that.')
        self.assertEqual(cap_spoken('好的，我会尽力提高音量。'), '好的，我会尽力提高音量。')

    def test_long_english_cut_at_clause_boundary(self):
        text = 'Beagle is a private messaging and agent network, ' * 6 + 'and it keeps identity on your device.'
        out = cap_spoken(text)
        self.assertLessEqual(len(out), 130)
        self.assertFalse(out.endswith(','))

    def test_long_chinese_capped(self):
        text = '我们这次通话能说多久取决于通话双方的意愿' * 4
        out = cap_spoken(text)
        self.assertLessEqual(len(out), 32)

if __name__ == '__main__':
    unittest.main()
