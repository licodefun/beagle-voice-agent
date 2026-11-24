#!/usr/bin/env python3
"""Persistent CPU-only ASR/LLM/TTS, JSON-lines on private stdin/stdout. No network inference."""
import os, sys, json, base64, wave, io, time, re
from pathlib import Path
FAST = os.environ.get('BVA_PROFILE', 'fast') != 'baseline'
THREADS = int(os.environ.get('BVA_THREADS', '4' if FAST else '2'))
os.environ.setdefault('OMP_NUM_THREADS', str(THREADS))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
import numpy as np
from faster_whisper import WhisperModel
import subprocess, socket, urllib.request, urllib.error, http.client, signal, atexit
from piper import PiperVoice
from local_policy import bilingual_choice, completed_sentence, spoken_sentences, is_repeat_of_recent, repeat_fallback
from speech_levels import normalize_wav_bytes, cap_spoken
from grounding import owner_allowed, current_clock, clock_intent, clock_reply, contextual_system, call_system, fix_self_name, story_intent, endcall_intent, closing_reply, latency_excuse_repair, hearing_claim_repair, text_reply_repair, identity_intent, identity_reply, stack_intent, stack_reply
from beagle_faq import beagle_topic, scope_redirect, pricing_question, unknown_pricing
ROOT = Path(__file__).resolve().parent
MODELS = ROOT / 'models'
ASR_BEAM = int(os.environ.get('BVA_ASR_BEAM', '5' if FAST else '3'))
# Per-call language lock: auto-detect on a call's first turn, then pin the
# language for the rest of the call. Per-segment auto-detect was one of the
# live-ASR weaknesses versus the offline lock that transcribed Wei cleanly.
# Only engaged for requests carrying a callId; one-shot requests (voice
# notes, benches) never read or write the lock.
_lang_lock = {'callId': None, 'language': None}
# Per-peer language prior (latency round 5): auto-detect costs a second
# encoder pass (~+2.3 s measured on the fixtures) and only ever runs on
# a call's first turn. Remember each peer's last confidently detected
# language and force it on their next call's first turn; a forced decode
# that hears nothing falls back to auto-detect once (see below).
_PEER_LANG_PATH = ROOT / 'out' / 'peer-lang.json'
def _load_peer_lang():
    try:
        raw = json.loads(_PEER_LANG_PATH.read_text())
        return {k: v for k, v in raw.items() if isinstance(v, dict) and v.get('last') in ('en', 'zh')}
    except Exception: return {}
_peer_lang = _load_peer_lang()
def _learn_peer_lang(peer, lang):
    if not peer or lang not in ('en', 'zh'): return
    rec = _peer_lang.setdefault(peer, {'last': lang, 'seen': []})
    changed = rec.get('last') != lang or lang not in rec.get('seen', [])
    rec['last'] = lang
    if lang not in rec['seen']: rec['seen'].append(lang)
    if changed:
        try:
            _PEER_LANG_PATH.parent.mkdir(exist_ok=True)
            _PEER_LANG_PATH.write_text(json.dumps(_peer_lang))
        except Exception: pass
# ---- 4090 GPU API (Wei's home RTX 4090; OpenAI-style; key in .gpu-key) ----
# Primary per stage when its flag is on; the local CPU stack stays loaded
# and is the fallback for ANY GPU failure (a 503 gpu_busy mid-call means
# Wei's own job has the card — the local model answers, never a wait).
# Warm bench 2026-11-16: ASR ~1.2 s vs ~3.0 s local; qwen2.5:7b chat
# ~0.7 s per short reply vs ~3-5 s local; qwen3tts ~6 s per sentence vs
# Piper ~1 s, so GPU TTS defaults OFF. qwen3 thinking is disabled with
# top-level reasoning_effort:"none" (HQ-verified 2026-11-16; think:false
# does NOT work on this route) — qwen3:14b is the live reply model.
# Second tier: Wei's Mac mini (mini.beagle.chat) with qwen3:8b + whisper
# large-v3, used per stage when the 4090 fails (503 gpu_busy / down),
# before the local CPU stack. Active only when .gpu-key-mini exists.
# The remote whispers have no hotwords; a prompt field carrying the
# names is sent, passthrough unverified — local whisper keeps its
# hotword advantage on names if the prompt is ignored.
GPU_BASE = os.environ.get('BVA_GPU_BASE', 'https://4090.beagle.chat/v1')
GPU_ASR = os.environ.get('BVA_GPU_ASR', '0') == '1'
GPU_LLM = os.environ.get('BVA_GPU_LLM', '0') == '1'
GPU_TTS = os.environ.get('BVA_GPU_TTS', '0') == '1'
GPU_LLM_MODEL = os.environ.get('BVA_GPU_LLM_MODEL', 'qwen2.5:7b')
_GPU_KEY = None
def _tts_text(text, lang):
    # Wei (2026-11-16): in Chinese, read 4090 digit by digit —
    # 四零九零 — not as the number four thousand ninety.
    if lang == 'zh' and text:
        return text.replace('4090', '四零九零')
    return text

def _gpu_key():
    global _GPU_KEY
    if _GPU_KEY is None:
        try: _GPU_KEY = (ROOT / '.gpu-key').read_text().strip()
        except Exception: _GPU_KEY = os.environ.get('BVA_GPU_KEY', '')
    return _GPU_KEY
MINI_BASE = os.environ.get('BVA_MINI_BASE', 'https://mini.beagle.chat/v1')
MINI_LLM_MODEL = os.environ.get('BVA_MINI_LLM_MODEL', 'qwen3:8b')
MINI_ON = os.environ.get('BVA_MINI', '1') == '1'
_MINI_KEY = None
def _mini_key():
    global _MINI_KEY
    if _MINI_KEY is None:
        try: _MINI_KEY = (ROOT / '.gpu-key-mini').read_text().strip()
        except Exception: _MINI_KEY = os.environ.get('BVA_MINI_KEY', '')
    return _MINI_KEY
# Third remote tier (Wei, 2026-11-19): Google Gemini 4 Hydrogen on the
# free tier of the Gemini API, through Google's OpenAI-compatible
# endpoint (Bearer key — the same _remote_post helper the GPU hosts
# use). FIRST for TEXT chat ops only: measured 10-16 s per reply, fine
# for texts but far too slow mid-call, so voice turns skip this tier
# entirely and keep the 4090 primary (Wei's split decision, 2026-11-19).
# Hydrogen generates no audio and has no Live API, so ASR/TTS never
# route here either.
# The free tier is rate-limited; a 429 is an HTTP error, so chat_any
# falls through to the 4090 exactly like a gpu_busy 503. Key lives in
# .gemini-key (chmod 600), same pattern as .gpu-key — never in code.
GEMINI_BASE = os.environ.get('BVA_GEMINI_BASE', 'https://generativelanguage.googleapis.com/v1beta/openai')
GEMINI_MODEL = os.environ.get('BVA_GEMINI_MODEL', 'gemini-4-hydrogen')
GEMINI_ON = os.environ.get('BVA_GEMINI', '1') == '1'
_GEMINI_KEY = None
def _gemini_key():
    global _GEMINI_KEY
    if _GEMINI_KEY is None:
        try: _GEMINI_KEY = (ROOT / '.gemini-key').read_text().strip()
        except Exception: _GEMINI_KEY = os.environ.get('BVA_GEMINI_KEY', '')
    return _GEMINI_KEY
_gpu_http = urllib.request.build_opener(urllib.request.ProxyHandler())
_CONN_ERRORS = (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError)
def _remote_post(base, key, path, data, ctype, timeout):
    # Retry ONCE on a connection-level failure (no HTTP status received):
    # the gateways in front of the GPU hosts recycle kept-alive
    # connections, and reusing a dead one surfaces as RemoteDisconnected
    # ('Remote end closed connection without response') — a fresh attempt
    # succeeds. HTTP errors (e.g. 503 gpu_busy) are NOT retried: they
    # fall through to the caller's fallback immediately. Transcription
    # and chat requests are safe to repeat. (HQ, 2026-11-17.)
    for attempt in (1, 2):
        req = urllib.request.Request(base + path, method='POST', data=data)
        req.add_header('Authorization', 'Bearer ' + key); req.add_header('Content-Type', ctype)
        try:
            with _gpu_http.open(req, timeout=timeout) as resp: return resp.read()
        except urllib.error.HTTPError:
            raise
        except _CONN_ERRORS:
            if attempt == 2: raise
        except urllib.error.URLError as e:
            if attempt == 2 or not isinstance(e.reason, _CONN_ERRORS): raise
    raise RuntimeError('unreachable')
def _gpu_post(path, data, ctype, timeout):
    return _remote_post(GPU_BASE, _gpu_key(), path, data, ctype, timeout)
def _mini_post(path, data, ctype, timeout):
    return _remote_post(MINI_BASE, _mini_key(), path, data, ctype, timeout)
def _gemini_post(path, data, ctype, timeout):
    return _remote_post(GEMINI_BASE, _gemini_key(), path, data, ctype, timeout)
class _GpuSeg:
    __slots__ = ('text', 'no_speech_prob', 'avg_logprob')
    def __init__(self, text): self.text, self.no_speech_prob, self.avg_logprob = text, 0.0, 0.0
class _GpuInfo:
    def __init__(self, language):
        self.language = language; self.language_probability = 1.0 if language else 0.0; self.all_language_probs = []
def _gpu_transcribe(audio, language, post=_gpu_post):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes())
    b = '----bva' + str(int(time.time() * 1000))
    fields = [('model', 'whisper'), ('response_format', 'verbose_json'), ('prompt', 'Noor, Wei Li, Beagle, Rio')]
    if language: fields.append(('language', language))
    raw = b''
    for name, val in fields: raw += f'--{b}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n'.encode()
    raw += f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + buf.getvalue() + b'\r\n' + f'--{b}--\r\n'.encode()
    d = json.loads(post('/audio/transcriptions', raw, f'multipart/form-data; boundary={b}', 30))
    text = (d.get('text') or '').strip()
    lang = d.get('language') or language
    segs = [_GpuSeg(sg.get('text', '')) for sg in (d.get('segments') or [])] or ([_GpuSeg(text)] if text else [])
    return segs, _GpuInfo(lang)
_ASR_BACKEND = {'last': 'local'}
def transcribe_any(audio, **kw):
    if GPU_ASR and _gpu_key():
        try:
            segs, info = _gpu_transcribe(audio, kw.get('language'))
            _ASR_BACKEND['last'] = 'gpu'; return segs, info
        except Exception as e:
            print(f'[gpu] asr fallback: {e}', file=sys.stderr)
    if MINI_ON and _mini_key():
        try:
            segs, info = _gpu_transcribe(audio, kw.get('language'), post=_mini_post)
            _ASR_BACKEND['last'] = 'mini'; return segs, info
        except Exception as e:
            print(f'[mini] asr fallback: {e}', file=sys.stderr)
    _ASR_BACKEND['last'] = 'local'
    return asr.transcribe(audio, **kw)

# Last spoken reply per call, for the anti-repeat guard (call 9f36a3a6:
# the model returned one identical canned sentence five turns in a row).
_last_reply = {}
def emit(x):
    print(json.dumps(x, ensure_ascii=False), flush=True)
try:
    asr = WhisperModel(os.environ.get('BVA_ASR_MODEL', str(MODELS/'whisper-small')), device='cpu', compute_type='int8', cpu_threads=THREADS)
    # Never honor HTTP_PROXY for private loopback inference.
    local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # Official local CPU runtime. Loopback HTTP only; nothing leaves this box.
    sock = socket.socket(); sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]; sock.close()
    server = subprocess.Popen([str(ROOT/'runtime/llama-b12211/llama-server'), '-m',os.environ.get('BVA_LLM_MODEL',str(MODELS/'qwen2.5-1.5b-instruct-q4_k_m.gguf')), '--host','127.0.0.1','--port',str(port),'-c','4096','-t',str(THREADS),'-np','1','--log-disable'],stdout=sys.stderr,stderr=sys.stderr)
    def cleanup(*_):
        if server.poll() is None:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
    atexit.register(cleanup)
    def terminate(*_):
        cleanup(); os._exit(0)
    signal.signal(signal.SIGTERM,terminate)
    for _ in range(200):
        if server.poll() is not None: raise RuntimeError('local llama server exited')
        try:
            with local_http.open(f'http://127.0.0.1:{port}/health',timeout=1) as response:
                if response.status == 200: break
        except Exception: time.sleep(.1)
    else: raise RuntimeError('local llama server startup timed out')
    def chat(messages, sentence_limit=1):
        # cache_prompt MUST stay true: sending it as false measured ~10x
        # slower per turn on this llama-server build (33 s vs 3-4 s), and
        # omitting it entirely was also slower than true.
        body = json.dumps({'messages':messages,'max_tokens':96 if sentence_limit>1 else (56 if FAST else 96),'temperature':0 if FAST else .35,'stream':FAST,'cache_prompt':True}).encode()
        request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/chat/completions',data=body,headers={'Content-Type':'application/json'})
        with local_http.open(request,timeout=70) as response:
            if not FAST: return json.load(response)['choices'][0]['message']['content'].strip()[:350]
            # Only speak a completed model-generated sentence, never an acknowledgement placeholder.
            text = ''
            for line in response:
                if not line.startswith(b'data: '): continue
                if line.strip() == b'data: [DONE]': break
                chunk = json.loads(line[6:]); choices = chunk.get('choices',[])
                if not choices: continue
                text += choices[0].get('delta',{}).get('content','') or ''
                # Wait for whitespace after a period, to avoid truncating decimals.
                sentence = completed_sentence(text)
                if sentence:
                    if sentence_limit == 1: return sentence
                    rest = text[len(sentence):].lstrip()
                    next_sentence = completed_sentence(rest)
                    if next_sentence: return sentence+' '+next_sentence
            return text.strip()[:550 if sentence_limit>1 else 300]
    voices = {}
    for lang, rel in [('en','en/en_US/lessac/low/en_US-lessac-low.onnx'),('zh','zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx')]:
        voices[lang] = PiperVoice.load(MODELS/'piper'/rel)
    _LLM_BACKEND = {'last': 'local'}
    def _remote_chat(post, model, messages):
        payload = {'model': model, 'messages': messages, 'max_tokens': 160, 'temperature': 0.3}
        if 'gemini' in model:
            # Hydrogen always thinks and thinking tokens count as
            # output — 160 would starve the visible reply. chat_any
            # caps the returned text anyway. Thinking must be LOW:
            # at the default level a short voice reply took >30 s
            # through this route and timed out (2026-11-19); low
            # measured 10-16 s.
            payload['max_tokens'] = 512
            payload['reasoning_effort'] = 'low'
        if 'qwen3' in model:
            # Thinking MUST be off for voice turns: qwen3's reasoning
            # otherwise eats the whole token budget and the caller hears
            # nothing. HQ verified this switch 2026-11-16 (think:false
            # does NOT work on this route).
            payload['reasoning_effort'] = 'none'
        d = json.loads(post('/chat/completions', json.dumps(payload).encode(), 'application/json', 30))
        return (d['choices'][0]['message'].get('content') or '').strip()
    def chat_any(messages, sentence_limit=1, gemini_first=True):
        cap = 550 if sentence_limit > 1 else 300
        if gemini_first and GEMINI_ON and _gemini_key():
            try:
                content = _remote_chat(_gemini_post, GEMINI_MODEL, messages)
                if content:
                    _LLM_BACKEND['last'] = 'gemini'
                    return content[:cap]
            except Exception as e:
                print(f'[gemini] chat fallback: {e}', file=sys.stderr)
        if GPU_LLM and _gpu_key():
            try:
                content = _remote_chat(_gpu_post, GPU_LLM_MODEL, messages)
                if content:
                    _LLM_BACKEND['last'] = 'gpu'
                    return content[:cap]
            except Exception as e:
                print(f'[gpu] chat fallback: {e}', file=sys.stderr)
        if MINI_ON and _mini_key():
            try:
                content = _remote_chat(_mini_post, MINI_LLM_MODEL, messages)
                if content:
                    _LLM_BACKEND['last'] = 'mini'
                    return content[:cap]
            except Exception as e:
                print(f'[mini] chat fallback: {e}', file=sys.stderr)
        _LLM_BACKEND['last'] = 'local'
        return chat(messages, sentence_limit)
    _TTS_BACKEND = {'last': 'local'}
    def synthesize(reply, lang):
        reply = _tts_text(reply, lang)
        # Normalized wav bytes: GPU qwen3tts when enabled (bench says
        # slower than Piper today — flag off by default), else Piper.
        # Any GPU failure falls back to Piper.
        if GPU_TTS and _gpu_key():
            try:
                body = json.dumps({'model': 'qwen3tts', 'voice': 'neutral-zh' if lang == 'zh' else 'neutral-en', 'input': reply, 'response_format': 'wav'}).encode()
                raw = _gpu_post('/audio/speech', body, 'application/json', 20)
                if raw[:4] == b'RIFF':
                    _TTS_BACKEND['last'] = 'gpu'; return normalize_wav_bytes(raw)
            except Exception as e:
                print(f'[gpu] tts fallback: {e}', file=sys.stderr)
        _TTS_BACKEND['last'] = 'local'
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav: voices[lang].synthesize_wav(reply, wav)
        return normalize_wav_bytes(output.getvalue())
    # Readiness is emitted after profile-specific warmup below.
except Exception as e:
    emit({'ready':False,'error':str(e)}); sys.exit(1)
SYSTEM = ('You are Noor, Wei Li\'s voice assistant on Beagle. Reply to what the caller actually says, '
          'using at most two short sentences in the caller\'s language, English or Chinese. '
          'Your input is transcribed microphone audio already received on this call. Do not claim you cannot hear when you have intelligible speech. '
          'If words are garbled, ask for a repeat instead of inventing connection problems. '
          'Do not invent facts or claim actions you cannot perform. You have no tools or internet. '
          'You cannot change settings or send messages. Ask a short clarification if speech is unclear. '
          'Never identify as a model provider. Do not output stage directions or role labels.')
if FAST:
    SYSTEM = ("You are Noor, Wei Li's personal voice assistant, speaking on the Beagle network. "
              "Your name is Noor, NOT Beagle. 你的名字是Noor，不是Beagle，也不是Noor的助手。 "
              "Answer the caller's actual question in ONE brief useful sentence (under 20 words, or under 30 Chinese characters) in their language, English or Chinese. "
              "Use facts from the preceding dialogue, never echo the question. 结合前文事实直接回答，不要复述问题。 "
              "Only introduce yourself when asked who you are. Do not preface answers with filler. "
              "You have no tools or internet; never invent facts or actions. "
              "You already received their speech transcript. If unclear ask them to repeat, not claim audio failure.")


try:
    if FAST:
        for lang, phrase in [('en','Hello Noor.'),('zh','你好，Noor。')]:
            output = io.BytesIO()
            with wave.open(output,'wb') as wav: voices[lang].synthesize_wav(phrase,wav)
            import av
            # Decode/resample the warmup WAV locally.
            container = av.open(io.BytesIO(output.getvalue()))
            resampler = av.AudioResampler(format='s16',layout='mono',rate=16000)
            chunks = []
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame): chunks.append(converted.to_ndarray().reshape(-1))
            for converted in resampler.resample(None): chunks.append(converted.to_ndarray().reshape(-1))
            container.close()
            audio = np.concatenate(chunks).astype(np.float32)/32768
            segments, _ = asr.transcribe(audio,language=lang,beam_size=1,temperature=0,without_timestamps=True,vad_filter=True)
            list(segments)
        chat([{'role':'system','content':contextual_system(None)},{'role':'user','content':'What is Beagle?'}])
        # End warmup on the CALL prompt: llama's single slot retains the
        # last prefix, and a call's first turn is the most latency-sensitive
        # request this worker serves. The ring-time 'warm' op re-primes
        # with the actual peer's prompt variant per call.
        chat([{'role':'system','content':call_system(None)},{'role':'user','content':'你好'}])
    emit({'ready':True,'profile':'fast' if FAST else 'baseline','threads':THREADS})
except Exception as e:
    emit({'ready':False,'error':str(e)});sys.exit(1)

def handle_request(req):
    try:
        started = time.monotonic(); op = req.get('op','turn')
        if op == 'warm':
            # Ring-time warm-up: prime llama's prompt cache with THIS
            # peer's call system prompt so the call's first turn doesn't
            # pay a cold re-eval (call ba87ef9d turn 2: llmMs 11,690 on a
            # "warm" service whose slot held another prefix).
            wsys = call_system(req.get('trustedPeerId')) if FAST else SYSTEM
            chat([{'role':'system','content':wsys},{'role':'user','content':'你好'}])
            return {'id':req.get('id'),'warmed':True,'stages':{'llmMs':round((time.monotonic()-started)*1000,2)}}
        text = req.get('text',''); language = req.get('language')
        if op in ('asr','turn'):
            audio = np.frombuffer(base64.b64decode(req['pcm']),dtype='<i2').astype(np.float32)/32768
            if audio.size > 16000*20: raise ValueError('audio exceeds 20 second limit')
            options = dict(beam_size=ASR_BEAM,condition_on_previous_text=False,vad_filter=True,hotwords='Noor, Wei Li, Beagle')
            if FAST: options.update(temperature=0,without_timestamps=True,max_new_tokens=96)
            call_id = req.get('callId')
            if call_id and call_id != _lang_lock['callId']:
                _lang_lock.update(callId=call_id, language=None)
            locked = _lang_lock['language'] if call_id else None
            peer_key = req.get('trustedPeerId')
            forced = None
            if FAST and call_id and locked is None and not language and peer_key:
                rec = _peer_lang.get(peer_key) or {}
                last, seen = rec.get('last'), rec.get('seen', [])
                if last == 'zh': forced = 'zh'
                elif last == 'en' and 'zh' not in seen: forced = 'en'
            decode_language = language or locked or forced
            segments, info = transcribe_any(audio, language=decode_language, **options)
            if FAST and not decode_language and info.language not in ('en','zh'):
                # Short Chinese/English turns sometimes score Japanese first. Decode
                # once in the strongest supported language, or ignore very weak noise.
                allowed = bilingual_choice(info.language,info.all_language_probs)
                if allowed is None: segments = []
                else: segments, info = transcribe_any(audio,language=allowed,**options)
            segments = [s for s in segments if s.no_speech_prob < .8 and s.avg_logprob > -1.2]
            text = ''.join(s.text for s in segments).strip()
            if call_id:
                if forced is not None and (not text or (forced == 'zh' and not any('\u4e00' <= c <= '\u9fff' for c in text))):
                    # The prior guessed wrong (or the turn was noise):
                    # a zh-forced decode of English speech comes back in
                    # Latin script with no CJK — the script check catches
                    # what confidence scores cannot. Fall back to
                    # auto-detect once; the lock/prior update below
                    # re-learns from the retry's detection.
                    retry_segments, retry_info = transcribe_any(audio, language=None, **options)
                    retry_segments = [s for s in retry_segments if s.no_speech_prob < .8 and s.avg_logprob > -1.2]
                    retry_text = ''.join(s.text for s in retry_segments).strip()
                    if retry_text:
                        segments, info, text = retry_segments, retry_info, retry_text
                if locked is None and text and info.language in ('en','zh') and getattr(info,'language_probability',0) >= .5:
                    _lang_lock['language'] = info.language
                    _learn_peer_lang(peer_key, info.language)
                elif locked is not None and not text:
                    # The locked language heard nothing (caller may have
                    # switched language): retry once unlocked, re-lock if
                    # the retry detects a supported language confidently.
                    retry_segments, retry_info = transcribe_any(audio, language=None, **options)
                    retry_segments = [s for s in retry_segments if s.no_speech_prob < .8 and s.avg_logprob > -1.2]
                    retry_text = ''.join(s.text for s in retry_segments).strip()
                    if retry_text:
                        segments, info, text = retry_segments, retry_info, retry_text
                        if retry_info.language in ('en','zh') and getattr(retry_info,'language_probability',0) >= .5:
                            _lang_lock['language'] = retry_info.language
                            _learn_peer_lang(peer_key, retry_info.language)
            language = info.language
            if FAST and language not in ('en','zh'): language = None
        asr_done = time.monotonic()
        result = {'id':req['id'],'text':text,'language':language,'profile':'fast' if FAST else 'baseline','stages':{'asrMs':round((asr_done-started)*1000,2),'asrBackend':_ASR_BACKEND['last'] if op in ('asr','turn') else 'n/a'}}
        if op != 'asr' and text:
            if op == 'tts': reply = text
            else:
                history = req.get('history',[])[-4:]
                trusted_peer = req.get('trustedPeerId')
                # Live call turns (callId present) use the compact call
                # prompt; other surfaces keep the full ambassador prompt.
                system = (call_system(trusted_peer) if req.get('callId') else contextual_system(trusted_peer)) if FAST else SYSTEM
                messages = [{'role':'system','content':system}] + [{'role':m['role'],'content':str(m['content'])[:140]} for m in history if m.get('role') in ('user','assistant')]
                messages += [{'role':'user','content':text[:400]}]
                story = story_intent(text)
                def finalize(raw):
                    # Enforce the voice brevity contract even when a small
                    # model ignores it. Idempotent: safe to re-apply.
                    r = hearing_claim_repair(latency_excuse_repair(fix_self_name(raw)), text)
                    ss = spoken_sentences(r)
                    lim = 2 if story or not FAST or (ss and len(ss[0].strip()) < 8) else 1
                    r = ''.join(ss[:lim]).strip()[:550 if story else 300]
                    return cap_spoken(r) if FAST else r
                if owner_allowed(trusted_peer) and clock_intent(text,history):
                    clock=current_clock();reply=clock_reply(text,clock);result['clock']=clock;result['replySource']='read-only-clock'
                elif pricing_question(text) and beagle_topic(text,history):
                    reply=unknown_pricing(text);result['replySource']='documented-unknown-pricing'
                elif req.get('callId') and identity_intent(text):
                    # The commonest call question; its grounded answer
                    # is a fixed line, so skip the model entirely
                    # (FD21CD4F: the LLM took 3.6-5.7 s to produce it).
                    reply=identity_reply(text);result['replySource']='identity-deterministic'
                elif req.get('callId') and stack_intent(text):
                    # Asked about the model/GPU switch itself: the model
                    # cannot know it was rewired (call 4B927E01 answered
                    # 'no update notice received' / 'nothing updated' to
                    # exactly this, minutes after the GPU went live).
                    reply=stack_reply(text);result['replySource']='stack-deterministic'
                elif req.get('callId') and endcall_intent(text):
                    # Caller asked to end the call: deterministic closing
                    # with the right object (the call, not "Beagle" — the
                    # model answered "我会关闭Beagle" on call 9f36a3a6), and
                    # the session hangs up after playing it (endCall flag).
                    reply=closing_reply(text);result['replySource']='call-closing';result['endCall']=True
                elif not beagle_topic(text,history) and not owner_allowed(trusted_peer):
                    reply=scope_redirect(text);result['replySource']='scope-redirect'
                else:
                    reply=finalize(chat_any(messages,sentence_limit=2 if story else 1,gemini_first=(op=='chat')));result['replySource']='local-model-grounded' if owner_allowed(trusted_peer) else 'local-model-public'
                    call_id = req.get('callId')
                    recent = _last_reply.get(call_id) or []
                    if FAST and call_id and is_repeat_of_recent(recent, reply):
                        # Anti-repeat guard (call 9f36a3a6 parrot loop;
                        # window widened to the last 3 replies after call
                        # ba87ef9d repeated its turn-3 excuse at turn 5):
                        # regenerate once with an explicit nudge; if it
                        # still repeats, break the loop with a brief
                        # acknowledgment instead of a third parroting.
                        nudged = [dict(messages[0], content=messages[0]['content'] + '\nIMPORTANT: your previous reply repeated your earlier answer word for word. Answer the caller\'s newest words directly, in a different way; never repeat that sentence.')] + messages[1:]
                        retry = finalize(chat_any(nudged, sentence_limit=2 if story else 1, gemini_first=(op=='chat')))
                        if is_repeat_of_recent(recent, retry):
                            reply = repeat_fallback(text); result['repeatGuard'] = 'fallback'
                        else:
                            reply = retry; result['repeatGuard'] = 'regenerated'
                reply = finalize(reply)
                if op == 'chat':
                    # Typed text cannot be misheard (see grounding.py
                    # text_reply_repair): a chat reply must never claim
                    # a hearing failure, whatever the model produced.
                    repaired = text_reply_repair(reply, text)
                    if repaired != reply:
                        reply = repaired; result['misheardGuard'] = 'text-fallback'
                if req.get('callId') and reply:
                    _recent = _last_reply.setdefault(req['callId'], [])
                    _recent.append(reply); del _recent[:-3]
            llm_done = time.monotonic()
            result['stages']['llmMs'] = round((llm_done-asr_done)*1000,2); result['stages']['llmBackend'] = _LLM_BACKEND['last']
            result['reply'] = reply
            if op != 'chat':
                lang = 'zh' if any('\u4e00'<=c<='\u9fff' for c in reply) else 'en'
                result['wav'] = base64.b64encode(synthesize(reply, lang)).decode()
                result['stages']['ttsMs'] = round((time.monotonic()-llm_done)*1000,2); result['stages']['ttsBackend'] = _TTS_BACKEND['last']
        elif op == 'turn':
            # ASR (including the unlocked retry) heard nothing intelligible:
            # never answer a turn with silence (call ba87ef9d turn 1 burned
            # 5.6 s and said nothing after the greeting). Speak a brief
            # prompt in the call's locked language; no LLM involved.
            hint = (_lang_lock['language'] if req.get('callId') else None) or language
            reply = '我在，你说。' if hint != 'en' else "I'm here — go ahead."
            result['replySource'] = 'empty-prompt'; result['emptyPrompt'] = True
            result['stages']['llmMs'] = 0
            result['reply'] = reply
            lang = 'zh' if any('\u4e00'<=c<='\u9fff' for c in reply) else 'en'
            result['wav'] = base64.b64encode(synthesize(reply, lang)).decode()
            result['stages']['ttsMs'] = round((time.monotonic()-asr_done)*1000,2); result['stages']['ttsBackend'] = _TTS_BACKEND['last']
        result['elapsedMs'] = round((time.monotonic()-started)*1000); return result
    except Exception as e:
        return {'id':req.get('id'),'error':str(e)}

if '--serve' in sys.argv:
    # Shared warm worker service: ONE ASR/LLM/TTS stack on this box, used by
    # the listener AND by outbound --call dialers. Before this, every dialer
    # spawned a second COLD stack beside the warm listener stack (call
    # 9f36a3a6: LLM stage 18.5 s cold, decaying, never reaching the warm
    # bench median, on 1.5 shared CPUs). Requests are serialized through a
    # single lock: whisper/llama are not thread-safe, and one inference at
    # a time is the right CPU policy here anyway. The ping handshake
    # reports this file's mtime as a build tag; clients fall back to a
    # private worker when the tag does not match their code on disk, so a
    # stale service can never silently serve old code.
    import socketserver, threading
    _port = int(sys.argv[sys.argv.index('--serve') + 1])
    _build = int(Path(__file__).stat().st_mtime)
    _lock = threading.Lock()
    class _Handler(socketserver.StreamRequestHandler):
        def handle(self):
            for raw in self.rfile:
                try: r = json.loads(raw)
                except Exception: continue
                if r.get('op') == 'ping':
                    out = {'id': r.get('id'), 'ready': True, 'build': _build, 'profile': 'fast' if FAST else 'baseline'}
                else:
                    with _lock: out = handle_request(r)
                try:
                    self.wfile.write((json.dumps(out, ensure_ascii=False) + '\n').encode()); self.wfile.flush()
                except Exception: return
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    # Daemon request threads: with the default (non-daemon), a client
    # holding its connection open (the listener does, permanently) blocks
    # interpreter exit forever after SIGTERM — the service wedged exactly
    # that way on 2026-11-12 (llama dead, socket closed, process immortal,
    # and every restart guard saw it as "already running").
    socketserver.ThreadingTCPServer.daemon_threads = True
    print(f'worker service listening on 127.0.0.1:{_port} build {_build}', file=sys.stderr, flush=True)
    with socketserver.ThreadingTCPServer(('127.0.0.1', _port), _Handler) as _srv:
        _srv.serve_forever()
else:
    for line in sys.stdin:
        try: _req = json.loads(line)
        except Exception: continue
        emit(handle_request(_req))
