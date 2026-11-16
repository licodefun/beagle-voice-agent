import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const workerPath = path.join(root,'local-worker.py');
// Transport: prefer the shared warm worker service (one ASR/LLM/TTS stack
// for the listener and every outbound dialer — a per-process cold stack
// cost call 9f36a3a6 an 18.5 s first LLM turn). The service reports the
// worker file's mtime as a build tag; on mismatch, connect failure, or
// BVA_WORKER_PORT=off, fall back to a private spawned worker (previous
// behavior, still used by isolated benches and tests).
export class LocalBackend {
  constructor({ log = () => {}, timeoutMs = 90000, env = {}, shared } = {}) {
    this.pending = new Map(); this.seq = 0; this.timeoutMs = timeoutMs; this.closed = false;
    this.process = null; this.socket = null; this.log = log;
    this.ready = new Promise((resolve,reject) => { this.readyResolve=resolve; this.readyReject=reject; });
    this.startupTimer=setTimeout(()=>this.fail(new Error('local model startup timed out')),120000);
    this.transport = 'undecided';
    void this.init(env, shared);
  }
  async init(env, sharedOpt) {
    const portSetting = env.BVA_WORKER_PORT ?? process.env.BVA_WORKER_PORT;
    const wantShared = sharedOpt !== false && portSetting !== 'off';
    if (wantShared) {
      const port = Number(portSetting || 8768);
      try {
        if (await this.tryShared(port)) { this.transport='shared'; clearTimeout(this.startupTimer); this.log('local-worker','using shared warm worker service on port '+port); this.readyResolve(); return; }
      } catch (e) { this.log('local-worker','shared worker unavailable: '+e.message); }
      if (this.closed) return;
      this.log('local-worker','falling back to a private worker process');
    }
    this.transport = 'spawn';
    this.spawnWorker(env);
  }
  async tryShared(port) {
    const expectedBuild = Math.floor(fs.statSync(workerPath).mtimeMs / 1000);
    let lastError;
    for (let attempt = 0; attempt < 8 && !this.closed; attempt++) {
      try {
        const socket = await this.connectAndPing(port, expectedBuild);
        this.socket = socket;
        createInterface({input:socket}).on('line', line => this.onLine(line));
        socket.on('error', e => this.fail(e));
        socket.on('close', () => { if (!this.closed) this.fail(new Error('shared worker connection closed')); });
        return true;
      } catch (e) { lastError = e; await new Promise(r => setTimeout(r, 400)); }
    }
    throw lastError || new Error('shared worker unreachable');
  }
  connectAndPing(port, expectedBuild) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let buffer = '';
      const cleanup = () => { socket.removeAllListeners('data'); };
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('shared worker ping timed out')); }, 5000);
      socket.on('error', e => { clearTimeout(timer); reject(e); });
      socket.on('connect', () => socket.write(JSON.stringify({op:'ping', id:'ping'})+'\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        const nl = buffer.indexOf('\n'); if (nl < 0) return;
        clearTimeout(timer); cleanup();
        let d; try { d = JSON.parse(buffer.slice(0, nl)); } catch { socket.destroy(); reject(new Error('shared worker ping unparsable')); return; }
        if (!d.ready) { socket.destroy(); reject(new Error('shared worker not ready')); return; }
        if (d.build !== expectedBuild) { socket.destroy(); reject(new Error(`shared worker build ${d.build} != local ${expectedBuild} (stale service)`)); return; }
        resolve(socket);
      });
    });
  }
  spawnWorker(env) {
    this.process = spawn(path.join(root,'.venv/bin/python'), ['-u',workerPath], {cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});
    this.process.stderr.on('data', b => this.log('local-worker',b.toString().trim()));
    createInterface({input:this.process.stdout}).on('line', line => this.onLine(line));
    this.process.on('error',e=>this.fail(e)); this.process.on('exit',()=>this.fail(new Error('local worker exited')));
  }
  onLine(line) {
    let d; try { d=JSON.parse(line); } catch { return; }
    if ('ready' in d && this.transport === 'spawn') { clearTimeout(this.startupTimer); d.ready ? this.readyResolve() : this.fail(new Error(d.error)); return; }
    const p=this.pending.get(d.id); if (!p) return; this.pending.delete(d.id); clearTimeout(p.timer); d.error ? p.reject(new Error(d.error)) : p.resolve(d);
  }
  fail(e) { if (this.closed) return; this.closed=true; this.readyReject(e); clearTimeout(this.startupTimer); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); try { this.process?.kill(); } catch {} try { this.socket?.destroy(); } catch {} }
  async request(data) {
    await this.ready; if (this.closed) throw new Error('backend closed');
    if (this.pending.size >= 2) throw new Error('backend busy');
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('local inference timed out')),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      const line=JSON.stringify({...data,id})+'\n';
      if (this.transport === 'shared') this.socket.write(line, e=>{if(e)this.fail(e);});
      else this.process.stdin.write(line, e=>{if(e)this.fail(e);});
    });
  }
  close() { this.fail(new Error('backend closed')); }
}
