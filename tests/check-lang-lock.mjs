// Functional check of the per-call language lock against the real worker:
// turn 1 (ZH fixture, callId X) auto-detects and locks; turn 2 (ZH again)
// decodes locked and fast; turn 3 (EN fixture, SAME callId) must recover
// English via the empty/low-yield retry path; turn 4 (new callId) is a
// fresh auto-detect.
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
const backend=new LocalBackend({env:{BVA_PROFILE:'fast'},log:()=>{}});
function pcm(file){
 const audio=execFileSync('ffmpeg',['-v','error','-i',file,'-ar','16000','-ac','1','-f','s16le','pipe:1']);
 let last=0;for(let i=0;i+640<=audio.length;i+=640){let power=0;for(let k=i;k<i+640;k+=2)power+=(audio.readInt16LE(k)/32768)**2;if(Math.sqrt(power/320)>=.012)last=i+640;}
 return audio.subarray(0,last).toString('base64');
}
const zh=pcm('tests/fixtures/latency-zh.wav'), en=pcm('tests/fixtures/latency-en.wav');
try{
 await backend.ready;
 const seq=[
  ['turn1 zh callA', zh, 'callA'],
  ['turn2 zh callA (locked)', zh, 'callA'],
  ['turn3 en callA (switch)', en, 'callA'],
  ['turn4 en callB (fresh)', en, 'callB'],
 ];
 for(const [name,p,id] of seq){
  const r=await backend.request({op:'turn',pcm:p,history:[],callId:id});
  console.log(name,'| lang',r.language,'| asrMs',Math.round(r.stages.asrMs),'| text',(r.text||'').slice(0,50));
 }
}finally{backend.close();}
