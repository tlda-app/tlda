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
  serverDaemonOutbox,
  serverDaemonOutboxInflight,
  daemonOutboxProcessedGetStmt = null,
  daemonOutboxProcessedInsertStmt = null,
  socketCanAcceptMore = () => true,
  clock = () => new Date().toISOString(),
  setTimeoutFn = setTimeout,
  log = console,
} = {}) {
  function isProcessedDaemonOutboxMessage(msg) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId || !daemonOutboxProcessedGetStmt) return false
    return !!daemonOutboxProcessedGetStmt.get(outboxId)
  }

  function markDaemonOutboxMessageProcessed(msg) {
    const outboxId = daemonOutboxId(msg)
    if (!outboxId || !daemonOutboxProcessedInsertStmt) return
    daemonOutboxProcessedInsertStmt.run(outboxId, msg.type || 'unknown', clock())
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

  function enqueueDaemonMessage(daemonKey, message, { dedupeKey = null } = {}) {
    const id = serverDaemonOutbox.enqueue(daemonKey, message, { dedupeKey })
    flushServerDaemonOutbox(daemonKey)
    return id
  }

  function ackServerDaemonOutboxMessage(msg) {
    const outboxId = msg?.outbox_id
    if (!outboxId) return
    serverDaemonOutbox.ack(outboxId)
    serverDaemonOutboxInflight.delete(outboxId)
  }

  function errorServerDaemonOutboxMessage(msg) {
    const outboxId = msg?.outbox_id
    if (!outboxId) return
    const daemonKey = serverDaemonOutboxInflight.get(outboxId)
    serverDaemonOutbox.markError(outboxId, msg.error || 'receiver did not accept delivery')
    serverDaemonOutboxInflight.delete(outboxId)
    if (daemonKey) {
      const timer = setTimeoutFn(() => flushServerDaemonOutbox(daemonKey), 1000)
      timer?.unref?.()
    }
  }

  function flushServerDaemonOutbox(daemonKey) {
    const dws = daemonConnections.get(daemonKey)
    if (!dws || dws.readyState !== 1) return
    for (const row of serverDaemonOutbox.pendingForDaemon(daemonKey, 100)) {
      if (serverDaemonOutboxInflight.has(row.id)) continue
      // Do not pile an unbounded replay behind a congested daemon socket. The
      // durable outbox keeps the remaining ordered rows for the next flush.
      if (!socketCanAcceptMore(dws)) {
        const timer = setTimeoutFn(() => flushServerDaemonOutbox(daemonKey), 25)
        timer?.unref?.()
        break
      }
      try {
        serverDaemonOutbox.markAttempt(row.id)
        dws.send(JSON.stringify(row.payload))
        serverDaemonOutboxInflight.set(row.id, daemonKey)
      } catch (e) {
        serverDaemonOutbox.markError(row.id, e)
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
        ackServerDaemonOutboxMessage(msg)
        return { handled: true, kind: 'server-daemon-outbox-ack' }
      }
      if (msg?.type === SERVER_DAEMON_OUTBOX_ERROR_TYPE) {
        errorServerDaemonOutboxMessage(msg)
        return { handled: true, kind: 'server-daemon-outbox-error' }
      }
      if (isProcessedDaemonOutboxMessage(msg)) {
        ackDaemonOutboxMessage(ws, msg)
        return { handled: true, kind: 'duplicate-daemon-outbox' }
      }
      await handleMessage(ws, msg)
      markDaemonOutboxMessageProcessed(msg)
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
