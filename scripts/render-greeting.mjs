// Render assets/greeting.wav through the production TTS path (op:'tts'),
// so the greeting uses the same Piper voices and peak normalization as
// live replies. EN segment (lessac) + 0.3 s gap + ZH segment (huayan),
// concatenated at 48 kHz mono — the rate pcmWavToOpus resamples to anyway.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
try {
  await backend.ready;
  const en = await backend.request({op:'tts', text:"Hi, this is Noor — I'm here, go ahead."});
  const zh = await backend.request({op:'tts', text:'你好，我是 Noor，我在听，请说。'});
  if (!en.wav || !zh.wav) throw new Error('tts returned no wav');
  fs.mkdirSync('assets', {recursive:true});
  fs.writeFileSync('/tmp/greet-en.wav', Buffer.from(en.wav, 'base64'));
  fs.writeFileSync('/tmp/greet-zh.wav', Buffer.from(zh.wav, 'base64'));
  execFileSync('ffmpeg', ['-y','-v','error',
    '-i','/tmp/greet-en.wav','-i','/tmp/greet-zh.wav',
    '-filter_complex','[0:a]aresample=48000,apad=pad_dur=0.3[a0];[1:a]aresample=48000[a1];[a0][a1]concat=n=2:v=0:a=1,alimiter=limit=0.95[out]',
    '-map','[out]','-ac','1','-ar','48000','assets/greeting.wav']);
  console.log('assets/greeting.wav written');
} finally { backend.close(); }
