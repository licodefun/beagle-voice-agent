// PM2 ecosystem for Noor's Beagle voice agent (cut over 2026-11-22 on Wei's go).
//
// Why: the watchdog hook (~/hooks/scripts/beagle-daemon-watchdog.sh) polls
// every 120 s, so a dead listener can sit dead for up to 2 minutes — exactly
// what ate Wei's first two calls on 2026-11-20 ~19:18/19:19 PST. PM2 restarts
// a crashed Node process in ~1 s. The watchdog stays as the OUTER layer: it
// revives the daemon + Python worker after a VM replacement, and re-arms
// PM2 itself (pm2_rearm in the watchdog, added 2026-11-22) so the two Node
// processes come back under PM2, not the old start scripts.
// PM2 lives in ~/.npm-global (home survives VM swaps); `npm config prefix`
// is set to ~/.npm-global so it is not wiped with /usr.
//
// Scope is deliberately narrow: the two Node processes only.
// - The Beagle daemon stays with the watchdog: its script warns a duplicate
//   daemon on one identity caused triple-delivered messages (2026-11-11).
// - The Python worker (local-worker.py :8768) stays with the watchdog:
//   start-worker.sh already guards against a second instance, and PM2 would
//   add nothing for a warm-model service that must not be restarted mid-call.
// - The watchdog's pgrep checks still pass while PM2 runs these processes,
//   so it will not spawn duplicates. A watchdog guard (skip restart when
//   `pm2 describe <name>` reports online) is the belt-and-braces for cutover.
//
// CUTOVER (only on Wei's go, never during an active call — check
// out/conversation-status.json first, and never hand-launch: use this file):
//   export PATH="$HOME/.npm-global/bin:$PATH"
//   cd ~/workspace/beagle-voice-agent
//   pkill -f "node converse.js"; pkill -f "node text-agent.js"
//   pm2 start ecosystem.config.cjs   # immediately, same minute as the kills
//   pm2 list   # both online; then call/text to verify
// ROLLBACK: pm2 stop all; bash start-listener.sh; bash start-text-agent.sh
// (the watchdog revives both within ~2 min on its own if PM2 is stopped).
module.exports = {
  apps: [
    {
      name: 'beagle-listener',
      script: 'converse.js',
      cwd: '/home/hatch/workspace/beagle-voice-agent',
      env: {
        BVA_RELAY: 'tcp',
        HOME: '/home/hatch',
        NODE_USE_ENV_PROXY: '1',
      },
      autorestart: true,
      restart_delay: 1000,
      max_memory_restart: '1G',
      // Never run two listeners: a second converse.js would double-answer.
      instances: 1,
      exec_mode: 'fork',
      out_file: 'out/pm2-listener.log',
      error_file: 'out/pm2-listener-error.log',
      // The listener must inherit the proxy/TCP-relay env above; a
      // hand-launched node without it picks UDP relays and dials fail
      // silently (2026-11-16). PM2 gets the env from this file, not the shell.
    },
    {
      name: 'beagle-text-agent',
      script: 'text-agent.js',
      cwd: '/home/hatch/workspace/beagle-voice-agent',
      env: {
        BVA_RELAY: 'tcp',
        HOME: '/home/hatch',
        NODE_USE_ENV_PROXY: '1',
      },
      autorestart: true,
      restart_delay: 1000,
      max_memory_restart: '1G',
      instances: 1,
      exec_mode: 'fork',
      out_file: 'out/pm2-text-agent.log',
      error_file: 'out/pm2-text-agent-error.log',
    },
  ],
};
