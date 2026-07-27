import {
  DAEMON_OUTBOX_ACK_TYPE,
  DAEMON_OUTBOX_ERROR_TYPE,
  DAEMON_OUTBOX_ID_FIELD,
  SERVER_DAEMON_OUTBOX_ACK_TYPE,
  SERVER_DAEMON_OUTBOX_ERROR_TYPE,
} from '../../shared/daemon-delivery.mjs'

export function daemonOutboxId(msg) {
  return msg?.[DAEMON_OUTBOX_ID_FIELD] || null
}

export function createDaemonWsControlPlane({
  daemonConnections,
  serverDaemonOutboxInflight,
  fleetStore,
  socketCanAcceptMore = () => true,
  clock = () => new Date().toISOString(),
  setTimeoutFn = setTimeout,
  log = console,
  classifyServerDaemonOutboxError = () => 'retry',
  onPermanentServerDaemonOutboxError = null,
} = {}) {
  // No store-missing guard on either of these. A null statement used to mean
  // "never processed" and "don't record", which would have replayed every
  // redelivered envelope forever without saying anything. The store is not
  // optional here; if it is missing the call throws, which is the correct
  // outcome for a server that cannot tell duplicates from new work.
  async function isProcessedDaemonOutboxMessage(msg) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId) return false
    return !!(await fleetStore.daemonOutboxWasProcessed(outboxId))
  }

  async function markDaemonOutboxMessageProcessed(msg) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId) return
    await fleetStore.markDaemonOutboxProcessed(outboxId, msg.type || 'unknown', clock())
  }

  function ackDaemonOutboxMessage(ws, msg) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId || ws.readyState !== 1) return
    ws.send(JSON.stringify({ type: DAEMON_OUTBOX_ACK_TYPE, outbox_id: outboxId }))
  }

  function errorDaemonOutboxMessage(ws, msg, error) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId || ws.readyState !== 1) return
    ws.send(JSON.stringify({
      type: DAEMON_OUTBOX_ERROR_TYPE,
      outbox_id: outboxId,
      error: String(error?.message || error || 'delivery failed'),
      permanent: error?.permanent === true,
    }))
  }

  async function enqueueDaemonMessage(daemonKey, message, { dedupeKey = null } = {}) {
    const id = await fleetStore.serverDaemonOutboxEnqueue(daemonKey, message, { dedupeKey })
    // Not awaited: enqueueing is durable, and a caller enqueueing a message
    // must not block on the daemon socket accepting it. The returned promise
    // never rejects — flushServerDaemonOutbox catches and logs — so dropping
    // it here cannot produce an unhandled rejection. Spelled `void` so the
    // async-cascade guard can tell a deliberate drop from a forgotten await.
    void flushServerDaemonOutbox(daemonKey)
    return id
  }

  async function ackServerDaemonOutboxMessage(msg) {
    const outboxId = msg?.outbox_id
    if (!outboxId) return
    await fleetStore.serverDaemonOutboxAck(outboxId)
    serverDaemonOutboxInflight.delete(outboxId)
  }

  async function errorServerDaemonOutboxMessage(msg) {
    const outboxId = msg?.outbox_id
    if (!outboxId) return
    const daemonKey = serverDaemonOutboxInflight.get(outboxId)
    const row = await fleetStore.serverDaemonOutboxGet(outboxId)
    const disposition = classifyServerDaemonOutboxError({ outboxId, daemonKey, msg, row })
    if (disposition === 'terminal') {
      await fleetStore.serverDaemonOutboxAck(outboxId)
      serverDaemonOutboxInflight.delete(outboxId)
      await onPermanentServerDaemonOutboxError?.({ outboxId, daemonKey, msg, row })
      return
    }
    await fleetStore.serverDaemonOutboxMarkError(outboxId, msg.error || 'receiver did not accept delivery')
    serverDaemonOutboxInflight.delete(outboxId)
    if (daemonKey) {
      const timer = setTimeoutFn(() => flushServerDaemonOutbox(daemonKey), 1000)
      timer?.unref?.()
    }
  }

  // One flush at a time per daemon, chained.
  //
  // This is not new caution — it is an invariant the synchronous version got
  // for free and the store moving off this thread takes away. Every ledger call
  // inside the loop is now a boundary crossing, so two overlapping flushes for
  // one daemon read the same pending page and interleave: the second sends a
  // later row while the first is still awaiting markAttempt on an earlier one,
  // and the queue goes out over the socket in an order that is not the order it
  // reported. Chaining restores exactly the serialization the single-threaded
  // loop provided.
  //
  // Claiming the row in serverDaemonOutboxInflight before the first await is
  // NOT sufficient on its own. It prevents a row being sent twice, and that is
  // all it prevents; the reordering survives it. Measured, because reasoning
  // about it goes wrong in both directions — scratch/outbox-ordering.mjs drives
  // three concurrent flushes over a real store and compares against the order
  // the queue itself reported. With the chain, byte-identical. Without it, and
  // with one crossing slower than the rest the way a real worker reply is, the
  // first row arrives LAST.
  //
  // "In order" here means the outbox's own order, `created_at ASC, id ASC` —
  // not enqueue order, which it has never guaranteed, because ids are random
  // UUIDs and rows enqueued in the same millisecond tie on created_at.
  //
  // The map holds one settled promise per daemon key, so it is bounded by the
  // number of daemons, not by traffic.
  const flushChain = new Map()

  function flushServerDaemonOutbox(daemonKey) {
    if (!daemonKey) return Promise.resolve()
    const next = (flushChain.get(daemonKey) || Promise.resolve())
      .then(() => flushOnce(daemonKey))
      .catch((e) => {
        // Reported, not rethrown: this runs from socket handlers and timers
        // that nobody awaits, so throwing here becomes an unhandled rejection
        // rather than a diagnosis. A failing flush means the ledger itself is
        // unreachable, which is worth seeing in the server log.
        log.error?.(`[server-daemon-outbox] flush failed for ${daemonKey}: ${e?.message || e}`)
      })
    flushChain.set(daemonKey, next)
    return next
  }

  async function flushOnce(daemonKey) {
    const dws = daemonConnections.get(daemonKey)
    if (!dws || dws.readyState !== 1) return
    const pending = await fleetStore.serverDaemonOutboxPendingForDaemon(daemonKey, 100)
    for (const row of pending) {
      if (serverDaemonOutboxInflight.has(row.id)) continue
      // Do not pile an unbounded replay behind a congested daemon socket. The
      // durable outbox keeps the remaining ordered rows for the next flush.
      if (!socketCanAcceptMore(dws)) {
        const timer = setTimeoutFn(() => flushServerDaemonOutbox(daemonKey), 25)
        timer?.unref?.()
        break
      }
      // Claimed before the first await in this iteration, so a flush that
      // started from another socket event cannot also claim this row.
      serverDaemonOutboxInflight.set(row.id, daemonKey)
      try {
        await fleetStore.serverDaemonOutboxMarkAttempt(row.id)
        dws.send(JSON.stringify(row.payload))
      } catch (e) {
        await fleetStore.serverDaemonOutboxMarkError(row.id, String(e?.message || e))
        serverDaemonOutboxInflight.delete(row.id)
        log.warn?.(`[server-daemon-outbox] send failed for ${daemonKey}:${row.type}: ${e.message}`)
        break
      }
    }
  }

  function clearServerDaemonOutboxInflightForDaemon(daemonKey) {
    for (const [outboxId, inflightDaemonKey] of serverDaemonOutboxInflight) {
      if (inflightDaemonKey === daemonKey) serverDaemonOutboxInflight.delete(outboxId)
    }
  }

  async function handleDaemonOutboxEnvelope(ws, msg, handleMessage, { onHandlerError = null } = {}) {
    try {
      if (msg?.type === SERVER_DAEMON_OUTBOX_ACK_TYPE) {
        await ackServerDaemonOutboxMessage(msg)
        return { handled: true, kind: 'server-daemon-outbox-ack' }
      }
      if (msg?.type === SERVER_DAEMON_OUTBOX_ERROR_TYPE) {
        await errorServerDaemonOutboxMessage(msg)
        return { handled: true, kind: 'server-daemon-outbox-error' }
      }
      if (await isProcessedDaemonOutboxMessage(msg)) {
        ackDaemonOutboxMessage(ws, msg)
        return { handled: true, kind: 'duplicate-daemon-outbox' }
      }
      await handleMessage(ws, msg)
      await markDaemonOutboxMessageProcessed(msg)
      ackDaemonOutboxMessage(ws, msg)
      return { handled: true, kind: 'processed' }
    } catch (e) {
      onHandlerError?.(e)
      errorDaemonOutboxMessage(ws, msg, e)
      return { handled: false, kind: 'error', error: e }
    }
  }

  return {
    handleDaemonOutboxEnvelope,
    isProcessedDaemonOutboxMessage,
    markDaemonOutboxMessageProcessed,
    ackDaemonOutboxMessage,
    errorDaemonOutboxMessage,
    enqueueDaemonMessage,
    ackServerDaemonOutboxMessage,
    errorServerDaemonOutboxMessage,
    flushServerDaemonOutbox,
    clearServerDaemonOutboxInflightForDaemon,
  }
}
