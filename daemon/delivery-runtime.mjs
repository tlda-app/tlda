import {
  DELIVERY_DIRECT,
  DELIVERY_DURABLE_FIFO,
  DELIVERY_EPHEMERAL_FIFO,
  DELIVERY_LATEST_WINS,
  daemonDeliveryPolicy,
} from './delivery-policy.mjs'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'

export class DaemonDeliveryRuntime {
  constructor({
    outbox,
    send,
    isConnected,
    isReady,
    log = null,
    ephemeralQueueLimit = 200,
    activityDeliveryCounters = null,
    beforeSend = null,
    ackGate = null,
    onDeadLetter = null,
    inflightDeadlineMs,
    now = () => Date.now(),
  }) {
    if (!Number.isFinite(inflightDeadlineMs) || inflightDeadlineMs <= 0) {
      throw new Error(`DaemonDeliveryRuntime requires a positive inflightDeadlineMs (got ${JSON.stringify(inflightDeadlineMs)})`)
    }
    this.outbox = outbox
    this.sendDirect = send
    this.isConnected = isConnected
    this.isReady = isReady
    this.log = log
    this.ephemeralQueueLimit = ephemeralQueueLimit
    // id → the time we handed it to the socket. A Set was enough while the
    // only exits were ack, error and reconnect; it has to carry the send time
    // now so a row that is never answered can be released.
    this.inflight = new Map()
    this.inflightDeadlineMs = inflightDeadlineMs
    this.now = now
    this.ephemeralQueues = new Map()
    this.flushTimer = null
    this.flushRunning = false
    this.droppedCount = 0
    this.droppedWarnAt = 0
    this.activityDeliveryCounters = activityDeliveryCounters
    this.beforeSend = beforeSend
    this.ackGate = ackGate
    this.onDeadLetter = onDeadLetter
  }

  send(message) {
    const policy = daemonDeliveryPolicy(message)

    if (policy === DELIVERY_DURABLE_FIFO) {
      const durableId = message?.type === 'rpc-reply' && message.id
        ? `rpc-reply:${message.id}:${message.request_fingerprint || 'unknown'}`
        : null
      const explicitId = message?.[DAEMON_OUTBOX_ID_FIELD] || durableId
      this.outbox.enqueue(message, explicitId ? { id: explicitId } : undefined)
      this.recordActivityDelivery('daemonQueued', message)
      this.scheduleFlush()
      return true
    }

    if (policy === DELIVERY_EPHEMERAL_FIFO) {
      if (this.trySend(message)) return true
      this.enqueueEphemeral(message, false)
      this.warnDropped(message)
      return false
    }

    if (policy === DELIVERY_LATEST_WINS) {
      if (this.trySend(message)) return true
      this.enqueueEphemeral(message, true)
      this.warnDropped(message)
      return false
    }

    if (policy === DELIVERY_DIRECT && this.trySend(message)) return true
    this.warnDropped(message)
    return false
  }

  handleAck(outboxId) {
    if (!outboxId) return
    const row = this.outbox.get(outboxId)
    if (row?.type === 'source-change' && this.ackGate && !this.ackGate(row.payload)) {
      // **Say it.** Refusing an ack we have already received leaves a row that
      // cannot leave the outbox, and until now it did so in total silence: the
      // server counts a delivered, acked envelope while the daemon holds the row
      // forever. Neither end can tell, and on 2026-08-18 the only trace was a
      // frozen `min(created_at)` reconstructed twenty-five minutes later.
      //
      // One line, and it makes the next occurrence visible while it is
      // happening. It is deliberately at warn: a row that can never leave is not
      // routine, however ordinary the reason.
      this.log?.warn?.(
        `refused the server's ack for ${row.type} ${outboxId}: its edit operations have not settled, `
        + `so the row stays in the outbox and will be re-sent (attempts=${row.attempts ?? 0})`,
      )
      return false
    }
    this.recordActivityDelivery('daemonAcked', row?.payload || { type: row?.type || 'unknown' })
    this.outbox.ack(outboxId)
    this.inflight.delete(outboxId)
    this.scheduleFlush()
    return true
  }

  /**
   * A refusal is an answer. Settle the row on it.
   *
   * `handleAck` refuses to settle a source-change whose ackGate is closed, and
   * the gate reads dispositions that a refused push does not always produce. So
   * a refused row was re-offered on every inflight deadline, re-sent, refused
   * again, forever: measured on bregman at 13:39Z, 35 pending rows, ~105
   * attempts each, `last_error: null` -- the outbox had never recorded that the
   * server said anything at all, which is why its own warning read "the server
   * received it and never answered" while the server had answered every time.
   *
   * Deliberately NOT gated. The gate exists so an unanswered push does not
   * disappear while its edits are unresolved; this path runs only when the
   * server HAS answered, and only after the sync layer has taken its action on
   * that answer -- enqueued the retry, blocked the project, or handed the
   * conflict to a person. The bytes are held above the transport in either
   * `blockedPayloads` or the retry row, so what leaves here is a delivery that
   * is finished, not an edit that is unresolved.
   *
   * Loud, because a row leaving without a trace is the same disease as one that
   * never leaves.
   */
  settleRefused(outboxId, reason) {
    if (!outboxId) return false
    const row = this.outbox.get(outboxId)
    if (!row) return false
    this.log?.warn?.(`daemon durable message settled by refusal after ${row.attempts || 0} attempt(s) (type=${row.payload?.type || 'unknown'}, id=${outboxId}): ${reason || 'refused'} — the sync layer owns what happens to the edit now, the transport does not re-send it`)
    this.outbox.ack(outboxId)
    this.inflight.delete(outboxId)
    this.scheduleFlush()
    return true
  }

  handleError(outboxId, error, { permanent = false } = {}) {
    if (!outboxId) return
    if (permanent) {
      this.outbox.deadLetter(outboxId, error || 'delivery failed')
      this.inflight.delete(outboxId)
      this.onDeadLetter?.(this.outbox.get(outboxId)?.payload, outboxId)
      this.log?.warn?.(`daemon durable message permanently rejected: ${String(error || 'delivery failed')}`)
      return
    }
    this.outbox.markError(outboxId, error || 'delivery failed', { deadLetterEligible: false })
    this.inflight.delete(outboxId)
    this.scheduleFlush()
  }

  noteReady() {
    this.inflight.clear()
    this.flushEphemeral()
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushDurable()
    }, 0)
  }

  // FIFO holds WITHIN an ordering stream, not across the whole queue. A
  // `source-change` may not overtake an earlier `source-change`; it has no
  // ordering relationship with an `agent-route` at all, and pretending it does
  // is what turned seven stuck envelopes into a total delivery outage.
  //
  // Measured on the testing daemon 2026-08-18: seven `source-change` envelopes
  // whose acks the gate refuses had been re-sent across 113 reconnects. They and
  // the rows sent alongside them filled `inflight` to 112 — against a batch
  // window of 100. Every row `pending(100)` returned was already inflight, every
  // one was skipped, and the flush sent nothing. 36,000 envelopes had been
  // stranded since 15 August, including 6,312 `agent-route`, 575 `rpc-reply` and
  // 2,443 `jsonl-index`, and every one of them was reported as queued.
  //
  // Note the shape: below 100 pinned rows this is a percentage cost, at 100 it
  // is a full stop, and the code reads identically either side of that line.
  static _orderingStream(row) {
    // Only source-change carries an ordering guarantee worth blocking on. One
    // stream rather than one per project: it preserves exactly today's ordering
    // and does not depend on parsing a project out of the payload.
    return row?.type === 'source-change' ? 'source-change' : null
  }

  flushDurable() {
    if (this.flushRunning || !this.isReady() || !this.isConnected()) return
    this.flushRunning = true
    try {
      // Ask for the budget PLUS whatever is pinned, so rows awaiting an ack
      // cannot consume the window. Without this the fetch is the bug: pinned
      // rows are counted before the ones that could actually be sent.
      const budget = 100
      const blocked = new Set()
      let sent = 0
      const drain = (rows) => {
        for (const row of rows) {
          if (sent >= budget) return true
          const stream = DaemonDeliveryRuntime._orderingStream(row)
          const sentAt = this.inflight.get(row.id)
          if (sentAt !== undefined) {
            const heldMs = this.now() - sentAt
            if (heldMs < this.inflightDeadlineMs) {
              // Awaiting an ack and still within its deadline, so nothing may
              // overtake it in ITS stream. Everything else steps past it.
              if (stream) blocked.add(stream)
              continue
            }
            // Loud on purpose. Reaching here means the server took this message
            // and neither acked nor errored it, which the sender cannot tell
            // from a message still in transit -- a severed wire reporting
            // health. Releasing the slot keeps the queue moving; it does not
            // make the silence acceptable, and this line is the only place that
            // silence becomes visible.
            this.log?.warn?.(`daemon durable message unanswered for ${Math.round(heldMs / 1000)}s (type=${row.payload?.type || 'unknown'}, id=${row.id}) — releasing its delivery slot and offering it again; the server received it and never answered`)
            this.inflight.delete(row.id)
          }
          if (stream && blocked.has(stream)) continue
          this.inflight.set(row.id, this.now())
          this.outbox.markAttempt(row.id)
          if (!this.trySend(row.payload)) {
            this.inflight.delete(row.id)
            this.outbox.markTransientError(row.id, 'websocket not open')
            return true
          }
          sent++
          this.recordActivityDelivery('daemonSent', row.payload)
        }
        return false
      }

      const stop = drain(this.outbox.pending(budget + this.inflight.size))
      // A blocked stream's own backlog can fill the window on its own — 36,000
      // rows of which most were `source-change` is exactly that. Once a stream
      // is known blocked, re-ask for the rows it is NOT holding up, so a large
      // stuck backlog costs one extra query instead of everyone else's delivery.
      if (!stop && sent < budget && blocked.size) {
        drain(this.outbox.pendingExcludingTypes([...blocked], budget - sent))
      }
    } finally {
      this.flushRunning = false
    }
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  flushEphemeral() {
    if (!this.isConnected()) return
    for (const [key, queue] of this.ephemeralQueues) {
      while (queue.length > 0) {
        if (!this.trySend(queue[0])) return
        queue.shift()
      }
      this.ephemeralQueues.delete(key)
    }
  }

  trySend(message) {
    try {
      this.beforeSend?.(message)
      return this.sendDirect(message) === true
    } catch (e) {
      this.log?.warn?.(`daemon delivery send failed for ${message?.type || 'unknown'}: ${e.message}`)
      return false
    }
  }

  enqueueEphemeral(message, latestWins) {
    const key = this.ephemeralKey(message)
    if (latestWins) {
      this.ephemeralQueues.set(key, [message])
      return
    }
    const queue = this.ephemeralQueues.get(key) || []
    queue.push(message)
    while (queue.length > this.ephemeralQueueLimit) queue.shift()
    this.ephemeralQueues.set(key, queue)
  }

  ephemeralKey(message) {
    return `${message?.type || 'unknown'}:${message?.agent_id || message?.agentId || message?.tmux_session || 'global'}`
  }

  warnDropped(message) {
    this.droppedCount++
    this.recordActivityDelivery('daemonDropped', message)
    const now = Date.now()
    if (now - this.droppedWarnAt > 5000) {
      this.log?.warn?.(`dropping messages (ws not open); dropped ${this.droppedCount} since last warn; sample type=${message?.type}`)
      this.droppedCount = 0
      this.droppedWarnAt = now
    }
  }

  recordActivityDelivery(stage, message) {
    this.activityDeliveryCounters?.record?.(stage, message, 1, {
      agent: message?.agent_id || message?.agentId || null,
      tool: message?.tool || null,
    })
  }
}
