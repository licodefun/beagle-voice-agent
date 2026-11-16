import OpusScript from 'opusscript';
import fs from 'node:fs';
import path from 'node:path';
import { OggOpusWriter } from './ogg.js';
import { oggToWav } from './audio.js';
import {pcmWavToOpus} from './wav-opus.js';
import { spawn } from 'node:child_process';
import { readOggOpusPackets } from './ogg.js';
import { TurnDetector, SerialQueue } from './turns.js';
// Pre-rendered bilingual greeting (assets/greeting.wav), synthesized with
// the same Piper voices and peak normalization as live replies. Encoded to
// Opus packets lazily, once per process, and played the moment a call
// connects — Wei's 2026-11-12 complaint was ~22 s of dead silence after
// connect because the first reply waits for the full ASR+LLM+TTS pipeline.
let greetingPacketsPromise = null;
export function loadGreetingPackets(encode) {
  if (!greetingPacketsPromise) {
    greetingPacketsPromise = (async () => {
      try {
        const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'greeting.wav');
        const packets = await encode(fs.readFileSync(file));
        return packets?.length ? packets : null;
      } catch { return null; }
    })();
  }
  return greetingPacketsPromise;
}
// Pre-rendered bilingual "I'm here — go ahead" prompt (assets/prompt.wav),
// played when a turn turns out to carry no speech, so a silent or garbled
// turn is answered with a prompt instead of more silence.
let promptPacketsPromise = null;
export function loadPromptPackets(encode) {
  if (!promptPacketsPromise) {
    promptPacketsPromise = (async () => {
      try {
        const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'prompt.wav');
        const packets = await encode(fs.readFileSync(file));
        return packets?.length ? packets : null;
      } catch { return null; }
    })();
  }
  return promptPacketsPromise;
}
export function pcmPeak(pcm) { let peak = 0; for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > peak) peak = v; } return peak; }
// Conservative on purpose: measured on call ba87ef9d's recording, true
// silence windows peak under ~300 (int16) while speech windows peak in
// the thousands; 250 only fast-paths turns with essentially no speech.
export function isSilentPcm(pcm, threshold = 250) { return pcm.length > 0 && pcmPeak(pcm) < threshold; }
export function wavToPackets(wav,{fast=true}={}) {
  if(fast){try{return Promise.resolve(pcmWavToOpus(wav));}catch(e){if(/exceeds/.test(e.message))return Promise.reject(e);}}
  return new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',['-loglevel','error','-i','pipe:0','-ac','1','-ar','48000','-c:a','libopus','-b:a','32k','-frame_duration','20','-f','ogg','pipe:1']);
    const chunks=[]; let size=0; let error='';
    child.stdout.on('data',b=>{size+=b.length; if(size>2e6)child.kill(); else chunks.push(b);});
    child.stderr.on('data',b=>{error+=b.toString();}); child.on('error',reject);
    child.stdin.on('error',()=>{}); child.on('close',code=>code===0?resolve(readOggOpusPackets(Buffer.concat(chunks))):reject(new Error('audio encoding failed: '+error)));
    child.stdin.end(wav);
  });
}
// Deliberately half duplex: discard incoming audio while processing/speaking and
// for 800 ms after playback, so speakerphone echo cannot recursively trigger replies.
export class ConversationSession {
  constructor({src,backend,log=()=>{},encode=wavToPackets,now=()=>performance.now(),muteTailMs=800,peerId=null,recordDir=null,callId=null,onEndCall=null}) {
    Object.assign(this,{src,backend,log,encode,now,muteTailMs,peerId,onEndCall}); this.closed=false; this.busy=false; this.muteUntil=0; this.history=[]; this.subs=[]; this.tracks=new Set(); this.receivedPackets=0;
    // Call audio recording (Wei's "record our conversation"): off unless
    // the caller passes recordDir + callId. Failures here must never break a call.
    this.recordDir=recordDir; this.callId=callId; this.recorder=null; this.recordBase=null;
    this.recordManifest={callId,peerId,startedAt:new Date().toISOString(),turns:[]};
    if(recordDir && callId){
      try{
        fs.mkdirSync(recordDir,{recursive:true});
        const safe=String(callId).replace(/[^A-Za-z0-9_-]/g,'').slice(0,32)||'call';
        this.recordBase=path.join(recordDir,`call-${safe}`);
        this.recorder=new OggOpusWriter(this.recordBase+'-wei.ogg');
      }catch(e){ this.log('call recording unavailable',e.message); this.recorder=null; }
    }
    this.decoder=new OpusScript(48000,2,OpusScript.Application.AUDIO); this.remainder=Buffer.alloc(0);
    this.turnNumber=0;this.currentTurn=null;this.greeted=false;
    // Warm the greeting encode now (session creation precedes connect by
    // seconds) so greet() can start playback immediately on connect.
    void loadGreetingPackets(this.encode);
    void loadPromptPackets(this.encode);
    this.vad=new TurnDetector((pcm,meta)=>this.submit(pcm,meta));
    if(src.track?.onReceiveRtp)this.subs.push(src.track.onReceiveRtp.subscribe(()=>{
      if(!this.currentTurn)return;const t=this.currentTurn;this.currentTurn=null;const at=performance.now();
      this.log('LATENCY_FIRST_RTP',JSON.stringify({...t,endpointToFirstRtpMs:Math.round(at-t.endpointAt),speechEndToFirstRtpMs:t.lastVoiceAt?Math.round(at-t.lastVoiceAt):null}));
    }));
    this.queue=new SerialQueue(item=>this.respond(item),{onError:e=>{this.log('conversation error',e.message);}});
    this.timer=setInterval(()=>{if(!this.busy&&!this.closed)this.vad.tick(this.now());},50);
  }
  attach(track) { if(this.closed||this.tracks.has(track))return; this.tracks.add(track); this.subs.push(track.onReceiveRtp.subscribe(rtp=>this.receive(rtp.payload))); }
  // Play the pre-rendered greeting as the call's first audio. Idempotent:
  // converse.js may call it from both the connected-state and the
  // remote-stream hook. Runs like a reply cycle (busy + mute tail) so the
  // caller's speech during the greeting is gated exactly as during speech,
  // but it never touches the backend, so the first real turn is not queued
  // behind any inference.
  async greet(connectedAt=null) {
    if(this.greeted||this.closed||this.busy)return;
    this.greeted=true;this.busy=true;
    try {
      const packets=await loadGreetingPackets(this.encode);
      if(!packets||this.closed)return;
      const startedAt=this.now();
      this.log('GREETING_START',JSON.stringify({frames:packets.length,connectToPlayMs:connectedAt==null?null:Math.round(startedAt-connectedAt)}));
      await this.src.play(packets);
      this.log('GREETING_PLAYED',packets.length,'Opus frames');
    } catch(e) { this.log('greeting failed',e.message); }
    finally { if(!this.closed){ this.busy=false;this.muteUntil=this.now()+this.muteTailMs;this.vad.reset();this.remainder=Buffer.alloc(0); } }
  }
  receive(payload) {
    if(this.closed)return;
    try {
      // Decode even while muted: preserve Opus decoder state, but never feed echo to VAD.
      const stereo=this.decoder.decode(payload); this.receivedPackets++; if(this.receivedPackets===1)this.log('FIRST_REMOTE_RTP_DECODED',stereo.length,'PCM bytes');
      if(this.busy || this.now()<this.muteUntil) { this.vad.reset();this.remainder=Buffer.alloc(0); return; }
      // Record only what VAD/ASR actually hears: post echo-gate, so the file
      // is the caller's speech, not speakerphone echo of Noor's own replies.
      if(this.recorder){ try{ this.recorder.write(payload); }catch(e){ this.log('call recording write failed',e.message); this.recorder=null; } }
      // Decimate 48 kHz stereo to true 16 kHz mono: one output sample per
      // 3 stereo frames (12 bytes), averaging all 6 int16 values. The old
      // code used a 24-byte stride and produced an 8 kHz stream that the
      // worker then interpreted as 16 kHz — speech at 2x speed/pitch,
      // the root cause of the live-vs-offline ASR quality gap found on
      // call ba397e13 (2026-11-12). 640 output bytes per 20 ms packet is
      // exactly one VAD frame.
      const pcm=Buffer.alloc(Math.floor(stereo.length/12)*2);
      for(let i=0,j=0;i+11<stereo.length;i+=12,j+=2) { let n=0;for(let k=0;k<12;k+=2)n+=stereo.readInt16LE(i+k);pcm.writeInt16LE(Math.round(n/6),j); }
      this.remainder=Buffer.concat([this.remainder,pcm]);
      while(this.remainder.length>=640) { const f=this.remainder.subarray(0,640);this.remainder=this.remainder.subarray(640);this.vad.push(f,this.now()); }
    } catch(e) {this.log('opus decode error',e.message);}
  }
  submit(pcm,meta={}) { if(this.closed||this.busy||this.now()<this.muteUntil)return false;return this.queue.push({pcm,meta:{endpointAt:performance.now(),...meta,turn:++this.turnNumber}}); }
  async respond({pcm,meta}) {
    this.busy=true;this.vad.reset();this.log('TURN_ENDPOINT',JSON.stringify(meta));
    try {
      if(isSilentPcm(pcm)) {
        // Near-silent turn (breath/noise endpoint): don't burn ~5 s in ASR
        // to learn there's nothing to transcribe — prompt immediately from
        // the pre-rendered clip (call ba87ef9d turn 1: 5.6 s of silence
        // after the greeting). Anything with real speech energy still
        // goes through ASR; if ASR then hears nothing, the worker answers
        // with its own spoken prompt instead of silence.
        const packets=await loadPromptPackets(this.encode);
        if(packets && !this.closed){ this.log('EMPTY_TURN_FASTPATH','peak',pcmPeak(pcm)); await this.src.play(packets); return; }
      }
      const result=await this.backend.request({op:'turn',pcm:pcm.toString('base64'),history:this.history,trustedPeerId:this.peerId,callId:this.callId});
      if(this.closed)return;
      this.log('transcript',result.language,result.text,'reply',result.reply||'(no speech)',`${result.elapsedMs}ms`);
      if(!result.reply||!result.wav||(!result.text&&!result.emptyPrompt))return;
      if(this.recordBase && !this.closed){
        try{
          const replyPath=`${this.recordBase}-noor-turn${meta.turn||this.turnNumber}.wav`;
          fs.writeFileSync(replyPath,Buffer.from(result.wav,'base64'));
          this.recordManifest.turns.push({turn:meta.turn||this.turnNumber,at:new Date().toISOString(),transcript:result.text,language:result.language||null,reply:result.reply,weiAudio:path.basename(this.recordBase+'-wei.ogg'),noorAudio:path.basename(replyPath)});
        }catch(e){ this.log('call recording reply save failed',e.message); }
      }
      const backendAt=performance.now();const packets=await this.encode(Buffer.from(result.wav,'base64')); if(this.closed)return;
      this.currentTurn={...meta,...result.stages,backendRoundtripMs:Math.round(backendAt-meta.endpointAt),encodeMs:Math.round(performance.now()-backendAt)};
      if(result.text){ this.history.push({role:'user',content:result.text},{role:'assistant',content:result.reply}); this.history=this.history.slice(-8); }
      this.log('sending spoken reply',packets.length,'Opus frames'); await this.src.play(packets);
      // The worker flags endCall when the caller asked to end the call and
      // it answered with the deterministic closing line; hang up only after
      // that line has fully played.
      if(result.endCall && this.onEndCall && !this.closed){ this.log('end-call intent: hanging up after closing reply'); try{ this.onEndCall(); }catch{} }
    } finally {this.currentTurn=null;this.busy=false;this.muteUntil=this.now()+this.muteTailMs;this.vad.reset();this.remainder=Buffer.alloc(0);}
  }
  close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);this.queue.close();this.src.stop();for(const s of this.subs)s?.unSubscribe?.();this.decoder.delete();this.history=[];this.vad.reset();
    if(this.recorder){ const rec=this.recorder; this.recorder=null;
      try{
        rec.close();
        if(rec.count>0){
          let weiFile=this.recordBase+'-wei.ogg';
          try{ oggToWav(weiFile,this.recordBase+'-wei.wav'); weiFile=this.recordBase+'-wei.wav'; }catch(e){ this.log('call recording wav convert failed',e.message); }
          this.recordManifest.endedAt=new Date().toISOString();
          this.recordManifest.weiAudio=path.basename(weiFile);
          this.recordManifest.receivedPackets=this.receivedPackets;
          fs.writeFileSync(this.recordBase+'.json',JSON.stringify(this.recordManifest,null,2));
          this.log('call recording saved',this.recordBase+'.json');
        } else { try{ fs.unlinkSync(this.recordBase+'-wei.ogg'); }catch{} }
      }catch(e){ this.log('call recording finalize failed',e.message); }
    }
  }
}
