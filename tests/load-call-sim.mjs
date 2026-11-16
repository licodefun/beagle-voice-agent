// Approximate the non-inference CPU of a live call: continuously decode
// the verification call's recorded Opus packets (the same decode the
// session receive path performs), for LOAD_SECONDS (default 240).
import fs from 'node:fs';
import OpusScript from 'opusscript';
import {readOggOpusPackets} from '../lib/ogg.js';
const packets = readOggOpusPackets(fs.readFileSync('records/call-c5a900df-118d-4f60-ab50-4ff4cbf0-wei.ogg'));
const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const until = Date.now() + (+(process.env.LOAD_SECONDS || 240)) * 1000;
let n = 0;
while (Date.now() < until) { for (const p of packets) { dec.decode(p); n++; } }
console.log('decoded', n, 'packets');
