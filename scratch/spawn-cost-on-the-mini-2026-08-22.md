# Why anything that spawns is slow on the mini — open question, 2026-08-22

**Status: unanswered, deliberately. Nobody has established it and the login fix did not need it.**
Tracked and force-added because it is a resumption point, not a report — `scratch/` is gitignored
(`.gitignore:47`), so an untracked copy of this would not survive.

## The measurement

`git rev-parse --path-format=absolute --git-common-dir` on `/Users/skip/work/tlda`, timed
repeatedly on 2026-08-22 between 22:40 and 23:50 UTC:

```
0.33s  0.38s  0.69s  0.80s  1.02s  1.38s  1.39s  1.67s  1.69s  2.28s  2.68s
```

**0.3–2.7 seconds of wall time for roughly 0.01–0.2s of CPU.** The variance is not a tail: it is
the ordinary distribution. Later the same night, with the box quieter, the same call ran in
0.21–0.26s — so it is load-sensitive, but load average was only 4–5 during the slow readings.

**Some of those spawns were `git -C <nonexistent-path>`, which fails immediately** and still cost
0.33–2.68s. So the cost is in *spawning a process at all*, not in the git work.

## Why it matters beyond login

It is why `login()` took minutes: `projectForCwd` spawned `git` once per source binding.
`3ef60c037` removed that loop, so **login no longer depends on this.** But the underlying cost is
paid by everything on this box that spawns a subprocess, and much of the fleet's tooling does.

## What is already ruled out, so nobody redoes it

- **Not the tlda server.** HTTP 0.23–0.65s, WS upgrade to `/ws/fleet` 250–390ms across 12
  attempts, server main-thread event-loop lag ~20ms.
- **Not the fleet store.** Its queue was idle — `depth=0`, `oldestWaitMs=0`, cumulative
  `waitMaxMs` frozen — through a four-minute client hang.
- **Not the network, DNS, or the fence.** `node` fetch 493ms, `dns.lookup` 11ms, `resolve4` 16ms.
- **Not broadcast volume.** One fleet socket receives 1.8 KiB/s and 5ms of `JSON.parse` CPU per
  minute.
- **Not CPU contention in the calling process.** The MCP process used 4.5s of CPU across 30
  minutes while fully blocked — see `docs/the-instrument-or-the-code.md` on why `%CPU` cannot
  see this.

## Where to start

The candidates nobody has tested: `xcrun`/developer-tools resolution on each `git` exec (this
machine has both `/usr/bin/git` and a CommandLineTools git), dyld work per spawn, the fenced
`TMPDIR` rewrite, filesystem pressure on the volume holding `~/worktrees`, and Gatekeeper /
`syspolicyd` evaluation. **A useful first cut is timing `/usr/bin/true` in the same loop** — if a
no-op binary costs the same, git is irrelevant and it is process creation.

`server/lib/lag-profiler.mjs` already samples the isolate and attributes stalls to the frames
inside them; `sample <pid>` is what found the login hang. Prefer both to building a new
instrument.

## The related decision that is held, not forgotten

`projectForCwd` reads each binding's value as a path, but the values are objects
(`bindingId`/`project`/`sourceDir`), so it returns `null` for every input and always has.
Reading `sourceDir` would remove the git loop entirely rather than making it cheap — containment
matches and returns before the loop is reached. **Held on 2026-08-22 because it changes what the
server records for every agent on every login**, which is a visibility change and Skip's call,
not a cleanup. Full entry and evidence in `docs/naming-errata.md` under `projectForCwd`.
