// Fetch Carrier ICE servers from the daemon and keep ONLY TURN entries (relay-only).
// UDP TURN (turn:host:3478) is preferred: Node's UDP is not subject to the box Chrome policy.
// STUN entries are dropped -> no host/srflx candidates are ever gathered (iceTransportPolicy relay too).
export const PREFERRED_HOSTS = ['13.58.208.50', '144.202.113.167'];
export function filterRelays(servers, { allowTcp = true } = {}) {
  const out = [];
  for (const s of servers || []) {
    for (const u of [].concat(s.urls)) {
      const url = String(u).trim();
      if (!/^turns?:/i.test(url)) continue;
      const tcp = /^turns:/i.test(url) || /[?&]transport=tcp\b/i.test(url);
      if (tcp && !allowTcp) continue;
      out.push({ urls: url, username: s.username, credential: s.credential });
    }
  }
  return out.sort((a, b) => score(b.urls) - score(a.urls));
}
export const filterTcpTlsRelays = filterRelays; // back-compat name
const isUdp = (u) => /^turn:/i.test(u) && !/[?&]transport=tcp\b/i.test(u);
const hostRank = (u) => { const i = PREFERRED_HOSTS.findIndex(h => u.includes(h)); return i < 0 ? 0 : 10 - i; };
// werift uses only the first TURN entry, so order matters: preferred host, then UDP.
const score = (u) => hostRank(u) * 10 + (isUdp(u) ? 5 : 0) + (/^turns:/i.test(u) ? 1 : 0);
export async function fetchRelayIceServers(base, prefer, opts) {
  const r = await fetch(base + '/api/call-ice-servers', { headers: { 'cache-control': 'no-cache' } });
  const d = await r.json(); if (!d.ok) throw new Error('call-ice-servers: ' + d.error);
  let list = filterRelays(d.iceServers, opts);
  if (prefer) list = [...list.filter(s => s.urls.includes(prefer)), ...list.filter(s => !s.urls.includes(prefer))];
  // BVA_RELAY=tcp: UDP is unavailable on this host (e.g. Muse's VM egress
  // policy), so keep ONLY TCP TURN entries and let werift run ICE over TCP.
  if (process.env.BVA_RELAY === 'tcp') {
    list = list.filter(s => /transport=tcp/i.test(s.urls) || /^turns:/i.test(s.urls));
    // Decent HQ (2026-11-10): the three bootstrap coturn relays take UDP only,
    // but tokyo.fi.chat runs TURN over TCP — it's the entry Beagle web
    // (app.beagle.chat) uses for call audio, with the web client's shared
    // credentials. werift uses only the first TURN entry, so in TCP mode
    // tokyo goes first: it's the one whose TCP port is actually open.
    const tokyo = { urls: 'turn:tokyo.fi.chat:3478?transport=tcp', username: 'allcom', credential: 'allcompass' };
    if (!list.some(s => String(s.urls).includes('tokyo.fi.chat'))) list = [tokyo, ...list];
  }
  return { raw: d.iceServers, relay: list };
}
/** Safe description of a server for logs (never includes credentials). */
export const describe = (s) => s?.urls;
