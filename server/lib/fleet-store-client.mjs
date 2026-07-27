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
  getAgent: 'one',
  findAgent: 'one',
  getAgentsByIds: 'many',
  getAgentsByDaemonKey: 'many',
  getLiveAgentsByFriendlyName: 'many',
  getAliveAgents: 'many',
  getLineageRoster: 'many',
  getAliveAgentsPage: 'page',
}

export class FleetStoreClient {
  constructor(dbPath, options = {}) {
    this._seq = 0
    this._pending = new Map()
    this._listeners = []
    this._closed = false

    this._worker = new Worker(new URL('./fleet-store.worker.mjs', import.meta.url), {
      workerData: { dbPath, options },
    })
    this._ready = new Promise((resolve) => { this._resolveReady = resolve })

    this._worker.on('message', (msg) => {
      if (msg.kind === 'ready') return this._resolveReady()
      if (msg.kind === 'event') {
        for (const fn of this._listeners) {
          try { fn(msg.event) } catch (e) {
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
    this._worker.on('error', (e) => this._failAll(new Error(`fleet store worker crashed: ${e?.message || e}`)))
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
          'Add it to NOT_PROXYABLE in the manifest generator with the reason a function ' +
          'crosses its boundary, then regenerate.',
        )
      }
      const shape = AGENT_RESULT_SHAPE[method]
      this[method] = shape
        ? (...args) => this._call(method, args).then(r => this._stampAgents(r, shape))
        : (...args) => this._call(method, args)
    }
  }

  _failAll(err) {
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
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, method, args })
    })
  }

  /** Resolves once the worker has opened the database. */
  ready() { return this._ready }

  onEvent(fn) {
    this._listeners.push(fn)
    return () => { this._listeners = this._listeners.filter(f => f !== fn) }
  }

  // Close the store inside the worker FIRST, then terminate. The store owns the
  // connection, a WAL checkpoint, a backfill timer and the db-writer worker;
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
