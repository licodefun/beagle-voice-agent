// Portable loader for the Decent Network SDK modules this agent needs.
//
// Rio's prototype imported these by absolute path from a sibling
// /workspace/beagle-cli install. Noor's version resolves them, in order:
//   1. $BEAGLE_NODE_MODULES  (a directory that contains @decentnetwork/*)
//   2. this project's own node_modules (npm install in this folder —
//      package.json depends on @decentnetwork/beagle, peer-webrtc and lan)
//   3. a sibling ../beagle-cli/node_modules (Rio's original layout)
//   4. ~/.beagle-cli/node_modules
// Nothing here is machine-specific; the first location that exists wins.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function candidateRoots() {
  const roots = [];
  if (process.env.BEAGLE_NODE_MODULES) roots.push(process.env.BEAGLE_NODE_MODULES);
  roots.push(path.join(projectRoot, 'node_modules'));
  roots.push(path.resolve(projectRoot, '..', 'beagle-cli', 'node_modules'));
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.beagle-cli', 'node_modules'));
  return roots;
}

function resolveModule(relPath) {
  for (const root of candidateRoots()) {
    const full = path.join(root, relPath);
    if (fs.existsSync(full)) return pathToFileURL(full).href;
  }
  throw new Error(
    `Cannot find ${relPath}. Run ./setup.sh in this folder (it npm-installs ` +
    `@decentnetwork/beagle, which brings peer-webrtc + lan), or set ` +
    `BEAGLE_NODE_MODULES to a node_modules folder that contains @decentnetwork/*.`
  );
}

/** @decentnetwork/peer-webrtc — CallEngine + signal codec (wire-compatible with the Beagle apps). */
export async function loadPeerWebrtc() {
  return import(resolveModule('@decentnetwork/peer-webrtc/dist/index.js'));
}

/** @decentnetwork/lan — OfflineCallBridge (Socket.IO signaling + wake push for offline friends). */
export async function loadOfflineCall() {
  return import(resolveModule('@decentnetwork/lan/dist/carrier/offline-call.js'));
}
