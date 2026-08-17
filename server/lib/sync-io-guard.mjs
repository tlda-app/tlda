// Synchronous filesystem work must not happen while the server is answering a
// request or a socket message.
//
// This is enforced by observation rather than by pattern-matching source. A
// grep cannot tell whether a `readFileSync` sits on a request path — the same
// function is fine at startup and fatal per-request — so a static rule either
// floods with false positives or is scoped so narrowly it misses the case that
// matters. On 2026-08-17 the case that mattered was `readEditEvents` reading an
// append-only log in full, on the main thread, once a second per open file,
// because a pill polled it. The server's own lag profiler measured 809ms
// stalls; `capture-pane` and agent-wake both cross server->daemon and both have
// deadlines shorter than that, so the fleet hibernated and could not come back.
//
// The property we actually want is "no sync IO while serving", and that is
// observable exactly: mark the async context when a handler starts, and make
// the sync fs calls throw inside it.
//
// Deliberately OFF unless TLDA_SYNC_IO_GUARD=1. Patching `fs` in production
// would turn a latency bug into an outage, which is a worse trade than the bug.
// It runs in tests and in `tlda-dev`, where a throw is a finding.
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

const serving = new AsyncLocalStorage()

/** Guarded methods. `existsSync`/`statSync` are metadata-only and stay: they do
 *  not read file bodies, they are how you avoid reading one, and banning them
 *  pushes people toward the async variants of a check that costs nothing. */
const GUARDED = [
  'readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync',
  'copyFileSync', 'truncateSync', 'rmSync', 'renameSync',
]

let installed = false

/**
 * Run `fn` marked as "this is a request/message handler". Anything synchronous
 * and file-touching underneath it throws when the guard is installed.
 */
export function whileServing(label, fn) {
  return serving.run({ label }, fn)
}

/** Express middleware form. */
export function syncIoGuardMiddleware(req, res, next) {
  whileServing(`${req.method} ${req.path}`, () => next())
}

export function currentlyServing() {
  return serving.getStore()?.label ?? null
}

/**
 * Patch the guarded methods so they throw while a handler is on the stack.
 * Idempotent. Returns a function that restores the originals.
 */
export function installSyncIoGuard() {
  if (installed) return () => {}
  installed = true
  const originals = new Map()
  for (const name of GUARDED) {
    const original = fs[name]
    if (typeof original !== 'function') continue
    originals.set(name, original)
    fs[name] = function guarded(...args) {
      const label = currentlyServing()
      if (label) {
        const error = new Error(
          `fs.${name} called while serving "${label}". Synchronous file IO on a ` +
          `request path blocks every other request, every socket message, and ` +
          `every daemon RPC for as long as it runs. Use the async form, move the ` +
          `work off the request, or -- first -- ask whether the read needs to ` +
          `exist at all.`)
        error.code = 'ERR_TLDA_SYNC_IO_WHILE_SERVING'
        throw error
      }
      return original.apply(this, args)
    }
  }
  return () => {
    for (const [name, original] of originals) fs[name] = original
    installed = false
  }
}

export const __test = { GUARDED }
