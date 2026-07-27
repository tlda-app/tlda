export function timerFirePatch({ to, now = new Date().toISOString() }) {
  return {
    pending: false,
    state: 'fired',
    timer_fire_notified_to: to,
    timer_fire_notified_at: now,
  }
}

export function timerCancelPatch({ now = new Date().toISOString() } = {}) {
  return {
    pending: false,
    state: 'cancelled',
    timer_cancelled_at: now,
  }
}

export function timerFireBroadcast({ event, to, metadataPatch, message }) {
  return {
    id: Number(event.id),
    event_id: Number(event.id),
    type: event.type || 'timer',
    from: event.from || null,
    to,
    from_id: event.from || null,
    to_id: to,
    text: message || event.text || event.metadata?.message || 'Timer fired',
    metadata: {
      ...(event.metadata || {}),
      ...metadataPatch,
    },
    metadata_patch: metadataPatch,
  }
}

export class ServerTimerScheduler {
  constructor({
    store,
    broadcast,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.store = store
    this.broadcast = broadcast
    this.now = now
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.timer = null
  }

  // start/refresh/fire/cancel are async because each reads or claims through
  // the store, which is a worker round trip now.
  async start() {
    await this.refresh()
  }

  stop() {
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = null
  }

  async refresh() {
    this.stop()
    const pending = (await this.store.listPendingTimerEvents()) || []
    const nowMs = this.now()
    const overdue = []
    const future = []
    for (const event of pending) {
      const fireAtMs = Date.parse(event.metadata?.fire_at || '')
      if (!Number.isFinite(fireAtMs)) continue
      if (fireAtMs <= nowMs) overdue.push(event)
      else future.push({ event, fireAtMs })
    }
    for (const event of overdue.sort((a, b) => Date.parse(a.metadata.fire_at) - Date.parse(b.metadata.fire_at) || a.id - b.id)) {
      await this.fire(event.id)
    }
    if (future.length) {
      future.sort((a, b) => a.fireAtMs - b.fireAtMs || a.event.id - b.event.id)
      const delay = Math.max(0, future[0].fireAtMs - this.now())
      // A refresh that throws is reported rather than becoming an unhandled
      // rejection. The promise is RETURNED rather than dropped: setTimeout
      // ignores it, so returning costs nothing, and it means a caller holding
      // the callback — a test harness with a fake clock, in practice — can wait
      // for the refresh instead of racing it.
      this.timer = this.setTimeoutFn(
        () => this.refresh().catch(e => console.error(`[timer-scheduler] refresh failed: ${e?.message || e}`)),
        delay,
      )
      this.timer?.unref?.()
    }
  }

  async fire(eventId, { message } = {}) {
    const event = await this.store.getEventById(Number(eventId))
    if (!event) return { ok: false, error: `timer fired event ${eventId} not found` }
    const to = event.to || event.from
    if (!to) return { ok: false, error: `timer fired event ${eventId} has no target` }
    const nowMs = this.now()
    const taskId = event.metadata?.task_id
    if (event.metadata?.task_expiry && taskId) {
      await this.store.retractTask?.(taskId, { retractedBy: 'timer' })
      return this.cancel(eventId)
    }
    const expiresAtMs = Date.parse(event.metadata?.expires_at || '')
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return this.cancel(eventId)
    if (taskId) {
      const task = await this.store.getTask?.(taskId)
      if (!task || ['done', 'retracted'].includes(task.status)) return this.cancel(eventId)
    }
    const metadataPatch = timerFirePatch({ to, now: new Date(nowMs).toISOString() })
    const claimed = await this.store.claimTimerTerminal(Number(eventId), {
      to,
      metadataPatch,
      unread: true,
    })
    if (!claimed) return { ok: true, to, notified: false, duplicate: true }
    this.broadcast?.('event-update', timerFireBroadcast({ event, to, metadataPatch, message }))
    const repeatSeconds = Number(event.metadata?.repeat_seconds)
    if (Number.isFinite(repeatSeconds) && repeatSeconds > 0) {
      const nextFireAt = new Date(nowMs + repeatSeconds * 1000).toISOString()
      const nextFireMs = Date.parse(nextFireAt)
      if (!Number.isFinite(expiresAtMs) || nextFireMs < expiresAtMs) {
        const repeatPatch = {
          pending: true,
          state: 'pending',
          fire_at: nextFireAt,
          last_fired_at: metadataPatch.timer_fire_notified_at,
        }
        await this.store.updateEventMetadata?.(Number(eventId), repeatPatch)
        this.broadcast?.('event-update', {
          ...timerFireBroadcast({ event, to, metadataPatch: repeatPatch, message }),
          text: event.text || `⏱ ${event.metadata?.message || message || 'Timer'}`,
        })
        await this.refresh()
        return { ok: true, to, notified: true, recurring: true, next_fire_at: nextFireAt }
      }
    }
    return { ok: true, to, notified: true, recurring: false }
  }

  async cancel(eventId) {
    const event = await this.store.getEventById(Number(eventId))
    if (!event) return { ok: false, error: `timer cancelled event ${eventId} not found` }
    const to = event.to || event.from
    const metadataPatch = timerCancelPatch({ now: new Date(this.now()).toISOString() })
    const claimed = await this.store.claimTimerTerminal(Number(eventId), {
      to,
      metadataPatch,
      unread: false,
    })
    if (!claimed) return { ok: true, to, notified: false, duplicate: true }
    this.broadcast?.('event-update', {
      id: Number(eventId),
      event_id: Number(eventId),
      type: event.type || 'timer',
      from: event.from || null,
      to,
      from_id: event.from || null,
      to_id: to,
      text: event.text || event.metadata?.message || 'Timer cancelled',
      metadata: {
        ...(event.metadata || {}),
        ...metadataPatch,
      },
      metadata_patch: metadataPatch,
    })
    await this.refresh()
    return { ok: true, to, notified: false }
  }
}
