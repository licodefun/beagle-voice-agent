// LLM-stage bench on the verification call's REAL turns (op:'chat', so no
// ASR/TTS noise): replays transcripts with session-style history growth.
// Variants are selected by request shape / worker env:
//   default            -> full prompt (no callId), worker env as-is
//   CALLID=1           -> callId attached (slim call prompt once implemented)
//   BVA_CACHE_PROMPT=1 -> worker sends cache_prompt to llama-server
import {LocalBackend} from '../lib/local-backend.js';
const TURNS = [
  '嘿,你好',
  '你這次改了什麼?',
  '但是你的響应还是很慢我现在抗拓好像你至少要过五秒钟才会響应',
  '你不只等了五分鐘',
  '那现在我没啥说的话就挂了吧',
];
const OWNER = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:()=>{}});
try {
  await backend.ready;
  // Warmup turn (excluded): same shape as turn 1.
  await backend.request({op:'chat', text:'你好', history:[], trustedPeerId:OWNER, ...(process.env.CALLID ? {callId:'bench-call'} : {})});
  const history = [];
  const rows = [];
  for (const text of TURNS) {
    const r = await backend.request({op:'chat', text, history, trustedPeerId:OWNER, ...(process.env.CALLID ? {callId:'bench-call'} : {})});
    rows.push({llmMs: Math.round(r.stages.llmMs || 0), replyChars: (r.reply || '').length, reply: (r.reply || '').slice(0, 44)});
    history.push({role:'user', content:text}, {role:'assistant', content:r.reply || ''});
  }
  const med = Math.round(rows.map(r => r.llmMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)]);
  console.log(JSON.stringify({variant: process.env.CALLID ? 'callId(slim)' : 'full', cachePrompt: process.env.BVA_CACHE_PROMPT || '0', medianLlmMs: med, rows}, null, 1));
} finally { backend.close(); }
