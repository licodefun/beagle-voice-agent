// Regression fixtures from live call 9f36a3a6 (2026-11-12 round-2 retest):
// the model answered turns 2-6 with ONE identical canned sentence, turn 1
// with the verbatim identity template, and the end-call turn with the wrong
// object ("我会关闭Beagle"). Wei's turns were demo side-conversation from a
// meeting — fragmentary inputs are the point of the fixture.
// Run against the shared worker service by default (production path), or
// BVA_WORKER_PORT=off for an isolated private (cold) worker.
import {LocalBackend} from '../lib/local-backend.js';
const TURNS = [
"That's right. Beagle, Beagle",
'但這個代碼是我給了他我的那個API然後他自己就去併尼巴那就開發出來了',
'他給了那台電腦所以他給了那台',
'對,他自己開發的',
'不不 天使在做demo他打到我的那个软件上了',
'他還以為我在跟他對話所以他把我們的話聽去了',
'好的 你關掉吧 我現在在開會',
];
const OWNER = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
const norm = s => (s || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:"“”‘’'()（）\[\]\-—…·]/g, '');
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
let failures = 0;
try {
await backend.ready;
console.log('transport:', backend.transport);
const callId = 'fixture-9f36a3a6-' + Date.now();
const history = [];
let prev = null;
for (let i = 0; i < TURNS.length; i++) {
const r = await backend.request({op:'chat', text:TURNS[i], history, trustedPeerId:OWNER, callId});
const reply = r.reply || '';
console.log(`turn ${i+1} llm=${Math.round(r.stages?.llmMs || 0)}ms guard=${r.repeatGuard || '-'} endCall=${!!r.endCall} reply=${reply}`);
if (prev!== null && norm(reply) && norm(reply) === norm(prev)) { console.log(`FAIL: turn ${i+1} repeats turn ${i} verbatim`); failures++;}
if (i === 0 && reply.trim() === "I'm Noor, Wei Li's AI assistant, answering voice calls on Beagle.") { console.log('FAIL: turn 1 parrots the identity template'); failures++;}
if (i === TURNS.length - 1) {
if (!reply.includes('挂')) { console.log('FAIL: closing reply does not mention hanging up'); failures++;}
if (reply.includes('关闭')) { console.log('FAIL: closing reply still says 关闭 (wrong object)'); failures++;}
if (!r.endCall) { console.log('FAIL: closing turn missing endCall flag'); failures++;}
}
prev = reply;
history.push({role:'user', content:TURNS[i]}, {role:'assistant', content:reply});
}
} finally { backend.close();}
console.log(failures? `check-repeat: ${failures} FAILURE(S)`: 'check-repeat: PASS');
process.exit(failures? 1: 0);
