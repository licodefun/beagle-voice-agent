import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readOggOpusPackets } from './ogg.js';
const tmp = (ext) => path.join(os.tmpdir(), `bva-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
/** Any audio file -> array of 20 ms Opus packets (48 kHz mono). */
export function fileToOpusPackets(file) {
  const ogg = tmp('ogg');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-frame_duration', '20', '-application', 'voip', ogg]);
  const p = readOggOpusPackets(fs.readFileSync(ogg)); fs.unlinkSync(ogg); return p;
}
// One-way --say TTS for agent.js. Rio's build used a machine-local gtts venv
// (Google TTS over the network). Noor's version is portable, in this order:
//   1. $TTS_CMD with {out} and {text} placeholders, e.g. a Piper or gtts wrapper
//   2. macOS `say` (Wei's Mac has it built in)
//   3. espeak-ng / espeak on Linux
// The two-way conversational path (converse.js) does NOT use this file — it
// synthesizes with the local Piper voices in local-worker.py, fully offline.
// If none of these exist, use --play <file.wav> instead of --say.
export function ttsToFile(text, lang = 'en') {
  const out = tmp('wav');
  const cmd = process.env.TTS_CMD;
  if (cmd) {
    const rendered = cmd.replaceAll('{out}', out).replaceAll('{text}', text.replaceAll('"', '\\"'));
    execFileSync('/bin/sh', ['-c', rendered]);
    return out;
  }
  if (process.platform === 'darwin') {
    const aiff = tmp('aiff');
    execFileSync('say', ['-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, out]);
    fs.unlinkSync(aiff);
    return out;
  }
  for (const bin of ['espeak-ng', 'espeak']) {
    try {
      execFileSync(bin, ['-w', out, text]);
      return out;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('no TTS available for --say: set TTS_CMD, run on macOS (say), install espeak-ng, or use --play <file.wav>. For two-way conversation use converse.js (local Piper).');
}
export function textToOpusPackets(text, lang) { const f = ttsToFile(text, lang); try { return fileToOpusPackets(f); } finally { fs.unlinkSync(f); } }
export function oggToWav(ogg, wav) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', ogg, '-ar', '48000', wav]); }
