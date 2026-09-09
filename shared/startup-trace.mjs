/**
 * Startup phase markers for the sandbox preview server.
 *
 * A stalled sandbox boot left evidence that said only: child spawned, no first
 * server-body log, wrapper deadline at 30s. Nothing in it could name a phase,
 * because the first thing the server prints happens after its whole static
 * import graph has already been evaluated — so "still importing" and "stuck in
 * initProjectStore" produce byte-identical logs.
 *
 * These markers make each startup edge observable in the log the wrapper
 * already retains. They are measurement only: off unless TLDA_STARTUP_TRACE=1,
 * and when off `markStartupPhase` writes nothing and the phase wrappers call
 * straight through, so an ordinary launch behaves exactly as before.
 *
 * A marker carries the phase, the edge, and monotonic milliseconds since this
 * process started — plus the error's class and code on a failure edge. It never
 * carries an exception message, a config value, a token, or environment.
 */
import { performance } from 'node:perf_hooks'

export const STARTUP_TRACE_TAG = '[startup-trace]'
export const STARTUP_TRACE_FLAG = 'TLDA_STARTUP_TRACE'

// The only keys a marker may carry. Anything else is a config value or a secret
// leaking into a log that gets pasted into chat. `phase`, `edge` and `elapsedMs`
// are the emitter's own and a caller cannot supply or override them.
export const STARTUP_MARKER_KEYS = ['phase', 'edge', 'elapsedMs', 'module', 'error', 'code']
export const STARTUP_MARKER_DETAIL_KEYS = ['module', 'error', 'code']

// A marker records that a phase failed and which class of failure it was. It
// does NOT record the exception's message: a config-load or auth failure puts
// the value it choked on into that string, and this line goes into a log people
// paste to each other. The server's own error output is unchanged and still in
// the same log, one scroll away, for whoever is entitled to read it.
// An error name and an errno are short identifiers; a module is a repo-relative
// path. Anything that is not shaped like one of those is not one, and is
// dropped rather than printed.
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SAFE_MODULE = /^[A-Za-z0-9_./-]{1,120}$/

function safeName(value, fallback = null) {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : fallback
}

const DETAIL_VALIDATORS = {
  module: value => (typeof value === 'string' && SAFE_MODULE.test(value) ? value : null),
  error: value => safeName(value),
  code: value => safeName(value),
}

export function startupTraceEnabled(env = process.env) {
  return env[STARTUP_TRACE_FLAG] === '1'
}

export function formatStartupMarker(record) {
  return `${STARTUP_TRACE_TAG} ${JSON.stringify(record)}`
}

// Read markers back out of a retained log. Lines that are not markers — the
// server's own output, a stack trace — are simply not markers, not errors.
export function parseStartupMarkers(text) {
  const markers = []
  for (const line of String(text).split('\n')) {
    const at = line.indexOf(STARTUP_TRACE_TAG)
    if (at === -1) continue
    try { markers.push(JSON.parse(line.slice(at + STARTUP_TRACE_TAG.length))) } catch { /* a torn line is not a marker */ }
  }
  return markers
}

const defaultClock = () => performance.now()

// stdout, because that is the fd the launcher already redirects into the
// retained server log. A marker that needs its own sink is a journal.
const defaultWrite = line => { console.log(line) }

export function markStartupPhase(phase, edge, detail = {}, {
  env = process.env,
  clock = defaultClock,
  write = defaultWrite,
} = {}) {
  if (!startupTraceEnabled(env)) return null
  // Built key by key from the allowlist rather than spread from `detail`, so a
  // caller can neither add a field nor overwrite the phase, the edge or the
  // clock — the three things a reader of this log has to be able to trust.
  const record = { phase: String(phase), edge: String(edge), elapsedMs: Math.round(clock() * 1000) / 1000 }
  for (const key of STARTUP_MARKER_DETAIL_KEYS) {
    if (!Object.hasOwn(detail, key)) continue
    const value = DETAIL_VALIDATORS[key](detail[key])
    if (value !== null) record[key] = value
  }
  write(formatStartupMarker(record))
  return record
}

function failureDetail(error) {
  return { error: safeName(error?.name, 'Error'), code: safeName(error?.code) }
}

/**
 * Run one awaited startup phase between a start and an end marker.
 *
 * The value and the throw are the phase's own — this wrapper adds observation
 * and nothing else, so a phase that hangs simply leaves its start marker as the
 * last thing in the log, which is exactly the fact that was missing.
 */
export function traceStartupPhase(phase, run, options = {}) {
  // Not an async function. An async wrapper would return a NEW promise and
  // resolve a turn later than the phase itself, so a preview with the trace off
  // would run on slightly different timing from the one this code replaced.
  // With the flag off the caller gets back exactly what the phase returned.
  if (!startupTraceEnabled(options.env ?? process.env)) return run()
  return tracedStartupPhase(phase, run, options)
}

async function tracedStartupPhase(phase, run, options) {
  markStartupPhase(phase, 'start', {}, options)
  try {
    const result = await run()
    markStartupPhase(phase, 'end', {}, options)
    return result
  } catch (error) {
    markStartupPhase(phase, 'error', failureDetail(error), options)
    throw error
  }
}

// The synchronous phases stay synchronous. Wrapping them in the async form
// would insert a microtask turn into startup that the untraced server does not
// have, which is a behavior change smuggled in as measurement.
export function traceStartupPhaseSync(phase, run, options = {}) {
  if (!startupTraceEnabled(options.env ?? process.env)) return run()
  markStartupPhase(phase, 'start', {}, options)
  try {
    const result = run()
    markStartupPhase(phase, 'end', {}, options)
    return result
  } catch (error) {
    markStartupPhase(phase, 'error', failureDetail(error), options)
    throw error
  }
}

/**
 * The sandbox bootstrap's whole body: mark that this process is alive, then
 * time the dynamic import of the server module.
 *
 * This exists as a function so the import edge can be exercised against a
 * fixture — a module that stalls, a module that throws — without booting a real
 * server. `server/sandbox-boot.mjs` is the one caller that names the real one.
 */
export async function bootWithStartupTrace(importModule, moduleName, options = {}) {
  markStartupPhase('process-start', 'mark', {}, options)
  markStartupPhase('module-import', 'start', { module: moduleName }, options)
  try {
    const loaded = await importModule()
    markStartupPhase('module-import', 'end', { module: moduleName }, options)
    return loaded
  } catch (error) {
    markStartupPhase('module-import', 'error', { module: moduleName, ...failureDetail(error) }, options)
    throw error
  }
}
