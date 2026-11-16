// Focused ASR/LLM stage bench: drives one throwaway worker directly.
// Env: BVA_THREADS (worker thread count), RUN_LLM=1 to include a model-path turn.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
const backend=new LocalBackend({env:{BVA_PROFILE:'fast'},log:()=>{}});
const inputs=[];
for(const language of ['en','zh']){
 const file=`tests/fixtures/latency-${language}.wav`;
 const audio=execFileSync('ffmpeg',['-v','error','-i',file,'-ar','16000','-ac','1','-f','s16le','pipe:1']);
 let last=0;for(let i=0;i+640<=audio.length;i+=640){let power=0;for(let k=i;k<i+640;k+=2)power+=(audio.readInt16LE(k)/32768)**2;if(Math.sqrt(power/320)>=.012)last=i+640;}
 inputs.push({language,pcm:audio.subarray(0,last),seconds:last/32000});
}
const median=a=>{const s=[...a].sort((x,y)=>x-y);return Math.round(s[Math.floor(s.length/2)]);};
try{
 await backend.ready;
 for(const input of inputs)await backend.request({op:'asr',pcm:input.pcm.toString('base64')}); // warmup
 const out={threads:process.env.BVA_THREADS||'(default)'};
 for(const input of inputs){
  const times=[];
  for(let n=0;n<3;n++){const r=await backend.request({op:'asr',pcm:input.pcm.toString('base64')});times.push(r.stages.asrMs);}
  out[input.language]={audioSec:input.seconds.toFixed(1),asrMs:times.map(Math.round),medianAsrMs:median(times)};
 }
 if(process.env.RUN_LLM){
  // Measure the real chat() path: synthesize a non-Beagle question with
  // Piper, feed the audio back as a turn from the owner (owner turns reach
  // the model; non-owner non-Beagle turns get the canned scope redirect).
  const OWNER='7yZfjNbbUwtQuHQzkAH87ditQUzULhjfPz1LYdRnsqwh';
  out.llm={};
  for(const [lang,text] of [['zh','你喜欢晴天还是雨天，为什么呢'],['en','Do you prefer sunny days or rainy days, and why?']]){
   const t=await backend.request({op:'tts',text});
   const pcm=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:Buffer.from(t.wav,'base64'),maxBuffer:1<<24});
   out.llm[lang]=[];
   for(let n=0;n<2;n++){
    const r=await backend.request({op:'turn',pcm:pcm.toString('base64'),history:[],trustedPeerId:OWNER});
    out.llm[lang].push({asrMs:Math.round(r.stages.asrMs),llmMs:Math.round(r.stages.llmMs||0),ttsMs:Math.round(r.stages.ttsMs||0),source:r.replySource,reply:(r.reply||'').slice(0,90)});
   }
  }
 }
 console.log(JSON.stringify(out,null,1));
}finally{backend.close();}
