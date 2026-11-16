// Cold/warm verification for the ring-time warm-up (call ba87ef9d turn 2:
// llmMs 11,690 on a service whose llama slot held another prefix).
// Usage (orchestrate service restarts around it):
//   node tests/check-warm.mjs cold    -> first request after a restart:
//                                       the retest's turn-2 fixture text
//   node tests/check-warm.mjs warmed  -> op 'warm' first (timed), then
//                                       the same turn: turn must be fast
import {LocalBackend} from '../lib/local-backend.js';
const OWNER = '7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
const TURN2 = '繼續改進 剛才不是說';
const mode = process.argv[2];
const backend = new LocalBackend({env:{BVA_PROFILE:'fast'}, log:(...a)=>console.error(...a)});
try {
  await backend.ready;
  console.log('transport:', backend.transport);
  if (mode === 'warmed') {
    const w = await backend.request({op:'warm', trustedPeerId:OWNER});
    console.log(`warm op: llm=${Math.round(w.stages?.llmMs || 0)}ms warmed=${!!w.warmed}`);
  }
  const r = await backend.request({op:'chat', text:TURN2, history:[], trustedPeerId:OWNER, callId:'fixture-warm-' + Date.now()});
  console.log(`turn-2 fixture (${mode}): llm=${Math.round(r.stages?.llmMs || 0)}ms reply=${(r.reply || '').slice(0, 40)}`);
} finally { backend.close(); }
