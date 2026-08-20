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
    onDeadLetter = null,
    inflightDeadlineMs,
    flushByteBudget,
    now = () => Date.now(),
  }) {
    if (!Number.isFinite(inflightDeadlineMs) || inflightDeadlineMs <= 0) {
      throw new Error(`DaemonDeliveryRuntime requires a positive inflightDeadlineMs (got ${JSON.stringify(inflightDeadlineMs)})`)
    }
    if (!Number.isFinite(flushByteBudget) || flushByteBudget <= 0) {
      throw new Error(`DaemonDeliveryRuntime requires a positive flushByteBudget (got ${JSON.stringify(flushByteBudget)})`)
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
    this.flushByteBudget = flushByteBudget
    this.now = now
    this.ephemeralQueues = new Map()
    this.flushTimer = null
    this.flushRunning = false
    this.droppedCount = 0
    this.droppedWarnAt = 0
    this.activityDeliveryCounters = activityDeliveryCounters
    this.beforeSend = beforeSend
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
    this.recordActivityDelivery('daemonAcked', row?.payload || { type: row?.type || 'unknown' })
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

  static _orderingStream(row) {
    return null
  }

  // Claim, then read. The window is scanned by id and type; a payload is read
  // and parsed only for a row this tick is going to hand to the socket, and only
  // until the byte budget is spent.
  //
  // The order matters more than it looks. Reading the window with payloads and
  // deciding afterwards means every skipped row is still read from SQLite and
  // JSON.parse'd -- and once the window is in flight, that is the whole cost of
  // the tick and none of it sends anything. Measured on the live daemon: one
  // 100-row window was 11.0 MB, 10.9 MB of it a single row, at 270-702ms of
  // synchronous time per flush. The daemon is a relay as well as a queue, and a
  // relay that blocks for 0.3-0.7s at a time cannot read the acks that would
  // retire the rows making it block.
  //
  // Measured ceiling before this change: 84 delivered/min against 104 produced.
  flushDurable() {
    if (this.flushRunning || !this.isReady() || !this.isConnected()) return
    this.flushRunning = true
    let stoppedOnBudget = false
    try {
      // Ask for the budget PLUS whatever is pinned, so rows awaiting an ack
      // cannot consume the window. Without this the fetch is the bug: pinned
      // rows are counted before the ones that could actually be sent.
      const budget = 100
      const blocked = new Set()
      let sent = 0
      let remainingBytes = this.flushByteBudget
      const drain = (rows) => {
        for (const ref of rows) {
          if (sent >= budget) return true
          const stream = DaemonDeliveryRuntime._orderingStream(ref)
          const sentAt = this.inflight.get(ref.id)
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
            // The type comes from the row's own column rather than the payload,
            // so saying this costs no payload read.
            this.log?.warn?.(`daemon durable message unanswered for ${Math.round(heldMs / 1000)}s (type=${ref.type || 'unknown'}, id=${ref.id}) — releasing its delivery slot and offering it again; the server received it and never answered`)
            this.inflight.delete(ref.id)
          }
          if (stream && blocked.has(stream)) continue
          // Checked before the read, so an exhausted budget costs nothing. Only
          // consulted BETWEEN rows: the first row of a tick always goes, even if
          // it is larger than the whole budget, or an oversized payload could
          // never be delivered at all.
          if (remainingBytes <= 0) {
            stoppedOnBudget = true
            return true
          }
          // Everything above decided from id and type alone. This is the first
          // line that touches the payload, and it runs only for a row that is
          // about to be handed to the socket.
          const row = this.outbox.getWithSize(ref.id)
          if (!row) continue
          this.inflight.set(row.id, this.now())
          this.outbox.markAttempt(row.id)
          if (!this.trySend(row.payload)) {
            this.inflight.delete(row.id)
            this.outbox.markTransientError(row.id, 'websocket not open')
            return true
          }
          sent++
          remainingBytes -= row.payloadBytes
          this.recordActivityDelivery('daemonSent', row.payload)
        }
        return false
      }

      const stop = drain(this.outbox.pendingRefs(budget + this.inflight.size))
      // A blocked stream's own backlog can fill the window on its own — 36,000
      // rows of which most were `source-change` is exactly that. Once a stream
      // is known blocked, re-ask for the rows it is NOT holding up, so a large
      // stuck backlog costs one extra query instead of everyone else's delivery.
      if (!stop && sent < budget && blocked.size) {
        drain(this.outbox.pendingRefsExcludingTypes([...blocked], budget - sent))
      }
    } finally {
      this.flushRunning = false
    }
    // Yield and come back. Stopping on the byte budget means there is more to
    // send and the queue would otherwise wait for the next unrelated send to
    // schedule a tick. Only on the budget: rescheduling when the window is
    // fully in flight would rebuild the busy loop this removes.
    if (stoppedOnBudget) this.scheduleFlush()
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
