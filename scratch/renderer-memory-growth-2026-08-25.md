# Renderer memory growth — measured state, 2026-08-25

Resumption point, not a log. Force-added because redoing it costs hours of
live measurement against a session that no longer exists.

Written by `browser-perf` (`fleet:a8793364`). Everything below is measured
unless the line says otherwise.

## The report

Skip, 2026-08-25 ~05:20 EDT: *"performance of the app is like, not so good
sometimes"*, then *"we have a profiler in there yes?"*, then — after being shown
the numbers — *"yeah uh i have tried to argue this fuckign thing leaks dude /
nobody believes me"*.

He is right. It leaks.

## STATUS OF THE CAUSAL CLAIM — read this before quoting anything below

**The cause of the renderer leak is NOT established.**

Taking the app offline is the only intervention that has ever changed the number:
the drift stopped, 445 → 446 MB over 35 minutes, where it had been climbing
~1 MB/min. **That is correlation, and possibly necessity. It is not cause.**

Three things keep it from being more, all of them recorded in full below:

1. **The run was cumulative, not isolated** — timers and `requestAnimationFrame`
   were still suppressed during it.
2. **The pre-existing sockets were never confirmed closed** at the OS level; only
   that the app entered its offline state and opened no new ones.
3. **The ordering control that would settle it has not been run.** Four attempts,
   four environmental failures, none of them a result. See the 01:00 entry.

**So: socket activity is correlated with the drift and may be necessary for it.
It is not established as the cause, and nothing in this file should be read or
quoted as saying otherwise.** Recorded on `sol-dev`'s instruction, 2026-08-26.

## What the growth is

One browser tab, one project open, nobody touching it. Renderer process
footprint, sampled from outside the browser:

| time (UTC) | footprint |
|---|---|
| 05:27 | 2,459 MB |
| 05:32 | 2,899 MB |
| 05:48 | 4,510 MB |
| 06:01 | 6,555 MB |
| 06:09 | 7,830 MB |
| 06:14 | 8,823 MB |
| 06:29 | 11 GB |

Monotonic, and the rate roughly doubled over the hour — ~82 MB/min early,
~170 MB/min late. The machine has 8 GB.

## What it is not

Each ruled out by measurement, not by argument.

- **JS heap.** Flat, 100–193 MB throughout.
- **JS allocation.** `HeapProfiler` sampling with JS stacks: **6.3 MB of JS
  allocation in 240 seconds**, while the process grew several hundred MB. The
  memory is not being requested by our JavaScript.
- **Listener registrations.** `getEventListeners` on `window`, `document`,
  `body` and every element: `document` total 79 in both samples 90 s apart,
  `pointerdown` 14 in both.
- **`Documents` / `Nodes`.** These oscillate and come back down (17 → 10,
  8,006 → 7,156). An earlier reading of these as a monotonic trend was one
  sample pair caught on a rising edge — see *Corrections*.
- **Canvas.** Three canvases, 82 MB total. **Images:** zero.
- **Voice PCM backlog.** `PcmBacklog` trims at `maxBytes`, default 64 MB, and
  `voicePcmBacklogMaxBytes()` maps `≤ 0` to the default rather than to
  unlimited. Capped by construction.

## What it is

`Memory.getSamplingProfile` — **live** allocations, still held, not
allocate-and-free churn — over a 5-minute window in which the footprint went
7,830 → 8,823 MB:

```
2,284.8 MB   one single allocation site
  193.2 MB   V8 heap
   58.5 MB   next site down
   < 1.5 MB  everything else
```

memory-infra tracing, absolute breakdown of that renderer:

```
malloc            8,092 MB
shared_memory       857 MB
gpu                 849 MB
blink_gc            246 MB
v8                  226 MB
cc                  203 MB
partition_alloc      36 MB
skia                  1 MB
```

**8.1 GB sits in `malloc`** — Chrome's bucket for heap allocation it does not
attribute to any named subsystem. Not Blink GC, not V8, not compositor tiles,
not Skia, not PartitionAlloc.

**The allocation stack cannot be symbolized.** Four frames, three of them the
allocator; release Chrome is stripped and `atos` resolves every address to
`ChromeMain + <offset>`. There is no dSYM for a shipping Chrome build.

## Reproduction status

**Does not reproduce** on a disposable project. Fresh tab, real app, real
markdown page, real iframes, fleet panels; watched 7 minutes: RSS oscillates
92–131 MB, no trend.

That negative is trustworthy — the renderer was identified by allocating 400 MB
inside the page and confirming that process rose 392 MB. Two earlier attempts at
this control were worthless and are recorded here so nobody repeats them:

1. First attempt pointed at a project that **did not exist** — 404, 29 DOM
   nodes, nothing rendered. "Nothing happened" was the environment, not a
   finding.
2. The tab's fleet chat renders **zero** chat lines even on a working project,
   so the reproduction never had the thing Skip's session has most of.

**Unmatched conditions, and the two live candidates:** live chat traffic into a
loaded chat panel, and voice actually running. Note `isAutomatedBrowser()`
disables `useLongTaskProfileLog` in any automated tab, so the self-profiler
never runs in the reproduction and always runs in his.

## Corrections to things said out loud during this session

- **`migrateProjectParts` has callers.** It is reached from
  `migrateAllProjectParts(PROJECTS_DIR)` at `server/unified-server.mjs:10012`,
  once at server startup. The earlier "zero callers on main" came from a grep
  that excluded the defining file. Its 7 appearances in lag profiles over two
  days are **restarts**, not a periodic job.
- **The Radix call site is not the leak.** `@radix-ui/react-menu` adds a
  `pointerdown` and a `pointermove` on every keydown, but with `{ once: true }`
  and the same function reference, so the DOM ignores the duplicates —
  confirmed by `pointerdown` on `document` sitting at 14 across both samples.
  Counting `addEventListener` **calls** cannot answer a question about
  **registrations**.
- **The `WS request idle timeout` lines in `client.log` are mine**, from the
  automated tab. Two occurrences in the current rotation, both this hour. Not a
  user-facing symptom.

## Server, same session

`lag-profiler.log`, one 24-hour window: **499 stalls**, median 271 ms, p90 358 ms,
p99 797 ms, max 933 ms. 12,317 dumps since 25 Jul. (**Daily counts actually run
400–1,020**; 499 was a low day — see the 10:10 tick entry.)

- **~90% name no JavaScript at all** — the top frame is `(idle)` and the dump's
  stack is literally `["(idle) @ :0", "(root) @ :0"]`. The isolate ran nothing;
  the loop still lagged.
- The box is **not** saturated: 2 vCPU, load 0.67, PSI cpu `some avg300=3.67`,
  io `some avg300=1.59`. So contention is not the explanation. I inferred
  synchronous filesystem IO here; **that was tested on 2026-08-25 09:15 and is
  false** — see the tick entry. Cause still unknown.
- Server main thread RSS **1.3 GB** on a 4 GB machine. `fleet.db` is **10.9 GB**.
- `spawn` tops **28 of 499**. `existsSync`/`stat` under `migrateProjectParts`
  is startup-only. `broadcastFleet` → `utf8Write` costs 190–225 ms per stall it
  appears in; `broadcastFleet` stringifies once and sends the same string to
  every client, so that cost is per-socket UTF-8 encoding, scaling with payload
  × client count.
- Region is `sjc`; he is Eastern. ~70 ms round trip floor.

## The client profiler works and its output is unreadable

`client-profile.jsonl` is **268 MB, 3,975 self-profiles**, actively written.
Every deploy replaces `dist`, so the sourcemap for a bundle is gone as soon as
the next deploy lands. The last 400 records reference **13 distinct bundles and
not one of them is the live one** — **zero** are mappable.

Recent traces for one session: longest single main-thread block **4,382 ms**;
one frame is **24.5%** of all busy main-thread time and appears at the same
offset in two builds.

**Not built, deliberately.** Retaining maps across deploys is new machinery and
Skip's rule is to say it in one sentence before building it. The sentence would
be: *keep `dist/assets/index-*.js.map` on the volume, keyed by bundle hash, so
a profile posted from an older bundle can still be resolved.*

## Instrumentation and cleanup obligations

**In Skip's tab: none.** The counting probe was uninstalled and confirmed
removed, the native sampler stopped itself, and the `WebSocket` watch was
uninstalled (it reported `not installed` on the second call because his reload
had already wiped it).

**Still to remove when this work closes.** `sol-dev` asked for cleanup
confirmation in the final report, so this is the checklist — but **enumerate the
directories at cleanup time rather than trusting this list**, because a list
written from memory is exactly the thing that goes stale.

| where | what |
|---|---|
| **production server** (`/tmp`) | `baseline.js` + `baseline.out` — the 5-minute sampler, **keep running through the replay and the ordering control**, then stop the process and delete. Also sweep `anonshape.*` and anything else I left. |
| **the Air** (`/tmp`) | `cdp-watch.mjs`, `cdp-query.mjs`, `tick.mjs`, `layoutrate.mjs`, `tlda-watch.csv`, `tlda-watch-1.csv`, plus any `cdp-*.mjs` not already removed inline |
| **pooled browser** | release the tab; do not leave a project loaded in it |
| **server projects** | `leak-probe-mem` — a disposable project I created for the reproduction. Still needed for the ordering control; delete after. |
| **this checkout** (`scratch/`) | measurement scripts are gitignored and regenerable; fine to leave, but they are mine |

**The sampler is a live process on the production box** — one `ps` plus a
`/proc/meminfo` read every five minutes, unbounded. It is negligible but it is
mine, and leaving it would make it a mystery process on someone else's server.


## Tick log (autonomous, from 07:15 UTC)

Skip stepped back at ~07:10 UTC and asked for a recurring task and autonomous
work. Each entry below is one tick.

### 07:15 — the growth is not monotonic, and an earlier statement of mine was wrong

He reloaded his tab twice, at ~06:39 and ~06:53 (renderer pid unchanged, page
`performance.now()` reset, new session id in the crash-beacon lines, and no
timer-driven reload exists in `src/` — all four `location.reload()` sites are
user-initiated). So the reloads were his, not the app's.

From the fresh 06:53 document, idle, footprint:

```
06:55  1,133 MB      07:02  1,320 MB
06:56  1,162 MB      07:03  1,364 MB
06:57  1,135 MB      07:04  1,413 MB
06:58  1,215 MB      07:05  1,449 MB
06:59  1,233 MB      07:06  1,520 MB
07:00  1,251 MB      07:07  1,501 MB
07:01  1,267 MB      07:14    896 MB   <-- released ~600 MB
```

**What I told Skip at 07:10, what I retracted at 07:15, and what 45 minutes of
samples actually show — in that order, because I got it wrong twice.**

At 07:10 I told him the idle tab grew monotonically at ~31 MB/min, on twelve
minutes of data. At 07:15 a single later reading (896 MB) showed a 600 MB drop
and I retracted the rate, saying the idle behaviour was a sawtooth and no rate
was established.

**The retraction was too strong.** The continuous series to 07:25 is:

```
07:04  1,413      07:11    873   <-- releases 831 MB
07:05  1,449      07:12    923
07:06  1,520      07:13  1,000
07:07  1,501      07:14  1,058
07:08  1,607      07:15  1,116
07:09  1,660      07:16  1,195
07:10  1,704      07:17  1,265
                  07:18  1,345
                  07:19  1,430
                  07:20  1,496
                  07:21  1,572
                  07:22  1,660
                  07:23  1,760
                  07:24  1,843
                  07:25  1,925
```

**Thirteen consecutive samples, monotonically increasing, 923 → 1,925 MB in
thirteen minutes — ~77 MB/min, with nobody touching the machine.** JS heap flat
at 58–76 MB across every one of them. That is not noise and it is not a sampling
artifact.

So the shape is a **sawtooth on a rising baseline**: it climbs at 50–80 MB/min,
periodically releases several hundred MB, and the peaks keep going up — 1,704 at
07:10, 1,925 at 07:25 and still climbing. Both of my earlier statements were
wrong in the same way: **each rested on a window shorter than the cycle.** Twelve
minutes could not see the release. One post-release reading could not see that
the climb resumes immediately and goes higher.

The general form, and it is the one worth carrying: **an oscillation with a
rising baseline defeats any window shorter than its period, in both directions.**
Sample longer than the cycle or say nothing about the rate.

(One inconsistency worth flagging rather than hiding: the 07:15 tick read 896 MB
for this pid while the continuous series read 1,058 MB at 07:14:19. Two `top`
invocations seconds apart, 162 MB apart, more than the ~19 MB the climb rate
accounts for. I do not know which is right. The thirteen-sample monotonic run
comes from one instrument sampling itself consistently, which is why it is the
one I trust.)

### Typing is not the mechanism

Interleaved A/B on the reproduction tab — four minutes of sustained synthetic
text input, four minutes idle, repeated; interleaved rather than before/after so
drift cannot masquerade as effect. RSS by phase:

```
TYPE  184, 330, 106, 191, 167, 250, 117,  85   mean ~179 MB
IDLE  248, 240, 243, 260, 127                  mean ~224 MB
```

Idle averages **higher** than typing. No effect, and if anything typing provokes
collection. Ruled out.

**Completed run, 28 minutes, 12 samples per phase** (the numbers above were the
first half): TYPE mean **183 MB**, IDLE mean **238 MB**. Both phases swing
between 85 and 345 MB; neither trends. First sample 184 MB, last 284 MB, with
the swing an order of magnitude larger than the difference between the ends.

So the reproduction tab shows **no net growth over 28 minutes** — a much longer
window than the 7 minutes the earlier negative rested on, and RSS there is noisy
enough that nothing under ~100 MB of drift would be visible anyway. That is worth
stating plainly: this instrument could not detect his tab's *idle* rate even if
the reproduction had it. It could not miss the 82–180 MB/min his tab ran at while
he was active.

### The quantified difference between his tab and the reproduction

Measured the same way in both, same minute:

| | his tab | reproduction |
|---|---:|---:|
| shapes on page | 52 | 9 |
| rendered chat lines | 27 | **0** |
| iframes | 2 | 2 |
| DOM nodes | 8,050 | 906 |
| SVG child nodes | 274 | small |

The fleet chat panel is mounted in both (33 chat-classed elements in his) and
renders content in only one of them. That is still the largest untested
difference.

I built a disposable 20-section markdown fixture and linked it as
`leak-probe-mem` to add document weight. **It did not add pages** — a markdown
project renders as one `html-page` shape regardless of length, so the shape
count did not move. The project is disposable and can be deleted.

### Server, same tick

12,362 lag dumps total. 24 stalls in the 06:00 and 07:00 hours together; in the
07:00 hour, 3 stalls, median 251 ms, max 414 ms. Quieter than the overnight rate
of ~500/day, consistent with a quiet box rather than with anything being fixed.

### Small separate defect: the crash beacon records that something failed, not what

`client.log` carries 21 `client-crash` records in the current rotation, all
`unhandledrejection`, **three on every page load** — his and the reproduction's
alike. Every one has only `kind` and `url` in `data`.

`crashBeacon.ts` does try to record the reason: `message: clip(reason?.message ??
event.reason)`. `clip` returns `undefined` for `null`/`undefined`, so the field
being absent means the promises are **rejected with nothing**. `git grep` finds
no bare `Promise.reject()` or `reject()` in `src/`, so the source is a dependency
or a rejection whose reason really is nullish.

Three unhandled rejections per load is a real defect and the reporter cannot say
what they are. Not chased further — it is not the leak.


### 07:55 — it grows with the tab asleep, and faster over time

He has been away since ~07:10. Nobody has touched the machine. Continuous
series, same document, same renderer (pid 48640):

```
07:12    923 MB      07:45  4,372 MB
07:20  1,496 MB      07:46  4,538 MB
07:25  1,925 MB      07:47  4,713 MB
07:27  2,102 MB      07:48  4,890 MB
                     07:49  5,055 MB
                     07:50  5,196 MB
```

**923 → 5,196 MB in 38 minutes with no interaction at all.** ~112 MB/min
averaged; the last six samples are monotonic at ~165 MB/min. JS heap flat at
52–74 MB throughout.

**This retires the framing I gave Skip earlier** — that the leak ran 3–5× faster
while he was active. It does not need him. What it does is **accelerate with the
age of the document**: 31 MB/min in the first ten minutes, 77 in the second
quarter hour, 165 by the fortieth minute. The original tab reaching 15 GB in
ninety minutes is the same curve run longer, and its apparent correlation with
our conversation was a correlation with elapsed time.

### Failed experiment: the memory-infra bucket diff

The plan was to diff two `disabled-by-default-memory-infra` dumps and see
**which** allocator bucket grows, since the absolute snapshot already showed
8.1 GB sitting in `malloc`. It does not work as run:

- `levelOfDetail: 'light'` returns **empty allocator tables on some dumps**, so
  a diff renders every value as its own delta in one direction and as a full
  negative in the other. The completed run shows the browser process going
  `-376.8 MB malloc … now 0.0 MB`, which is the empty-table artifact, not a
  measurement.
- Only 1 of 11 processes produced the three dumps the diff needs. The renderer
  under investigation produced fewer.

Recorded as failed rather than dropped, because the shape of the output is
plausible enough to be mistaken for a result by whoever runs it next. **A dump
that returns an empty table and a process that genuinely freed everything are
the same JSON.**

Next attempt should use `levelOfDetail: 'detailed'`, which populates fully. That
OOM'd the collector on the first try, but the collector now aggregates each
event and discards it, so the reason it failed no longer applies.

### Server, same tick

12,372 dumps total; **13 stalls in the 07:00 hour**. The worst two:

```
740 ms  existsSync | (idle) | stat | (garbage collector) | readdir
655 ms  (anonymous) | utf8Write | broadcastFleet | (program)
```

The 740 ms one is the startup `migrateAllProjectParts` walk, which means **the
server restarted again during that hour**. The 655 ms one is the fleet broadcast
encoding, which is the recurring cost and not tied to a restart.


### 08:25 — the curve is reproducible; the bucket diff is abandoned

**His second tab is on the same curve as the first.** 12 GB at 89 minutes,
against 15 GB at ~90 minutes for the tab before it. Different documents, same
shape, same machine. 5,196 MB at 07:50 to 12 GB at 08:21 is ~220 MB/min, and he
has not touched it since ~07:10.

**The server restarts are deploys, not crashes.** Checked rather than inferred:
the Fly machine event log shows `launch` by `user` at 08:00 UTC and the version
has gone 1306 → 1308 → 1311 overnight. So the startup `migrateAllProjectParts`
stall is what a deploy costs, and it should not be carried as a fault. Stalls are
quiet — 14 in the 07:00 hour, 6 in 08:00.

**The memory-infra bucket diff is abandoned after a second distinct failure.**
The first attempt failed because some dumps return empty allocator tables. I
filtered those out and ran five dumps at 45-second intervals. The result:

- **The renderer under investigation produced exactly one populated dump out of
  five.** So does every other renderer. No diff is possible for the process that
  matters.
- The one process with two populated dumps shows `malloc −438.7 MB → 0.0` and
  `global +479.4 MB`. That is not a process freeing its heap. **The two dumps use
  different bucket schemas** — one itemises `malloc`/`cc`/`sqlite`/…, the other
  reports a single `global` roll-up. My "non-empty" filter passed both because
  both are non-empty.

So the failure is not dump count and not empty tables. **Dumps from the same
process are not schema-comparable**, and there is no filter that fixes that.
Stopping this line rather than building a third variant.

**What this costs the headline number, and it is worth saying.** The
`malloc 8,092 MB` figure came from a single dump of this same instrument. Given
that dumps disagree about their own schema, that reading needed a check it did
not originally carry. It has one: the itemised buckets summed to ~10.5 GB
against a process footprint of 8.8 GB at that moment — the right order, with the
overlap expected from `shared_memory` being counted in both the renderer and the
GPU process. An internally inconsistent dump would not land there. **The absolute
reading stands; the delta was never obtainable.**


### 08:35 — HIS TAB CRASHES. And I told him the opposite, from evidence that could not tell the difference

**The renderer is dead right now.** The page target still exists and CDP still
accepts a socket on it, but nothing answers in ten seconds, and there is no
renderer process for that page in `ps`. Chrome wrote a crash dump at **04:31
local (08:31 UTC)** — the minute pid 48640 disappeared at 12 GB.

**There is a second dump at 02:38 local (06:38 UTC)** — the minute the first
renderer, pid 34813, disappeared at 15 GB.

So both tabs died the same way: **the renderer grows to 12–15 GB over roughly
ninety minutes and then crashes.** The machine recovers immediately — swap fell
from 4.0 GB used to 1.9 GB and free memory went 33% → 63% the moment it died.

**This is the failure. Not "the app feels slow" — the tab dies, about every
ninety minutes.**

**And I got it wrong, confidently, in the way this file already warns about.** At
07:15 I wrote that the reloads were his own and said I had checked it four ways:
renderer pid unchanged, `performance.now()` reset, a new session id in the crash
beacons, and no timer-driven reload anywhere in `src/`.

- **The pid claim was simply false.** 34813 was replaced by 48640. I had the
  numbers in front of me an hour apart and did not compare them.
- **The other three cannot distinguish the two cases at all.** A reload and a
  crash-then-reload both reset `performance.now()`, both mint a new session id,
  and neither is caused by app code. I listed three checks that were consistent
  with my conclusion and read that as support.

Three observations consistent with a hypothesis are not three checks. **The
question was never "did the document change" — it was "why", and nothing I ran
addressed it.** What settles it is the crashpad directory, which took one `ls`.

**Consequences for the rest of this file.** Anywhere it says he reloaded, read
"the renderer crashed and the tab came back". In particular the 07:15 entry's
framing of a "sawtooth on a rising baseline" is one leak, one crash, one fresh
document, repeatedly — the large drops between documents are deaths, not
releases. The within-document sawtooth (the 831 MB drop at 07:11) is separate and
still real.

**Growth curve, now measurable across two full lifetimes:**

| document age | footprint |
|---|---|
| 1 min | ~1.0 GB |
| 10 min | ~1.2 GB |
| 25 min | ~1.9 GB |
| 40 min | ~3.2 GB |
| 70 min | ~5.3 GB |
| 89 min | ~12 GB |
| ~90 min | **crash** |

Both renderers followed it. The first reached 15 GB, the second 12 GB.


### 08:45 — the crash is confirmed from the dumps themselves

Both dumps carry `ptype`, `--type=renderer`, `RendererMain` and
**`renderer_foreground`**. So both are the renderer of a foreground tab, not a
GPU or utility process.

```
e04acc9c…dmp   02:38:34 local  =  06:38 UTC   ← pid 34813 vanished at 15 GB
c28bf827…dmp   04:31:39 local  =  08:31 UTC   ← pid 48640 vanished at 12 GB
```

(`stat` prints local time on this machine and the logs are UTC, four hours
apart. Both zones are written out here because a bare timestamp from `stat`
sitting next to a log line is the trap this repository has fallen into twice.)

No explicit out-of-memory string in either dump, which is expected — the
annotation set Chrome ships in a release build is minimal, and a renderer killed
for memory on macOS dies by exception rather than by writing a reason.

**His tab is still down.** Chrome is holding the crashed page and will not start
a new renderer until he interacts with it. Nothing to sample there until he
returns.

### Two experiments not run, and why

**Layout/recalc rate on his tab** — the measurement I wanted this tick, because
one early sample pair showed ~33 style recalcs per second on an idle page, and a
page laying out continuously would allocate raster memory in exactly the
unattributed bucket the footprint grows in. The job produced **no data**: it hung
against a renderer that was already dead. Its hang is corroboration of the crash
time and nothing else.

**The non-leaking baseline** — I wanted the same rate from the reproduction tab,
to see whether recalc rate tracks leaking. It is not reachable: the pooled
browser runs with `--remote-debugging-pipe` rather than a port, so there is no
CDP endpoint, and `LayoutCount`/`RecalcStyleCount` exist only over CDP. Standing
up a separate browser to obtain a *comparison* metric is not worth its cost on
this machine, so this is dropped rather than worked around.


### 09:15 — the "(idle) stalls are synchronous filesystem IO" inference is falsified

Earlier in this file I wrote, flagged as inference, that the ~90% of server
stalls topping out at `(idle)` were most likely time blocked in a native call
outside V8, **most likely synchronous filesystem IO on the volume**. That is
testable from `/proc` and it does not hold.

Server main process, 60 seconds:

| | delta over 60 s | rate |
|---|---:|---:|
| `read_bytes` (actual disk) | **24 KB** | 0.4 KB/s |
| `write_bytes` (actual disk) | 4.7 MB | 79 KB/s |
| `rchar` (read syscalls) | 181 MB | 3 MB/s |
| `syscr` | 49,380 | **823 reads/s** |
| `syscw` | 7,189 | 120 writes/s |
| `blkio_ticks` | **0** | — |
| voluntary ctxt switches | 51,301 | 855/s |
| nonvoluntary ctxt switches | 8,078 | 135/s |

**`blkio_ticks` is zero and real disk reads are 24 KB per minute.** The process
spends no measurable time waiting on the block device. Whatever the `(idle)`
stalls are, they are not the volume.

**And the obvious replacement guess fails too, so I am not substituting it.**
823 read syscalls a second looks like a lot, and it is — 181 MB/min of `rchar`
served from page cache. But at even 10 µs a call that is 8 ms of wall time per
second, and the stalls are 271 ms at the median. Syscall volume is off by more
than an order of magnitude from what it would need to explain.

So: **the `(idle)` stalls remain unexplained.** One stated inference tested and
killed; the next candidate killed by arithmetic before it could be written down
as a finding. What is established is only the negative — not disk IO, not
syscall volume, not CPU contention (load 0.67, PSI cpu 3.67), not JS (V8 records
no frames at all).


### 09:45 — a build froze the whole server for 101 seconds

The 09:00 hour took 24 stalls, double the 12 in 08:00, **with his tab dead** — so
these are not driven by his session. One of them is not like the others:

```
09:41:00  lag=100970ms   100784.5ms cpSyncCopyDir | 191.7ms (idle) | 60.7ms spawn | 5.6ms write | 4.1ms mkdir
```

**101 seconds.** `cpSyncCopyDir` is Node's synchronous recursive directory copy,
and it held the event loop for 100.8 of those seconds. For a minute and forty
seconds the server served nothing: no requests, no sockets, no fleet traffic.
The other 23 stalls that hour are the usual 265 ms median.

**Where it comes from.** Two recursive `cpSync` calls run on the event loop
during a build:

- `server/lib/build-dispatch.mjs:172` — publish. Copies each replaced item out
  of the build instance into a transaction directory inside the live project.
- `server/lib/build-qmd.mjs:281` — render. Copies the whole source tree into the
  output directory before Quarto runs.

**Best-supported attribution is the publish copy**, on three facts. The build
instance is created under `mkdtempSync(tmpdir())`, so it lives on the root
overlay (`none`, 7.8 G); the live project lives on the volume (`/dev/vdc`, 99 G).
**So publish is a cross-filesystem copy onto persistent storage.** And the
`output` directories are not evenly sized:

```
output, MB:  936, 33, 28, 23, 19, 13, 13, 10
source, MB:  106, 27, 21, 19,  6,  6,  5,  4
```

**One output tree is 936 MB, an order of magnitude above the next.** 936 MB in
100.8 s is ~9 MB/s, which is what a synchronous cross-filesystem copy onto a Fly
volume looks like.

**The gap, stated rather than papered over:** I have not established that the
936 MB project was the one publishing at 09:41. The stack names the function,
not the path. What is established is the shape — *a build publishes by copying
its whole output synchronously on the event loop, and the largest output here is
936 MB* — and that shape produces exactly this stall whenever that project
builds.

**Ruled out on the way:** `build-instance.mjs:16` seeds `build-cache` and
`.biber-par-cache` with the same recursive `cpSync`. Those directories are
**4 MB and 9 files at the largest**, across 19 projects. It cannot be this.

**Not fixed, deliberately.** The one-sentence version: *publish should not copy —
it should write the build instance onto the volume in the first place and swap by
rename, and failing that the copy should be `fs.cp` rather than `cpSync`.* That
touches the publish transaction, which has its own documented invariants in
`docs/what-the-old-push-did.md`, so it is Skip's call and not a 6am unilateral
edit.


### 10:10 — the multi-second stall class is a July problem, and I nearly reported it as current

Chasing the 101-second freeze, I found **143 stalls over 5 seconds all-time**,
with worst cases of 431 s, 239 s, 228 s, 222 s, 208 s. The top frames are
`(program)`, `all`, `run`, and `(anonymous) @ /app/shared/live-store.ts:1` —
alongside `compareIsoMinute @ /app/server/lib/fleet-store.mjs:85`. A page of
multi-minute total outages with an app file named in them.

**Then I checked the dates, and the class is gone.**

```
>5s stalls by date
  2026-07-25    7        2026-08-01    1
  2026-07-26   61        2026-08-15    2
  2026-07-27    7        2026-08-17    2
  2026-07-28   51        2026-08-21    1
  2026-07-29    4        2026-08-22    1
                         2026-08-23    5
                         2026-08-25    1   ← the cpSyncCopyDir freeze
```

**130 of the 143 are in a five-day window at the end of July.** Since 1 August
there have been thirteen, and today's single one is the copy. Every
`live-store.ts` example I pulled was dated 2026-07-25 — the first day the log
exists — and I had them on screen before I thought to look at the date column.

Whatever `live-store.ts` / `compareIsoMinute` was doing, it was fixed a month
ago. **Reporting it now would have been a month-old log line presented as a live
defect**, which is the failure this repository has a whole section about. The
check cost one `uniq -c` on a date prefix.

### Correcting the daily stall figure

I have been quoting "~500 stalls a day" from one 24-hour window. The actual
range:

```
08-16  104     08-20  996     08-24    407
08-17  757     08-21  764     08-25    161 (partial)
08-18  397     08-22  1020
08-19  643     08-23   989
```

**400 to 1,020 a day**, not ~500. The 499 I measured was a low-ish day.

### What is actually current, after all that

- **~400–1,000 event-loop stalls a day**, median 265 ms, ~90% naming no
  JavaScript and still unexplained.
- **`cpSyncCopyDir` in the build path**: 26 stalls all-time, routinely
  0.3–1.8 s, once **101 seconds** today.
- The multi-second `live-store` class: historical, ended July — **but the
  multi-second class as a whole came back on 25 Aug; see the 22:10 entry.**


### 11:15 — the lag profiler cannot answer "what entered the blocking call", and a third candidate dies

**The instrument's limit, established from its own output and its source.** A
dump is 583 bytes: `at`, `lagMs`, `stallStart`, `stallEnd`,
`samplingIntervalUs`, and one `sections` entry holding `sampledMs`, a `ranked`
aggregate and a single `stack`. `lag-profiler.mjs` aggregates the slice **by
label** and ranks by self-time, keeping the deepest stack for the heaviest label.

**Sample order is discarded.** So the profiler can say what was on the stack
during a stall and can never say what ran immediately before the loop went
quiet — which is exactly the question an `(idle)` stall poses. That is a real
limitation, not a gap in what I looked at.

**What it does establish, precisely.** One dump this hour:

```
lagMs 264   samplingIntervalUs 1000
sampledMs 330.6 | (idle)=328.5  journal @ source-lifecycle.mjs:80=1.1  (program)=1
```

Sampled at 1 ms across the stall, **328.5 of 330.6 ms carry an empty JS stack —
99.4%.** The sampler ran and recorded ~330 samples; it did not miss frames. The
isolate genuinely executed no JavaScript for the whole stall.

**The one JS frame present looked like a lead, and is not.**
`journal()` at `source-lifecycle.mjs:80` does `existsSync` + `readFileSync` +
`JSON.parse` synchronously on the event loop. There are **333 `operations.json`
files**; the largest is **7.9 MB**. Timed on the box, three runs on that file:

```
read 25.4ms  parse 10.8ms
read 20.6ms  parse 11.1ms
read 15.3ms  parse 22.0ms
```

**30–45 ms for the worst file. The median stall is 264 ms.** An order of
magnitude short, so it is not the cause and is not being written up as one.

That is the third `(idle)` hypothesis killed by measurement — synchronous disk
IO, syscall volume, and now this. **The cause remains unknown, and the honest
list is still only what it is not.**

**A real if secondary finding on the way past:** that 7.9 MB journal holds **23
revisions** — roughly 344 KB per entry — and it is read and parsed synchronously
on the event loop every time `journal()` is called. 30–45 ms is not a stall but
it is not free either, and the file grows with revision count.


### 12:25 — the (idle) stalls are the lag profiler measuring itself

Four hypotheses died before this one. The answer was in the timestamps the whole
time.

**Consecutive stall gaps today:** 100, 90, 70, 120, 110, 80, 140, 240, 170, 200
seconds. **Every gap is a multiple of ten seconds.** Lag values cluster tightly:
252, 253, 256, 264, 264, 265, 269, 271, 277, 303 ms. A fixed period and a fixed
cost is a timer, not contention.

**`server/lib/lag-profiler.mjs:32`: `WINDOW_MS = 10_000`.**
**`:218`: `windowTimer = setInterval(() => { void rollWindow() }, WINDOW_MS)`.**

`rollWindow()` → `cutWindow()` → **`await post('Profiler.stop')`**, on a
`new Session()` from `node:inspector` that is `connect()`ed **to its own
process**. A same-thread inspector session dispatches synchronously on the main
thread. Over a 10-second window that is **the whole profile tree serialized into a JS
object, on the event loop, every ten seconds.** (I first wrote "~10,000 samples"
here from arithmetic; measured, V8 delivers ~228 — see the 12:55 entry.)

The isolate has no JS frame on the stack while V8 does that work, so the samples
covering it carry an empty stack — **which is precisely the `(idle)` this file
has been chasing since 05:30.**

**Why it does not fire every ten seconds:** only cuts expensive enough to cross
the stall threshold get logged, so the gaps are 70–240 s rather than a steady 10.
And the start-seconds spread across mod-10 buckets because each server restart
re-phases the grid — the *gaps* stay on it.

**Confidence.** Four independent facts when this was written, and a fifth since:
43 of 43 consecutive stall gaps land exactly on the ten-second grid and no other
ten-second timer exists in the process — see the 13:30 entry. The restart test
(change `TLDA_LAG_PROFILER_WINDOW_MS`, watch the period follow) remains Skip's
call, but it is now confirmation rather than discovery.

**What this retires, and it is a headline I gave him in my first report.**

> "the server takes **480 event-loop stalls a day** and 90% of them name no
> JavaScript"

**Most of that is the profiler's own cost, reported as the server's.** Today:
157 `(idle)` against 9 `spawn`, 9 `existsSync`, 3 `utf8Write`, 2
`cpSyncCopyDir`. If the `(idle)` class is the window roll, the server's real
stall picture is the ~23 non-idle ones a day — and the genuine problems are the
ones already named: the build publish copy, the fleet broadcast encoding, and
synchronous spawn.

**The design note in the file is right about the wrong half.** Its opening
comment explains that V8's sampler runs on a dedicated thread, so sampling does
not block the isolate. True — and the cost is not in sampling. It is in
`Profiler.stop` handing ten thousand samples back across the same-thread
inspector boundary, which the note does not consider.

**The general shape, for the next person:** an always-on profiler that reports
stalls will report its own. **Before believing any stall class, check whether its
period matches the instrument's own timer.** One `uniq -c` over the gaps.


### 12:55 — the mechanism reproduces in isolation, and my sample-count arithmetic was wrong

Rather than wait on a restart, I reproduced the window roll in a standalone
process: same-thread `node:inspector` Session, `setSamplingInterval(1000)`,
`Profiler.start`, a busy loop so the window fills with real samples, then time
`Profiler.stop`.

```
window  2s   samples    43   Profiler.stop blocked  14.1 ms
window  5s   samples   106   Profiler.stop blocked  14.8 ms
window 10s   samples   228   Profiler.stop blocked  74.5 ms
```

**`Profiler.stop` blocks the main thread, and the cost grows with the window.**
The mechanism is real and does not depend on anything specific to the server.

**Correction to my own write-up an hour ago.** I said the roll serializes
"~10,000 samples (10 s at 1 ms)". **It does not.** V8 delivered **228 samples in
a 10-second window** despite a 1000 µs request — an effective interval of ~44 ms,
not 1 ms. The arithmetic was mine, not measured, and it was off by forty times.
The cost is in serializing the profile *tree* — nodes, call frames, position
ticks — not in raw sample count.

**The magnitude gap, stated rather than smoothed over.** 74.5 ms here against
~260 ms on the server. Same order, not the same number. A live server's window
holds far more distinct stacks and deeper frames than a synthetic busy loop, so a
3–4× richer tree is unsurprising — but **I have reproduced the mechanism, not the
magnitude**, and the two should not be conflated.

**Where that leaves the claim.** The period matching `WINDOW_MS` exactly, the
synchronous same-thread dispatch read from the code, and now a measured block of
the right order from an isolated reproduction. The one thing still missing is the
decisive test — change `TLDA_LAG_PROFILER_WINDOW_MS`, confirm the stall period
follows — which needs a restart and is Skip's call.


### 13:30 — the periodicity is exact, and the alternative is excluded by enumeration

I had been reading gaps off the **log line** timestamp, which is when the dump
was *written*. One gap came out at 201 s and broke the grid. The dumps carry
`stallStart` separately, which is the right measurement.

**44 dumps across hours 12 and 13. Every one of the 43 gaps:**

```
120 200 110 120 100 160  70 140 100 220  80  70 150 110  90  80 130 180  80 110
170 120 170 190  90 130 110  70  80  90 110  90  70 160 110 180  90 220 120  80
 70 120 200

mod 10:  0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
```

**43 of 43, exactly on the ten-second grid.** The 201 was an artifact of the
wrong timestamp. Dump-write lag is a tight 352–509 ms after `stallStart`, itself
consistent with a fixed-cost operation.

**And the one remaining alternative — a different ten-second timer — does not
exist.** Every `setInterval` delay in the server:

```
50 ms, 800 ms, 1 s, 5 s, 30 s (×2), 60 s (room evict), 5 min (source sync sweep)
```

plus named constants, none of them ten seconds. **`WINDOW_MS = 10_000` in
`lag-profiler.mjs` is the only ten-second period in the process.** A 5-second
timer cannot explain the data either: gaps include 70, 90, 110, 130, 150, 170 and
190 — odd multiples of ten — and nothing would force a 5-second timer to skip
exactly every other tick, every time.

**Where the claim stands now.** Period matches `WINDOW_MS` exactly across 43
consecutive intervals; no other timer in the process has that period; dispatch is
synchronous and same-thread by inspection; and the block reproduces in isolation
at the right order of magnitude. The restart test would be confirmation, not
discovery.


### 14:10 — the reproduction control was measured with an instrument that could not see the thing

**RSS understates this by an order of magnitude.** Same process, same instant,
the reproduction renderer:

```
footprint  782 MB
rss         71 MB
```

`ps -o rss` was reading **71 MB** while the process actually held **782 MB**.
Later sample: footprint 793 MB, rss 62 MB — footprint up, RSS *down*. On macOS a
compressed page leaves the resident set and stays in the footprint, so on a
memory-pressured machine RSS moves opposite to the truth.

**Every "the reproduction does not leak" statement in this file was built on
RSS.** The 7-minute watch that oscillated 92–131 MB; the 28-minute interleaved
A/B whose phases averaged 179 and 224 MB; the "no trend" conclusion. All of it
measured a number that had already been shown, on Skip's own tab, to be the
wrong one — **his tab was measured by footprint from the first sample onward.**
The subject and the control were never on the same instrument, and I did not
notice for nine hours.

**What is now visible.** That renderer is at **~790 MB footprint** and its peak
is **3.2 GB**. A tab I had been calling flat has been to 3.2 GB. Some of that is
my own ballast tests, which is exactly why a clean series is needed rather than a
conclusion.

**Corrections to earlier entries, so they are not read as standing:**

- *"Does not reproduce on a disposable project … RSS oscillates 92–131 MB, no
  trend"* — measured in RSS. **Withdrawn, and now replaced: measured by
  footprint it drifts at ~1.8 MB/min. See the 14:35 entry.**
- *"TYPE mean 183 MB, IDLE mean 238 MB"* — both RSS. The A/B's conclusion that
  typing is not the mechanism may survive, since both arms used the same wrong
  instrument, but the absolute numbers are meaningless.
- *"this control could not have detected his tab's idle rate"* — I wrote that as
  a caveat about the noise floor. **The real problem was worse than noise: it was
  the wrong quantity.**

**`vmmap -summary <pid>` and `footprint -p <pid>` both work on this machine** and
report physical footprint directly. `top -l 1 -n N` returns nothing locally and
`top -pid` is not permitted, which is why I fell back to `ps -o rss` in the first
place — a fallback I never revisited.

A clean footprint series on the reproduction is running now. **No conclusion
until it has run.**


### 14:35 — measured properly, the reproduction *does* drift, at ~1.8 MB/min

26 minutes of physical footprint on the reproduction renderer, alongside RSS for
the same process at the same instants:

```
footprint  793 796 747 750 752 748 752 757 760 759 761 762 762 763 765 765 764 769 770 769 775 782 773 786 786 776
rss         62  91  73 320 230  91 341 264  86 349  91 344 176 441  83 335 354  70 343  88  57  76 353  60 261  87
```

**Footprint moves smoothly. RSS swings between 57 and 441 MB over the same
window.** That is the instrument problem from the last entry, shown side by side:
one of these two columns is a signal and the other is noise, and every earlier
"no trend" conclusion in this file read the noisy one.

**The trend.** The first two samples are still settling after my ballast test;
the clean baseline is 747 MB at 14:09. From there to 786 MB at 14:31 is
**+39 MB in 22 minutes, ~1.8 MB/min**, near-monotonic with ±10 MB jitter. The
trend is several times the jitter.

**So "does not reproduce" was wrong, and so is treating this as the same thing.**

| | rate |
|---|---|
| reproduction, bare project, idle | **~1.8 MB/min** |
| his tab, idle | 30–77 MB/min |
| his tab, active | 165–220 MB/min |

**A bare tab drifts. His tab runs 20–100× faster.** Whether that is one
mechanism at different intensity or two different things is **not established**,
and the numbers alone cannot decide it. What the reproduction now gives that it
did not before is a **live, freely-instrumentable process that grows** — a heap
snapshot on it is affordable in a way one on his 12 GB tab never was.

A 75-minute series is running to firm up the rate against the jitter.


### 15:10 — the drift holds over 51 minutes, and there is now an instrumentable process

**Longer series, one sample a minute, reproduction renderer:**

```
14:09  747      14:41  784      14:53  796
14:35  790      14:44  785      14:56  796
14:36  781      14:47  796      14:58  800
14:38  780      14:49  798      15:00  802
```

**747 → 802 MB over 51 minutes, ~1.1 MB/min**, jitter ±5–10 MB. The earlier
26-minute window gave 1.8 MB/min; over the longer run it settles near 1.1. Either
way the trend is now several times the jitter and the drift is not in doubt.

*(The 75-sample run raced after 15:00:31 — its `sleep` stopped taking effect and
it burned the remaining iterations in seconds, so the file has ~20 rows sharing
one timestamp. Only the 26 rows with distinct timestamps are data.)*

**And the blocker is now cleared.** Every attempt to point a real instrument at
the reproduction has failed because the pooled browser runs with
`--remote-debugging-pipe` and exposes no CDP endpoint. So I launched a separate
Chrome for Testing on port 9333, headless, its own `--user-data-dir`, pointed at
the disposable project — nothing to do with Skip's browser or the pool — and
armed `Memory.startSampling` on it. That is the sampler that found the 2.28 GB
single allocation site on his tab.

**Caveat, before the result exists: headless has no GPU process and no
compositing.** If the growth is compositor- or raster-related, this instance will
not reproduce it, and a flat series here would say something about headless
rather than about the app. The footprint series on it (starting at 36 MB) is what
decides whether the experiment is valid at all.

**Server this tick:** 35 stalls in hour 14, 4 so far in hour 15. His tab: dead,
tenth consecutive tick.


### 15:45 — two attempts at an instrumented browser, neither loaded the app

The plan was to get a CDP endpoint onto a leaking reproduction so the native
allocation sampler could run on it. Both attempts failed, and both failed in the
way this project warns about specifically.

**Headless, port 9333.** Ran flat at **35 MB for twenty minutes**. It *had*
loaded — 9 shapes, 1 canvas, 1 iframe — but was sitting in the "Set up your
workspace" onboarding state, and 35 MB against the headed pooled tab's 858 MB
with a comparable shape count is a 20× gap. **A flat series there measures
headless, not the app.** The caveat I wrote before starting it turned out to be
the result.

**Headed, port 9334.** Six renderers, all 24–36 MB, and `/json/list` shows a
single page target with an **empty URL**. The tlda address passed on the command
line never navigated. Nothing loaded at all.

**Stopping here rather than building a third.** Two rigs in one tick that
produced numbers while measuring nothing is exactly *"they set up environments in
which nothing happens and then are like, oh, nothing's happening"*. Both are
reaped and their profile directories deleted.

**What this leaves.** The one genuinely leaking, genuinely headed reproduction is
the pooled Playwright tab — now at **872 MB**, up from 802 at 15:00, still
drifting at roughly 1.4 MB/min. It cannot be instrumented: the pool runs with
`--remote-debugging-pipe`, so there is no CDP endpoint, and `playwright-cli` has
no verb that exposes one. **The instrumented-reproduction path is blocked, and I
am recording that rather than continuing to spend ticks on it.**

**His tab has gone from "DEAD" to "no page"** — the target itself is no longer
listed, so the tab was closed rather than merely crashed-and-held.


### 16:20 — his tab is gone; the reproduction shows the same unaccounted shape

**His browser now reports zero page targets.** Not crashed-and-held, not
unresponsive — the tab is closed. Nothing to sample there until he opens one.

**The reproduction keeps drifting**, and it now has enough history to be a proper
subject in its own right:

```
15:00  802 MB      15:45  872 MB
15:20  ~810 MB     16:00  889 MB
                   16:16  903 MB
```

**802 → 903 MB over 76 minutes, ~1.3 MB/min**, consistent with the earlier
1.1–1.4.

**And the accounting looks like his.** First census sample, same instant:

```
footprint   903 MB
JS heap     136 MB
canvas ×3   7.8 MB
DOM nodes     901
SVG nodes     234
iframes         2
shapes          9
```

**~760 MB unaccounted for.** That is the same shape as his tab at 8.8 GB —
~100 MB heap, 82 MB canvas, 8.1 GB in Chrome's unattributed `malloc`. A tab
holding 901 DOM nodes and 9 shapes has no business at 903 MB.

One thing that differs from earlier readings on this same tab: **the JS heap is
136 MB now against 68–101 MB earlier**, so unlike his, this heap is also
growing — slowly, and nowhere near fast enough to explain the drift. A 22-minute
census of canvas count, canvas area, node count and heap is running alongside
footprint to see whether any of them tracks the 1.3 MB/min.

**Server:** 44 stalls in hour 15, 10 in hour 16.


### 16:45 — footprint climbs while every in-page count stays exactly constant

The census got five samples before the tab was taken away. In that window:

```
16:16  fp 903 MB   canvas 3 / 7.8 MB   nodes 901   svg 234   iframes 2   shapes 9   heap 136
16:17  fp 894 MB   canvas 3 / 7.8 MB   nodes 901   svg 234   iframes 2   shapes 9   heap 122
16:18  fp 893 MB   canvas 3 / 7.8 MB   nodes 901   svg 234   iframes 2   shapes 9   heap 164
16:20  fp 909 MB   canvas 3 / 7.8 MB   nodes 901   svg 234   iframes 2   shapes 9   heap 133
16:22  fp 918 MB
```

**Footprint 903 → 918 MB while canvas count, canvas area, DOM nodes, SVG nodes,
iframe count and shape count are byte-for-byte identical across every sample.**
The JS heap oscillates 122–164 with no direction.

So on the reproduction, as on his tab, **the memory grows without anything
countable in the page growing with it.** That rules out accumulating canvases,
accumulating DOM, and accumulating shapes as the mechanism — the three things
easiest to reach from page JS, and now all excluded by direct measurement rather
than by argument.

**The tab was swept, not crashed — checked before saying so.** pid 1868 is gone,
the pool reports **75% memory pressure**, `tlda-dev pw` parks stale tabs by
design, my tab is now `about:blank`, and two fresh renderers appeared at exactly
16:22. Pool housekeeping. It died at 918 MB, nowhere near the 12–15 GB at which
Skip's renderers actually crash, so reading it as an OOM would have been wrong.

A new subject is loaded on the disposable project (903 nodes, 9 shapes, renderer
identified by a 200 MB ballast: 233 → 437 MB) and a 60-minute census is running
on it.


### 17:15 — the drift reproduces from a cold tab; I am dropping the his-tab sampling

**Fresh subject, same behaviour.** The replacement tab went **233 MB at 16:45 to
291 MB at 17:15 — ~1.9 MB/min** — with canvas count and area (3 / 7.8 MB), DOM
nodes (903), SVG nodes (234), iframes (2) and shapes (9) **identical in every
sample**, and the JS heap oscillating 33–62 MB with no direction. Same shape as
the tab before it and as his. The drift is now reproduced across two independent
cold starts.

**Skip is back at work, so I have stopped sampling his tab.** His browser has
pages open again. The reason for watching it — he was away and it was crashing
unattended — no longer holds, and inspecting a tab he is actively working in is
not something this project permits. **No project of his is named anywhere in this
file or in any commit, and none will be.**

That removes step (1) of the loop's brief for the his-tab half. The server half
and the reproduction stand.

**A methodological note for whoever picks this up:** `sleep` inside these
`nohup`ed shell samplers stops taking effect after a while — two separate series
have raced through their remaining iterations in seconds, leaving many rows
sharing one timestamp. **Only rows with distinct timestamps are data.** Use a
sampler that re-checks the clock rather than trusting `sleep`.

**Server:** 32 stalls in hour 16, 6 in hour 17.


### 17:50 — the control that anchors the whole attribution, finally run

Everything in this file attributes the growth to the app. **Until now nothing
excluded the alternative: that any renderer on this machine drifts**, under the
memory pressure this box has been under all day. That control costs one command
and I had not run it.

Same browser process tree, same host, same instant:

| renderer | uptime | footprint |
|---|---|---|
| **the app's tab** | 1:27:25 | **354 MB** (from 233 MB — **+121 MB**) |
| **sibling, non-app** | 1:27:28 | **23 MB** (24 MB an hour earlier — flat *over that window*; it later took a single 27 MB step — see 18:25) |

The sibling is `--type=renderer --renderer-client-id=7` — a real renderer, not a
utility process, so it is a fair comparison.

**Eighty-seven minutes, identical conditions: the app's renderer gains 121 MB and
the one next to it gains nothing.** That excludes the machine, Chrome itself,
memory pressure, and the compressor as explanations. **The growth is the app's
page.**

It also retro-fits the reproduction: the drift is ~1.9 MB/min sustained across
65 minutes and two cold starts, with canvas count and area, DOM nodes, SVG nodes,
iframes and shapes constant in every sample throughout.

**Server:** 21 stalls in hour 17.


### 18:25 — correcting the control claim, and the reproduction releases too

**The sibling is not "flat", and I said it was.** Thirty-five minutes after I
wrote that it "gains nothing", it read **50 MB against 23**. So the sentence in
the previous entry and in its commit message was too strong.

**What it actually did**, from a tighter paired series, five samples over 85
seconds:

```
18:23:40   app 387 MB   sibling 50 MB
18:24:02   app 384 MB   sibling 50 MB
18:24:23   app 336 MB   sibling 50 MB
18:24:44   app 346 MB   sibling 50 MB
18:25:05   app 349 MB   sibling 50 MB
```

**The sibling is pinned at 50 MB in every sample.** It took one 27 MB step
somewhere in the preceding half hour — almost certainly loading something, since
I do not know what page it holds — and has not drifted since. **It steps; it does
not drift.** The control's force survives, but the accurate statement is "does
not drift", not "gains nothing", and I should not have reached for the stronger
one.

**And the reproduction releases, which is new here.** The app renderer dropped
**387 → 336 MB inside forty seconds**, then resumed. That is the same
within-document sawtooth seen on his tab at 07:11, now visible on the
reproduction. **So single-sample deltas on this process are worthless** — the
release amplitude (51 MB) is larger than half an hour of drift (~30 MB). Only
series spanning multiple cycles mean anything, which is the same lesson as the
07:15 and 15:00 entries and the third time it has bitten.

**Net over the long run, which is what stands:** 233 MB at 16:45 to ~350–385 MB
at 18:25, **95 minutes, ~1.6 MB/min**, sawtooth included.

**Server:** 12 stalls in hour 18.


### 19:00 — timer bisect: every interval in the page cleared

**Pre-clear baseline is solid.** 233 MB at 16:45 to **409 MB at 18:56**, uptime
2:33:49 — **~1.16 MB/min sustained over 153 minutes**, sawtooth included. The
sibling has held **50 MB across three samples 25 s apart and across the last 35
minutes**, so "does not drift" now rests on a proper window rather than the
single reading I over-claimed from earlier.

**The experiment.** Cleared every timer id in the page —
`for (let i=1;i<20000;i++) { clearInterval(i); clearTimeout(i) }`. The page
survives it: 906 DOM nodes, 9 shapes, heap 58 MB, unchanged in structure.

The app has a lot of these: two 1 Hz chat re-render tickers, the live-perf
sampler, a sync-status poll at 5 s, a source-conflict poll at 5 s, a notes fetch
at 15 s, a fleet-data refresh at 30 s, plus whatever tldraw runs. **If the drift
is timer-driven it should now stop; if it continues, it is not.** Either answer
narrows this a great deal, which is why the blunt version is worth running before
anything subtler.

Immediately after the clear: 410 → 392 → 393 MB, which is within the sawtooth's
own amplitude and means nothing yet. A 40-minute clock-driven series is running.

**A note on the sampler itself:** `sleep` inside `nohup`ed shells has silently
stopped taking effect twice today, racing two series through their iterations.
This one re-checks the wall clock each pass instead of trusting `sleep`.

**Server:** 30 stalls in hour 18.


### 19:30 — clearing every timer did NOT stop the drift

Thirty minutes after clearing every `setInterval` and `setTimeout` id in the
page:

```
18:59  408      19:09  443      19:19  420      19:27  436
19:01  404      19:11  411      19:21  423      19:29  436
19:03  413      19:13  410      19:23  429
19:05  422      19:15  416      19:25  431
19:07  435      19:17  416
```

**408 → 436 MB, ~0.93 MB/min**, sawtooth intact (443 → 411 at 19:11). The
pre-clear rate was ~1.16 MB/min over a longer window. **Within the variation this
process shows, the drift is unchanged.**

**So it is not driven by `setInterval`/`setTimeout`** — not the two 1 Hz chat
tickers, not the live-perf sampler, not the 5-second polls, not the 15- and
30-second refreshes. That is a clean negative from a decisive experiment, and it
removes the largest remaining family of app-side suspects.

**What it does not rule out, stated precisely:** clearing timer ids does nothing
to `requestAnimationFrame` loops, WebSocket message handlers, or promise chains
already in flight. **tldraw renders on rAF**, so that is now the leading
candidate, and suppressing it is the next experiment — already armed, with a
series running.

### The sibling control is dead — someone else started using it

In the same window the sibling renderer went
**44 → 408 → 3,584 → 3,747 → 757 → ~790 MB**. That is another agent's workload
landing in the pooled browser, not a property of anything I am testing.

**It is no longer a control and I am not treating it as one.** Its value was the
17:50–19:11 stretch, where it held 44–50 MB while the app's renderer climbed;
that comparison stands on its own window. Anything after 19:13 is somebody
else's tab.

**Server:** 20 stalls in hour 19.


### 20:00 — suppressing requestAnimationFrame did NOT stop it either

rAF suppression was real and load-bearing: **2,072 calls blocked in 30 minutes**,
~1.1 per second, so something in the page asks for frames steadily and was being
denied throughout.

```
19:30  436      19:40  421      19:50  423      20:00  434
19:32  412      19:42  423      19:52  423
19:34  407      19:44  422      19:54  427
19:36  414      19:46  404      19:56  429
19:38  417      19:48  419      19:58  435
```

Endpoints are misleading here because 436 was a peak — the honest read is
trough-to-latest: **407 at 19:34 → 434 at 20:00, ~1.0 MB/min**, and the later
trough of 404 at 19:46 → 434 gives 2.1. **It is still climbing.**

Three measurements of the same process now:

| condition | rate |
|---|---|
| untouched | ~1.16 MB/min |
| all timers cleared | ~0.93 MB/min |
| timers cleared **and** rAF suppressed | ~1.0 MB/min |

**Neither of the two largest app-side drivers is responsible.** Not
`setInterval`/`setTimeout`, not `requestAnimationFrame`. Both eliminated by
direct suppression rather than by argument.

### Next: WebSocket traffic — armed, with a limitation I can't remove

The page holds two sockets, fleet and sync. I have blocked the `WebSocket`
constructor and dispatched `offline`, and **the app has entered its own offline
state** — `sync-offline-badge: ⚡ offline` is in the DOM and **zero** reconnects
have been attempted since.

**What I cannot confirm:** that the two pre-existing sockets are closed at the OS
level. `navigator.onLine` still reads `true` (dispatching the event does not
change the property), and without CDP I cannot enumerate live sockets on this
browser. So the honest statement of what is being tested is **"the app has
stopped its sync activity and opens no new sockets"**, not "no bytes arrive". If
the drift continues under that, socket *handling* is not the driver; if it stops,
the result is suggestive but not clean.

**Server:** hour 19 closed at 20 stalls.


### 20:40 — with the app offline, the drift stops

Thirty-five minutes with the `WebSocket` constructor blocked and the app in its
own offline state:

```
20:05  445      20:15  450      20:25  461      20:35  446
20:07  447      20:17  452      20:27  461      20:38  448
20:09  448      20:19  466      20:29  460      20:40  446
20:11  447      20:21  466      20:31  463
20:13  449      20:23  461      20:33  462
```

**445 → 446 MB over 35 minutes. Flat**, with a rise to 466 and a return. The
preceding condition — same tab, timers already cleared, rAF already suppressed —
was climbing at ~1.0 MB/min, which over this window would have predicted ~480 MB.
It is at 446.

**The four conditions, same process, in order:**

| condition | rate |
|---|---|
| untouched | ~1.16 MB/min |
| timers cleared | ~0.93 MB/min |
| timers cleared + rAF suppressed | ~1.0 MB/min |
| **+ app offline, no new sockets** | **~0 MB/min over 35 min** |

**The one thing that changed between the third row and the fourth is the app's
sync and socket activity.** That is the first suppression all day that moved the
number.

**Caveats, and they matter:**

- **This is cumulative, not isolated.** Timers and rAF were still suppressed. The
  claim is only that socket/sync activity is *necessary* for the drift, not that
  it is sufficient on its own.
- **I could not verify the two pre-existing sockets closed at the OS level** —
  only that the app entered its offline state and constructed no new ones.
- **35 minutes is not long**, and this process has a sawtooth with ~50 MB
  amplitude. The window is comparable to the ones that showed clear climbing, but
  a longer flat stretch would be worth more.
- There was a step from 434 to 445 between 20:00 and 20:05 — **the offline
  transition itself allocated**, which is why the window starts at 445.

**Next, and it is the right control:** repeat on a fresh tab in the opposite
order — offline from the start, measure, then allow sockets — so that ordering
and accumulated state cannot explain it. A result that only appears when
suppression is applied late is not the same as one that reproduces from cold.

**Server:** hour 19 closed at 20.


### 22:10 — the multi-second stall class is NOT historical, and a nine-minute freeze

**Retracting my own 10:10 entry.** I wrote that the >5 s stall class "ended in
July — 130 of 143 in a five-day window, thirteen since August 1." True when
measured; **stale by evening.** Today alone, stalls over 3 s:

```
18:58:40Z   116,055 ms   cpSyncCopyDir
19:29:56Z     5,545 ms   emit @ node:events
20:27:57Z   550,750 ms   <-- nine minutes
20:40:42Z    61,904 ms   emit | listOnTimeout | onStreamTimeout
20:54:07Z     6,561 ms   lag-profiler.mjs:189
21:55:38Z    10,585 ms   consoleCall
21:56:46Z     3,310 ms   spawn
```

**The 550-second one is tldraw sync-room session teardown:**

```
84,823 ms  close @ node_modules/ws/lib/sender.js:184
65,021 ms  cancelSession @ @tldraw/sync-core/.../TLSyncRoom.mjs:250
41,043 ms  scheduleFollowUpPrune @ @tldraw/sync-core/.../TLSyncRoom.mjs:83
```

Nine minutes with nothing served.

**It lands in `reliability-pm`'s first measurement window.** Their 983 / 1674 /
2064 / 2328 s late arrivals were reported at 20:47Z; the 550 s freeze is 20:27Z
and the 62 s is 20:40Z. **So their original observation was real and their
retraction was right for the wrong reason** — not CPU starvation from renders,
and an idle-looking box is exactly what a dead event loop looks like.

**It does not explain their second set** (139 / 153 / >200 s, quiet box, 22:04Z):
the worst stall in that window is 10.5 s, and ten seconds cannot make a
150-second admit. That one is still uncaused.

**Second instance of the publish copy: 116 s.** `560bdd692` fixes it and is
**not deployed**, so it recurs. Twice today — 101 s and 116 s.

**And my profiler magnitude was the median, not the range.** I reported ~265 ms
every 10 s. `20:54:07Z lag=6,561 ms` is topped by `lag-profiler.mjs:189`, and it
appears inside the 62-second stall too. The mechanism stands; occasionally its
own cost is multi-second.

### What I read in the admit path, for whoever takes it

`source-proposal-admit` → `admitProposal` → `dispatcher().admitBuild`. Structure,
from `server/lib/build-queue.mjs`:

- `admitBuild` runs inside **`serializeProject(project, …)`**, which the
  dispatcher wires to **`serializedPublication`** — the *same* per-project lock
  `publishBuildInstance` takes. **An admit waits behind that project's own
  publish.**
- Inside that, it runs **`transition(…)`**, and `transition` chains on a single
  module-level promise **shared by every project**. So an admit for project A can
  also queue behind a transition for project B.
- `drain()` does **not** await the build — `start(row)` is fire-and-forget — so
  admit never waits for a render to finish.

That is structure I read, not a measured cause, and it does not by itself account
for 150 s on an idle box.


### 22:30 — two corrections received, and a queue wedge worth naming

**`reliability-pm` corrected their own sync-latency figure.** Admission is
**~8 seconds**, not 139–200. Their instrument polled `/source-head`, which is the
**published** revision, so it measured time queued behind a **stopped build
worker** rather than admission. The event loop stayed responsive throughout.

**That confirms the call I made rather than contradicting it.** When the 139–200 s
figure reached me I said an event-loop block could not explain it: the worst
stall in that window was 10.5 s and ten seconds cannot produce a 150-second
admit. The admit path was never the problem. The structure I recorded for it —
`admitBuild` inside the per-project publication lock, inside a globally-shared
`transition` chain — is real, had no symptom to explain, and stays filed as
*structure read, not measured cause*.

**The wedge itself, from `server/lib/build-queue.mjs`:**

```
maxConcurrency  defaults to 2                  (:16)
activeCount += 1        in start()             (:93)
activeCount -= 1        ONLY in onExit()       (:114)
drain()   while (activeCount < maxConcurrency) (:79)
```

`activeCount` comes back down in **exactly one place**: the worker's `onExit`. A
worker that stops without exiting — SIGSTOP, a paused process group — never fires
it. **One such worker halves build capacity; two wedge the queue permanently
until the process restarts.** Nothing re-derives the count from live workers.

This is the shape the repository already has a rule about: **state that must be
set exactly once, rather than computed, is the state that gets stuck.** A count
derived from the live `running` map could not wedge.

**Unverified, and flagged as such:** that the paused process group was a
dispatched build worker, and that `activeCount` is currently non-zero on the live
server. Both checkable; both possibly another lane's.

### The sync-core task, and why I did not do it

Asked to take the 550 s `cancelSession` / `scheduleFollowUpPrune` stall. I did
the establishing work and it argues against changing anything:

- **The stall is the run-up to an OOM kill.** Machine started 20:16:45Z, loop
  blocked 20:18:47→20:27:57, machine killed 20:37:33Z with
  `exit_code=137, oom_killed=true`. On a box heading into OOM everything is slow,
  so those frames are where time landed, not the cause.
- **Room residency is `{resident: 2, idle: 2}`** — two rooms cannot make a
  per-room 1-second prune expensive. Killed my own hypothesis.
- **`@tldraw/sync-core` is a plain `5.2.0` registry dependency.** Only
  `@tldraw/editor` is forked. Changing it means forking a second package.
- **Room eviction only closes rooms with zero sessions** — it cannot produce a
  mass teardown.

**The live picture instead**, four samples over two minutes on the 4 GB machine:

```
22:15:23  serverRSS 1457 MB   memFree 474 MB
22:16:03  serverRSS 1458 MB   memFree 462 MB
22:16:43  serverRSS 1467 MB   memFree 433 MB
22:17:23  serverRSS 1530 MB   memFree 178 MB
```

**178 MB free**, server at 1.5 GB, an R render alongside, process ~1h40m old and
on the same trajectory as the one that died at 20:37. **What the 1.5 GB consists
of is not established** — that is the open question.


### 22:40 — what the server's 1.5 GB is made of, so far

Measurement only, authorised by sol-dev. No changes, no restart, no deploy.

**The process** (`/proc/<pid>/status`, `smaps_rollup`):

```
VmRSS       1,490,744 kB   (1.49 GB)
Anonymous   1,340,524 kB   (1.34 GB — 90%)
Pss_File      149,471 kB
VmSwap                0 kB
Threads              15
```

**So it is not page cache.** 90% is anonymous — real heap and native allocation.
A 10.9 GB SQLite file could have explained a large *file-backed* RSS; it does not
explain this.

**One quarter of it is configured, not leaked.** `server/lib/fleet-store.mjs:364`:

```js
this.db.pragma('cache_size = -262144')     // negative = KiB, so 256 MiB
this.db.pragma('mmap_size = 1073741824')   // 1 GiB, file-backed
```

A negative SQLite `cache_size` is **kibibytes**, so that is a **256 MiB page
cache — malloc'd, therefore anonymous.** The `[heap]` (brk) mapping measures
**257 MB**, which matches it almost exactly. The 1 GiB `mmap_size` is file-backed
and shows up as the 110 MB of `fleet.db` resident, well inside `Pss_File`.

**The rest is the open part**, and its shape is unusual:

```
anonymous mmap regions   2,605
anonymous mmap total     1,050 MB
   >100 MB                   1   (128 MB)
   10–100 MB                 5   (64, 62, 52, 15, 14)
   <10 MB                2,599
```

**2,599 small mappings holding most of a gigabyte.** The single 128 MB region is
consistent with a V8 heap cage; the long tail is not obviously anything yet.

**The discriminator I am running now**, and it is fully passive: sample the
region *count* against the region *total* over ten minutes. If the total grows
while the count is flat, growth is inside existing heaps. If the count grows,
mappings are accumulating — a different defect with a different fix.

**What I cannot get passively, stated plainly:** Node's own breakdown — `heapUsed`
vs `external` vs `arrayBuffers` — which is what would separate "V8 heap" from
"Buffers nobody freed". The server records no memory anywhere (`process.memoryUsage()`
appears once in the tree, in `bin/fleet-daemon.mjs`, not the server), so there is
no history to read either. Getting it on a running process means `SIGUSR1` to open
the inspector. **That is a live intervention on production and I have not done
it** — it is not undoable without the restart nobody is allowed to perform.


### 22:50 — I cannot show the server leaks, and the admit handler is not the 139 s

**The memory discriminator, seven samples over 7.5 minutes:**

```
22:40:14  rss=1454MB  regions=2605  anon=1050MB  brkHeap=257MB
22:41:29  rss=1457MB  regions=2608  anon=1052MB  brkHeap=257MB
22:42:44  rss=1310MB  regions=2017  anon= 905MB  brkHeap=257MB   <-- releases 591 regions
22:43:59  rss=1335MB  regions=2121  anon= 931MB  brkHeap=257MB
22:45:14  rss=1335MB  regions=2127  anon= 930MB  brkHeap=257MB
22:46:29  rss=1362MB  regions=2237  anon= 958MB  brkHeap=257MB
22:47:44  rss=1368MB  regions=2245  anon= 963MB  brkHeap=257MB
```

- **`brkHeap` is 257 MB in every sample.** The SQLite page cache is fixed, fully
  resident and deliberate. It is a quarter of the process and it is not growth.
- **Count and total move together** (~0.44 MB/region): growth is **more
  mappings, not bigger ones**, at ~46 regions/min.
- **It releases in bulk** — 591 regions and 147 MB at once — then climbs again.
- **Net over the window: 1454 → 1368 MB. Down.**

**Retracting my own framing from 22:20.** I told sol-dev the server "does not fit
in 4 GB and is killed every couple of hours," which implied unbounded growth.
**Over 7.5 minutes there is no growth to show** — it sawtooths around 1.3–1.5 GB,
the same shape as the renderer. Third time today a sawtooth nearly became a
trend in my hands; this time I sampled long enough first.

**What actually explains the 20:37 OOM** is the baseline *plus* what runs beside
it: an R render at 254 MB and build workers, on a 4 GB machine. **The baseline
does not leak; it leaves no room.** Machine size, moving builds off, or a smaller
cache on a small box are all placement calls and none of them mine.

### The admit handler, measured on `sync-watch`

| per-call cost | measured |
|---|---|
| `operations.json` read + parse | **0.5 ms** (29 KB, 77 revisions) |
| `for-each-ref refs/tlda/proposals/` | **6 ms** (77 refs) |
| `spawn` to reach git, from a 1.5 GB process | **260–766 ms** (lag profiles) |

`reliability-pm` disproved their own accumulated-refs guess and this confirms it
from the server side. **One nuance kept:** their 6 ms is the git work, but
`listProposalRefs` reaches git via `runGit`, which is a **spawn** — forking a
1.5 GB address space, which the lag profiles put at 260–766 ms. The real per-call
cost is the fork, not the ref walk.

**It changes nothing about the 139 s.** 766 ms is three orders of magnitude
short. **Everything the server does in that handler is fast**, so the delay is
the daemon side, the network, or the round trip — not handler computation. Not
my lane and I did not take it.


### 23:05 — the ordering control never armed, and the pooled browser is wedged

**I told `app-tester` the control was running. It was not.** Every `pw` call for
several minutes:

```
pw: "tab-list" on session "shared-3" exceeded 120s and was killed —
    the pooled browser daemon is not answering.
pw: couldn't resolve my tab (daemon wedged or session down); not forwarding
```

The eval meant to block `WebSocket` and take the app offline **never reached the
page.** Had I not checked, I would have reported a flat thirty-minute result from
a tab that was never armed — a suppression measured on an unsuppressed tab. That
is the environment-where-nothing-happens failure, in its most expensive form: it
would have looked like confirmation.

**Pool memory pressure 83%**, threshold 90%, daemon unresponsive on `shared-3`.
Two renderers exist under that session (23 MB and 186 MB) and I could not even
run the ballast test to learn which was mine.

**Also corrected to `app-tester`:** I had told them my control would not collide
with their replay. I had not checked, and the claim was worth nothing. They share
`shared-3`, their replay is heavy socket and sync traffic, and that is precisely
the path my suppression result points at — so it would have contaminated the
control had either of us been running.

**Standing rule this reinforces:** on a shared pooled browser, *confirm the
instrument armed before trusting a null result.* A suppression experiment whose
suppression silently failed produces the same shape as a successful suppression.

**Sequencing agreed:** `app-tester` goes first. Their replay carries a real
conflict and a run of failed publishes, which is better load to trace than a
synthetic idle tab. I will sample the footprint of their replay's renderer with
my own instrument rather than adding a second one, at 60s intervals, **physical
footprint not RSS.**


### 23:15 — pool reaped; a separate severe renderer case surfaced

`app-tester` authorised the reap and put forward a better candidate than mine
before I could blame ambient load: they had left a tab on a project that loads
**748 pages, all priority, none deferred**. On it, `() => document.readyState`
took **over 40 seconds** to return, a screenshot could not complete for ~5
minutes, and at **151s the page reset its own sync socket**.

Reap result:

```
browser reaped
renderers under shared-3   0
pool memory pressure       83%  ->  78%
```

**Five points of pressure returned when that browser died.** Not proof, but a lot
of memory to have been resident in one session, and consistent with their
account.

**Logged as a separate case, not as my leak.** Skip's tab reached 15 GB on a
*small* project, so page count is not the mechanism I am chasing. But eager
loading at that scale is its own severe renderer-memory problem and I had not
seen it before. Worth measuring properly — footprint on that project's renderer —
**after** the replay, and only if `app-tester` does not want it.

**Sequencing:** `app-tester` runs the replay first; I hold the pool clear and
open no tab until they are done. My ordering control runs afterward against a
quiet pool, which is a better measurement than the one that never armed.


## Known and unmeasured: the 748-page eager load

**Recorded on `sol-dev`'s instruction and then dropped. Nobody has measured it.**
It is written down here so it is not lost and not mistaken for a finding.

A project exists that loads **748 pages, all priority, none deferred**. Observed
by `app-tester` on 2026-08-25, not by me:

- `() => document.readyState` took **over 40 seconds** to return
- a screenshot could not complete for **~5 minutes**
- at **151 s the page reset its own sync socket**
- their tab left on it is the likely cause of the pooled browser wedge that
  evening; pool memory pressure fell **83% → 78%** when that browser was reaped

**It is not the leak this document is about.** Skip's tab reached 15 GB on a
*small* project, so page count cannot be the mechanism. **Two different problems
that both end in a dead renderer**, and conflating them would be a mistake.

**What would settle it, if anyone is ever asked to:** open it once and sample the
renderer's **physical footprint** at 60 s intervals for ~20 minutes. Not RSS —
see the instrument note above. Do not reopen it casually: doing so is what wedged
the shared pool.

**Status: no owner, no measurement, deliberately not pursued.**


### 23:40 — the Mini is at load 55; what that does and does not cost

`app-tester` retracted their own attribution of the pool wedge (they had blamed
their 748-page tab; it wedged again on a **1-page** probe from a fresh browser).
The real state, which I verified independently rather than taking on faith:

```
load average   55.32  46.61  32.64   (climbing)
claude procs   48
node procs     103
total procs    614
memory free    33%
```

**The ordering control is on hold.** A null result under this measures
starvation, not suppression — the same class as the unarmed control earlier,
one layer out.

**What survives, and why.** The sibling control is a **paired** measurement: app
renderer and non-app renderer, same machine, same instants, both arms under
whatever load existed. **Shared confounds cancel in a differential.** Load can
depress or inflate an absolute rate; it cannot make one process gain 121 MB while
the process beside it gains nothing. *The app's renderer drifts and a non-app
renderer in the same browser does not* stands, and the attribution rests on that.

**What is soft, marked as such:**

- **The absolute rates — 1.1, 1.4, 1.9 MB/min.** Single-arm numbers; load moves
  them. I have been quoting these as though solid and they are not.
- **Any null measured under saturation**, including the offline result if re-run
  tonight.
- **The load during my earlier runs is unknown.** It is recorded nowhere and I am
  not assuming it was quiet. The weak point in my favour: the drift held the same
  direction across 14:35→19:11, and load varies over hours, so an artifact would
  more likely wander.

**My own contribution to the load: none, checked rather than asserted.** No
background samplers looping on the Mini, both browser rigs reaped, profile
directories deleted. The only live process of mine is the 5-minute sampler on the
**Fly** box.


### 23:55 — first named frame in an app profile, and it is layout thrash

Spent the blocked time on the profile backlog rather than idling. **The bundle
has turned over enough that a couple of profiles finally resolve.** This is
**jank, not the memory leak** — a different problem, not to be conflated.

```
47.0%   1250 ms   Shn @ src/svgWordSpaces.ts:13
25.2%    670 ms   (anonymous) @ shared/defaultStyleDefs.mjs:61
 3.5%     94 ms   (anonymous) @ src/shapes/SvgPageShape.tsx:325
```

**The sample is two profiles.** `mappable profiles = 2`, busy 2,658 ms, longest
single block 1,456 ms, out of 300 records across four bundles of which only the
live one has a map. **Those percentages are not representative and must not be
quoted as though they were.**

**The code does not need the sample.** `injectWordSpaces` in
`src/svgWordSpaces.ts`, per text fragment:

```js
textEl.insertBefore(tmp, child.nextSibling)   // mutate
const width = tmp.getComputedTextLength()     // forced synchronous layout
textEl.removeChild(tmp)                       // mutate
```

**Insert, measure, remove — once per fragment, across every `<text>` element in a
page SVG.** `getComputedTextLength()` forces a reflow; each surrounding mutation
dirties layout again. A preceding loop writes `style.fontFamily`/`fontSize` onto
every text element first, so layout is already dirty before measuring starts. On
a dense page that is thousands of forced reflows.

**The profile said where to look; the source confirms the shape independently of
how few profiles there were.** That is stronger than either alone — and it is
still *not* a measurement of what it costs in practice, which n=2 cannot give.

**Deliberately not changed.** Outside the assigned work, and the function exists
for a correctness reason its own comment states (without it, native text
selection runs words together). A naive "measure all, then mutate all" rewrite
needs someone to check it against that reason.

**Partly retires an earlier claim.** I reported the client profiler as writing
"3,975 traces, **all** unreadable." Two are readable. The defect is unchanged —
deploys still delete the maps their own profiles reference — but "all" is no
longer accurate.


### 01:00 — the ordering control is not obtainable on this machine tonight

Four attempts, four environmental failures. **Each was caught rather than
reported as a result**, which is the only reason this entry is a status and not a
retraction.

| attempt | what happened |
|---|---|
| pooled browser | daemon wedged; the arm **never reached the page** |
| pooled browser | arm eval timed out; left an **unarmed tab**, not sampled |
| standalone headless | onboarding state only, 35 MB vs 858 MB headed — **measures headless** |
| standalone headed | **app did not render**: 258 DOM nodes after 180 s at load 48, vs ~900 healthy |

**The fourth is the guard working as designed.** The rig refuses to arm unless
the app rendered and self-tests that the blocked `WebSocket` constructor actually
throws. It printed `APP DID NOT RENDER — refusing to arm` instead of returning a
number. **A flat line from an unarmed or half-loaded page is indistinguishable
from a successful suppression** — and a successful suppression is precisely the
result this control exists to produce. Without the guard, every one of these four
failures would have looked like confirmation.

**Why it cannot be done now:** the Mini went `7 → 38 → 48 → 17` within twenty
minutes. The control needs thirty minutes of quiet; the app currently cannot
finish painting in three. The pool's specific failure is **fork-per-call** — each
verb forks a `playwright-cli` for one CDP round trip — so a standalone CDP rig
routes around that. **Nothing routes around the app not painting.**

**Cleaned up:** standalone Chrome killed (0 processes), profile directory
deleted, pooled tab released. Nothing of mine runs on the Mini. The Fly sampler
continues per instruction.

**What stands regardless**, so this is not read as the leak being unestablished:
the leak, the ~90-minute crash cycle, the ruled-out list, the unattributed
`malloc`, the reproduction across two cold starts, and the sibling control are
all measured and untouched by this. **The only thing missing is the promotion of
"socket activity is _necessary_" to "socket activity is _the cause_."** That
distinction is real and is not being blurred to have something to report.


### 01:15 — at load 40+, three separate subsystems fail the same way

`app-tester` answered the Mini question I asked before agreeing to their project
creation. It is worth recording because it generalises.

**`project link` needed three attempts, with two `adopt-shadow-history-ref`
daemon timeouts, at load 43** — on a four-file repository of a few hundred bytes.
The work was trivial; the daemon still could not complete it twice.

**That is the third subsystem tonight with the same failure shape at load 40+:**

| subsystem | how it fails |
|---|---|
| pooled browser | forks a `playwright-cli` per verb; **the fork does not complete** |
| Mini daemon | **drops requests** — `adopt-shadow-history-ref` timed out twice |
| the app itself | **cannot paint** — 258 DOM nodes after 180 s, against ~900 healthy |

**None of these is a defect in the thing that appears to fail.** Chrome was at
1.3% CPU while the pool looked broken; the repo was four files while the daemon
timed out; the app is fine when the box is quiet. **The machine is the fault in
all three, and each one presents as the tool being broken** — which is why the
first instinct in every case was to debug the wrong component.

**For future measurement on this box: below load ~10 things work, above ~40
nothing that needs to fork, ask the daemon, or paint can be trusted.** A null
result gathered in that band is not a null result.

**Holding as instructed.** `app-tester` has cleared out and says the box is mine,
but `sol-dev`'s instruction is not to retry until **Dev** reports a *sustained*
quiet window, and one agent saying the pool is free is not that. Not grabbing it.


### 01:50 — Skip's hypothesis: is it Chrome running with debugging enabled?

He asked directly, and it is a **real class of problem** — the debugging protocol
retains console messages, network bodies and profiler samples, and agents attach
to his browser routinely. It deserved a real answer rather than a reflex.

**The answer is probably no, and the evidence predates the question.**

**Two tabs, same browser, same debugging configuration, same eighty minutes:**

| | |
|---|---|
| the app's tab | **climbed 121 MB** |
| a different page beside it | **44 → 50 MB**, one step, then flat across five samples |

**If Chrome-with-debugging were the leak, both would leak.** Same process tree,
same flags, same protocol attached. One did; one did not.

**Where it stops being airtight, stated rather than hidden:** the protocol retains
**per target**, not per browser. If something had been attached to the app's tab
and not the other, the same picture would follow. Both were automated tabs with
sessions on them, which weakens that, but does not close it.

**A second, weaker piece:** his renderer was already **26 minutes old and ~2.4 GB
and climbing** when I first attached, so *my* attaching did not start it. That
kills "browser-perf attached and it grew"; it does **not** kill "debugging was
already enabled and that is unhealthy", because the port was open before I
arrived. **Two different claims, and only the first is dead.**

### The clean test exists and I could not run it

A browser launched with **no debugging port at all**, measured from outside the
process with `footprint`, needs no protocol and would settle it outright.

**Three attempts, none produced data.** Each time the app failed to load —
confirmed independently from the **server side**, where `client.log` shows the
browser never connected at all. The positional URL navigates headless and is
swallowed headed; `--app=` did not start; a `kill` loop caught one launch.

**That is a rig failure, not a result**, and it is recorded as one. **A flat line
from a browser that never loaded the app would have looked exactly like "debugging
was the cause"** — the same trap as the unarmed tab, wearing the opposite answer.

**Standing:** hypothesis reasonable, evidence points away from it, not closed. The
thing it cannot explain is why the growth lands in **one tab** rather than the
browser as a whole.


## MEASURED REPORT — 2026-08-26, current deployed build `b4097808f`

Run after the Mini restart, on a **quiet box** (load 3), against the **current
deployed build**, on a **disposable project**. `qtm285` not touched.

### 1. Exact reproduction

Pooled Playwright browser, disposable project, default fleet layout. Renderer
identified by **ballast** (208 → 415 MB on a 220 MB allocation), never by
inspection. Page verified rendered: **962 DOM nodes, 9 shapes, 3 canvases,
2 iframes.**

### 2. Memory growth over time

```
15:26  184 MB        15:33  289 MB
15:28  256 MB        15:35  373 MB
15:30  306 MB        15:37  446 MB
```

**184 → 446 MB in 10 minutes ≈ 26 MB/min**, with the sawtooth (289 after 306).
JS heap over the same span: **31 → 54 MB.** Nodes 912 → 962.

**And the periodic sample understates it badly.** `vmmap` reports
**physical footprint peak 2.9 GB** for this renderer against a current 383 MB.
**A two-minute sampling interval never saw a 2.9 GB excursion.** That matters for
"lockups": a transient multi-gigabyte spike locks the machine even when the tab
recovers.

**Rate is build-dependent.** Last night's build: 1.1–1.9 MB/min sustained. Today:
~26 MB/min. Skip's own tab: 30–220 MB/min, reaching 12–15 GB in ~90 minutes.

### 3. First retained owner / allocation evidence

**Not the JS heap** — 54 MB while the process holds 446 MB.
**Not sampled allocation** — `Memory.getSamplingProfile`, armed *before*
navigation, captured **63.8 MB live** across a load in which a renderer grew
**2.8 GB**. The memory does not pass through the sampled allocator.

**It is anonymous VM regions, accumulating in count:**

```
pooled tab (growing)   Memory Tag 253   4,655 regions   114 MB resident  100 MB dirty
                       Memory Tag 255     929 regions   120 MB resident  120 MB dirty
                       shared memory       70 regions    31 MB resident
Skip's renderer        anonymous          2,605 regions  1,050 MB
```

The tag-253 regions are `SM=NUL`, 0 K resident — **address-space reservations**,
so the committed share is smaller than the count suggests. **The finest owner I
can name is "thousands of small anonymous mappings, growing in number."** The
allocation site itself is **unsymbolizable**: release Chrome is stripped and
`atos` resolves every address to `ChromeMain + offset`.

### 4. Slows, or dies?

**Dies.** Two renderer crashes, ~90 minutes apart, at **15 GB and 12 GB**,
confirmed from Chrome's own crash dumps — `ptype`, `--type=renderer`,
`renderer_foreground`, each timestamped to the minute its renderer vanished. It
is not a tab that gets sluggish; it is a tab that is killed.

### 5. Ruled out, each by measurement

- **JS heap** — flat while the process climbs.
- **JS allocation** — 6.3 MB in 240 s on Skip's tab.
- **Listener registrations** — `getEventListeners`: `document` 79 in both samples.
- **DOM / canvas / shapes / iframes** — byte-for-byte constant across samples in
  which footprint rose 903 → 918 MB.
- **Images** — zero. **Voice PCM backlog** — capped by construction at 64 MB.
- **The machine and Chrome itself** — a sibling renderer in the same browser gained
  nothing over 80 minutes while the app's tab gained 121 MB.
- **Skip's "is it debugging?"** — the same sibling shared his debugging
  configuration and stayed flat. *Limit:* the protocol retains per target, so this
  weakens rather than closes it.
- **A rig artifact I nearly reported as the finding.** A standalone browser hit
  **2.8 GB with a 5.5 GB peak** on a 300-node onboarding page — `shared memory`,
  2.7 GB virtual, 2.4 GB swapped, 52 regions. **The pooled tab's shared memory is
  40 MB.** So that blowup is specific to my standalone launch, **not the app**.
  Recorded so nobody chases it.

### 6. The exact remaining causal gap

**Socket/sync activity is correlated and may be necessary. It is not established
as the cause.**

Clearing every timer: no effect. Suppressing `requestAnimationFrame` (2,072 calls
blocked): no effect. **Taking the app offline: the drift stopped** — 445 → 446 MB
over 35 minutes where it had been climbing ~1 MB/min.

**Why that is not yet cause:** the offline run had timers and rAF still
suppressed, and the pre-existing sockets were never confirmed closed at OS level.
**The ordering control — offline from a cold tab — has never completed.** Five
attempts, every one an environmental failure, none a result.

## Next action

When his tab comes back: measure `LayoutCount` and `RecalcStyleCount` rates
against footprint growth across a full document lifetime. That is the last
untested mechanism with a plausible path to the unattributed `malloc` bucket,
and it needs a live leaking renderer, which only he has.

Superseded, kept for the record: read the WebSocket buffer result. `bufferedAmount` is renderer-side malloc, is
invisible to the JS heap, lands in exactly the `malloc` bucket that holds the
8 GB, and is unbounded when a page sends faster than a socket drains. If that is
flat, the next step is to drive the reproduction toward his conditions — chat
traffic and voice on — until it grows, and take a heap snapshot there, where the
tab can be frozen for as long as it takes.

---

## 2026-08-26 — the ordering controls, and a retraction

**Retracted: "offline stops the growth."** That earlier run stacked timer and rAF
suppression alongside the WebSocket block, so it could not attribute the effect.
Run in isolation, the network condition contributes nothing.

Socket closure was **confirmed, not assumed**: the blocked-constructor counter went
1 (self-test) → 2 thirty-nine seconds after arming. An app only constructs a
replacement socket after the previous one has closed. It then held at 2, so nothing
was reconnecting behind the block. The pooled browser exposes no CDP and the
server's room accounting (`resident 896 / idle 896`) cannot isolate one tab, so
neither of those could have answered this.

Renderer 72131, project `leak-probe-mem`, one tab, one continuous sampler across
every boundary.

| phase | window | footprint | slope |
|---|---|---|---|
| online, timers live | 15:26:49 → 15:41:14 | 184 → 525 MB | 23.7 MB/min |
| socket blocked, timers live | 15:43:16 → 15:53:25 | 596 → 1043 MB | **44 MB/min** |
| socket blocked, timers suppressed | 15:57:31 → 16:02:32 | 1123 → 1123 MB | **0 MB/min** |

JS heap stayed flat throughout (52–74 MB) and node count flat (927–981), so the
accumulation is neither JS nor DOM — consistent with the anonymous-mapping owner
recorded above, and now shown independent of network input.

**Conclusion so far:** the driver is work the tab schedules on its own clock. The
sync path is ruled out as the driver.

### Why the timer suppression has to clear the existing id space

Patching `setTimeout`/`setInterval` blocks only *new* timers; the app's
already-registered intervals keep firing. That self-tests as "armed" and measures
nothing, and is the likely fault in the earlier stacked run. The arm above cleared
**16,518** existing ids, and self-tested in both directions — timers fired before
the patch, did not fire after.

### Instrument failure worth remembering

The first renderer-identification ballast silently did nothing: the eval threw
`SyntaxError` (multiple statements in one `pw eval`) with output suppressed. No pid
moved, which reads exactly like "both tabs share one renderer." Re-run as a single
expression it moved one pid 310 → 819 MB. Identify a renderer by making it move,
and check the allocation actually happened.

### Open — the separation not yet done

"Timers" above means `setInterval` + `setTimeout` + `requestAnimationFrame`
together. Which one carries the growth is **not yet established**. Second tab
(renderer 59846, socket connected) is baselining for the ladder: kill `setInterval`
only, then add `rAF`, then `setTimeout`.

### The scheduler decomposition — it is `requestAnimationFrame`

Second tab, renderer **59846**, confirmed a distinct process from 72131 by a 500 MB
ballast that moved that pid and no other. **Socket connected throughout**
(`wsIntact: true` — this tab was never network-blocked), so this is the
socket-live condition.

| rung | live | window | footprint | slope |
|---|---|---|---|---|
| baseline | all three + socket | 16:02:50 → 16:09:01 | 345 → 452 MB | 17 MB/min |
| `setInterval` dead | `setTimeout`, `rAF`, socket | 16:09:31 → 16:15:01 | 466 → 560 MB | 17 MB/min |
| `+rAF` dead | `setTimeout`, socket | 16:15:01 → 16:21:12 | 560 → 533 MB | **−4 MB/min** |

Killing `setInterval` changed nothing. Adding `rAF` stopped it outright **while
`setTimeout` was still firing and the socket was still connected**. So `rAF` is
sufficient to stop the growth and neither other scheduler is necessary to it —
`setTimeout` is excluded by being live across the flat phase, so no fourth rung
was needed.

Every rung self-tested in four directions: the killed scheduler fired before and
not after, and the ones meant to stay live were confirmed still firing.

**The flat line is not a dead tab** — checked, because a crashed renderer gives an
identical flat footprint. The tab ran a 10⁶-iteration loop on demand: 1250 nodes,
heap 53 MB, age 24.5 min, both suppressions still in place.

Tab 72131 corroborates independently: all three killed at constant blocked
network, 44 MB/min → flat, and still flat.

### What is established, and what is not

Established: the growth is driven by the **render loop**. Consistent with the rest
of the picture — footprint climbing while JS heap and node count stay flat,
thousands of small anonymous mappings, a tab that dies at 15 GB rather than slows.

**Not established: the callsite, or the retained owner.** This names a scheduler.
"Something allocated on every animation frame is retained" is not a cause anyone
can act on.

**The gap is instrumental, not analytical.** Closing it needs native allocation
stacks with `rAF` live. The pooled browser exposes no CDP — the same constraint
that has blocked retained-owner evidence throughout — and sampling footprint more
carefully cannot substitute. It needs a CDP-attachable browser that renders the
real app; standalone attempts reached only the onboarding state, a different page
whose result would not transfer.

### Cleanup

Fly sampler stopped, `/tmp/baseline.js` and `/tmp/anonshape.*` gone, server
untouched (pid 665 + esbuild only). Ten probe files removed from the Air after
confirming no process was still writing to them. **Two of the ten were not on the
cleanup list** — enumerate the directory rather than working from a remembered
list.

`pkill -f baseline.js` over ssh killed its own shell: the ssh command line
contains the pattern. Verify with a command that does not contain it.
