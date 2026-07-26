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
selection such as `TLDA_ENV` and `TLDA_SERVER`. Until that lands,
`scratch/restart-daemon.sh` is the manual recovery path: it kills the stale
daemon, removes stale pid/lock files, strips the sandbox/DNS environment, starts
the daemon from `/Users/skip/work/tlda`, and prints heartbeat plus `lsof` proof.

## 2026-07-25: it dies silently, and launchd will not take it back

Two more failures, found the hard way during a 25-minute outage of the
`mini:default` daemon. Both are ours to fix — this is the app, not ops. The
route-to-ops guidance exists so a *math* agent doesn't abandon a proof to chase
infrastructure; it was never a lane boundary for app developers.

### 1. A bad `daemon.yaml` kills the daemon with a zero-byte log

`daemon.yaml` is validated against a **closed allow-list**
(`DAEMON_CONFIG_TOP_LEVEL_KEYS` in `shared/daemon-config-schema.mjs`). An unknown
key makes the daemon refuse to start:

```
Error: daemon config supports only machineId, regions, profiles, grants, models,
default, tmuxSocket, taskDoc, spawnMachineId, environments;
unknown key(s): statusScanSeconds
```

The trap is not the validation — it is that **nothing records it**. The daemon
doesn't fail at edit time; it dies on its *next* restart, and
`~/.config/tlda/fleet-daemon.log` stays **0 bytes**. So the symptom is: `pgrep -f
fleet-daemon` returns nothing, the server shows no daemon connection, activity
cards and terminal-agent chat stop, and there is no error anywhere on disk. The
only way it was diagnosed was running the daemon in the foreground.

**If the daemon is missing and its log is empty, run it in the foreground first
— don't go looking for a cause that was never written down:**

```bash
cd /Users/skip/work/tlda
PATH=/opt/homebrew/bin:$PATH TLDA_ENV=default \
  /opt/homebrew/bin/node --import tsx bin/fleet-daemon.mjs
```

**Adding a new daemon.yaml setting requires naming it in the allow-list in the
same change.** A named setting the schema rejects is not a named setting. Worth
fixing properly: write the validation error somewhere durable before exiting, so
this failure announces itself instead of presenting as an absence.

### 2. `com.tlda.fleet-daemon` will not bootstrap; the running daemon is unsupervised

```
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.tlda.fleet-daemon.plist
  → Bootstrap failed: 5: Input/output error
launchctl print gui/501/com.tlda.fleet-daemon
  → Could not find service "com.tlda.fleet-daemon" in domain for user gui: 501
launchctl list | grep -i tlda
  → (nothing; no tlda jobs loaded at all)
```

`bootout` first returns `3: No such process`, and `bootstrap` still fails the
same way afterwards. The plist itself inspects fine — `KeepAlive`, `RunAtLoad`,
correct node path, `TLDA_ENV=default` — so this reads as a launchd
registration problem rather than a bad plist. Several `.plist.before-*` backups
sit in `~/Library/LaunchAgents/` from earlier interventions and may be related.

**Current state: `mini:default` runs under `nohup`, so nothing restarts it if it
dies.** `mini:stable` is supervised normally. This likely predates the outage —
`fleet-daemon.log` was 0 bytes dated 19:04 while `fleet-daemon.stable.log` was
actively written through 22:51, so `default` was already running outside launchd
beforehand.

Two daemons on this machine is **correct**, not a duplicate: one per environment.
Check `TLDA_ENV` per pid before concluding otherwise:

```bash
pgrep -f fleet-daemon | while read p; do ps eww $p | tr ' ' '\n' | grep ^TLDA_ENV=; done
```

### Why `bootstrap` fails: agents cannot register launchd jobs at all

The `5: Input/output error` is not about the plist, the label, or the daemon.
**Agent shells run in the wrong launchd domain.**

```
$ launchctl managername     → Background      (Skip's GUI session is "Aqua")
$ launchctl manageruid      → 501
$ ps -o sess= -p $$         → 0               (no audit session)

$ launchctl print gui/501/com.tlda.fleet-daemon.stable  → works (domain = gui/501 [100003])
$ launchctl bootstrap gui/501 <any plist>               → Bootstrap failed: 5: Input/output error
```

`gui/501` is **readable** from a Background-session process but not **writable**.
Proven with a control: a probe plist with a fresh label whose `ProgramArguments`
were `/bin/echo` — nothing to do with tlda — failed with the identical error. So
it is neither this label nor this program; **no job of any kind can be
bootstrapped into `gui/501` from an agent shell.** `sudo` is not available either,
so `launchctl asuser` is not a route.

**Consequences, both load-bearing:**

- **Any fix that depends on an agent running `launchctl bootstrap` will always
  fail.** Do not write one. Supervision has to come from something already inside
  the login session.
- **`~/Library/LaunchAgents/*.plist` is auto-bootstrapped at login**, so the job
  returns by itself on next login/reboot. If a label is missing mid-session,
  something *booted it out* during this session — that is the thing to find, not
  the registration.

**To register it now, from Skip's GUI session (a terminal he opened), one command:**

```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.tlda.fleet-daemon.plist
launchctl print gui/501/com.tlda.fleet-daemon | head -5   # expect state = running
```

Until then `mini:default` runs unsupervised and `mini:stable` does not, which is
the asymmetry that makes the two-environment pair unreliable: one config error
takes both down, and only one comes back on its own.
