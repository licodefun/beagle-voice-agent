// Empty-turn fixture (call ba87ef9d turn 1): an unintelligible/silent turn
// must be answered with the worker's spoken prompt, never silence.
// Sends (1) 1.5 s of digital silence and (2) real speech (the zh latency
// fixture's PCM) as op:'turn' with a callId, through the shared service.
import fs from 'node:fs';
import {LocalBackend} from '../lib/local-backend.js';
const OWNER = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
let failures = 0;
try {
  await backend.ready;
  console.log('transport:', backend.transport);
  const callId = 'fixture-empty-' + Date.now();
  const silence = Buffer.alloc(16000 * 3); // 1.5 s of int16 zeros
  const r1 = await backend.request({op:'turn', pcm:silence.toString('base64'), history:[], trustedPeerId:OWNER, callId});
  console.log(`silence: elapsed=${r1.elapsedMs}ms emptyPrompt=${!!r1.emptyPrompt} reply=${r1.reply || '(none)'} wav=${r1.wav ? 'yes' : 'NO'}`);
  if (!r1.emptyPrompt) { console.log('FAIL: silence turn not flagged emptyPrompt'); failures++; }
  if (!r1.reply || !r1.wav) { console.log('FAIL: silence turn produced no spoken prompt'); failures++; }
  const speech = fs.readFileSync('tests/fixtures/speech-zh.pcm');
  const r2 = await backend.request({op:'turn', pcm:speech.toString('base64'), history:[], trustedPeerId:OWNER, callId});
  console.log(`speech: elapsed=${r2.elapsedMs}ms emptyPrompt=${!!r2.emptyPrompt} text=${r2.text || '(none)'} reply=${(r2.reply || '').slice(0, 30)}`);
  if (r2.emptyPrompt) { console.log('FAIL: real speech flagged emptyPrompt'); failures++; }
  if (!r2.text) { console.log('FAIL: real speech produced no transcript'); failures++; }
} finally { backend.close(); }
console.log(failures ? `check-empty: ${failures} FAILURE(S)` : 'check-empty: PASS');
process.exit(failures ? 1 : 0);
