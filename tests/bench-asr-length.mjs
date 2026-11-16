// Does ASR cost scale with clip length, or is it a fixed ~30 s window cost?
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
const backend=new LocalBackend({env:{BVA_PROFILE:'fast'},log:()=>{}});
try{
 await backend.ready;
 const full=execFileSync('ffmpeg',['-v','error','-i','tests/fixtures/latency-en.wav','-ar','16000','-ac','1','-f','s16le','pipe:1']);
 const variants={
  '1.0s': full.subarray(0,32000),
  '3.5s(full)': full,
  '10s(padded)': Buffer.concat([full,Buffer.alloc(16000*2*6.5)]),
 };
 for(const [name,pcm] of Object.entries(variants))await backend.request({op:'asr',pcm:pcm.toString('base64')}); // warmup
 for(const [name,pcm] of Object.entries(variants)){
  const ts=[];
  for(let n=0;n<2;n++){const r=await backend.request({op:'asr',pcm:pcm.toString('base64')});ts.push(Math.round(r.stages.asrMs));}
  console.log(name, ts.join(', '));
 }
}finally{backend.close();}
