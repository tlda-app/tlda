import { fork } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'

import { loadServerConfig } from '../../shared/config.mjs'

const METHODS = [
  'getAgentsByIds',
  'getChatContext',
  'getSearchStats',
  'resolveAgentQuery',
  'resolveAgentSelector',
  'resolveAgentSpans',
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

// What this error may and may not assert.
//
// It used to name CPU starvation as the cause, in those words, and rule out the
// alternative. The timeout cannot distinguish those. All it observes is that no
// reply arrived in time.
//
// It was wrong, and expensively. On 2026-09-12 `from:skip & project:tlda` hit
// this bound because `project:tlda` resolves to 435 agents and the read then
// cost ~86ms per id; seconds later the same server answered a trivial read in
// 563ms, so the box was not starved and the query was exactly the thing this
// message swore it was not. A chief spent the night chasing CPU starvation on
// the strength of that sentence and repeated it to Skip as fact.
//
// The advice it then gave was worse, because it was actionable and false. It
// told the reader to run a trivial search to tell the two causes apart, and
// said a retry would queue behind the same child. Neither was true while the
// timeout did not cancel anything: each suggested query added another
// uncancellable scan to a box already saturated. Measured on 2026-09-12, the
// child held ~52 MB/s of disk reads for sixteen minutes after the last caller
// had given up.
//
// The timeout now cancels, by killing the child and letting the exit handler
// respawn it, so that text would describe a state that can no longer happen.
// What the bound still cannot do is tell you WHY, so it does not guess.
function searchTimeoutError(what, timeoutMs) {
  return new Error(
    `the fleet search child did not answer ${what} within ${timeoutMs}ms, `
    + `so it was killed and restarted — the query is no longer running and is no longer `
    + `holding the search worker. Any other searches in flight were cancelled with it, `
    + `because there is one child and no way to interrupt a single query inside it. `
    + `Retrying is safe, but the same query will probably take the same time. `
    + `Why it happened, in the order worth suspecting: the query was expensive (an agent `
    + `term resolving to many ids is the usual cause, and a label like project:<name> can `
    + `resolve to hundreds); or the child is starved, since it runs at BELOW_NORMAL `
    + `priority so that communications win the box ahead of search. This bound cannot tell `
    + `you which. Raise TLDA_SEARCH_REQUEST_TIMEOUT_MS if it is too tight for a `
    + `legitimately slow search.`,
  )
}

// How many search children to run.
//
// One was the original, and one is why a single slow query made search look
// broken: every other search queued behind it, and recycling it on timeout took
// the innocent ones too. A pool lets a slow query occupy its own worker while
// the rest keep answering, and confines a recycle to the queries on that child.
//
// Configurable because the right number is a property of the box, not of the
// code, and it lives in the deployment's `server.yaml` rather than an
// environment variable so a wrong value is a diff someone can read.
//
// Cost per child, measured on the live box rather than guessed: Pss 60.7 MB,
// of which 33.7 MB is private dirty — most of an RSS reading is shared pages
// counted again in every process, which is what makes RSS the wrong number for
// "what does one more of these cost". Against 2.4 GB available there, four is
// comfortable. It is still a knob because the fleet database grows and the box
// it runs on is about to change.
const DEFAULT_SEARCH_WORKERS = 4

function searchWorkerCount() {
  let configured
  try {
    configured = Number(loadServerConfig().searchWorkers)
  } catch {
    // A CLI or a test may run with no deployment config at all; the default is
    // not worth a startup failure.
    configured = NaN
  }
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_SEARCH_WORKERS
  return Math.floor(configured)
}

export class FleetSearchClient {
  constructor(dbPath, { workers = null } = {}) {
    this.dbPath = dbPath
    this._seq = 0
    this._pending = new Map()
    this._closed = false
    this._workers = []
    const count = Number.isFinite(workers) && workers >= 1 ? Math.floor(workers) : searchWorkerCount()
    for (let i = 0; i < count; i++) this._spawn(i)
    for (const method of METHODS) this[method] = (...args) => this._call(method, args)
  }

  _spawn(index) {
    const worker = this._workers[index] || { index, inflight: new Set() }
    this._workers[index] = worker
    worker.ready = new Promise((resolve, reject) => {
      worker.resolveReady = resolve
      worker.rejectReady = reject
    })
    worker.child = fork(new URL('./fleet-search-process.mjs', import.meta.url), [], {
      env: { ...process.env, TLDA_FLEET_DB: this.dbPath },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    try {
      setPriority(worker.child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch (error) {
      worker.child.kill()
      throw new Error(`could not lower fleet search process priority: ${error?.message || error}`, { cause: error })
    }
    worker.child.on('message', message => {
      if (message?.kind === 'ready') return worker.resolveReady()
      const waiter = this._pending.get(message?.id)
      if (!waiter) return
      this._pending.delete(message.id)
      worker.inflight.delete(message.id)
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
    worker.child.on('error', error => this._fail(worker, error))
    worker.child.on('exit', (code, signal) => this._onChildExit(worker, code, signal))
    return worker
  }

  // Separate from `_spawn` so a caller that supplies its own child — the tests
  // stub one rather than forking, because "the child never replies" is not
  // reproducible with a real subprocess — wires the same exit behaviour instead
  // of a copy of it that can drift.
  _onChildExit(worker, code, signal) {
    if (this._closed) return
    // A recycle is a deliberate kill, and the waiters that die with it did
    // nothing wrong — say which it was rather than reporting a bare exit.
    const reason = worker.recycleReason
    worker.recycleReason = null
    this._fail(worker, new Error(reason
      ? `the fleet search child was restarted because ${reason}; searches in flight on that child were cancelled with it`
      : `fleet search process exited (${code ?? signal})`))
    this._spawn(worker.index)
  }

  // Least busy wins. Nothing cleverer, because the cost of a search is not
  // knowable before it runs — the query that takes sixteen minutes looks exactly
  // like the one that takes 40ms until it is running.
  _pickWorker() {
    let chosen = this._workers[0]
    for (const worker of this._workers) {
      if (worker.inflight.size < chosen.inflight.size) chosen = worker
    }
    return chosen
  }

  // Kill one child so an uncancellable query stops consuming the box. Safe to
  // call more than once: the second kill finds no child, and `_closed` keeps
  // shutdown from respawning. Only this worker's queries are affected — which
  // is the point of having more than one.
  _recycle(worker, reason) {
    if (this._closed || !worker?.child) return
    worker.recycleReason = reason
    try { worker.child.kill('SIGKILL') } catch { /* already gone */ }
  }

  _fail(worker, error) {
    worker.rejectReady?.(error)
    for (const id of worker.inflight) {
      const waiter = this._pending.get(id)
      if (!waiter) continue
      this._pending.delete(id)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    worker.inflight.clear()
  }

  // The ready handshake gets the same bound as a request. `_call` used to await
  // readiness unguarded, so a child that forked but never sent {kind:'ready'}
  // hung EVERY call forever, with no timeout and nothing logged. Raced per call
  // rather than poisoning the promise itself, so a child that comes up late
  // still serves every later caller.
  _awaitReady(worker, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn(`[fleet-search-request] TIMEOUT after ${timeoutMs}ms waiting for child ready`)
        reject(searchTimeoutError('the ready handshake', timeoutMs))
      }, timeoutMs)
      timer.unref?.()
      worker.ready.then(
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
    const worker = this._pickWorker()
    return this._awaitReady(worker, timeoutMs).then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only this path can report a request that never came back. The elapsed
        // log below lives in the reply handler, so before this existed a hung
        // request produced no line at any log retention, ever.
        this._pending.delete(id)
        worker.inflight.delete(id)
        console.warn(`[fleet-search-request] TIMEOUT after ${timeoutMs}ms ${method} ${JSON.stringify(context || {})}`)
        reject(searchTimeoutError(`${method}()`, timeoutMs))
        // Abandoning the request left the scan running: `better-sqlite3` is
        // synchronous, so the child's event loop is inside the query and cannot
        // read an IPC cancel or run a signal handler. Killing the process is
        // the only thing that reaches it. The `exit` handler rejects that
        // child's remaining waiters and respawns it, so recovery is the path
        // that already exists rather than a new one.
        this._recycle(worker, `a ${method}() request exceeded ${timeoutMs}ms`)
      }, timeoutMs)
      // Never hold the process open on account of an in-flight search.
      timer.unref?.()
      this._pending.set(id, { resolve, reject, queuedAt: performance.now(), context, timer, worker })
      worker.inflight.add(id)
      worker.child.send({ id, method, args })
    }))
  }

  ready() { return Promise.all(this._workers.map(worker => worker.ready)) }

  async close() {
    if (this._closed) return
    this._closed = true
    await Promise.all(this._workers.map(worker => new Promise(resolve => {
      const id = ++this._seq
      this._pending.set(id, { resolve, reject: resolve })
      worker.inflight.add(id)
      try { worker.child.send({ id, kind: 'close' }) } catch { resolve() }
    })))
    for (const worker of this._workers) {
      try { worker.child.kill() } catch { /* already gone */ }
    }
  }
}
