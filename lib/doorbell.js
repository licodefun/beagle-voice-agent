// Doorbell event watcher (2026-11-13).
//
// Inbound calls that arrive over the socket.io channel start as a
// doorbellCall wake frame at the Carrier layer (the callee may be
// "offline" from the caller's view). The daemon's carrier-node patch
// mirrors those events to a JSONL file; this watcher tails the file and
// surfaces them so the listener can join the call's socket.io room —
// the step that turns a wake frame into an answerable call
// (SocketIoSignaling.joinCall is designed exactly for "after a push
// notification delivered the callId").
//
// Events appended after the watcher starts are surfaced live. On top
// of that, start() replays the recent tail: a 'call' doorbell no more
// than 90 s old that was never followed by a decline/end for the same
// callId is surfaced once, so a call that rang while the listener was
// down (watchdog restart gap) is not lost. Older history is never
// replayed. Poll-based (1 s) — doorbells are rare and the join does
// not need sub-second latency; the caller re-sends its offer when a
// peer joins the room.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOORBELL_FILE = process.env.BVA_DOORBELL_EVENTS || path.join(os.homedir(), '.agentnet', 'doorbell-events.jsonl');

export class DoorbellWatcher {
  constructor({ file = DOORBELL_FILE, log = () => {}, onEvent } = {}) {
    this.file = file; this.log = log; this.onEvent = onEvent;
    this.offset = 0; this.buffer = ''; this.timer = null;
  }
  start() {
    try { this.offset = fs.statSync(this.file).size; } catch { this.offset = 0; }
    this.#replayRecent();
    this.timer = setInterval(() => this.#poll(), 1000);
    this.timer.unref?.();
    this.log('doorbell watcher on', this.file, 'offset', this.offset);
  }
  // Surface 'call' doorbells from the file's recent tail that arrived
  // while no watcher was running (listener restart gap). A callId that
  // a later decline/end already closed is skipped, as is anything
  // older than 90 s. Events go through the same onEvent path as live
  // ones, so all downstream checks (friend, busy, pending) still apply.
  #replayRecent() {
    if (!this.onEvent || !this.offset) return;
    const TAIL = 256 * 1024, FRESH_MS = 90 * 1000;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const len = Math.min(this.offset, TAIL);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset - len);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return; }
    const lines = chunk.split('\n');
    if (this.offset > TAIL) lines.shift(); // first line may be partial
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    const now = Date.now();
    let replayed = 0;
    events.forEach((evt, i) => {
      if (evt.action !== 'call' || evt.isFriend !== true || !evt.callId) return;
      if (!evt.ts || now - evt.ts > FRESH_MS) return;
      const closed = events.slice(i + 1).some(e => e.callId === evt.callId
        && (e.action === 'decline' || e.action === 'end' || e.action === 'ended'));
      if (closed) return;
      replayed++;
      try { this.onEvent(evt); } catch (e) { this.log('doorbell replay handler failed', e.message); }
    });
    if (replayed) this.log('doorbell replay: surfaced', replayed, 'recent call(s) missed while down');
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  #poll() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.buffer = ''; } // truncated/rotated
    if (size === this.offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return; }
    this.offset = size;
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      try { this.onEvent?.(evt); } catch (e) { this.log('doorbell event handler failed', e.message); }
    }
  }
}
