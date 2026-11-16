#!/usr/bin/env node
// Inbound-only by default. --offline-call explicitly requests one SDK Socket.IO call.
import {PW,relayOnlyPeerConnectionFactory,makeAudioSource} from './lib/engine.js';
import {fetchRelayIceServers} from './lib/ice.js';
import {LocalBackend} from './lib/local-backend.js';
import {ConversationSession} from './lib/conversation.js';
import {CombinedSignaling} from './lib/offline-signaling.js';
import {DoorbellWatcher} from './lib/doorbell.js';
import {CallBudget} from './lib/call-budget.js';
import fs from 'node:fs';
import path from 'node:path';
const base=process.env.BEAGLE_URL||'http://localhost:8766';
const log=(...a)=>console.log(new Date().toISOString(),...a);
const backend=new LocalBackend({log}); let engine,signaling,active=null,session=null;let outbound=false,sawRinging=false,exitScheduled=false;const mediaPCs=new Set();
const budget=new CallBudget(id=>{if(active!==id)return;log('HARD_THREE_MINUTE_LIMIT',id);session?.close();for(const pc of mediaPCs)void pc.close();mediaPCs.clear();void engine.hangup(id).catch(e=>log('hangup failed',e.message));session=null;active=null;status();exitAfterCall();});
const statusPath=path.join(path.dirname(new URL(import.meta.url).pathname),'out/conversation-status.json');
function status(ready=true){const tmp=statusPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,ready,activeCall:active,profile:process.env.BVA_PROFILE||'fast',updatedAt:new Date().toISOString()}));fs.renameSync(tmp,statusPath);}
async function shutdown(){status(false);budget.stop();session?.close();if(active)await engine?.hangup(active).catch(()=>{});signaling?.stop();backend.close();process.exit(0);}
// A --call process is a one-shot dialer. Before this fix it stayed resident
// after its call ended — a second full listener with a second ASR/LLM/TTS
// stack, polling the same signaling (found live after the 2026-11-12 10:41
// call, still running an hour later). Exit once the outbound call is over.
function exitAfterCall(){if(!outbound||exitScheduled)return;exitScheduled=true;setTimeout(()=>{log('outbound call finished; dialer process exiting');void shutdown();},1500);}
// Locally-initiated end (caller asked to hang up; the worker's closing line
// has been played). Mirrors the budget-expiry teardown.
function endCallNow(reason){if(!active||active==='pending-outgoing')return;const id=active;log('ENDING_CALL',reason,id);budget.stop();session?.close();for(const pc of mediaPCs)void pc.close();mediaPCs.clear();void engine.hangup(id).catch(e=>log('hangup failed',e.message));session=null;active=null;status();exitAfterCall();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try {
 await backend.ready;
 const f=await fetch(base+'/api/friends-list').then(r=>r.json());
 const friends=new Set((f.friends||[]).filter(x=>x.accepted===true).map(x=>x.userid));
 if(!friends.size)throw new Error('no accepted friends; refusing to listen');
 const {relay}=await fetchRelayIceServers(base);
 // Per-call audio source: the CallEngine STOPS every localStream track
 // when a call ends (its #cleanup), so the old single shared source was
 // dead after the first call and the next call's answer died with
 // "track is ended" (live proof: CFEA190C ok, E8BD396D failed,
 // 2026-11-13). One source per call; engine and session share it.
 let callSrc=null;
 const freshSrc=()=>{callSrc=makeAudioSource();return callSrc;};
 const diag=await fetch(base+'/api/diag').then(r=>r.json());
 const selfId=diag?.data?.identity?.userid;if(!selfId)throw new Error('daemon self public userid unavailable');
 signaling=new CombinedSignaling(base,selfId,log);
 // Doorbell→room bridge (2026-11-13): a socket.io-channel inbound call
 // starts as a doorbellCall wake frame inside the daemon (the caller
 // sees us as offline and waits in the call's socket.io room). On a
 // friend's doorbell the listener joins that room, the caller re-sends
 // its offer on peer-join, and the normal incomingCall path answers.
 const doorbellPending=new Map();
 const clearDoorbellPending=(key,why)=>{const p=doorbellPending.get(key);if(!p)return;doorbellPending.delete(key);clearTimeout(p.timer);clearTimeout(p.acceptTimer);if(why){signaling.leaveSocketCall(p.callId);log('DOORBELL_DROPPED',p.callId,why);}};
 const joinDoorbell=async evt=>{
  const callId=evt.callId,peer=evt.from,key=callId?.toLowerCase();
  if(!callId||!peer||!key)return;
  if(evt.action==='decline'){clearDoorbellPending(key,'caller declined');return;}
  if(evt.action!=='call'||evt.isFriend!==true)return;
  if(doorbellPending.has(key)||active===key)return;
  if(active){log('DOORBELL_BUSY',callId,peer);return;}
  try{
   const current=await fetch(base+'/api/friends-list',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error('friend permission unavailable');return r.json();});
   if(!(current.friends||[]).some(f=>f.userid===peer&&f.accepted===true)){log('DOORBELL_NOT_FRIEND',callId,peer);return;}
  }catch(e){log('DOORBELL_FRIEND_CHECK_FAILED',callId,e.message);return;}
  void backend.request({op:'warm',trustedPeerId:peer}).catch(()=>{});
  const entry={callId,timer:null,acceptTimer:null};
  // Ring-first callers (iOS/Android, per HQ 2026-11-13): after the push
  // the phone joins the room and waits for an accept — it sends NO
  // offer until the callee accepts. Offer-first (JS/SDK) callers
  // re-send their offer the moment we join, well inside the grace
  // window, so they never see the accept. After the grace, send the
  // accept that triggers the phone's offer; the engine's own accept
  // follows when the offer arrives (duplicate accepts are idempotent
  // on this channel — the dual-send era proved that).
  entry.timer=setTimeout(()=>clearDoorbellPending(key,'no offer within 65s'),65000);entry.timer.unref?.();
  doorbellPending.set(key,entry);
  try{await signaling.joinDoorbellCall(callId);log('DOORBELL_JOINING',callId,peer);}
  catch(e){clearDoorbellPending(key,'join failed: '+e.message);return;}
  // Grace clock starts at the JOIN (the caller's re-offer is triggered
  // by our room entry), not at the doorbell.
  if(doorbellPending.get(key)===entry){entry.acceptTimer=setTimeout(()=>{signaling.sendAccept(peer,callId,evt.payload?.hasVideo==='true'?['audio','video']:['audio']).catch(e=>log('DOORBELL_ACCEPT_FAILED',callId,e.message));},4000);entry.acceptTimer.unref?.();}
 };
 const doorbell=new DoorbellWatcher({log,onEvent:evt=>{void joinDoorbell(evt);}});
 const factory=relayOnlyPeerConnectionFactory(relay,log);
 const createPC=config=>{const pc=factory(config);mediaPCs.add(pc);pc.connectionStateChange.subscribe(state=>{if(state==='closed')mediaPCs.delete(pc);});return pc;};
 engine=new PW.CallEngine({selfId:process.env.AGENT_NAME||'Noor',signaling,createPeerConnection:createPC,getLocalMedia:async()=>(callSrc??freshSrc()).stream,iceServers:relay,shrinkVideoCodecs:false});
 engine.on('incomingCall',async info=>{
  // Ring-time warm-up: prime the shared worker's prompt cache with this
  // peer's call prompt while the call is being set up (fire-and-forget).
  void backend.request({op:'warm',trustedPeerId:info.peerId}).catch(()=>{});
  if(active)return engine.reject(info.callId);
  const key=info.callId.toLowerCase();clearDoorbellPending(key);active=key;budget.start(key);status();
  try {
   // Refresh permission at call time: revoked friends cannot use a stale startup allowlist.
   const current=await fetch(base+'/api/friends-list',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error('friend permission unavailable');return r.json();});
   if(!(current.friends||[]).some(f=>f.userid===info.peerId&&f.accepted===true))throw new Error('caller is not an accepted friend');
   if(active!==key)return engine.reject(info.callId);
   session=new ConversationSession({src:freshSrc(),backend,log,peerId:info.peerId,recordDir:path.join(path.dirname(new URL(import.meta.url).pathname),'records'),callId:info.callId,onEndCall:()=>endCallNow('caller asked to end the call')});
   log('answering accepted friend',info.peerId,info.callId);
   await engine.accept(info.callId);
  }catch(e){log('accept refused/failed',e.message);if(active===key){session?.close();session=null;active=null;budget.stop();status();}await engine.reject(info.callId).catch(()=>{});}
 });
 engine.on('remoteStream',(id,stream)=>{if(id.toLowerCase()===active){for(const track of stream.getAudioTracks())session?.attach(track);if(outbound)void session?.greet(performance.now());}});
 engine.on('ended',(id,why)=>{if(id.toLowerCase()===active){log('call ended',why,'remoteDecodedPackets',session?.receivedPackets||0,'socketAnswerReceived',signaling.answers.has(active));budget.stop();session?.close();session=null;active=null;budget.stop();status();exitAfterCall();}});
 engine.on('stateChanged',(info,state)=>{log('state',info.callId,state);
  if(!session||info.callId.toLowerCase()!==active)return;
  if(state==='ringing')sawRinging=true;
  // Greeting trigger: inbound connects right at answer; outbound also emits
  // an early 'connected' before the callee picks up, so outbound waits for
  // the post-ringing connect (remoteStream is the fallback). Idempotent.
  if(state==='connected'&&(!outbound||sawRinging))void session.greet(performance.now());
 });
 status();log('READY: local bilingual conversation listener; accepted friends',friends.size,'half duplex','profile',process.env.BVA_PROFILE||'fast');
 doorbell.start();
 let i=process.argv.indexOf('--offline-call'); if(i<0)i=process.argv.indexOf('--call');
 if(i>=0){
  const peer=process.argv[i+1];if(!friends.has(peer))throw new Error('outbound target is not an accepted friend');
  outbound=true;signaling.outboundPeer=peer;
  // Ring-time warm-up: prime the shared worker's prompt cache with this
  // peer's call prompt while the phone rings (fire-and-forget).
  void backend.request({op:'warm',trustedPeerId:peer}).catch(()=>{});
  let callId;const outgoingStarted=Date.now();active='pending-outgoing';budget.start(active);status();
  signaling.onRemoteAnswered=id=>{if(id===active)log('REMOTE_ANSWERED_HARD_LIMIT_UNCHANGED',id);};
  signaling.onOutboundId=id=>{
   if(Date.now()-outgoingStarted>=180000)throw new Error('call setup exceeded hard limit');
   callId=id;active=id.toLowerCase();session=new ConversationSession({src:callSrc??freshSrc(),backend,log,peerId:peer,recordDir:path.join(path.dirname(new URL(import.meta.url).pathname),'records'),callId:id,onEndCall:()=>endCallNow('caller asked to end the call')});budget.start(id,180000-(Date.now()-outgoingStarted));status();
   log('OFFLINE_CALL_START',callId,'peer',peer,'route Socket.IO + SDK wake push; hard maximum 180 seconds including setup');
  };
  try {const actualId=await engine.call(peer,{audio:true,video:false});log('OFFLINE_INVITE_SUBMITTED',actualId,'NOT proof of remote ringing');}
  catch(e){log('OFFLINE_CALL_FAILED',callId||'(before offer)',e.message);budget.stop();session?.close();session=null;active=null;status();exitAfterCall();}

 }

}catch(e){log('startup failed',e.message);backend.close();process.exit(1);}
