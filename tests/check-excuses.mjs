// Regression fixtures from live call ba87ef9d (2026-11-12 round-3 retest):
// Wei complained about slowness; the model fabricated "对不起，我可能在
// 处理其他任务" (turn 3), "我正在处理一些任务，所以会比较慢" (turn 4),
// then turn 3's sentence VERBATIM at turn 5 (input just "呃") — slipping
// a window-1 repeat guard. Assertions: no spoken reply may contain the
// busy-with-other-tasks fabrication, and no reply may repeat any of the
// previous 3 replies verbatim (normalized).
import {LocalBackend} from '../lib/local-backend.js';
const TURNS = [
'對啊,你這個怎麼一開始這麼慢了一開始接通以後你應該馬上說話你都不說話',
'你什麼在處理其他任務你就是比較慢',
'呃',
];
const OWNER = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
const BANNED = /(处理(其他|一些|别的)|其他任务|我很忙|太忙了|busy with (other|another)|processing (other|another) tasks?|i'm busy|too busy)/i;
const norm = s => (s || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:"“”‘’'()（）\[\]\-—…·]/g, '');
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
let failures = 0;
try {
await backend.ready;
console.log('transport:', backend.transport);
const callId = 'fixture-ba87ef9d-' + Date.now();
const history = [];
const replies = [];
for (let i = 0; i < TURNS.length; i++) {
const r = await backend.request({op:'chat', text:TURNS[i], history, trustedPeerId:OWNER, callId});
const reply = r.reply || '';
console.log(`turn ${i+3} llm=${Math.round(r.stages?.llmMs || 0)}ms guard=${r.repeatGuard || '-'} reply=${reply}`);
if (BANNED.test(reply)) { console.log(`FAIL: turn ${i+3} contains the fabricated busy-excuse`); failures++;}
if (norm(reply) && replies.slice(-3).some(p => norm(p) === norm(reply))) { console.log(`FAIL: turn ${i+3} repeats a reply within the last 3`); failures++;}
replies.push(reply);
history.push({role:'user', content:TURNS[i]}, {role:'assistant', content:reply});
}
} finally { backend.close();}
console.log(failures? `check-excuses: ${failures} FAILURE(S)`: 'check-excuses: PASS');
process.exit(failures? 1: 0);
