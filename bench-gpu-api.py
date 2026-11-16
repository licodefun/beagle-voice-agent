#!/usr/bin/env python3
"""Warm re-bench of the 4090 GPU API: ASR formats, TTS, chat models + think-off variants.
Run from the project root (needs .gpu-key + tests/fixtures). Prints timings only."""
import json, time, urllib.request, urllib.error, uuid, pathlib

key = pathlib.Path('.gpu-key').read_text().strip()
BASE = 'https://4090.beagle.chat/v1'

def post(path, data, ctype, timeout=180):
    r = urllib.request.Request(BASE + path, method='POST', data=data)
    r.add_header('Authorization', 'Bearer ' + key); r.add_header('Content-Type', ctype)
    t = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, time.time() - t, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, time.time() - t, e.read()

def asr(wav, fmt, lang=None):
    b = '----bench' + uuid.uuid4().hex
    fields = [('file', 'clip.wav', 'audio/wav', wav), ('model', None, None, b'whisper'),
              ('response_format', None, None, fmt.encode())]
    if lang: fields.append(('language', None, None, lang.encode()))
    raw = b''
    for name, fn, ct, val in fields:
        raw += f'--{b}\r\nContent-Disposition: form-data; name="{name}"'.encode()
        if fn: raw += f'; filename="{fn}"'.encode()
        raw += b'\r\n'
        if ct: raw += f'Content-Type: {ct}\r\n'.encode()
        raw += b'\r\n' + val + b'\r\n'
    raw += f'--{b}--\r\n'.encode()
    st, dt, body = post('/audio/transcriptions', raw, f'multipart/form-data; boundary={b}')
    try:
        d = json.loads(body)
        return st, dt, d.get('language'), str(d.get('text'))[:60]
    except Exception:
        return st, dt, None, body[:80]

def chat(model, extra=None, prompt='In one short sentence, what is Beagle?'):
    payload = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 400}
    if extra: payload.update(extra)
    st, dt, body = post('/chat/completions', json.dumps(payload).encode(), 'application/json')
    if st != 200: return st, dt, body[:100]
    d = json.loads(body); m = d['choices'][0]['message']
    return st, dt, f"content={str(m.get('content'))[:60]!r} reasoning_chars={len(m.get('reasoning') or '')} out_tokens={d.get('usage',{}).get('completion_tokens')}"

def tts(text, voice):
    st, dt, body = post('/audio/speech', json.dumps({'model': 'qwen3tts', 'voice': voice, 'input': text, 'response_format': 'wav'}).encode(), 'application/json')
    return st, dt, f'{len(body)} bytes' if st == 200 else body[:100]

en = pathlib.Path('tests/fixtures/latency-en.wav').read_bytes()
zh = pathlib.Path('tests/fixtures/latency-zh.wav').read_bytes()

print('--- ASR json + forced en (x2)')
for _ in range(2): print(' ', asr(en, 'json', 'en'))
print('--- ASR verbose_json auto (x2)')
for _ in range(2): print(' ', asr(en, 'verbose_json'))
print('--- ASR verbose_json zh forced (x1)')
print(' ', asr(zh, 'verbose_json', 'zh'))
print('--- TTS en (x2), zh (x1)')
for _ in range(2): print(' ', tts("Hi, I'm Noor. This is a voice test from the 4090.", 'neutral-en'))
print(' ', tts('你好，我是 Noor。这是一个语音测试。', 'neutral-zh'))
print('--- CHAT qwen2.5:7b (x2)')
for _ in range(2): print(' ', chat('qwen2.5:7b'))
print('--- CHAT qwen3:14b think-off variants')
print('  think=false:', chat('qwen3:14b', {'think': False}))
print('  chat_template_kwargs:', chat('qwen3:14b', {'chat_template_kwargs': {'enable_thinking': False}}))
print('  /no_think:', chat('qwen3:14b', None, 'In one short sentence, what is Beagle? /no_think'))
