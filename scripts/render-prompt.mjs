// Render assets/prompt.wav through the production TTS path (op:'tts'):
// the brief bilingual "I'm here — go ahead" prompt played when a turn
// carries no speech (session fast path). ZH segment (huayan) + 0.25 s
// gap + EN segment (lessac), concatenated at 48 kHz mono.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
try {
  await backend.ready;
  const zh = await backend.request({op:'tts', text:'我在，你说。'});
  const en = await backend.request({op:'tts', text:"I'm here — go ahead."});
  if (!en.wav || !zh.wav) throw new Error('tts returned no wav');
  fs.mkdirSync('assets', {recursive:true});
  fs.writeFileSync('/tmp/prompt-zh.wav', Buffer.from(zh.wav, 'base64'));
  fs.writeFileSync('/tmp/prompt-en.wav', Buffer.from(en.wav, 'base64'));
  execFileSync('ffmpeg', ['-y','-v','error',
    '-i','/tmp/prompt-zh.wav','-i','/tmp/prompt-en.wav',
    '-filter_complex','[0:a]aresample=48000,apad=pad_dur=0.25[a0];[1:a]aresample=48000[a1];[a0][a1]concat=n=2:v=0:a=1,alimiter=limit=0.95[out]',
    '-map','[out]','-ac','1','-ar','48000','assets/prompt.wav']);
  console.log('assets/prompt.wav written');
} finally { backend.close(); }
