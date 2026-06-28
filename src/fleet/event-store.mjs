// event-store.mjs — the single ordered, id-keyed buffer for fleet chat + activity.
//
// One store, two sources (live WS + DB history), no duplicates, bounded memory.
//
// Key per entry: `_dbId` if it has one, else `_tempId`. Both the live stream and
// the history fetch funnel through upsert(), so:
//   - insert-by-id can't duplicate (same id → same entry)
//   - history filling a gap can't duplicate (it upserts by id too)
//   - capping trims only one edge of the single ordered buffer, so the in-memory
//     set remains one contiguous window instead of a history/live split
//
// The optimistic handoff (your own send) is the one place an entry changes key:
// it starts keyed by `_tempId`, and when the server echo arrives carrying both
// the `_tempId` and the real `_dbId`, the SAME entry is rebound from `tmp:` to
// `db:`. With the tempId persisted on the row, even a reconnect-replayed echo
// carries it — so binding is ALWAYS by id (tempId or dbId), never by content.

export function keyOf(e) {
  if (e._dbId != null) return 'db:' + e._dbId
  if (e._tempId) return 'tmp:' + e._tempId
  return null
}

export const DEFAULT_MAX_EVENTS = 500

export function makeEventStore(opts = {}) {
  const maxEvents = Number.isFinite(opts.maxEvents) ? Math.max(1, Math.floor(opts.maxEvents)) : DEFAULT_MAX_EVENTS
  /** @type {any[]} chronological (timestamp asc, ties in insertion order) */
  const events = []
  /** @type {Map<string, any>} 'db:<id>' | 'tmp:<tempId>' → the live entry object */
  const byKey = new Map()
  // False after scrollback has shifted the memory window away from the live
  // tail. The next newer live/reconnect event starts a fresh tail window rather
  // than creating an old-history + new-live split.
  let hasLiveTail = true

  function tsOf(e) {
    const t = e && e.timestamp ? Date.parse(e.timestamp) : NaN
    return Number.isNaN(t) ? Infinity : t // undated (fresh optimistic) sorts to the end
  }

  // Insert keeping chronological order. New events usually arrive at/after the
  // tail, so scan from the end — O(1) for the common append, O(n) worst case.
  function insertOrdered(e) {
    const t = tsOf(e)
    let i = events.length
    while (i > 0 && tsOf(events[i - 1]) > t) i--
    events.splice(i, 0, e)
  }

  function removeFromArray(e) {
    const i = events.indexOf(e)
    if (i >= 0) events.splice(i, 1)
  }

  function forgetKey(e) {
    const k = keyOf(e)
    if (k) byKey.delete(k)
  }

  function clearEventsOnly() {
    events.length = 0
    byKey.clear()
  }

  function trimOverflow(evict = 'oldest') {
    /** @type {any[]} */
    const evicted = []
    while (events.length > maxEvents) {
      const ev = evict === 'newest' ? events.pop() : events.shift()
      if (!ev) break
      forgetKey(ev)
      evicted.push(ev)
    }
    if (evict === 'newest' && evicted.length) hasLiveTail = false
    if (evict === 'oldest' && evicted.length) hasLiveTail = true
    return evicted
  }

  function shouldResetToLiveTail(incoming, evict) {
    if (evict !== 'oldest' || hasLiveTail || events.length === 0) return false
    return tsOf(incoming) > tsOf(events[events.length - 1])
  }

  // Bring server-authoritative fields onto an existing entry without clobbering
  // its identity. Never let a merge null out an id we already hold.
  function merge(target, incoming) {
    for (const k of Object.keys(incoming)) {
      if (k === '_tempId' && incoming._tempId == null) continue
      // A temp id is only the identity of a pending optimistic row. Once the
      // row is db-keyed, later broadcast/replay echoes may still carry the
      // client_temp_id metadata for binding, but that must not re-mark the
      // canonical row as optimistic.
      if (k === '_tempId' && target._dbId != null) continue
      target[k] = incoming[k]
    }
  }

  /**
   * Insert or update an event. Returns { event, isNew, evicted }.
   * `event` is the live, canonical entry (callers should use it, not `incoming`).
   */
  function upsert(incoming, opts = {}) {
    const evict = opts.evict === 'newest' ? 'newest' : 'oldest'
    let evicted = []
    if (shouldResetToLiveTail(incoming, evict)) {
      evicted = events.slice()
      clearEventsOnly()
      hasLiveTail = true
    }

    const dbId = incoming._dbId
    const tempId = incoming._tempId

    if (dbId != null) {
      // 1) Already have this id — update in place. The dedup backstop.
      const exDb = byKey.get('db:' + dbId)
      if (exDb) { merge(exDb, incoming); return { event: exDb, isNew: false, evicted } }

      // 2) Optimistic handoff: this is the echo of our own send. Rebind the
      //    pending tmp entry to its real id instead of adding a second row.
      if (tempId) {
        const opt = byKey.get('tmp:' + tempId)
        if (opt) {
          byKey.delete('tmp:' + tempId)
          merge(opt, incoming)
          opt._dbId = dbId
          delete opt._tempId
          delete opt._failed // it actually went through
          byKey.set('db:' + dbId, opt)
          return { event: opt, isNew: false, evicted }
        }
      }

      // 3) Genuinely new.
      byKey.set('db:' + dbId, incoming)
      insertOrdered(incoming)
      if (!opts.skipTrim) evicted.push(...trimOverflow(evict))
      return { event: incoming, isNew: true, evicted }
    }

    if (tempId) {
      const exTmp = byKey.get('tmp:' + tempId)
      if (exTmp) { merge(exTmp, incoming); return { event: exTmp, isNew: false, evicted } }
      byKey.set('tmp:' + tempId, incoming)
      insertOrdered(incoming)
      if (!opts.skipTrim) evicted.push(...trimOverflow(evict))
      return { event: incoming, isNew: true, evicted }
    }

    // No stable key at all — shouldn't happen for real events. Append rather
    // than silently drop, so the gap is visible instead of mysterious.
    insertOrdered(incoming)
    if (!opts.skipTrim) evicted.push(...trimOverflow(evict))
    return { event: incoming, isNew: true, evicted }
  }

  function upsertMany(incomingEvents, opts = {}) {
    /** @type {{ event: any, isNew: boolean, evicted: any[] }[]} */
    const results = []
    /** @type {any[]} */
    const evicted = []
    for (const incoming of incomingEvents) {
      const result = upsert(incoming, { ...opts, skipTrim: true })
      results.push(result)
      evicted.push(...result.evicted)
    }
    evicted.push(...trimOverflow(opts.evict === 'newest' ? 'newest' : 'oldest'))
    if (evicted.length) {
      for (const result of results) result.evicted = evicted
    }
    return results
  }

  /**
   * Link a pending optimistic entry to its server id (called when the WS reply
   * to a send arrives). Idempotent with the echo path above: whichever runs
   * first binds, the other no-ops.
   */
  function reconcile(tempId, dbId, newTo) {
    const opt = byKey.get('tmp:' + tempId)
    if (!opt) {
      // Reply lost-then-recovered, or echo already bound it. Nothing to do.
      return byKey.get('db:' + dbId) || null
    }
    byKey.delete('tmp:' + tempId)
    opt._dbId = dbId
    delete opt._tempId
    delete opt._failed
    if (newTo) opt.to = newTo

    // If the broadcast echo already created a db entry, fold into it (keep one).
    const exDb = byKey.get('db:' + dbId)
    if (exDb && exDb !== opt) {
      removeFromArray(opt)
      merge(exDb, opt)
      return exDb
    }
    byKey.set('db:' + dbId, opt)
    return opt
  }

  /** Mutate an existing entry by db id (e.g. metadata patch / read receipt). */
  function patchByDbId(dbId, updates) {
    const ev = byKey.get('db:' + dbId) || byKey.get('db:' + Number(dbId))
    if (!ev) return null
    if (updates.metadata && ev.metadata) {
      Object.assign(ev.metadata, updates.metadata)
      const rest = { ...updates }; delete rest.metadata
      Object.assign(ev, rest)
    } else {
      Object.assign(ev, updates)
    }
    return ev
  }

  /** Mutate a pending optimistic entry by temp id (e.g. mark _failed). */
  function patchByTempId(tempId, updates) {
    const ev = byKey.get('tmp:' + tempId)
    if (ev) Object.assign(ev, updates)
    return ev || null
  }

  /** Remove a pending optimistic entry by temp id (e.g. dismiss failed send). */
  function removeByTempId(tempId) {
    const ev = byKey.get('tmp:' + tempId)
    if (!ev) return null
    byKey.delete('tmp:' + tempId)
    removeFromArray(ev)
    return ev
  }

  function all() { return events }
  function size() { return events.length }
  function get(key) { return byKey.get(key) }
  function clear() { clearEventsOnly(); hasLiveTail = true }

  return { upsert, upsertMany, reconcile, patchByDbId, patchByTempId, removeByTempId, all, size, get, clear, keyOf }
}
