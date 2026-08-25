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

## Instrumentation left in his tab

None. The counting probe was uninstalled and confirmed removed, the native
sampler stopped itself, and the `WebSocket` watch was uninstalled (it reported
`not installed` on the second call because his reload had already wiped it).
Left on the Air under `/tmp`: `cdp-watch.mjs`, `cdp-query.mjs`, `tlda-watch.csv`.
Delete them when this is done.


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
- The multi-second `live-store` class: **historical, ended July.**


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
  trend"* — measured in RSS. **Withdrawn pending the footprint series.**
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
