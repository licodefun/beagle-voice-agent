// TURN-over-TCP media test: two werift peers in one process, both forced to a
// TCP TURN relay from the running beagle daemon (http://localhost:8766).
// This is the media path the voice agent needs on hosts where UDP is blocked.
// Never places a call; purely local peers talking through the relay server.
import { fetchRelayIceServers } from '../lib/ice.js';
import { relayOnlyPeerConnectionFactory, makeAudioSource } from '../lib/engine.js';
import { fileToOpusPackets, oggToWav } from '../lib/audio.js';
import { OggOpusWriter } from '../lib/ogg.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const base = process.env.BEAGLE_URL || 'http://localhost:8766';
const { relay: all } = await fetchRelayIceServers(base);
const relay = all.filter(s => /transport=tcp/i.test(s.urls));
if (!relay.length) { console.log('FAIL: daemon offered no TCP TURN entry'); process.exit(2); }
console.log('TCP relay entries:', relay.map(s => s.urls).join(', '));
const chosen = [relay[0]];
console.log('using:', chosen[0].urls);

const log = (who) => (...a) => console.log(who, ...a);
const A = relayOnlyPeerConnectionFactory(chosen, log('A'))();
const B = relayOnlyPeerConnectionFactory(chosen, log('B'))();
A.onicecandidate = (e) => { if (e.candidate) B.addIceCandidate(e.candidate); };
B.onicecandidate = (e) => { if (e.candidate) A.addIceCandidate(e.candidate); };

fs.mkdirSync('out', { recursive: true });
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '48000', '-ac', '1', 'out/tone.wav']);
const src = makeAudioSource(); A.addTrack(src.track, src.stream);
const w = new OggOpusWriter('out/tcp-relay-test.ogg'); let n = 0;
B.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => { n++; w.write(rtp.payload); }));
B.addTransceiver('audio', { direction: 'recvonly' });
await A.setLocalDescription(await A.createOffer()); await B.setRemoteDescription(A.localDescription);
await B.setLocalDescription(await B.createAnswer()); await A.setRemoteDescription(B.localDescription);
const to = setTimeout(() => { console.log('FAIL: no connection in 45s', A.connectionState, B.connectionState); process.exit(2); }, 45000);
await new Promise((r) => A.connectionStateChange.subscribe((s) => s === 'connected' && r()));
clearTimeout(to); console.log('CONNECTED via TCP TURN relay');
const pk = fileToOpusPackets('out/tone.wav');
await src.play(pk); await new Promise((r) => setTimeout(r, 1500));
w.close(); oggToWav('out/tcp-relay-test.ogg', 'out/tcp-relay-test.wav');
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'out/tcp-relay-test.wav']).toString().trim();
console.log(`sent ${pk.length} frames, B received ${n} RTP packets, wav ${dur}s`);
await A.close(); await B.close();
process.exit(n > pk.length * 0.8 ? 0 : 3);
