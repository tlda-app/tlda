import { fork } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'

const METHODS = [
  'getAgentsByIds',
  'getChatContext',
  'getSearchStats',
  'resolveAgentQuery',
  'resolveAgentSelector',
  'searchAll',
]

function requestContext(args) {
  for (const arg of args || []) {
    if (arg?._requestContext) return arg._requestContext
  }
  return null
}

// How long a request may sit in the child before we give up on it.
//
// There was no bound here at all. `_pending` entries were removed on a reply, or
// by `_fail` when the child ERRORED or EXITED -- so a child that was alive but
// not answering held every request forever, and the caller's own 45s WS deadline
// was the only thing that ended them.
//
// That is not hypothetical: this child is forked at PRIORITY_BELOW_NORMAL, and
// the server box is 2 CPUs with no swap that also runs builds. A build saturates
// both cores, the child gets almost no CPU, and the main thread -- being NORMAL
// -- keeps its event loop clean the whole time. Measured 2026-09-03 during a
// 20-minute outage: peak event-loop lag 931ms, so every main-thread instrument
// reported health while search returned nothing.
//
// Default is below the 45s caller deadline on purpose, so this named error wins
// the race and the caller learns the child is starved rather than seeing a
// generic socket timeout. It is well above any healthy search, so a slow-but-live
// query still completes rather than being failed by this bound.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function requestTimeoutMs() {
  const configured = Number(process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS
}

function starvedChildError(what, timeoutMs) {
  return new Error(
    `the fleet search child did not answer ${what} within ${timeoutMs}ms. `
    + `The child process is alive but not replying, which is CPU starvation on the server box, `
    + `not your query being too large and not the store being down: it runs at BELOW_NORMAL priority, `
    + `so a build or render saturating the box starves it while the main thread still looks healthy. `
    + `Retrying now queues behind the same starved child. `
    + `Raise TLDA_SEARCH_REQUEST_TIMEOUT_MS if this bound is too tight for a legitimately slow search.`,
  )
}

export class FleetSearchClient {
  constructor(dbPath) {
    this.dbPath = dbPath
    this._seq = 0
    this._pending = new Map()
    this._closed = false
    this._spawn()
    for (const method of METHODS) this[method] = (...args) => this._call(method, args)
  }

  _spawn() {
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    this._child = fork(new URL('./fleet-search-process.mjs', import.meta.url), [], {
      env: { ...process.env, TLDA_FLEET_DB: this.dbPath },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    try {
      setPriority(this._child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch (error) {
      this._child.kill()
      throw new Error(`could not lower fleet search process priority: ${error?.message || error}`, { cause: error })
    }
    this._child.on('message', message => {
      if (message?.kind === 'ready') return this._resolveReady()
      const waiter = this._pending.get(message?.id)
      if (!waiter) return
      this._pending.delete(message.id)
      if (waiter.timer) clearTimeout(waiter.timer)
      const elapsedMs = performance.now() - waiter.queuedAt
      if (elapsedMs >= Number(process.env.TLDA_SEARCH_REQUEST_LOG_MS || 1000)) {
        console.warn(`[fleet-search-request] ${elapsedMs.toFixed(1)}ms ${JSON.stringify(waiter.context || {})}`)
      }
      if (message.error) {
        const error = new Error(message.error.message)
        error.processStack = message.error.stack
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
    })
    this._child.on('error', error => this._fail(error))
    this._child.on('exit', (code, signal) => {
      if (this._closed) return
      this._fail(new Error(`fleet search process exited (${code ?? signal})`))
      this._spawn()
    })
  }

  _fail(error) {
    this._rejectReady?.(error)
    for (const waiter of this._pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this._pending.clear()
  }

  // The ready handshake gets the same bound as a request. `_call` used to await
  // `this._ready` unguarded, so a child that forked but never sent {kind:'ready'}
  // hung EVERY call forever, with no timeout and nothing logged. Raced per call
  // rather than poisoning `_ready` itself, so a child that comes up late still
  // serves every later caller.
  _awaitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn(`[fleet-search-request] TIMEOUT after ${timeoutMs}ms waiting for child ready`)
        reject(starvedChildError('the ready handshake', timeoutMs))
      }, timeoutMs)
      timer.unref?.()
      this._ready.then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
    })
  }

  _call(method, args) {
    if (this._closed) return Promise.reject(new Error('fleet search client is closed'))
    const id = ++this._seq
    const timeoutMs = requestTimeoutMs()
    const context = requestContext(args)
    return this._awaitReady(timeoutMs).then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only this path can report a request that never came back. The elapsed
        // log below lives in the reply handler, so before this existed a hung
        // request produced no line at any log retention, ever.
        this._pending.delete(id)
        console.warn(`[fleet-search-request] TIMEOUT after ${timeoutMs}ms ${method} ${JSON.stringify(context || {})}`)
        reject(starvedChildError(`${method}()`, timeoutMs))
      }, timeoutMs)
      // Never hold the process open on account of an in-flight search.
      timer.unref?.()
      this._pending.set(id, { resolve, reject, queuedAt: performance.now(), context, timer })
      this._child.send({ id, method, args })
    }))
  }

  ready() { return this._ready }

  async close() {
    if (this._closed) return
    this._closed = true
    const id = ++this._seq
    await new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._child.send({ id, kind: 'close' })
    })
    this._child.kill()
  }
}
