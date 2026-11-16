// Live self-check of the greeting path without placing a call: builds a
// real ConversationSession on a real werift audio source, fires greet()
// as the connect hook would, and measures connect -> first RTP packet.
import {ConversationSession} from '../lib/conversation.js';
import {makeAudioSource} from '../lib/engine.js';
const src = makeAudioSource();
let firstRtpAt = null, packets = 0;
src.track.onReceiveRtp.subscribe(() => { packets++; if (firstRtpAt === null) firstRtpAt = performance.now(); });
const logs = [];
const s = new ConversationSession({src, backend:{request:async()=>{throw new Error('backend must not be called by greet');}}, log:(...a)=>logs.push(a.join(' '))});
const connectAt = performance.now();
await s.greet(connectAt);
console.log(logs.join('\n'));
console.log('packets sent:', packets);
console.log('connect->first RTP ms:', firstRtpAt === null ? null : Math.round(firstRtpAt - connectAt));
s.close();
if (firstRtpAt === null || firstRtpAt - connectAt > 1000) { console.error('SELF-CHECK FAILED'); process.exit(1); }
console.log('SELF-CHECK OK');
