// The thread that owns fleet.db.
//
// better-sqlite3 is synchronous, so every read and write blocks the thread it
// runs on. That is fine HERE and fatal on the main thread: a single scan has
// held the server's event loop for 178 seconds, during which chat, health,
// voice and task-close all stop together. On this thread a slow query blocks
// only this thread, and the main loop keeps serving.
//
// This thread holds the ONLY connection. That is the point: with one
// connection there is no second writer colliding mid-FTS-merge, and no write
// path can block the main loop for up to five seconds on SQLITE_BUSY.
//
// It also means the 15 read-then-write transactions need no protocol at all.
// They stay exactly as they are, synchronous, inside this thread. Splitting
// reads from writes would have made each one a distributed-transaction problem;
// moving the whole store makes them a non-problem.

import { parentPort, workerData } from 'node:worker_threads'
import { FleetStore } from './fleet-store.mjs'

const store = new FleetStore(workerData.dbPath, workerData.options || {})

// Events the store emits (share() -> SSE broadcast) have to reach the main
// thread, which is where the sockets are. They are plain rows, so they cross as
// data. Fire-and-forget: an emit is a broadcast and nothing awaits it.
store.onEvent(event => {
  parentPort.postMessage({ kind: 'event', event })
})

parentPort.on('message', async (msg) => {
  const { id, method, args } = msg
  // Lifecycle, not a query. The store has to be closed from in here — it owns
  // the connection, a WAL checkpoint and the cwd-segment backfill timer.
  // Terminating the thread without this kills it mid-write.
  if (msg.kind === 'close') {
    try { store.close() } catch (e) {
      parentPort.postMessage({ kind: 'result', id, error: { message: e?.message || String(e), stack: e?.stack || null } })
      return
    }
    parentPort.postMessage({ kind: 'result', id, result: null })
    return
  }
  try {
    const fn = store[method]
    if (typeof fn !== 'function') {
      throw new Error(`FleetStore has no method '${method}'`)
    }
    // await covers both: the ten methods that are already async, and the rest,
    // which return plain values that await passes through unchanged.
    const result = await fn.apply(store, args)
    parentPort.postMessage({ kind: 'result', id, result })
  } catch (e) {
    // The message must carry a real reason. A rejected call that arrives as
    // `undefined` is indistinguishable from a call that returned nothing, and
    // this boundary is exactly where a swallowed error would become "the store
    // is silently wrong" rather than "the store threw".
    parentPort.postMessage({
      kind: 'result',
      id,
      error: { message: e?.message || String(e), stack: e?.stack || null },
    })
  }
})

parentPort.postMessage({ kind: 'ready' })
