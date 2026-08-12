// The main thread's handle on the fleet store, which now lives on a worker.
//
// Every method returns a Promise. That is the whole risk of this change and the
// reason the await-fleet-store lint rule exists: an un-awaited call yields a
// Promise, a Promise is truthy, and every property on it is undefined — so
// `agent.dead` reads as ALIVE and live agents get reaped, with nothing thrown.
//
// Methods are generated from FLEET_STORE_METHODS rather than from a bare Proxy,
// deliberately. A Proxy would turn every typo into a call that fails at the
// far end, or worse hangs; generating from the manifest keeps
// `store.getAgnet(...)` a TypeError on the calling line, the way it is today.

import { Worker } from 'node:worker_threads'
import { FLEET_STORE_METHODS } from './fleet-store-methods.mjs'

// Which methods hand back agent rows, and where the rows sit in what they
// return. The store no longer stamps `runtime_status` — liveness is a
// projection over live sockets and heartbeat evidence, none of which exists on
// the thread holding the database — so it is stamped here instead, on the main
// thread, where that evidence already lives.
//
// An explicit list rather than "walk the result and stamp anything that looks
// like an agent": a shape-sniffing stamper silently misses a new method, and a
// missing runtime_status reads as hibernating, which is the reap-a-live-agent
// failure this whole change is trying not to cause.
const AGENT_RESULT_SHAPE = {
  getAllAgents: 'many',
  getAgent: 'one',
  findAgent: 'one',
  getAgentsByIds: 'many',
  getAgentsByDaemonKey: 'many',
  getLiveAgentsByFriendlyName: 'many',
  getAliveAgents: 'many',
  getPendingShellAgents: 'many',
  getLineageRoster: 'many',
  getAliveAgentsPage: 'page',
}

export class FleetStoreClient {
  constructor(dbPath, options = {}) {
    // Mirrors FleetStore.dbPath so diagnostics that report which database the
    // store opened keep working with no boundary crossing.
    this.dbPath = dbPath
    this._seq = 0
    this._pending = new Map()
    this._listeners = []
    this._closed = false
    // Queue accounting. The worker is one thread handling one message at a
    // time, so everything queued behind the running call waits for it, and that
    // wait is the whole latency of a store call under load — not the query.
    // Nothing on the main thread could see it: the loop stays healthy while
    // callers wait, so event-loop lag reads fine and each caller's own timer
    // reports its total wait as if the call itself were slow. Twelve RPCs were
    // observed completing within 3ms of each other, each reporting 3.32s, with
    // main-thread lag at 20.9ms — one blocking op, eleven queued behind it, no
    // instrument anywhere that could say so.
    this._queueStats = { calls: 0, settled: 0, maxDepth: 0, waitTotalMs: 0, waitMaxMs: 0, byMethod: new Map() }

    this._worker = new Worker(new URL('./fleet-store.worker.mjs', import.meta.url), {
      workerData: { dbPath, options },
    })
    this._readySettled = false
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = () => {
        this._readySettled = true
        resolve()
      }
      this._rejectReady = (error) => {
        this._readySettled = true
        reject(error)
      }
    })

    this._worker.on('message', (msg) => {
      if (msg.kind === 'ready') return this._resolveReady()
      if (msg.kind === 'event') {
        const event = Array.isArray(msg.event?._filter_agents)
          ? { ...msg.event, _filter_agents: this._stampAgents(msg.event._filter_agents, 'many') }
          : msg.event
        for (const fn of this._listeners) {
          try { fn(event) } catch (e) {
            // Reported, not rethrown: listeners are independent subscribers and
            // one failing must not stop the event reaching the others.
            console.error('[fleet-store-client] event listener threw:', e?.message || e)
          }
        }
        return
      }
      const waiter = this._pending.get(msg.id)
      if (!waiter) return
      this._pending.delete(msg.id)
      this._recordSettled(waiter)
      if (msg.error) {
        const err = new Error(msg.error.message)
        // Keep the worker-side stack; without it every store failure looks like
        // it originated at this line, which is useless for finding the query.
        err.workerStack = msg.error.stack
        waiter.reject(err)
      } else {
        waiter.resolve(msg.result)
      }
    })

    // A dead store is not recoverable by retrying — it means the thread holding
    // the only connection is gone. Fail every caller loudly rather than leaving
    // them awaiting a promise that will never settle.
    this._worker.on('error', (e) => {
      const detail = e?.stack || e?.message || (
        typeof e === 'object' ? JSON.stringify(e) : String(e)
      )
      this._failAll(new Error(`fleet store worker crashed: ${detail}`))
    })
    this._worker.on('exit', (code) => {
      if (!this._closed) this._failAll(new Error(`fleet store worker exited (${code})`))
    })

    for (const method of FLEET_STORE_METHODS) {
      // Refuse to overwrite something this class implements itself. Without
      // this the loop silently replaced `onEvent` with an RPC call that tried
      // to postMessage the listener callback, and the failure surfaced as a
      // DataCloneError from an unrelated line. A method the client owns is
      // owned deliberately; a manifest that reintroduces it is a mistake in the
      // manifest, and it should say so here rather than at the far end.
      if (typeof this[method] === 'function' || method in FleetStoreClient.prototype) {
        throw new Error(
          `FLEET_STORE_METHODS lists '${method}', which FleetStoreClient implements itself. ` +
          'Remove it from the list in server/lib/fleet-store-methods.mjs and note it under ' +
          '"Deliberately NOT here" with the reason a function crosses its boundary.',
        )
      }
      const shape = AGENT_RESULT_SHAPE[method]
      this[method] = shape
        ? (...args) => this._call(method, args).then(r => this._stampAgents(r, shape))
        : (...args) => this._call(method, args)
    }
  }

  _failAll(err) {
    if (!this._readySettled) this._rejectReady(err)
    for (const [, waiter] of this._pending) waiter.reject(err)
    this._pending.clear()
  }

  // The projector runs on this thread, against evidence this thread owns. It
  // replaces setRuntimeStatusProvider, which handed the same closure to the
  // store — the difference being that here nothing has to cross a boundary to
  // call it.
  setRuntimeProjector(fn) {
    this._projectRuntimeStatus = fn
  }

  _stampAgents(result, shape) {
    const project = this._projectRuntimeStatus
    if (!project || result == null) return result
    const one = (agent) => (agent ? { ...agent, runtime_status: project(agent) } : agent)
    if (shape === 'one') return one(result)
    if (shape === 'many') return Array.isArray(result) ? result.map(one) : result
    if (shape === 'page') {
      return Array.isArray(result?.agents) ? { ...result, agents: result.agents.map(one) } : result
    }
    return result
  }

  _call(method, args) {
    if (this._closed) return Promise.reject(new Error('fleet store client is closed'))
    const id = ++this._seq
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method, queuedAt: performance.now() })
      this._recordQueued(method)
      this._worker.postMessage({ id, method, args })
    })
  }

  _methodStats(method) {
    let stats = this._queueStats.byMethod.get(method)
    if (!stats) {
      stats = { calls: 0, settled: 0, waitTotalMs: 0, waitMaxMs: 0 }
      this._queueStats.byMethod.set(method, stats)
    }
    return stats
  }

  _recordQueued(method) {
    const q = this._queueStats
    q.calls += 1
    if (this._pending.size > q.maxDepth) q.maxDepth = this._pending.size
    this._methodStats(method).calls += 1
  }

  _recordSettled(waiter) {
    if (!waiter?.method) return
    const waited = performance.now() - waiter.queuedAt
    const q = this._queueStats
    q.settled += 1
    q.waitTotalMs += waited
    if (waited > q.waitMaxMs) q.waitMaxMs = waited
    const stats = this._methodStats(waiter.method)
    stats.settled += 1
    stats.waitTotalMs += waited
    if (waited > stats.waitMaxMs) stats.waitMaxMs = waited
  }

  /**
   * What the queue in front of the store looks like right now, and what it has
   * cost since this process started. `depth` is the calls waiting or running;
   * `oldestWaitMs` is how long the one at the head has been waiting, which is
   * the number that says "wedged" rather than "busy". Per-method rows name
   * which caller is paying and which is charging.
   *
   * Cumulative counters rather than a sampled window: a ring would need a size
   * and a window would need a period, and neither is a fact anybody has. A
   * counter read twice is a rate, and the caller already knows the interval.
   */
  queueStats() {
    const q = this._queueStats
    let oldestWaitMs = 0
    let head = null
    const now = performance.now()
    for (const waiter of this._pending.values()) {
      if (!waiter.method) continue
      const waited = now - waiter.queuedAt
      if (waited > oldestWaitMs) {
        oldestWaitMs = waited
        head = waiter.method
      }
    }
    const byMethod = {}
    for (const [method, stats] of q.byMethod) {
      byMethod[method] = {
        calls: stats.calls,
        settled: stats.settled,
        waitMeanMs: stats.settled ? stats.waitTotalMs / stats.settled : 0,
        waitMaxMs: stats.waitMaxMs,
      }
    }
    return {
      depth: this._pending.size,
      oldestWaitMs,
      oldestMethod: head,
      maxDepth: q.maxDepth,
      calls: q.calls,
      settled: q.settled,
      waitMeanMs: q.settled ? q.waitTotalMs / q.settled : 0,
      waitMaxMs: q.waitMaxMs,
      byMethod,
    }
  }

  /** Resolves once the worker has opened the database. */
  ready() { return this._ready }

  onEvent(fn) {
    this._listeners.push(fn)
    return () => { this._listeners = this._listeners.filter(f => f !== fn) }
  }

  // Close the store inside the worker FIRST, then terminate. The store owns the
  // connection, a WAL checkpoint and a backfill timer;
  // terminating the thread without closing it kills all of that mid-flight.
  async close() {
    if (this._closed) return
    const id = ++this._seq
    const closed = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, kind: 'close' })
    })
    try {
      await closed
    } catch (e) {
      // Surfaced, not swallowed: a store that could not close cleanly may have
      // left the database mid-checkpoint, and that is worth knowing about even
      // though we terminate either way.
      console.error('[fleet-store-client] store did not close cleanly:', e?.message || e)
    }
    this._closed = true
    this._failAll(new Error('fleet store client closed'))
    await this._worker.terminate()
  }
}
