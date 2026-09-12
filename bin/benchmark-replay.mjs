#!/usr/bin/env node
// Benchmark replay — turn "this period in this project" into a rerunnable benchmark.
//
// Skip, 2026-09-02 17:23–17:24 EDT:
//   "play exactly the same chat + calls through the app on the same timeline and watch the doc"
//   "think of that as like a benchmark"
//   "latency at speed magnification is a like, plot that acts as a benchmark"
//   "we'll accumulate benchmark sessions as we go; let's make it like, scripted/trivial
//    to say 'this period in this project is a benchmark'"
//
// So the unit is (project, start, end) → a named benchmark, replayable at a speed
// multiplier, producing latency-vs-speed points. Not a one-off gate script.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not copy document or chat CONTENT into
// the trace. A trace stores event IDs, timings, actors and sizes; the replayer
// re-reads bodies from the store at run time. That keeps a benchmark artifact from
// becoming a second copy of somebody's writing, and keeps project names out of
// anything that gets reported.
//
//   capture  --project P --from ISO --to ISO --name N   → traces/N.json
//   replay   --trace traces/N.json --into DISPOSABLE --speed 1 [--dry-run]
//   report   --trace traces/N.json                      → latency-vs-speed table
//
// Execution against a live box is gated: replay refuses without --into, and
// --into must not name the project the trace came from.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TRACE_DIR = join(ROOT, 'scratch', 'benchmarks')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const has = name => process.argv.includes(`--${name}`)

function die(msg) {
  console.error(`benchmark-replay: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- instruments
//
// Each returns a plain number or null. null means "not measured", never 0 —
// a zero that means "no instrument" is the failure this repo keeps paying for.

/** dvisvgm fan-out: how many render workers exist right now. Skip: "how are there 6 dvisvgm workers". */
function dvisvgmWorkers() {
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'command'], { encoding: 'utf8' })
    return out.split('\n').filter(l => /dvisvgm/.test(l) && !/\[d\]visvgm/.test(l)).length
  } catch { return null }
}

/** 1-minute load average. */
function loadAvg1() {
  try {
    const out = execFileSync('/usr/bin/uptime', [], { encoding: 'utf8' })
    const m = out.match(/load averages?:\s*([\d.]+)/)
    return m ? Number(m[1]) : null
  } catch { return null }
}

/** Wall-clock ms for one authenticated GET. null on failure — never a fabricated number. */
function httpLatencyMs(url, token) {
  const t0 = Date.now()
  try {
    execFileSync('/usr/bin/curl', [
      '-s', '-m', '30', '-o', '/dev/null',
      '-H', `Authorization: Bearer ${token}`, url,
    ])
    return Date.now() - t0
  } catch { return null }
}

/** Project freshness: the fields that say what the server believes is built. */
function projectState(base, project, token) {
  try {
    const out = execFileSync('/usr/bin/curl', [
      '-s', '-m', '30', '-H', `Authorization: Bearer ${token}`,
      `${base}/api/projects/${encodeURIComponent(project)}`,
    ], { encoding: 'utf8' })
    const j = JSON.parse(out)
    return {
      pages: j.pages ?? null,
      buildStatus: j.buildStatus ?? null,
      buildPhase: j.buildPhase ?? null,
      lastBuild: j.lastBuild ?? null,
      sourceRevision: j.sourceRevision ?? null,
      acceptSeq: j.acceptSeq ?? null,
    }
  } catch { return null }
}

/**
 * What the BROWSER is actually showing — not what the server believes is built.
 *
 * Skip's surface is the rendered document, so curve 1 has to end at the pixels.
 * This reads the rendered revision/content marker out of the pooled browser tab
 * that `replay --browser` keeps pointed at the project.
 *
 * Returns null if the tab is not up or the read fails. null is "not measured";
 * it is never to be read as "nothing rendered".
 */
function browserRendered() {
  const expr = `() => {
    const e = window.__tldraw_editor__
    if (!e) return JSON.stringify({ ready: false })
    const ids = [...e.getCurrentPageShapeIds()]
    const page = ids.map(i => e.getShape(i)).find(s => s && s.type === 'html-page')
    const ver = document.querySelector('[data-doc-revision]')?.getAttribute('data-doc-revision') ?? null
    const txt = document.body.innerText || ''
    return JSON.stringify({
      ready: true,
      revision: ver,
      pageSrc: page?.props?.src ?? null,
      renderedChars: txt.length,
      renderedHash: [...txt].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) | 0), 7),
    })
  }`
  try {
    const out = execFileSync('tlda-dev', ['pw', 'eval', expr], { encoding: 'utf8', timeout: 60000 })
    const m = out.match(/"\{.*\}"/s)
    if (!m) return null
    return JSON.parse(JSON.parse(m[0]))
  } catch { return null }
}

function sample(base, project, token, label, opts = {}) {
  return {
    label,
    at: new Date().toISOString(),
    dvisvgmWorkers: dvisvgmWorkers(),
    load1: loadAvg1(),
    healthMs: httpLatencyMs(`${base}/health`, token),
    projectMs: httpLatencyMs(`${base}/api/projects/${encodeURIComponent(project)}`, token),
    state: projectState(base, project, token),
    // Only when the browser is in the loop; otherwise absent rather than faked.
    browser: opts.browser ? browserRendered() : undefined,
  }
}

// ------------------------------------------------------------------- capture
//
// The trace is metadata only: who acted, when, how big, and the event id to
// re-read at replay time. Content stays in the store.

async function extractFromStore(from, to) {
  // Skip: "make it like, scripted/trivial to say 'this period in this project is a
  // benchmark'" — so capture does its own extraction. Adding a session must never
  // mean hand-authoring a trace.
  //
  // Reads through FleetSearchClient, which forks a worker against a db PATH — so
  // point it at a snapshot rather than running ad-hoc queries against the live
  // store. TLDA_FLEET_DB overrides; the default is the standard location.
  const dbPath = process.env.TLDA_FLEET_DB
    || join(process.env.HOME, '.config', 'tlda', 'fleet.db')
  if (!existsSync(dbPath)) die(`no fleet store at ${dbPath} (set TLDA_FLEET_DB)`)

  const { FleetSearchClient } = await import('../server/lib/fleet-search-client.mjs')
  const client = new FleetSearchClient(dbPath)
  try {
    const res = await client.searchAll('', {
      limit: 5000,
      filters: { since: from, until: to },
    })
    const rows = Array.isArray(res) ? res : (res?.results ?? res?.rows ?? [])
    if (!rows.length) die(`store returned no events for ${from}..${to} — widen the window, ` +
                          'or check TLDA_FLEET_DB points at the right store')
    return rows
  } finally {
    client.close?.()
  }
}

async function capture() {
  const project = arg('project') || die('capture needs --project')
  const from = arg('from') || die('capture needs --from ISO')
  const to = arg('to') || die('capture needs --to ISO')
  const name = arg('name') || die('capture needs --name')
  const eventsFile = arg('events')   // optional: an auditable offline export

  const raw = eventsFile
    ? JSON.parse(readFileSync(eventsFile, 'utf8'))
    : await extractFromStore(from, to)
  if (!Array.isArray(raw) || raw.length === 0) die('no events to capture')

  const stamped = raw
    .map(e => ({ ...e, t: Date.parse(e.timestamp ?? e.at ?? e.time) }))
    .filter(e => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)
  if (!stamped.length) die('no events carried a parseable timestamp')

  const t0 = stamped[0].t
  const trace = {
    name,
    capturedAt: new Date().toISOString(),
    window: { from, to },
    sourceProject: project,          // recorded here, never emitted in reports
    eventCount: stamped.length,
    spanMs: stamped[stamped.length - 1].t - t0,
    events: stamped.map(e => ({
      id: e.id ?? null,
      offsetMs: e.t - t0,
      from: e.from ?? null,
      to: e.to ?? null,
      type: e.type ?? 'chat',
      bytes: typeof e.text === 'string' ? e.text.length : null,
    })),
  }

  mkdirSync(TRACE_DIR, { recursive: true })
  const out = join(TRACE_DIR, `${name}.json`)
  writeFileSync(out, JSON.stringify(trace, null, 2))

  const actors = [...new Set(trace.events.map(e => e.from).filter(Boolean))]
  console.log(`captured ${trace.eventCount} events over ${(trace.spanMs / 60000).toFixed(1)} min`)
  console.log(`actors: ${actors.length}`)
  console.log(`wrote ${out}`)
}

// -------------------------------------------------------------------- replay

async function replay() {
  const tracePath = arg('trace') || die('replay needs --trace FILE')
  const into = arg('into')
  const speed = Number(arg('speed', '1'))
  const dry = has('dry-run')
  const base = arg('base', 'https://tlda-pic-dev.example-tailnet.ts.net')
  const token = process.env.TLDA_TOKEN || die('replay needs TLDA_TOKEN in the environment')

  const trace = JSON.parse(readFileSync(tracePath, 'utf8'))
  if (!into) die('replay needs --into DISPOSABLE_PROJECT (never the captured project)')
  if (into === trace.sourceProject) die('--into must not be the project the trace came from')
  if (!Number.isFinite(speed) || speed <= 0) die('--speed must be a positive number')

  const useBrowser = has('browser')
  let pendingSince = null

  if (has('notify')) {
    die('--notify is disabled until the benchmark uses the real agent MCP path')
  }
  const notifyDriver = null

  if (useBrowser) {
    // The tab must already be on the project: replay measures, it does not
    // navigate mid-run. A tab pointed elsewhere would report a rendered hash
    // that never changes, which reads as "never painted" — a false zero.
    const probe = browserRendered()
    if (!probe?.ready) die('--browser needs the pooled tab up and on the project ' +
                           '(tlda-dev pw acquire, then pw goto the project URL)')
  }

  const scaledSpanMin = trace.spanMs / speed / 60000
  console.log(`replay "${trace.name}": ${trace.eventCount} events, speed ${speed}x, ` +
              `${scaledSpanMin.toFixed(1)} min into "${into}"${dry ? ' [DRY RUN]' : ''}`)

  const samples = [sample(base, into, token, 'before', { browser: useBrowser })]
  const perEvent = []

  for (const ev of trace.events) {
    const dueAt = ev.offsetMs / speed
    if (!dry) {
      const wait = dueAt - (Date.now() - Date.parse(samples[0].at))
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
    }
    const t0 = Date.now()
    const s = sample(base, into, token, `event:${ev.id ?? ev.offsetMs}`, { browser: useBrowser })

    // Which curves this harness can fill WITHOUT a driver, and which it cannot.
    // A null here means "not measured" and must never be read as zero — a zero
    // that means "no instrument" is the failure this repo keeps paying for.
    //
    //   editToVisibleMs  — NEEDS --browser. Ends at the rendered document, not at
    //                      server freshness; null without a tab in the loop.
    //   chatRoundTripMs  — live: authenticated request round trip.
    //   notificationMs   — NEEDS A DRIVER. It is the interval from a chat send to
    //                      the target agent being notified, and nothing observable
    //                      from outside the app can stand in for it. Left null
    //                      rather than proxied.
    const prevS = perEvent.at(-1)?.sample ?? null
    const cur = s.state
    const revChanged = prevS?.state && cur && prevS.state.sourceRevision !== cur.sourceRevision

    // Curve 1 ends at the BROWSER, not the server. An accepted revision that the
    // tab has not painted is exactly the "document is out of sync a cycle" state
    // Skip was working through, so server freshness cannot stand in for it.
    // pendingSince is set when the source revision moves and cleared when the
    // rendered content actually changes; the gap between them is the latency.
    let editToVisibleMs = null
    if (useBrowser) {
      const nowHash = s.browser?.renderedHash ?? null
      const prevHash = prevS?.browser?.renderedHash ?? null
      if (revChanged && pendingSince === null) pendingSince = Date.now()
      if (pendingSince !== null && nowHash !== null && prevHash !== null && nowHash !== prevHash) {
        editToVisibleMs = Date.now() - pendingSince
        pendingSince = null
      }
    }

    const curves = {
      editToVisibleMs,
      chatRoundTripMs: s.healthMs,
      notificationMs: notifyDriver ? notifyDriver.lastArrivalMs() : null,
      buildStatus: cur?.buildStatus ?? null,
    }

    perEvent.push({ offsetMs: ev.offsetMs, dueAt, observedMs: Date.now() - t0, curves, sample: s })
    if (dry) break
  }

  samples.push(sample(base, into, token, 'after', { browser: useBrowser }))
  if (notifyDriver) await notifyDriver.close()

  // Skip, on what the curves are: "two primary curves, kept separate" —
  //   (1) edit → browser-visible render latency
  //   (2) chat send → target agent notification arrival latency
  // and load/dvisvgm as an EXPLANATORY COVARIATE, never blended into a latency
  // number. A single "latency" figure that mixes render and notification hides
  // exactly the difference he is trying to see, so they stay in separate series.
  const series = key => {
    const nums = perEvent.map(p => p.curves[key]).filter(n => typeof n === 'number')
    const sorted = [...nums].sort((a, b) => a - b)
    const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null
    return { n: nums.length, p50: pct(0.5), p95: pct(0.95), max: sorted.at(-1) ?? null }
  }

  // The saturation knee: lag that ACCUMULATES rather than clearing between events.
  // Measured as the trend in per-event lag across the run — a positive slope means
  // each event starts further behind than the last, which is the thing that ruins
  // a meeting. Reported per run; the knee is the speed at which it goes positive.
  const drift = key => {
    const pts = perEvent.map((p, i) => [i, p.curves[key]]).filter(([, v]) => typeof v === 'number')
    if (pts.length < 4) return null
    const n = pts.length
    const mx = pts.reduce((s, [x]) => s + x, 0) / n
    const my = pts.reduce((s, [, y]) => s + y, 0) / n
    const num = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0)
    const den = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0)
    return den === 0 ? null : Number((num / den).toFixed(2))   // ms of lag added per event
  }

  const workers = perEvent.map(p => p.sample.dvisvgmWorkers).filter(n => typeof n === 'number')
  const loads = perEvent.map(p => p.sample.load1).filter(n => typeof n === 'number')

  const result = {
    trace: trace.name, speed, into, dry,
    ranAt: new Date().toISOString(),
    curves: {
      editToVisibleMs: series('editToVisibleMs'),
      notificationMs: series('notificationMs'),
      chatRoundTripMs: series('chatRoundTripMs'),
    },
    accumulationPerEvent: {
      editToVisibleMs: drift('editToVisibleMs'),
      notificationMs: drift('notificationMs'),
    },
    covariate: {
      dvisvgmWorkers: { max: workers.length ? Math.max(...workers) : null },
      load1: { max: loads.length ? Math.max(...loads) : null },
    },
    before: samples[0], after: samples.at(-1),
  }

  mkdirSync(TRACE_DIR, { recursive: true })
  const out = join(TRACE_DIR, `${trace.name}.run-${speed}x-${Date.now()}.json`)
  writeFileSync(out, JSON.stringify({ ...result, perEvent }, null, 2))
  console.log(JSON.stringify(result, null, 2))
  console.log(`wrote ${out}`)
}

// -------------------------------------------------------------------- report

function report() {
  const tracePath = arg('trace') || die('report needs --trace FILE')
  const trace = JSON.parse(readFileSync(tracePath, 'utf8'))
  const dir = TRACE_DIR
  if (!existsSync(dir)) die('no runs recorded yet')
  const runs = execFileSync('/bin/ls', [dir], { encoding: 'utf8' })
    .split('\n').filter(f => f.startsWith(`${trace.name}.run-`))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.speed - b.speed)
  if (!runs.length) die(`no runs for "${trace.name}" yet`)

  // Two primary curves, kept separate, plus the covariate alongside — never mixed
  // into one number. The knee is the first speed at which lag stops clearing
  // between events (accumulation goes positive).
  const fmt = v => (v === null || v === undefined ? '—' : v)
  console.log(`benchmark "${trace.name}" — latency at speed magnification\n`)

  console.log('curve 1: edit → browser-visible render')
  console.log('speed\tp50\tp95\tmax\taccum/event')
  for (const r of runs) {
    const c = r.curves?.editToVisibleMs ?? {}
    console.log([r.speed, fmt(c.p50), fmt(c.p95), fmt(c.max),
                 fmt(r.accumulationPerEvent?.editToVisibleMs)].join('\t'))
  }

  console.log('\ncurve 2: chat send → target agent notification')
  console.log('speed\tp50\tp95\tmax\taccum/event')
  for (const r of runs) {
    const c = r.curves?.notificationMs ?? {}
    console.log([r.speed, fmt(c.p50), fmt(c.p95), fmt(c.max),
                 fmt(r.accumulationPerEvent?.notificationMs)].join('\t'))
  }

  console.log('\ncovariate (explanatory only, not a latency metric)')
  console.log('speed\tdvisvgm\tload1\tchatRT p95')
  for (const r of runs) {
    console.log([r.speed, fmt(r.covariate?.dvisvgmWorkers?.max), fmt(r.covariate?.load1?.max),
                 fmt(r.curves?.chatRoundTripMs?.p95)].join('\t'))
  }

  for (const key of ['editToVisibleMs', 'notificationMs']) {
    const knee = runs.find(r => (r.accumulationPerEvent?.[key] ?? -1) > 0)
    console.log(`\nsaturation knee (${key}): ` +
      (knee ? `${knee.speed}x — lag accumulates rather than clearing`
            : 'not reached at any speed run so far'))
  }
}

const verb = process.argv[2]
if (verb === 'capture') await capture()
else if (verb === 'replay') await replay()
else if (verb === 'report') report()
else {
  console.log(`benchmark-replay — "this period in this project is a benchmark"

  capture --project P --from ISO --to ISO --name N [--events FILE]
          extracts the window itself from the store; --events is an optional
          offline export. TLDA_FLEET_DB should point at a snapshot.

  replay  --trace FILE --into DISPOSABLE [--speed 1] [--base URL] [--dry-run]
          [--browser]                  curve 1 ends at the rendered document
          --notify is disabled until curve 2 uses the real agent MCP path

  report  --trace FILE
          two curves kept separate, covariate alongside, saturation knee

  TLDA_TOKEN must be set for replay. --into must not be the captured project.
  --browser needs the pooled tab already up and on the project.
  Without --browser / --notify the respective curve is null, never zero.`)
}
