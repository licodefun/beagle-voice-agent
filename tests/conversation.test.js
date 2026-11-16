import test from 'node:test';
import assert from 'node:assert/strict';
import {packetPlayer} from '../lib/playback.js';
import {TurnDetector,SerialQueue} from '../lib/turns.js';
import {ConversationSession,wavToPackets,pcmPeak,isSilentPcm} from '../lib/conversation.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const frame=(amp=0)=>{const b=Buffer.alloc(640);for(let i=0;i<640;i+=2)b.writeInt16LE(amp,i);return b;};
test('loop monotonic, bounded catch-up, stop resolves promise',async()=>{
 let tick,now=0,sent=0,cleared=0;const player=packetPlayer(()=>sent++,{now:()=>now,interval:f=>(tick=f,1),clear:()=>cleared++});
 const done=player.play([Buffer.from([1]),Buffer.from([2])],{loop:true});
 for(let n=0;n<1000;n++){now=n*20;tick();}assert.equal(sent,1000);now+=60000;tick();assert.equal(sent,1005);player.stop();await done;assert.equal(cleared,1);
});
test('finite playback and replacement settle all promises',async()=>{
 let tick;let count=0;const p=packetPlayer(()=>count++,{interval:f=>(tick=f,1),clear:()=>{}});
 const a=p.play([1,2]);const b=p.play([3]);await a;tick();await b;assert.equal(count,1);await p.play([]);
});
test('VAD silence and clicks rejected, speech endpoint bounded',()=>{
 const turns=[];const v=new TurnDetector(p=>turns.push(p));
 for(let i=0;i<100;i++)v.push(frame());v.push(frame(4000));for(let i=0;i<40;i++)v.push(frame());assert.equal(turns.length,0);
 for(let i=0;i<25;i++)v.push(frame(4000));for(let i=0;i<40;i++)v.push(frame());assert.equal(turns.length,1);assert(turns[0].length<50000);
});
test('VAD max turn and packet-gap endpoint',()=>{
 const turns=[];const v=new TurnDetector(p=>turns.push(p),{maxMs:1000});for(let i=0;i<100;i++)v.push(frame(2000),0);assert.equal(turns.length,2);
 for(let i=0;i<20;i++)v.push(frame(2000),100);v.tick(801);assert.equal(turns.length,3);
});
test('serial queue capacity and error recovery',async()=>{
 let release;const seen=[];const q=new SerialQueue(async n=>{seen.push(n);if(n===1)await new Promise(r=>release=r);else throw new Error('test');});
 assert(q.push(1));assert(q.push(2));assert(!q.push(3));release();await q.idle;assert.deepEqual(seen,[1,2]);q.close();assert(!q.push(4));
});
test('conversation serial ASR -> reply -> encoder -> awaited send, history kept',async()=>{
 const played=[];let requests=0;const src={play:async p=>{played.push(p);},stop:()=>{}};
 const backend={request:async d=>{requests++;assert.equal(d.op,'turn');return {text:'hello',language:'en',reply:'Hi Wei.',wav:Buffer.from('wav').toString('base64')};}};
 const s=new ConversationSession({src,backend,encode:async()=>[Buffer.from('opus')],muteTailMs:0});assert(s.submit(frame(1000)));assert(!s.submit(frame(1000)));await s.queue.idle;
 assert.equal(requests,1);assert.equal(played.length,1);assert.equal(s.history.length,2);s.close();assert(!s.submit(frame()));
});
test('echo gate drops mic audio during reply and tail; close ignores late model result',async()=>{
 let finish;const src={play:async()=>assert.fail('late send'),stop:()=>{}};
 const s=new ConversationSession({src,backend:{request:()=>new Promise(r=>finish=r)},encode:async()=>[1]});s.submit(frame(1000));assert(s.busy);assert(!s.submit(frame(1000)));s.close();finish({text:'a',reply:'b',wav:'eA=='});await s.queue.idle;assert.equal(s.history.length,0);
 const t=new ConversationSession({src,backend:{},now:()=>0});t.muteUntil=1000;assert(!t.submit(frame()));t.close();
});
test('model failure recovers without playing canned reply',async()=>{
 let errors=0;const s=new ConversationSession({src:{play:async()=>assert.fail(),stop:()=>{}},backend:{request:async()=>{throw new Error('ASR failed');}},log:tag=>{if(tag==='conversation error')errors++;}});s.submit(frame(1000));await s.queue.idle;assert(!s.busy);assert.equal(errors,1);s.close();
});
test('actual WAV -> Opus -> decoder -> PCM -> VAD speech pipeline, muted feedback not submitted',async()=>{
 const {execFileSync}=await import('node:child_process');
 const wav=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','48000','-ac','1','-f','wav','pipe:1']);
 const packets=await wavToPackets(wav);let requests=0;
 const s=new ConversationSession({src:{play:async()=>{},stop:()=>{}},backend:{request:async()=>{requests++;return {text:''};}},now:()=>0,muteTailMs:0});
 for(const p of packets)s.receive(p);s.vad.flush();await s.queue.idle;assert.equal(requests,1);
 s.busy=true;for(const p of packets)s.receive(p);s.vad.flush();assert.equal(requests,1);s.close();
});
test('real werift source emits sequenced Opus RTP and stops finite playback',async()=>{
 const {makeAudioSource}=await import('../lib/engine.js');const src=makeAudioSource();const rtp=[];
 src.track.onReceiveRtp.subscribe(p=>rtp.push(p));
 const packets=[Buffer.from([0xf8,0xff,0xfe]),Buffer.from([0xf8,0xff,0xfe]),Buffer.from([0xf8,0xff,0xfe])];
 await src.play(packets);assert.equal(rtp.length,3);assert.equal(rtp[0].header.payloadType,111);
 assert.equal((rtp[1].header.sequenceNumber-rtp[0].header.sequenceNumber+65536)%65536,1);
 assert.equal((rtp[1].header.timestamp-rtp[0].header.timestamp)>>>0,960);src.stop();
});
test('offline route binds SDK-generated offer ID, preserves other Carrier calls',async()=>{
 const {CombinedSignaling}=await import('../lib/offline-signaling.js');const s=new CombinedSignaling('http://unused','self',()=>{});const sent=[];
 s.daemon={send:async(p,sig)=>sent.push('carrier:'+sig.callId),stop:()=>{}};
 s.bridge={sendSignal:async(p,data)=>{sent.push('socket');return {pushed:true};},connected:true,close:()=>{}};
 let actual;s.outboundPeer='wei';s.onOutboundId=id=>actual=id;
 await s.send('wei',{type:'offer',callId:'Actual-ID',sdp:'sdp'});assert.equal(actual,'Actual-ID');
 await s.send('wei',{type:'candidate',callId:'ACTUAL-ID',candidate:'x'});
 await s.send('other',{type:'offer',callId:'other-id',sdp:'sdp'});
 assert.deepEqual(sent,['socket','socket','carrier:other-id']);s.stop();
});
test('450ms endpoint preserves internal pauses; emits monotonic timeline metadata',()=>{
 let turn;const v=new TurnDetector((pcm,meta)=>turn={pcm,meta});for(let n=0;n<20;n++)v.push(frame(3000),n*20);
 for(let n=0;n<15;n++)v.push(frame(),400+n*20);assert(!turn);
 for(let n=0;n<15;n++)v.push(frame(3000),700+n*20);v.tick(1429);assert(!turn);v.tick(1430);assert(turn);assert.equal(turn.meta.lastVoiceAt,980);assert(turn.meta.voicedMs>=600);
});
test('fast PCM WAV encoder rejects malformed or overlong inputs safely',async()=>{
 const {pcmWavToOpus}=await import('../lib/wav-opus.js');assert.throws(()=>pcmWavToOpus(Buffer.alloc(20)),/not PCM WAV/);
});
test('per-turn telemetry measures actual first source RTP with worker stages',async()=>{
 const {makeAudioSource}=await import('../lib/engine.js');const src=makeAudioSource();const logs=[];
 const s=new ConversationSession({src,backend:{request:async()=>({text:'hello',reply:'Hello Wei.',wav:'eA==',stages:{asrMs:11,llmMs:22,ttsMs:3}})},encode:async()=>[Buffer.from([0xf8,0xff,0xfe])],log:(...a)=>logs.push(a),muteTailMs:0});
 try{s.submit(frame(2000));await s.queue.idle;const entry=logs.find(a=>a[0]==='LATENCY_FIRST_RTP');assert(entry);const result=JSON.parse(entry[1]);assert.equal(result.asrMs,11);assert(result.endpointToFirstRtpMs>=0);assert.equal(result.turn,1);}finally{s.close();}
});
test('remote accept/answer starts one answered-call budget, case-insensitive',async()=>{
 const {CombinedSignaling}=await import('../lib/offline-signaling.js');const {EventEmitter}=await import('node:events');const {PW}=await import('../lib/engine.js');
 const s=new CombinedSignaling('http://unused','self',()=>{});s.daemon={onSignal:()=>{},stop:()=>{}};s.bridge=new EventEmitter();s.bridge.close=()=>{};let notifications=0;let handled=0;s.onRemoteAnswered=id=>{assert.equal(id,'call-id');notifications++;};s.onSignal(()=>handled++);
 for(const signal of [{type:'action',action:'accept',callId:'CALL-ID'},{type:'answer',callId:'call-id',sdp:'v=0'}])s.bridge.emit('signal',{userid:'wei',data:PW.encodeSignal(signal)});
 assert.equal(notifications,1);assert.equal(handled,2);s.stop();
});
test('incoming/outgoing hard call budget cannot extend beyond 180s and cleans once',async()=>{
 const {CallBudget}=await import('../lib/call-budget.js');let tick,delay,cleared=0;const expired=[];
 const b=new CallBudget(id=>expired.push(id),{set:(fn,ms)=>(tick=fn,delay=ms,1),clear:()=>cleared++});
 b.start('INCOMING');assert.equal(delay,180000);tick();tick();assert.deepEqual(expired,['incoming']);
 b.start('PENDING-OUTGOING');b.start('OUTGOING',170000);assert.equal(delay,170000);b.stop();tick();assert.deepEqual(expired,['incoming']);assert(cleared>0);
 b.start('test',999999);assert.equal(delay,180000);b.stop();
});

test('live conversation path records caller audio and reply audio to files',async()=>{
 const {mkdtempSync,existsSync,readFileSync,readdirSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'bva-record-'));
 const wav=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','48000','-ac','1','-f','wav','pipe:1']);
 const packets=await wavToPackets(wav);
 const s=new ConversationSession({src:{play:async()=>{},stop:()=>{}},backend:{request:async()=>({text:'hello',language:'en',reply:'Hi Wei.',wav:Buffer.from('RIFFxxxx').toString('base64')})},encode:async()=>[Buffer.from([0xf8,0xff,0xfe])],now:()=>0,muteTailMs:0,recordDir:dir,callId:'TESTCALL123'});
 for(const p of packets)s.receive(p);
 s.vad.flush();await s.queue.idle;
 s.close();
 const files=readdirSync(dir);
 assert(files.some(f=>f.endsWith('-wei.ogg')));
 assert(files.some(f=>f.endsWith('-wei.wav')));
 assert(files.some(f=>f.includes('-noor-turn1.wav')));
 assert(existsSync(join(dir,'call-TESTCALL123.json')));
 const manifest=JSON.parse(readFileSync(join(dir,'call-TESTCALL123.json'),'utf8'));
 assert.equal(manifest.turns.length,1);assert.equal(manifest.turns[0].transcript,'hello');assert.equal(manifest.turns[0].reply,'Hi Wei.');
});
test('greeting plays pre-rendered packets once, never calls backend, busy-gates then releases',async()=>{
 let plays=0;const src={play:async p=>{plays++;assert(p.length>0);await sleep(5);},stop:()=>{}};
 let backendCalls=0;const s=new ConversationSession({src,backend:{request:async()=>{backendCalls++;}},encode:async()=>[Buffer.from('g1'),Buffer.from('g2')],muteTailMs:0});
 await s.greet(performance.now());assert.equal(plays,1);assert.equal(backendCalls,0);assert(!s.busy);assert(s.greeted);
 await s.greet(performance.now());assert.equal(plays,1);s.close();
});
test('greeting deferred while busy does not consume the one-shot',async()=>{
 let plays=0;const src={play:async()=>{plays++;},stop:()=>{}};
 const s=new ConversationSession({src,backend:{},encode:async()=>[Buffer.from('g')],muteTailMs:0});
 s.busy=true;await s.greet(performance.now());assert.equal(plays,0);assert(!s.greeted);
 s.busy=false;await s.greet(performance.now());assert.equal(plays,1);s.close();
});

test('endCall result fires onEndCall once, after the closing reply plays; absent flag never fires',async()=>{
 let ended=0,played=0;
 const mk=(withFlag)=>new ConversationSession({src:{play:async()=>{played++;},stop:()=>{}},backend:{request:async()=>({text:'好的 你關掉吧',language:'zh',reply:'好的，我先挂了，再见。',wav:Buffer.from('RIFFxxxx').toString('base64'),...(withFlag?{endCall:true}:{}),stages:{}})},encode:async()=>[Buffer.from([1])],muteTailMs:0,onEndCall:()=>{ended++;}});
 const s=mk(true); s.submit(frame(1000)); await s.queue.idle; assert.equal(played,1); assert.equal(ended,1); s.close();
 const t=mk(false); t.submit(frame(1000)); await t.queue.idle; assert.equal(played,2); assert.equal(ended,1); t.close();
});

test('pcmPeak and isSilentPcm: silence fast-paths, speech energy does not',()=>{
 assert.equal(pcmPeak(Buffer.alloc(100)),0);
 const loud=Buffer.alloc(200); loud.writeInt16LE(5000,10); assert.equal(pcmPeak(loud),5000);
 assert(isSilentPcm(Buffer.alloc(200))); assert(!isSilentPcm(loud));
});
test('near-silent turn plays the pre-rendered prompt and never calls the backend',async()=>{
 let backendCalls=0,played=0;
 const s=new ConversationSession({src:{play:async()=>{played++;},stop:()=>{}},backend:{request:async()=>{backendCalls++;throw new Error('backend must not be called for a silent turn');}},encode:async()=>[Buffer.from([1])],muteTailMs:0});
 s.submit(Buffer.alloc(32000)); await s.queue.idle;
 assert.equal(backendCalls,0); assert.equal(played,1); s.close();
});

import {CombinedSignaling} from '../lib/offline-signaling.js';
import {PW as PW2} from '../lib/engine.js';
function fakeSignaling(){const s=Object.create(CombinedSignaling.prototype);s.log=()=>{};s.ids=new Set();s.inbound=new Set();s.answers=new Set();s.preAccepted=new Set();s.pendingAccepts=new Map();s.offersSeen=new Set();s.acceptResent=new Set();s.awaitingAnswer=new Set();s.candidateQueue=new Map();s.sent=[];s.bridgeHandlers={};s.bridge={connected:true,sendSignal:async(peer,data)=>{s.sent.push(PW2.decodeSignal(data));return{pushed:false};},forgetCall(){},on:(ev,f)=>{s.bridgeHandlers[ev]=f;}};s.daemon={send:async()=>{},onSignal(){}};return s;}
test('doorbell pre-accept suppresses the engine trailing accept',async()=>{
 const s=fakeSignaling();const cid='ABC-123';
 await s.sendAccept('peer1',cid,['audio']);
 await s.send('peer1',{type:'action',action:'accept',callId:cid,options:['audio']});
 assert.equal(s.sent.filter(x=>x.action==='accept').length,1);
});
test('doorbell accept resent once when the caller (re)joins before offering',async()=>{
 const s=fakeSignaling();const cid='DEF-456';s.onSignal(()=>{});
 await s.sendAccept('peer1',cid,['audio']);
 const online=()=>s.bridgeHandlers.signal({userid:'peer1',data:PW2.encodeSignal({type:'event',event:'online',callId:cid})});
 online();await sleep(10);online();await sleep(10);
 assert.equal(s.sent.filter(x=>x.action==='accept').length,2);
 s.bridgeHandlers.signal({userid:'peer1',data:PW2.encodeSignal({type:'offer',callId:cid,sdp:'x'})});
 online();await sleep(10);
 assert.equal(s.sent.filter(x=>x.action==='accept').length,2);
});
test('candidates are held until the answer is sent, then flushed and resent',async()=>{
 const s=fakeSignaling();const cid='GH-789';s.ids.add(cid.toLowerCase());s.onSignal(()=>{});
 s.bridgeHandlers.signal({userid:'peer1',data:PW2.encodeSignal({type:'offer',callId:cid,sdp:'x'})});
 await s.send('peer1',{type:'candidate',callId:cid,candidate:'cand1'});
 assert.equal(s.sent.filter(x=>x.type==='candidate').length,0);
 await s.send('peer1',{type:'answer',callId:cid,sdp:'y'});
 assert.deepEqual(s.sent.map(x=>x.type),['answer','candidate']);
 await sleep(400);
 assert.equal(s.sent.filter(x=>x.type==='candidate').length,2);
 await s.send('peer1',{type:'candidate',callId:cid,candidate:'cand2'});
 assert.equal(s.sent.filter(x=>x.type==='candidate').length,3);
});
