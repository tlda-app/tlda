# Fleet daemon respawn landmine

On 2026-06-29, the Mini fleet daemon was healthy until the old process was
terminated for a restart. The server/CLI auto-respawn path did not bring it back
cleanly. The immediate recovery was the one-shot script at
`scratch/restart-daemon.sh`.

The failure had two parts:

- The daemon launch inherited a fenced agent environment. In particular,
  `NODE_OPTIONS` loaded `shared/node-dns-alias.cjs` and
  `TLDA_NODE_DNS_ALIAS_*` pointed `tlda-fly` at the agent's sandbox DNS alias.
  When a daemon was started from that environment it could resolve the wrong
  target and connect as if `localhost` were the fleet server.
- The CLI launch path used `node --import tsx bin/fleet-daemon.mjs` without a
  stable repo cwd. Under Node v26, `--import tsx` is resolved from the launch
  cwd; when the respawn path ran from `/Users/skip`, Node reported
  `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from /Users/skip/`.

The real hardening is to make every supervisor/CLI daemon spawn use a stable cwd
at the tlda repo root and a sanitized daemon environment. The sanitizer should
remove tmux/fenced-agent variables and the tlda DNS-alias preload
(`NODE_OPTIONS`, `TLDA_NODE_DNS_ALIAS_*`) while preserving intentional target
selection such as `TLDA_CONFIG` and `TLDA_SERVER`. Until that lands,
`scratch/restart-daemon.sh` is the manual recovery path: it kills the stale
daemon, removes stale pid/lock files, strips the sandbox/DNS environment, starts
the daemon from `/Users/skip/work/tlda`, and prints heartbeat plus `lsof` proof.
