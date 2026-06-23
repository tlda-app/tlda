// fleet-data.mjs — Single data object for the fleet UI.
//
// One WebSocket. One DB. Shapes subscribe to slices.
// No dedup needed — there's only one source.
//
// Stores: agents[], tasks[], events[] (chat/lifecycle), activity[agentId][]
// WS: one connection to /ws/fleet — receives state, fleet-event, activity
// Subscribers: subscribe(channel, filter, callback)
//   channel: 'agents' | 'tasks' | 'messages' | 'activity'
//   filter: { agent: 'fleet:xxx' } or null for all
//   callback: (event) => void
//
// Write API: sendMessage, respawnAgent, renameAgent, etc.
// Writes go to server → DB → SSE → subscriber. One path.

import { toolContentDetail } from './activity-render.mjs'
import { matchesFleetFilter, resolveFleetFilter } from './filter-semantics.mjs'
import { makeEventStore } from './event-store.mjs'
import {
  removeFleetEvent,
  replaceFleetEvents,
  upsertFleetEvent,
  upsertFleetEvents,
} from './fleet-data.ts'
import { log } from '../logger'
import { probe } from '../perf-probe'
import { DATABASE_HTTP, DATABASE_WS } from '../activeConfig'
import { storedIdentityLoginFailureAction } from './identity-persistence.mjs'

// The global fleet/event store (chat, agents, activity, tasks) = the active
// config's DATABASE, read directly from the server-injected config. No fetch, no
// resolution step, no fallback — the value is fixed for the life of the page.
const FLEET = DATABASE_HTTP
const FLEET_WS = DATABASE_WS

// For modules that open their own fleet socket (e.g. TerminalShape's /ws/terminal):
// the same global database base. Doc/shape (store) bases come from activeConfig
// directly, not from here.
export function getFleetWsBase() { return FLEET_WS }
export function getFleetHttpBase() { return FLEET }

// --- Stores ---
let _agents = []
let _tasks = []
let _items = []
// One id-keyed ordered buffer — the SINGLE source for chat + activity, fed by
// two sources (live WS + DB history). upsert() dedups by id and binds the
// optimistic tempId→dbId handoff, so there's no live/older split to merge (the
// old two-list merge was what duplicated cards). No memory cap: the buffer
// grows and the renderer windows the tail (fixed size in render, not memory).
const _store = makeEventStore()
// History fetched from the server is limited to this many rows per request.
const HISTORY_PAGE = 150
// Activity events are now stored in the events table (type='activity')
// and flow through the same channel as chat — no separate store needed.
let _reaperStatus = null     // latest reaper-status from daemon
let _humanId = null
let _humanName = null
let _identifyPending = false   // true while waiting for identify response
let _lastEventId = 0
// Buffer for event-updates that arrive before their target event is in the
// store (e.g. an async file-upload's `event-update` racing ahead of the chat
// event it patches). Without this, the update is dropped and its change — most
// visibly a late `inline_attachments` → file chip — is lost until reload. Keyed
// by db event id; drained when the matching fleet-event arrives.
const _pendingEventUpdates = new Map()
const _MAX_PENDING_UPDATES = 200

// Apply an `event-update` payload's fields onto an already-stored event. Shared
// by the live handler and the buffered-apply path so a buffered update behaves
// identically to one that arrived after its event.
function applyEventUpdateFields(ev, data) {
  if (data.text !== undefined) ev.text = data.text
  if (data.inline_attachments) ev._inlineAttachments = data.inline_attachments
  // Amend can set or clear file-section provenance. A file-form amend
  // sends source = { file, section }; a string-form amend sends
  // source = null to clear it. Updating ev.metadata.source makes the
  // provenance chip appear/disappear in place on the amended message.
  if (data.source !== undefined) {
    if (!ev.metadata) ev.metadata = {}
    ev.metadata.source = data.source
  }
  if (data.metadata_patch) {
    if (!ev.metadata) ev.metadata = {}
    Object.assign(ev.metadata, data.metadata_patch)
    if (data.metadata_patch.approvedAt) {
      ev._planResponse = data.metadata_patch.mode === 'supervised' ? 'supervised' : 'approved'
      ev._promptResponse = 'approved'
    }
    if (data.metadata_patch.rejectedAt) {
      ev._planResponse = 'rejected'
      ev._promptResponse = 'rejected'
    }
    // Timer countdown reaching a terminal state: flip the derived flags
    // so the line re-renders as cancelled (struck) or fired (persists,
    // showing it ran). Neither state hides the line.
    if (ev.type === 'timer' || ev._timerCountdown || ev._timerCancelled) {
      if (ev.metadata.state === 'cancelled') {
        ev._timerCancelled = true; ev._timerCountdown = false
      } else if (ev.metadata.state === 'fired') {
        ev._timerFired = true; ev._timerCountdown = false
        if (!ev._timerMessage) ev._timerMessage = ev.metadata.message || (ev.text || '').replace(/^[⏱⏰]\s*/, '')
      } else if (ev.metadata.pending === false) {
        ev._timer = true; ev._timerCountdown = false
      }
    }
  }
}

// --- Subscribers ---
const _subs = []  // { channel, filter, callback }

export function subscribe(channel, filter, callback) {
  const sub = { channel, filter, callback }
  _subs.push(sub)
  return () => {
    const idx = _subs.indexOf(sub)
    if (idx >= 0) _subs.splice(idx, 1)
  }
}

function notify(channel, event) {
  for (const sub of _subs) {
    if (sub.channel !== channel) continue
    if (!matchesFilter(sub.filter, event)) continue
    try { sub.callback(event) } catch {}
  }
}

export function matchesFilter(filter, event) {
  return matchesFleetFilter(filter, event, { agents: _agents, humanId: _humanId, humanName: _humanName })
}

function resolveFilter(filter) {
  return resolveFleetFilter(filter, { agents: _agents, humanId: _humanId, humanName: _humanName })
}

export { resolveFilter }

// --- Read API ---
export function getReaperStatus() { return _reaperStatus }
export function getAgents() { return _agents }
export function getTasks() { return _tasks }
export function getItems() { return _items }
export function getEvents() { return _store.all() }
export function getActivity(agentId) { return _store.all().filter(e => e._activity && e.agent === agentId) }
export function getHumanId() { return _humanId }
export function getHumanName() { return _humanName }

// A stable per-browser id, generated once and persisted. This is the "device"
// half of the (identity, device) fleet-layout key: the same human identity open
// on two devices (Mac + iPad) gets two distinct device ids, so each device owns
// and lays out its own fleet shapes instead of fighting over one shared set.
// Purely local — never sent to the server as an identity, only stamped on shapes.
let _deviceId = null
export function getDeviceId() {
  if (_deviceId) return _deviceId
  if (typeof localStorage === 'undefined') return ''
  let id = localStorage.getItem('tlda-device-id')
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
    localStorage.setItem('tlda-device-id', id)
  }
  _deviceId = id
  return id
}
export function needsIdentity() { return !_humanId && _identifyPending }

/** Log in as an existing agent. Used by returning users and ?name= auto-login. */
export async function login(name) {
  const res = await wsSend({ type: 'login', name })
  _humanId = res.id
  _humanName = res.name
  _identifyPending = false
  localStorage.setItem('tlda-identity', res.name)
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  _startHeartbeat()
  return res
}

/** Register a new human agent. Used by the IdentityPicker for new users. */
export async function registerHuman(name) {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const humanId = `fleet:${sanitized}`
  const res = await wsSend({ type: 'register', agent_id: humanId, name: sanitized, human: true })
  _humanId = res.agent?.id || humanId
  _humanName = sanitized
  _identifyPending = false
  localStorage.setItem('tlda-identity', sanitized)
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  _startHeartbeat()
  return res
}

// Returns { agentId: count } for unread messages from agents to the human
export function getUnreadCountsForHuman() {
  const counts = {}
  for (const ev of _store.all()) {
    if (ev.type === 'chat' && !ev.read && ev.to === _humanId && ev.from) {
      counts[ev.from] = (counts[ev.from] || 0) + 1
    }
  }
  return counts
}

export function getAgent(id) {
  if (!id) return undefined
  // The friendly name is an opaque atom — look up by exact id or friendly_name.
  // No suffix games: dawn is "base", day is "base:day", dusk is "base:dusk".
  return _agents.find(a => a.id === id || a.friendly_name === id)
}

// --- Write API (all go through server) ---

export async function sendMessage(to, text, opts = {}) {
  const body = { type: 'chat', message: text, to }
  if (_humanId) body.from = _humanId
  if (opts._tempId) body._tempId = opts._tempId
  if (opts.raw) body._raw = true
  if (opts.attachments) body.attachments = opts.attachments
  if (opts.cc) body.cc = opts.cc
  if (opts.context) body.context = opts.context
  // The human's preamble is the document they're viewing — stamp it so readers
  // render this message's math with that doc's macros (mirrors how agents stamp
  // their working-dir doc). { doc, version }; version captured, not yet resolved.
  if (opts.preambleRef) body.preambleRef = opts.preambleRef
  const _t0 = performance.now()
  try {
    const d = await wsSend(body)
    console.log(`[chat-send] to=${to} id=${d.event_id} ws=${Math.round(performance.now()-_t0)}ms text=${text.substring(0,30)}`)
    return { ok: true, event_id: d.event_id }
  } catch (e) {
    console.log(`[chat-send] to=${to} FAILED ws=${Math.round(performance.now()-_t0)}ms err=${e.message}`)
    return { ok: false, event_id: null }
  }
}

/** Inject an optimistic (locally-authored) event into the event list immediately. */
export function injectOptimisticEvent(event) {
  const { event: ev } = _store.upsert(event)
  upsertFleetEvent(ev)
  notify('messages', ev)
}

/** Update fields on an optimistic event (e.g. mark _failed, or set _dbId on reconcile). */
export function updateOptimisticEvent(tempId, updates) {
  const ev = _store.patchByTempId(tempId, updates)
  if (ev) {
    upsertFleetEvent(ev)
    notify('messages', null)
  }
}

/** Remove a local optimistic event that never reached the server. */
export function removeOptimisticEvent(tempId) {
  const ev = _store.removeByTempId(tempId)
  if (ev) {
    removeFleetEvent(ev)
    notify('messages', null)
  }
}

export function updateEventById(dbId, updates) {
  const ev = _store.patchByDbId(dbId, updates)
  if (ev) {
    upsertFleetEvent(ev)
    notify('messages', null)
  }
}

/** Link an optimistic event to its server-assigned ID (if SSE hasn't already done it). */
export function reconcileOptimistic(tempId, serverEventId, newTo) {
  // For broadcasts, the optimistic event was injected with `to: <label>` (e.g. "awake").
  // reconcile() rewrites it to the first concrete recipient so the line transitions
  // from "Skip → awake" to "Skip → alice" — a delivery confirmation for the first agent.
  // Broadcasts for the remaining recipients arrive as separate events with their own to_id.
  // Idempotent with the WS-echo path: whichever binds the tempId→dbId first wins.
  const ev = _store.reconcile(tempId, serverEventId, newTo)
  if (ev) upsertFleetEvent(ev)
  notify('messages', null)
}

export function respawnAgent(id) {
  return wsSend({ type: 'spawn', agent: id, respawn: true })
}

export function spawnAgent(model, doc, name, effort) {
  return wsSend({ type: 'spawn', fresh: true, model, ...(doc ? { doc } : {}), ...(name ? { name } : {}), ...(effort ? { effort } : {}) })
}

export function renameAgent(id, name) {
  return wsSend({ type: 'rename', agent: id, name })
}

export function setAgentLabels(id, labels) {
  return wsSend({ type: 'label', agent: id, labels })
}

export function kickAgent(id) {
  return wsSend({ type: 'kick', agent: id })
}

export function killSession(id) {
  return wsSend({ type: 'kill-session', agent: id })
}

export function hibernateSession(id) {
  return wsSend({ type: 'hibernate-session', agent: id })
}

export function sendKey(agent, key) {
  return wsSend({ type: 'send-key', agent, key })
}

export function sendText(agent, text) {
  return wsSend({ type: 'send-text', agent, text })
}

/** Send an arbitrary WS message to the fleet server. Returns a promise for the result. */
export function fleetWS(type, body = {}) {
  return wsSend({ type, ...body })
}

export async function dismissItem(id) {
  const userId = _humanId
  if (!userId) throw new Error('no human identity')
  const res = await fetch(`${FLEET}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dismiss', userId, id }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || res.statusText)
  }
  _items = _items.filter(i => i.id !== id)
  notify('items', { userId, items: _items })
}

// --- WebSocket connection ---
let _ws = null
let _reconnectDelay = 1000
let _connected = false
let _disconnectedAt = 0
let _heartbeatInterval = null

/** Returns true if the WS is currently connected */
export function isConnected() { return _connected }

/** Returns ms since disconnect, or 0 if connected */
export function disconnectedFor() { return _connected ? 0 : (_disconnectedAt ? Date.now() - _disconnectedAt : 0) }

// WS request/response: pending callbacks keyed by message ID
let _wsReqId = 0
const _wsCallbacks = new Map()

function _startHeartbeat() {
  if (_heartbeatInterval) clearInterval(_heartbeatInterval)
  _heartbeatInterval = setInterval(() => {
    if (_humanId && _ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'heartbeat', agent: _humanId }))
    }
  }, 30_000)
}

let _lastViewingSent = 0
let _viewingEnrichFn = null
export function setViewingEnrichFn(fn) { _viewingEnrichFn = fn }
export function sendViewingContext(context) {
  const now = Date.now()
  if (now - _lastViewingSent < 5000) return
  _lastViewingSent = now
  if (!_humanId || !_ws || _ws.readyState !== 1) return
  const send = (ctx) => _ws.send(JSON.stringify({ type: 'viewing', agent: _humanId, context: ctx }))
  if (_viewingEnrichFn) {
    _viewingEnrichFn({ ...context }).then(send).catch(() => send(context))
  } else {
    send(context)
  }
}

function wsSend(msg) {
  if (!_ws || _ws.readyState !== 1) return Promise.reject(new Error('not connected'))
  const id = ++_wsReqId
  return new Promise((resolve, reject) => {
    _wsCallbacks.set(id, { resolve, reject })
    _ws.send(JSON.stringify({ ...msg, id }))
    setTimeout(() => { _wsCallbacks.delete(id); reject(new Error('timeout')) }, 5000)
  })
}

export function connect() {
  if (_ws) return
  const params = new URLSearchParams(location.search)
  const token = params.get('token')
  const wsUrl = FLEET_WS + '/ws/fleet'
  _ws = new WebSocket(wsUrl)

  _ws.onopen = () => {
    _reconnectDelay = 1000
    _connected = true
    notify('connection', { type: 'connection', connected: true })
    // Log in if we have a stored identity
    const storedName = localStorage.getItem('tlda-identity')
    if (storedName) {
      wsSend({ type: 'login', name: storedName }).then(res => {
        _humanId = res.id
        _humanName = res.name
        _identifyPending = false
        notify('identity', { type: 'identity', id: _humanId, name: _humanName })
        _startHeartbeat()
      }).catch((err) => {
        // A deploy/restart can drop or time out this login request. Do not erase
        // the browser's chosen identity for a transient transport failure; the
        // next reconnect should retry the same stored name.
        if (storedIdentityLoginFailureAction(err) !== 'register-stored') {
          _identifyPending = false
          notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: false })
          _ws?.close()
          return
        }
        // Fresh/test servers may not have the human row yet. Preserve the
        // browser identity by creating that same human instead of forcing a
        // manual switch or temporary identity.
        registerHuman(storedName).catch(() => {
          _identifyPending = true
          notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
        })
      })
    } else {
      _identifyPending = true
      notify('identity', { type: 'identity', id: null, name: null, needsIdentity: true })
    }
    // State (agents/tasks) is pushed by the server on WS connect — no need to re-fetch.
    // Catch up on missed chat events
    if (_lastEventId > 0) {
      const reconnectTimer = probe.start('reconnect', 'reconnect-backfill')
      fetch(`${FLEET}/api/store/events?after=${_lastEventId}&limit=500`)
        .then(r => r.json())
        .then(data => {
          // One path: ingest EVERYTHING the live stream would (it upserts any
          // typed fleet-event — the render whitelist is the sole display gate).
          // A separate type-allowlist here drifts from that whitelist; that drift
          // is the bug where a reconnect silently dropped `activity` (and amend/
          // interrupt/timer/kill-session) while chats survived. Don't add one back.
          const missed = (data.events || []).filter(e => (e.type || e.event_type))
          const newEvents = []
          let boundAny = false
          for (const raw of missed) {
            const eid = raw.id || raw._dbId
            if (eid && eid > _lastEventId) _lastEventId = eid
            // upsert dedups by id and binds the optimistic tempId→dbId handoff
            // (the replayed row carries _tempId, persisted server-side). No
            // content matching — binding is always by id, per the dedup rule.
            const { event: ev, isNew } = _store.upsert(convertChatEvent(raw))
            upsertFleetEvent(ev)
            if (isNew) newEvents.push(ev); else boundAny = true
          }
          for (const ev of newEvents) notify('messages', ev)
          if (boundAny && !newEvents.length) notify('messages', null)
          probe.stop(reconnectTimer, { missedCount: missed.length, newCount: newEvents.length, boundAny })
        })
        .catch(e => {
          console.warn('[fleet-data] history backfill failed:', e.message)
          probe.stop(reconnectTimer, { error: e.message })
        })
    }
  }

  _ws.onclose = (ev) => {
    _ws = null
    _connected = false
    _disconnectedAt = _disconnectedAt || Date.now()
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null }
    notify('connection', { type: 'connection', connected: false })
    setTimeout(connect, _reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, 15000) // cap at 15s, not 30s
  }

  _ws.onerror = () => {}

  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)

      // Handle request/response messages (replies to wsSend)
      if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
        const cb = _wsCallbacks.get(msg.id)
        if (cb) {
          _wsCallbacks.delete(msg.id)
          // Reconcile optimistic events SYNCHRONOUSLY before resolving —
          // the next WS message may be the echo, and _dbId must be set
          // before the echo's dedup check runs.
          if (msg.result && msg.result._tempId && Array.isArray(msg.result.event_ids) && msg.result.event_ids.length > 0) {
            // Server fans out chats over recipients (DNF resolution). Reconcile the optimistic event
            // with the first event_id; broadcasts for the other event_ids arrive as new events
            // (dedup is keyed on _dbId, so the first echo is silently absorbed).
            const firstRecipient = Array.isArray(msg.result.recipients) && msg.result.recipients.length > 0
              ? msg.result.recipients[0] : null
            reconcileOptimistic(msg.result._tempId, msg.result.event_ids[0], firstRecipient)
          }
          if (msg.error) cb.reject(new Error(msg.error))
          else cb.resolve(msg.result)
        }
        return
      }

      // Full-state snapshot (sent once on connect) — no event field
      if (msg.agents && !msg.event) {
        updateAgents(msg.agents || [])
        updateTasks(msg.tasks || [])
        applyFleetEphemeral(msg)
        return
      }

      // Event-typed messages
      const eventType = msg.event
      const data = msg.data

      // Incremental agent/task state — only changed/removed agents on the wire.
      if (eventType === 'agents-delta') {
        applyAgentDelta(data.changed, data.removed)
        updateTasks(data.tasks || [])
        applyFleetEphemeral(data)
        return
      }

      if (eventType === 'fleet-event') {
        if (!data || !data.type) return
        if (data.type === 'open-doc' && data.url) {
          notify('open-doc', data)
          return
        }
        // upsert dedups by db id and binds our optimistic send: if the echo
        // carries the _tempId we sent (or the WS reply already set the _dbId),
        // it rebinds the pending entry instead of appending a duplicate. All by
        // id — no content matching.
        const converted = convertChatEvent(data)
        const { event, isNew } = _store.upsert(converted)
        // Drain any event-updates that arrived before this event (e.g. a late
        // file-upload's inline_attachments). Applying them now, before notify,
        // means the first render already shows the patched line.
        if (data.id != null && _pendingEventUpdates.has(data.id)) {
          for (const u of _pendingEventUpdates.get(data.id)) applyEventUpdateFields(event, u)
          _pendingEventUpdates.delete(data.id)
        }
        upsertFleetEvent(event)
        if (data.id && data.id > _lastEventId) _lastEventId = data.id
        if (data.type === 'chat') {
          console.log(`[chat-recv] id=${data.id} from=${data.from_id||data.from} text=${(data.text||'').substring(0,30)}`)
        }
        if (data.type === 'interrupt' || data.type === 'kill-session') {
          log.warn('interrupt-recv', 'event received', { type: data.type, id: data.id, from: data.from_id||data.from, to: data.to_id||data.to, isNew })
        }
        notify('messages', isNew ? event : null)
      } else if (eventType === 'event-update') {
        const ev = _store.get('db:' + data.id)
        if (ev) {
          applyEventUpdateFields(ev, data)
          upsertFleetEvent(ev)
          notify('messages', null)
        } else if (data.id != null) {
          // The event isn't in the store yet (the update raced ahead of its
          // event). Buffer it; the fleet-event ingest drains this on arrival so
          // the change isn't lost until reload. Bound the buffer so orphaned
          // updates (for events that never come) can't leak.
          const list = _pendingEventUpdates.get(data.id) || []
          list.push(data)
          _pendingEventUpdates.set(data.id, list)
          while (_pendingEventUpdates.size > _MAX_PENDING_UPDATES) {
            _pendingEventUpdates.delete(_pendingEventUpdates.keys().next().value)
          }
        }
      } else if (eventType === 'read-receipt') {
        const ids = new Set(data.event_ids || [])
        for (const ev of _store.all()) {
          if (ids.has(ev._dbId)) {
            ev.read = true
            upsertFleetEvent(ev)
          }
        }
        if (ids.size) notify('messages', null)
      } else if (eventType === 'reaper-status') {
        _reaperStatus = data
        notify('reaper', data)
      } else if (eventType === 'suggestions') {
        notify('suggestions', data)
      } else if (eventType === 'items') {
        if (!data?.userId || data.userId === _humanId) {
          _items = data.items || []
          notify('items', data)
        }
      } else if (eventType === 'projects-updated') {
        notify('projects', data)
      } else if (eventType === 'agent-thinking') {
        if (data.agent) notify('thinking', data)
      } else if (eventType === 'agent-compacting') {
        if (data.agent) notify('compacting', data)
      } else if (eventType === 'agent-context') {
        if (data.agent) notify('context', data)
      } else if (eventType === 'agent-status') {
        if (data.agent) notify('status', data)
      } else if (eventType === 'reload') {
        location.reload()
      } else if (eventType === 'heartbeat') {
        // ignore — keep-alive
      }
    } catch {}
  }
}

// --- Initial load ---
export async function init() {
  // Human identity is established via WS 'login' on connect.
  // If localStorage has a stored name, login is sent automatically.
  // If not, the UI shows a picker with login/register options.

  // FLEET/FLEET_WS come straight from the injected active config — no resolution
  // step needed before the fetches below.

  // Fetch initial state + history in parallel.
  const [stateRes, historyRes] = await Promise.all([
    fetch(`${FLEET}/api/state`).then(r => r.json()).catch(e => { console.warn('[fleet-data] state fetch failed:', e.message); return {} }),
    fetch(`${FLEET}/api/chat/history?limit=${HISTORY_PAGE}`).then(r => r.json()).catch(e => { console.warn('[fleet-data] history fetch failed:', e.message); return { events: [] } }),
  ])

  // Populate agents + tasks
  updateAgents(stateRes.agents || [])
  updateTasks(stateRes.tasks || [])

  // Populate chat events and notify subscribers
  // One path: ingest everything (matching the live stream); the render whitelist
  // is the single gate for what displays. Mirrors the reconnect catch-up in connect().
  const chatEvents = (historyRes.events || [])
    .filter(e => (e.event_type || e.type))
    .map(convertChatEvent)
  for (const ev of chatEvents) _store.upsert(ev)
  replaceFleetEvents(_store.all())
  // Track highest event ID for reconnect catch-up
  for (const e of historyRes.events || []) {
    if (e.id && e.id > _lastEventId) _lastEventId = e.id
  }
  for (const ev of chatEvents) notify('messages', ev)

  const fetchItemsForHuman = () => {
    if (!_humanId) return
    fetch(`${FLEET}/api/items?userId=${encodeURIComponent(_humanId)}`)
      .then(r => r.json())
      .then(data => {
        _items = data.items || []
        notify('items', { userId: _humanId, items: _items })
      })
      .catch(e => console.warn('[fleet-data] items fetch failed:', e.message))
  }
  const offIdentity = subscribe('identity', null, fetchItemsForHuman)
  fetchItemsForHuman()
  setTimeout(() => offIdentity?.(), 30000)

  // Connect SSE for live updates
  connect()
}

// --- State updates ---
function updateAgents(agents) {
  _agents = agents
  notify('agents', { type: 'agents', agents })
}

// Merge an incremental agent delta into the current list, then notify with the
// full merged list (same contract subscribers already rely on for 'agents').
function applyAgentDelta(changed, removed) {
  if (!(changed?.length || removed?.length)) return
  const byId = new Map(_agents.map(a => [a.id, a]))
  for (const a of (changed || [])) byId.set(a.id, a)
  for (const id of (removed || [])) byId.delete(id)
  _agents = [...byId.values()]
  notify('agents', { type: 'agents', agents: _agents })
}

// Apply server-authoritative ephemeral state (thinking/compacting/context).
// Shared by the connect snapshot and the agents-delta path so both stay in sync.
function applyFleetEphemeral(src) {
  const serverThinking = new Set(Object.keys(src.thinking || {}))
  const serverCompacting = new Set(Object.keys(src.compacting || {}))
  for (const [agent, ts] of Object.entries(src.thinking || {})) {
    notify('thinking', { agent, thinking: true, ts })
  }
  for (const [agent, ts] of Object.entries(src.compacting || {})) {
    notify('compacting', { agent, compacting: true, ts })
  }
  for (const [agent, ctx] of Object.entries(src.context || {})) {
    notify('context', { agent, percent: ctx.percent, inputTokens: ctx.inputTokens })
  }
  notify('thinking-sync', serverThinking)
  notify('compacting-sync', serverCompacting)
}

function updateTasks(tasks) {
  _tasks = tasks
  notify('tasks', { type: 'tasks', tasks })
}

// --- Converters ---

export function convertChatEvent(e) {
  // metadata may be a JSON string (from DB) or an object (from SSE)
  if (typeof e.metadata === 'string') {
    try { e.metadata = JSON.parse(e.metadata) } catch { e.metadata = null }
  }
  const type = e.event_type || e.type
  const msg = {
    type,
    from: e.from_id || e.from,
    to: e.to_id || e.to,
    text: e.text,
    timestamp: e.timestamp,
    read: e.read !== undefined ? e.read : false,
    _dbId: e.id,
  }
  if (type === 'delegate') {
    msg._evType = 'delegate'
    msg._description = e.text || ''
    msg._taskId = e.metadata?.taskId || e.task_id || ''
    msg._fromLabel = e.metadata?.fromLabel || ''
    msg._toLabel = e.metadata?.toLabel || ''
    msg._criteria = e.metadata?.criteria || []
    if (e.metadata?.message) msg._message = e.metadata.message
  } else if (type === 'task_done') {
    msg._evType = 'task_done'
    msg._description = e.text || ''
    msg._taskId = e.metadata?.taskId || e.task_id || ''
    msg._agent = e.agent_id || e.from || ''
  } else if (type === 'terminal_attention') {
    msg._evType = 'terminal_attention'
    msg._reason = e.metadata?.reason || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
    msg._snippet = e.metadata?.snippet || ''
    msg._promptResponse = e.metadata?.approvedAt ? 'approved' : e.metadata?.rejectedAt ? 'rejected' : ''
  } else if (type === 'plan_approval') {
    msg._evType = 'plan_approval'
    msg._agentId = e.metadata?.agentId || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
    msg._planText = e.text || e.metadata?.planText || ''
    msg._tmuxSession = e.metadata?.tmux_session || ''
    msg._machineId = e.metadata?.machine_id || ''
    msg._planResponse = e.metadata?.rejectedAt ? 'rejected' : e.metadata?.approvedAt ? (e.metadata?.mode === 'supervised' ? 'supervised' : 'approved') : ''
  } else if (type === 'terminal_card') {
    msg._evType = 'terminal_card'
    msg._reason = e.metadata?.reason || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
  } else if (type === 'terminal_user' || type === 'terminal_assistant') {
    msg._evType = type
    msg._source = e.source || 'terminal'
  } else if (type === 'timer') {
    const tmsg = e.metadata?.message || (e.text || '').replace(/^[⏱⏰]\s*/, '')
    if (e.metadata?.state === 'cancelled') {
      // Cancelled in the grace window — show a struck "cancelled" line, not hidden.
      msg._timerCancelled = true
      msg._timerMessage = tmsg
    } else if (e.metadata?.pending) {
      msg._timerCountdown = true
      msg._timerUntil = e.metadata.fire_at
      msg._timerMessage = tmsg
      msg._timerRemaining = Math.max(0, Math.ceil((new Date(e.metadata.fire_at) - Date.now()) / 1000))
    } else if (e.metadata?.state === 'fired') {
      // Fired — keep it as a terminal line so the timer stays in the log
      // showing it ran. A timer is a chat event; it shouldn't vanish on fire.
      msg._timerFired = true
      msg._timerMessage = tmsg
    } else {
      // Expired with no terminal state recorded — legacy/dim line.
      msg._timer = true
    }
  } else if (type === 'compacting') {
    msg._compacting = true
    // from may come from agent field in live events
    if (!msg.from && e.agent) msg.from = e.agent
  } else if (type === 'activity') {
    const tool = e.metadata?.tool || e.text
    msg._activity = true
    msg._toolName = tool === '_text' ? null : (tool === '_prettyResult' ? (e.metadata?.origTool || tool) : tool)
    msg._isText = tool === '_text'
    msg._text = tool === '_text' ? (e.metadata?.arg || e.text) : null
    msg._toolArg = e.metadata?.arg || ''
    msg._toolInput = e.metadata?.input || null
    msg._toolDetail = e.metadata?.input ? toolContentDetail(tool === '_text' ? null : tool, e.metadata.input) : null
    msg._prettyResult = e.metadata?.prettyResult || null
    msg.agent = msg.from
    if (msg._isText) msg.text = e.metadata?.arg || e.text
  }
  if (e.metadata?.inline_attachments) {
    msg._inlineAttachments = e.metadata.inline_attachments
  }
  if (e.metadata?.attachments) {
    msg.attachments = e.metadata.attachments
  }
  // File-section provenance: a message whose body was baked from a file section
  // carries metadata.source = { file, section }. Carry it onto the msg so the
  // chat renderer can draw the "from <file> §<section>" chip. (convertChatEvent
  // otherwise only cherry-picks specific metadata keys onto msg.)
  if (e.metadata?.source) {
    msg.metadata = { ...(msg.metadata || {}), source: e.metadata.source }
  }
  // Reference-event amend: carry metadata.amends so the chat shape can fold this
  // amend event into its original message's version stepper (it never renders
  // standalone). The amend's own text/source ride along normally.
  if (e.metadata?.amends != null) {
    msg.metadata = { ...(msg.metadata || {}), amends: e.metadata.amends }
  }
  if (e.metadata?.context?.bullets) {
    msg._bullets = e.metadata.context.bullets
  }
  // Carry the sender's preamble reference so the chat shape renders this message's
  // math with the sender's macros (its preambleRef.doc), not the viewer's.
  if (e.metadata?.preambleRef) {
    msg.metadata = { ...(msg.metadata || {}), preambleRef: e.metadata.preambleRef }
  }
  return msg
}

// --- Chat history helpers ---
// All events (chat + activity) come from the events table via /api/chat/history.
// No separate activity fetch needed.

export async function fetchHistory(agentIds = [], limit = 200) {
  const agentParams = (agentIds || []).map(id => `&agents=${encodeURIComponent(id)}`).join('')
  const res = await fetch(`${FLEET}/api/chat/history?limit=${limit}${agentParams}`).then(r => r.json())

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session' || t === 'interrupt'
    })
    .map(convertChatEvent)

  return events.sort((a, b) =>
    (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
  )
}

export async function loadBefore(agentIds = [], beforeTs, count = 100) {
  let res
  if (_ws && _ws.readyState === 1) {
    const msg = { type: 'load-history', agents: agentIds || [], before: beforeTs, limit: count }
    res = await wsSend(msg)
  } else {
    const agentParams = (agentIds || []).map(id => `&agents=${encodeURIComponent(id)}`).join('')
    res = await fetch(`${FLEET}/api/chat/history?limit=${count}&before=${encodeURIComponent(beforeTs)}${agentParams}`).then(r => r.json())
  }

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session' || t === 'interrupt'
    })
    .map(convertChatEvent)

  // Fold scrollback into the single store (it orders by timestamp, so these
  // land before the live tail and dedup against anything already present).
  // Return the count of genuinely-new rows so the caller knows whether to
  // re-pin scroll after a prepend.
  let added = 0
  const changed = []
  for (const ev of events) {
    const result = _store.upsert(ev)
    if (result.isNew) added++
    changed.push(result.event)
  }
  if (added) replaceFleetEvents(_store.all())
  else upsertFleetEvents(changed)
  if (added) notify('messages', null)
  return added
}
