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

import { convertChatEvent } from './convert-chat-event.mjs'
export { convertChatEvent } from './convert-chat-event.mjs'
import { matchesFleetFilter, resolveFleetFilter } from '../../shared/filter-semantics.mjs'
import { makeEventStore } from './event-store.mjs'
import { bumpIdentityEpoch } from './identity-epoch.mjs'
import {
  removeFleetEvent,
  removeFleetAgents,
  replaceFleetAgents,
  replaceFleetEvents,
  setFleetEventBufferPinned,
  upsertFleetAgents,
  upsertFleetEvent,
  upsertFleetEvents,
  upsertFleetEventsForBuffer,
  upsertLocalEventIntoBuffer,
  applyFilterEvents,
} from './fleet-data.ts'
import { log } from '../logger'
import { noteProjection, recordFilterNameIds } from './chat-freeze-probe.mjs'
import { dispatchFilterEvent, dispatchFilterEvents, setChatSubscriptionTransport, refreshChatSubscriptionIdentity, resubscribeAll } from './chat-subscription.mjs'
import { probe } from '../perf-probe'
import { DATABASE_HTTP, DATABASE_WS } from '../activeConfig'
import { isUsableIdentityName, sanitizeIdentityName, storedIdentityLoginFailureAction } from './identity-persistence.mjs'
import { resetWsRequestIdleTimers, startWsRequest, WsReconnectBuffer } from '../../shared/fleet-browser-transport.mjs'
import { createFleetOperationTransport } from '../../shared/fleet-operation-transport.mjs'
import { createActivityDeliveryCounters, ACTIVITY_DELIVERY_STAGES } from '../../shared/activity-delivery-counters.mjs'
import { checkAppShellFreshness } from '../appShellFreshness'

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
let _agentTotals = { awake: 0, hibernating: 0, total: 0 }
let _tasks = []
let _items = []
let _nextAgentsCursor = null
let _agentsPageLoading = null
// One id-keyed ordered buffer — the SINGLE source for chat + activity, fed by
// two sources (live WS + DB history). upsert() dedups by id, binds the
// optimistic tempId→dbId handoff, and caps memory as one contiguous ordered
// window, so there's no live/older split to gap against.
const _store = makeEventStore()
// History fetched from the server is limited to this many rows per request.
// Activity events are now stored in the events table (type='activity')
// and flow through the same channel as chat — no separate store needed.
let _humanId = null
let _humanName = null
let _identifyPending = false   // true while waiting for identify response
let _lastEventId = 0
let _identityRetryTimer = null
const _liveTailViewers = new Map()

function isLiveTailPinned() {
  for (const pinned of _liveTailViewers.values()) {
    if (!pinned) return false
  }
  return true
}

function trimIfLiveTailPinned() {
  if (!isLiveTailPinned()) return []
  const evicted = _store.trim({ evict: 'oldest' })
  if (evicted.length) {
    replaceFleetEvents(_store.all())
    notify('messages', null)
  }
  return evicted
}

function liveUpsert(event) {
  return _store.upsert(event, { skipTrim: !isLiveTailPinned() })
}

/**
 * @param {string | null | undefined} viewerId
 * @param {boolean} pinned
 * @param {string | null | undefined} bufferKey
 */
export function setFleetEventsLiveTailPinned(viewerId, pinned, bufferKey = null) {
  if (bufferKey) {
    setFleetEventBufferPinned(bufferKey, !!pinned)
    return
  }
  const key = viewerId || 'default'
  const wasPinned = isLiveTailPinned()
  _liveTailViewers.set(key, !!pinned)
  if (!wasPinned && isLiveTailPinned()) trimIfLiveTailPinned()
}

/**
 * @param {string | null | undefined} viewerId
 * @param {string | null | undefined} bufferKey
 */
export function clearFleetEventsLiveTailPinned(viewerId, bufferKey = null) {
  if (bufferKey) {
    setFleetEventBufferPinned(bufferKey, true)
    return
  }
  const key = viewerId || 'default'
  const wasPinned = isLiveTailPinned()
  _liveTailViewers.delete(key)
  if (!wasPinned && isLiveTailPinned()) trimIfLiveTailPinned()
}

function projectStoreResult(result) {
  if (!result) { noteProjection('dropped', _lastEventId); return }
  if (result.evicted?.length) { noteProjection('replace', _lastEventId); replaceFleetEvents(_store.all()) }
  else { noteProjection('upsert', _lastEventId); upsertFleetEvent(result.event) }
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

// Identity resolves after panels may already have subscribed. One place to
// re-send them with the resolved identity, rather than every caller remembering.
subscribe('identity', null, () => {
  refreshChatSubscriptionIdentity(_humanId, _humanName)
})

export function matchesFilter(filter, event) {
  return matchesFleetFilter(filter, event, { agents: _agents, humanId: _humanId, humanName: _humanName })
}

function resolveFilter(filter) {
  return resolveFleetFilter(filter, { agents: _agents, humanId: _humanId, humanName: _humanName })
}

export { resolveFilter }

// --- Read API ---
export function getAgents() { return _agents }
export function getAgentTotals() { return _agentTotals }
export function getTasks() { return _tasks }
export function getItems() { return _items }
// The transport's high-water mark, for diagnostics that must report a panel's
// own position and the stream's position in the SAME record (see
// src/fleet/chat-freeze-probe.mjs). Reading it from getFleetRuntimeSummary()
// would drag the whole summary into a hot path.
export function getLastEventId() { return _lastEventId }
export function getActivity(agentId) { return _store.all().filter(e => e._activity && e.agent === agentId) }
export function getHumanId() { return _humanId }
export function getHumanName() { return _humanName }

// Fetch the next bounded live-agent page only when a list view reaches it.
// Dead agents are intentionally not hydrated into the browser roster.
export function loadNextAgentsPage() {
  if (!_nextAgentsCursor || _agentsPageLoading) return _agentsPageLoading || Promise.resolve(false)
  _agentsPageLoading = browserFleetTransport.ephemeral('agents-page', {
    limit: 100,
    cursor: _nextAgentsCursor,
  })
    .then(data => {
      _nextAgentsCursor = data.nextCursor || null
      if (data.totals) _agentTotals = data.totals
      applyAgentDelta(data.agents || [], [], data.totals)
      return true
    })
    .catch(e => { console.warn('[fleet-data] agent page transport failed:', e.message); return false })
    .finally(() => { _agentsPageLoading = null })
  return _agentsPageLoading
}

const _agentLookupPromises = new Map()

export async function hydrateFleetAgentsForFilter(filter) {
  if (!Array.isArray(filter)) return
  const ids = new Set()
  const names = new Set()
  const pseudo = new Set(['here', 'away', 'awake', 'hibernating', 'dead', 'human', 'me', 'my_labels'])
  for (const clause of filter) {
    if (!Array.isArray(clause)) continue
    for (const term of clause) {
      if (!Array.isArray(term) || term.length < 2) continue
      const label = String(term[1] || '').trim()
      if (!label || pseudo.has(label)) continue
      if (label.startsWith('fleet:')) ids.add(label)
      else names.add(label)
    }
  }
  const requests = []
  if (ids.size) requests.push({ key: `ids:${[...ids].sort().join(',')}`, url: `${FLEET}/api/agents/lookup?ids=${encodeURIComponent([...ids].join(','))}` })
  for (const name of names) requests.push({ key: `name:${name}`, url: `${FLEET}/api/agents/lookup?name=${encodeURIComponent(name)}` })
  const batches = await Promise.all(requests.map(({ key, url }) => {
    let pending = _agentLookupPromises.get(key)
    if (!pending) {
      // Keep WHY a lookup produced nothing. `.catch(() => ({agents: []}))` made a
      // failed fetch and a legitimately-empty result arrive identically, so the
      // probe could not tell "this name will never resolve for this tab" (a bug)
      // from "no agent is called that" (correct — e.g. an id fragment typed as a
      // filter term). Only the first is a fault.
      pending = fetch(url)
        .then(r => r.ok
          ? r.json().then(j => ({ ...j, _outcome: 'ok' }))
          : { agents: [], _outcome: `http-${r.status}` })
        .catch(e => ({ agents: [], _outcome: `threw:${e?.name || 'error'}` }))
        .finally(() => _agentLookupPromises.delete(key))
      _agentLookupPromises.set(key, pending)
    }
    return pending
  }))
  // Record what each NAME term resolved to. A name that resolves to nothing is
  // permanently unresolvable for this tab — nothing re-runs hydration unless the
  // filter changes — so every message from that agent is dropped by the panel
  // while radio still shows it. chat-freeze-probe logs that at its source.
  requests.forEach((req, i) => {
    if (!req.key.startsWith('name:')) return
    recordFilterNameIds(req.key.slice(5), (batches[i]?.agents || []).map(a => a.id), batches[i]?._outcome || 'unknown')
  })
  const agents = batches.flatMap(batch => batch?.agents || [])
  if (agents.length) applyAgentDelta(agents, [])
}

if (typeof window !== 'undefined') {
  window.__tldaFleetIdentity = () => ({
    id: _humanId,
    name: _humanName,
    identifyPending: _identifyPending,
    connected: _connected,
    wsReadyState: _ws?.readyState ?? null,
  })
}

// A stable per-browser id, generated once and persisted. This is the "device"
// half of the (identity, device) fleet-layout key: the same human identity open
// on two devices (Mac + iPad) gets two distinct device ids, so each device owns
// and lays out its own fleet shapes instead of fighting over one shared set.
// Purely local — never sent to the server as an identity, only stamped on shapes.
const DEVICE_ID_KEY = 'tlda-device-id'
const DEVICE_ID_DB = 'tlda-device'
const DEVICE_ID_STORE = 'kv'
let _deviceId = null
let _deviceReady = false
let _deviceReadyResolve = null
const _deviceReadyPromise = new Promise(resolve => { _deviceReadyResolve = resolve })

export function whenDeviceReady() { return _deviceReadyPromise }
export function isDeviceReady() { return _deviceReady }

function readLocalDeviceId() {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(DEVICE_ID_KEY) || ''
  } catch {
    return ''
  }
}

function writeLocalDeviceId(id) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DEVICE_ID_KEY, id)
  } catch {}
}

function openDeviceDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DEVICE_ID_DB, 1)
      req.onupgradeneeded = () => {
        try {
          const db = req.result
          if (!db.objectStoreNames.contains(DEVICE_ID_STORE)) db.createObjectStore(DEVICE_ID_STORE)
        } catch {}
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function readIndexedDeviceId() {
  const db = await openDeviceDb()
  if (!db) return ''
  try {
    return await new Promise(resolve => {
      const tx = db.transaction(DEVICE_ID_STORE, 'readonly')
      const store = tx.objectStore(DEVICE_ID_STORE)
      const req = store.get(DEVICE_ID_KEY)
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : '')
      req.onerror = () => resolve('')
      tx.oncomplete = () => db.close()
      tx.onerror = () => { try { db.close() } catch {}; resolve('') }
      tx.onabort = () => { try { db.close() } catch {}; resolve('') }
    })
  } catch {
    try { db.close() } catch {}
    return ''
  }
}

async function writeIndexedDeviceId(id) {
  const db = await openDeviceDb()
  if (!db) return
  try {
    await new Promise(resolve => {
      const tx = db.transaction(DEVICE_ID_STORE, 'readwrite')
      tx.objectStore(DEVICE_ID_STORE).put(id, DEVICE_ID_KEY)
      tx.oncomplete = () => { try { db.close() } catch {}; resolve() }
      tx.onerror = () => { try { db.close() } catch {}; resolve() }
      tx.onabort = () => { try { db.close() } catch {}; resolve() }
    })
  } catch {
    try { db.close() } catch {}
  }
}

function mintDeviceId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
}

async function initDeviceId() {
  try {
    let id = readLocalDeviceId()
    if (id) {
      _deviceId = id
      void writeIndexedDeviceId(id)
      return
    }

    id = await readIndexedDeviceId()
    if (id) {
      _deviceId = id
      writeLocalDeviceId(id)
      return
    }

    id = mintDeviceId()
    _deviceId = id
    writeLocalDeviceId(id)
    void writeIndexedDeviceId(id)
  } finally {
    _deviceReady = true
    if (_deviceReadyResolve) { _deviceReadyResolve(); _deviceReadyResolve = null }
    bumpIdentityEpoch()
  }
}

void initDeviceId()

export function getDeviceId() {
  if (_deviceId) return _deviceId
  return ''
}
export function needsIdentity() { return !_humanId && _identifyPending }

function readStoredIdentity() {
  try {
    const stored = localStorage.getItem('tlda-identity')
    const clean = sanitizeIdentityName(stored)
    if (!isUsableIdentityName(clean)) {
      if (stored) localStorage.removeItem('tlda-identity')
      return null
    }
    return clean
  }
  catch {
    // Storage access can be blocked by the browser; fall back to temporary identity.
    return null
  }
}

function readUrlIdentity() {
  try {
    const clean = sanitizeIdentityName(new URLSearchParams(window.location.search).get('name'))
    return isUsableIdentityName(clean) ? clean : null
  } catch {
    return null
  }
}

function writeStoredIdentity(name) {
  try { localStorage.setItem('tlda-identity', name) } catch {
    // Storage persistence is best-effort; the active WS identity is already set.
  }
}

function writeTemporaryIdentity(name) {
  try { sessionStorage.setItem('tlda-temporary-identity', name) } catch {
    // Temporary identity storage is diagnostic only; registration already succeeded.
  }
}

function clearTemporaryIdentity() {
  try { sessionStorage.removeItem('tlda-temporary-identity') } catch {
    // Clearing a diagnostic session key must not block identity upgrade.
  }
}

function clearIdentityRetry() {
  if (_identityRetryTimer) {
    window.clearTimeout(_identityRetryTimer)
    _identityRetryTimer = null
  }
}

/** Log in as an existing agent. Used by returning users and ?name= auto-login. */
export async function login(name) {
  const clean = sanitizeIdentityName(name)
  if (!isUsableIdentityName(clean)) throw new Error('invalid identity name')
  _humanName = clean
  const res = await browserFleetTransport.durable('login', { name: clean })
  _humanId = res.id
  _humanName = res.name
  _identifyPending = false
  clearIdentityRetry()
  writeStoredIdentity(res.name)
  clearTemporaryIdentity()
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  bumpIdentityEpoch()
  _startHeartbeat()
  return res
}

/** Register a new human agent. Used by the IdentityPicker for new users. */
export async function registerHuman(name, { persist = true } = {}) {
  const sanitized = sanitizeIdentityName(name)
  if (!isUsableIdentityName(sanitized)) throw new Error('invalid identity name')
  _humanName = sanitized
  const humanId = `fleet:${sanitized}`
  const res = await browserFleetTransport.durable('register', { agent_id: humanId, name: sanitized, human: true })
  _humanId = res.agent?.id || humanId
  _humanName = sanitized
  _identifyPending = false
  clearIdentityRetry()
  if (persist) {
    writeStoredIdentity(sanitized)
    clearTemporaryIdentity()
  } else {
    writeTemporaryIdentity(sanitized)
  }
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  bumpIdentityEpoch()
  _startHeartbeat()
  return res
}

function retryStoredIdentity(storedName) {
  if (!storedName) return
  if (_identityRetryTimer) return
  _identityRetryTimer = window.setTimeout(() => {
    _identityRetryTimer = null
    if (!_ws || _ws.readyState !== 1) return
    if (readStoredIdentity() !== storedName) return
    if (_humanId && _humanName === storedName) return
    login(storedName).catch(() => {
      _identifyPending = true
      notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
      retryStoredIdentity(storedName)
    })
  }, 5000)
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
    const { type, ...payload } = body
    const d = await browserFleetTransport.durable(type, payload, { operationId: body._tempId })
    console.log(`[chat-send] to=${to} id=${d.event_id} ws=${Math.round(performance.now()-_t0)}ms text=${text.substring(0,30)}`)
    // A durable send that only reached the outbox is queued, not sent. Reporting
    // ok for it is a success this layer can't support: it's what stops the caller
    // ever marking the message "not sent", so a disconnected message is neither
    // visibly sent nor visibly unsent. The row still delivers on reconnect, and
    // the echo clears the mark when it binds.
    return { ok: d.queued !== true, event_id: d.event_id || null, queued: d.queued === true, operation_id: d.operation_id || body._tempId || null }
  } catch (e) {
    console.log(`[chat-send] to=${to} FAILED ws=${Math.round(performance.now()-_t0)}ms err=${e.message}`)
    return { ok: false, event_id: null }
  }
}

/**
 * Inject an optimistic (locally-authored) event into the event list immediately.
 *
 * `bufferKey` is the sending chat panel's own buffer. A filtered panel renders from a
 * server-fed buffer that the global fanout deliberately skips, so without this the row
 * is invisible there until the server echoes it back — which, connected, is a few
 * milliseconds and looks like a working local echo, and disconnected is never.
 */
export function injectOptimisticEvent(event, bufferKey) {
  const result = liveUpsert(event)
  projectStoreResult(result)
  upsertLocalEventIntoBuffer(bufferKey, result.event)
  notify('messages', result.event)
}

/**
 * Update fields on an optimistic event (e.g. mark _failed, or set _dbId on reconcile).
 * Takes the sending panel's `bufferKey` for the same reason inject does: the row is the
 * same object, but the panel's buffer needs its own upsert to notify its view.
 */
export function updateOptimisticEvent(tempId, updates, bufferKey) {
  const ev = _store.patchByTempId(tempId, updates)
  if (ev) {
    upsertFleetEvent(ev)
    upsertLocalEventIntoBuffer(bufferKey, ev)
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
  return browserFleetTransport.durable('spawn', { agent: id, respawn: true })
}

export function spawnAgent(model, doc, name, options = {}) {
  const modelOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  return browserFleetTransport.durable('spawn', { fresh: true, model, ...(doc ? { doc } : {}), ...(name ? { name } : {}), ...modelOptions })
}

export function renameAgent(id, name) {
  return browserFleetTransport.durable('rename', { agent: id, name })
}

export function setAgentLabels(id, labels) {
  return browserFleetTransport.durable('label', { agent: id, operation: 'replace', labels })
}

export function kickAgent(id) {
  return browserFleetTransport.durable('kick', { agent: id })
}

export function killSession(id) {
  return browserFleetTransport.durable('kill-session', { agent: id })
}

export function hibernateSession(id) {
  return browserFleetTransport.durable('hibernate-session', { agent: id })
}

export function sendKey(agent, key) {
  return browserFleetTransport.ephemeral('send-key', { agent, key })
}

export function sendText(agent, text) {
  return browserFleetTransport.ephemeral('send-text', { agent, text })
}

/** Send an arbitrary WS message to the fleet server. Returns a promise for the result. */
export function fleetEphemeral(type, body = {}) {
  return browserFleetTransport.ephemeral(type, body)
}

/** Send an arbitrary durable fleet operation through the shared transport. */
export function fleetDurable(type, body = {}, options = {}) {
  return browserFleetTransport.durable(type, body, options)
}

export async function dismissItem(id) {
  const userId = _humanId
  if (!userId) throw new Error('no human identity')
  await browserFleetTransport.durable('notify', { action: 'dismiss', userId, id })
  _items = _items.filter(i => i.id !== id)
  notify('items', { userId, items: _items })
}

// --- WebSocket connection ---
let _ws = null
let _reconnectDelay = 1000
let _connected = false
let _disconnectedAt = 0
let _heartbeatInterval = null
let _receiveWatchdogInterval = null
// Force a reconnect if the socket produces no inbound traffic for this long. A
// healthy socket yields a message at least every 10s (the id'd heartbeat reply
// below, plus deltas), so 30s of total silence = 3 missed cycles → half-open/dead.
// Detection is ~30-35s (timeout + one check tick). This sits BELOW the server's
// 60s heartbeat grace: harmless, because a client that reconnects while the server
// still holds the old socket just opens a fresh one and backfills — the server
// reaps the abandoned socket at 60s, and no message is lost across the gap.
const WS_RECEIVE_TIMEOUT_MS = 30_000
const WS_RECEIVE_CHECK_MS = 5_000
// A socket that never reaches OPEN fires no open, no close, and no error, so
// nothing above ever runs: the receive watchdog returns immediately because it
// only looks at readyState 1, and connect() refuses to redial because `_ws` is
// non-null. That is a permanent deafness with a working composer and no error,
// and it is what a deploy produces — the edge accepts the TCP connection while
// no backend is there to answer the upgrade. A healthy connect to the live
// server was measured at ~329ms, so this ceiling is generous by an order of
// magnitude: it catches wedged, not slow.
const WS_CONNECT_TIMEOUT_MS = 5_000
let _connectAttemptTimer = null
let _lastWsOpenAt = 0
let _lastWsCloseAt = 0
let _lastWsActivityAt = 0
let _lastWsMessageAt = 0
let _lastAgentsDeltaAt = 0
const browserActivityDeliveryCounters = createActivityDeliveryCounters({ origin: 'browser' })
const _browserRenderedActivityIds = new Set()

function finiteMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isoMs(value) {
  if (!value) return null
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : null
}

function latencyDelta(later, earlier) {
  return Number.isFinite(later) && Number.isFinite(earlier) ? Math.max(0, later - earlier) : null
}

function summarizeValues(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const pick = p => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: sorted[sorted.length - 1],
  }
}

function summarizeActivityLatency(now) {
  const rows = _store.all()
    .filter(e => e?._activity && e._activityLatency)
    .slice(-25)
    .map(e => {
      const latency = e._activityLatency || {}
      const jsonlMs = isoMs(latency.jsonlTs || e.timestamp)
      const daemonReceivedMs = finiteMs(latency.daemonReceivedAtMs)
      const daemonSentMs = finiteMs(latency.daemonSentAtMs)
      const serverReceivedMs = finiteMs(latency.serverReceivedAtMs)
      const serverBroadcastQueuedMs = finiteMs(latency.serverBroadcastQueuedAtMs)
      const browserReceivedMs = finiteMs(latency.browserReceivedAtMs)
      return {
        id: e._dbId ?? null,
        agent: e.from || e.agent || null,
        tool: e._toolName || e.text || null,
        jsonlTs: latency.jsonlTs || e.timestamp || null,
        browserReceivedAgoMs: browserReceivedMs ? now - browserReceivedMs : null,
        jsonlToDaemonMs: latencyDelta(daemonReceivedMs || daemonSentMs, jsonlMs),
        daemonQueueMs: latencyDelta(daemonSentMs, daemonReceivedMs),
        daemonToServerMs: latencyDelta(serverReceivedMs, daemonSentMs),
        serverToBrowserMs: latencyDelta(browserReceivedMs, serverBroadcastQueuedMs || serverReceivedMs),
        jsonlToBrowserMs: latencyDelta(browserReceivedMs, jsonlMs),
      }
    })
  return {
    recent: rows,
    summary: {
      jsonlToDaemon: summarizeValues(rows.map(row => row.jsonlToDaemonMs)),
      daemonQueue: summarizeValues(rows.map(row => row.daemonQueueMs)),
      daemonToServer: summarizeValues(rows.map(row => row.daemonToServerMs)),
      serverToBrowser: summarizeValues(rows.map(row => row.serverToBrowserMs)),
      jsonlToBrowser: summarizeValues(rows.map(row => row.jsonlToBrowserMs)),
    },
  }
}

/** Returns true if the WS is currently connected */
export function isConnected() { return _connected }

/** Returns ms since disconnect, or 0 if connected */
export function disconnectedFor() { return _connected ? 0 : (_disconnectedAt ? Date.now() - _disconnectedAt : 0) }

export function getFleetRuntimeSummary(now = Date.now()) {
  return {
    connected: _connected,
    disconnectedForMs: disconnectedFor(),
    wsReadyState: _ws?.readyState ?? null,
    pendingRpcCount: _wsCallbacks.size,
    reconnectDelayMs: _reconnectDelay,
    lastWsOpenAgoMs: _lastWsOpenAt ? now - _lastWsOpenAt : null,
    lastWsCloseAgoMs: _lastWsCloseAt ? now - _lastWsCloseAt : null,
    lastWsActivityAgoMs: _lastWsActivityAt ? now - _lastWsActivityAt : null,
    lastWsMessageAgoMs: _lastWsMessageAt ? now - _lastWsMessageAt : null,
    lastEventId: _lastEventId || null,
    lastAgentsDeltaAgoMs: _lastAgentsDeltaAt ? now - _lastAgentsDeltaAt : null,
    agentCount: _agents.length,
    taskCount: _tasks.length,
    itemCount: _items.length,
    eventCount: _store.all().length,
    loadingAgentPage: !!_agentsPageLoading,
    hasNextAgentsPage: !!_nextAgentsCursor,
    liveTailPinned: isLiveTailPinned(),
    activityLatency: summarizeActivityLatency(now),
    activityDelivery: browserActivityDeliveryCounters.snapshot(),
  }
}

export function recordBrowserActivityRendered(stage, activityGroup = [], count = 1) {
  const group = Array.isArray(activityGroup) ? activityGroup : []
  let amount = count
  let first = group[0] || null
  if (stage === ACTIVITY_DELIVERY_STAGES.BROWSER_RENDERED) {
    const newEvents = []
    for (const activity of group) {
      const id = activity?._dbId ?? activity?.id ?? null
      if (id == null) {
        newEvents.push(activity)
        continue
      }
      const key = String(id)
      if (_browserRenderedActivityIds.has(key)) continue
      _browserRenderedActivityIds.add(key)
      newEvents.push(activity)
    }
    if (newEvents.length === 0) return
    amount = newEvents.length
    first = newEvents[0]
  }
  browserActivityDeliveryCounters.record(stage, { type: 'activity' }, amount, {
    type: 'activity',
    agent: first?.from || first?.agent || null,
    tool: first?._toolName || first?.text || null,
  })
}

// WS request/response: pending callbacks keyed by message ID
let _wsReqId = 0
const _wsCallbacks = new Map()
const WS_REQUEST_IDLE_MS = 45_000
const _wsReconnectBuffer = new WsReconnectBuffer({
  isConnected: () => !!_ws && _ws.readyState === 1,
})

function markWsActivity() {
  _lastWsActivityAt = Date.now()
  resetWsRequestIdleTimers(_wsCallbacks)
}

function _startHeartbeat() {
  if (_heartbeatInterval) clearInterval(_heartbeatInterval)
  _heartbeatInterval = setInterval(() => {
    if (_humanId && _ws && _ws.readyState === 1) {
      // Send the heartbeat as a REQUEST (with an id) so the server's reply()
      // sends a frame back. That inbound frame is what resets the receive
      // watchdog every 10s on a healthy socket. A raw id-less heartbeat gets
      // NO reply — the server's reply() no-ops without an id — so a
      // quiet-but-healthy connection would produce zero inbound and the
      // watchdog would false-reconnect every cycle. The reply is fire-and-forget
      // here (we only need the inbound frame); a half-open socket gets no reply,
      // so the watchdog still fires.
      browserFleetTransport.ephemeral('heartbeat', { agent: _humanId }).catch(() => {})
    }
  }, 10_000)
  _startReceiveWatchdog()
}

// Receive-side watchdog. The heartbeat above only SENDS; on its own it can't
// notice a socket that went half-open (Wi-Fi sleep, network change, backgrounded
// tab) where `onclose` never fires. A half-open socket sits at readyState===1
// forever, so no reconnect runs and new chat events silently stop arriving —
// the "reload over and over to see anything" failure. This is the browser-native
// equivalent of ResilientWS's heartbeat-timeout (shared/resilient-ws.mjs): a live
// socket produces inbound traffic at least every 10s (the server replies to our
// heartbeat, plus agents-delta/chat), so if we've heard NOTHING for 3 heartbeat
// cycles (30s) we assume the socket is dead and force-close it. That close
// fires `onclose`, which runs the existing reconnect + reconnect-backfill path.
function _startReceiveWatchdog() {
  if (_receiveWatchdogInterval) clearInterval(_receiveWatchdogInterval)
  // Seed activity so a stale timestamp from a prior dead socket can't fire
  // immediately after a fresh open.
  _lastWsActivityAt = Date.now()
  _receiveWatchdogInterval = setInterval(() => {
    if (!_ws || _ws.readyState !== 1) return
    const silentForMs = Date.now() - _lastWsActivityAt
    if (silentForMs > WS_RECEIVE_TIMEOUT_MS) {
      log.warn('fleet-data', 'receive watchdog: no inbound activity — forcing reconnect', { silentForMs })
      try { _ws.close() } catch { /* onclose still fires the reconnect path */ }
    }
  }, WS_RECEIVE_CHECK_MS)
}

function _stopReceiveWatchdog() {
  if (_receiveWatchdogInterval) { clearInterval(_receiveWatchdogInterval); _receiveWatchdogInterval = null }
}

// The receive watchdog above only inspects an OPEN socket, so it cannot see a
// socket that never opened. This covers that window, and only that window: it is
// armed when the socket is constructed and cleared the moment it opens.
function _armConnectTimeout(ws) {
  _clearConnectTimeout()
  _connectAttemptTimer = setTimeout(() => {
    _connectAttemptTimer = null
    // A later generation may already have replaced this socket; only the
    // generation this timer was armed for may act on the timeout.
    if (_ws !== ws) return
    if (ws.readyState !== 0) return // 0 = CONNECTING; anything else is not wedged
    log.metric('fleet-data', 'connect watchdog: socket never opened — forcing reconnect', {
      waitedMs: WS_CONNECT_TIMEOUT_MS,
    })
    // close() drives the existing onclose path, which nulls _ws and schedules
    // the retry with backoff. No second reconnect route.
    try { ws.close() } catch { /* onclose still fires the reconnect path */ }
  }, WS_CONNECT_TIMEOUT_MS)
}

function _clearConnectTimeout() {
  if (_connectAttemptTimer) { clearTimeout(_connectAttemptTimer); _connectAttemptTimer = null }
}

let _lastViewingSent = 0
let _viewingEnrichFn = null
export function setViewingEnrichFn(fn) { _viewingEnrichFn = fn }
export function sendViewingContext(context) {
  const now = Date.now()
  if (now - _lastViewingSent < 5000) return
  _lastViewingSent = now
  if (!_humanId) return
  const send = (ctx) => browserFleetTransport.ephemeral('viewing', { agent: _humanId, context: ctx }).catch(error => {
    log.error('fleet-transport', 'viewing update failed', { error: error.message })
  })
  if (_viewingEnrichFn) {
    _viewingEnrichFn({ ...context }).then(send).catch(() => send(context))
  } else {
    send(context)
  }
}

async function sendBrowserRequestAttempt(type, payload = {}, { idleTimeoutMs = WS_REQUEST_IDLE_MS, deadlineMs, envelope = null } = {}) {
  const msg = {
    type,
    ...payload,
    ...(envelope ? {
      operation_id: payload.operation_id || envelope.operation_id,
      fleet_operation: envelope,
    } : {}),
  }
  const startedAt = Date.now()
  const connectionDeadlineMs = deadlineMs ?? idleTimeoutMs
  while (!_ws || _ws.readyState !== 1) {
    const elapsed = Date.now() - startedAt
    const remaining = connectionDeadlineMs - elapsed
    if (remaining <= 0) throw new Error(`not connected after ${connectionDeadlineMs}ms (type=${msg.type})`)
    const connected = await _wsReconnectBuffer.waitForConnection(Math.min(remaining, 1000))
    if (!connected && (!_ws || _ws.readyState !== 1) && Date.now() - startedAt >= connectionDeadlineMs) {
      throw new Error(`not connected after ${connectionDeadlineMs}ms (type=${msg.type})`)
    }
  }
  const id = ++_wsReqId
  return startWsRequest({
    pending: _wsCallbacks,
    id,
    type: msg.type,
    idleTimeoutMs,
    deadlineMs,
    send: () => {
      _ws.send(JSON.stringify({ ...msg, id }))
      return true
    },
  })
}

const BROWSER_DURABLE_OUTBOX_KEY = `tlda:fleet-transport:${FLEET}`
let _browserDurableFlush = null

function readBrowserDurableOutbox() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BROWSER_DURABLE_OUTBOX_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeBrowserDurableOutbox(rows) {
  localStorage.setItem(BROWSER_DURABLE_OUTBOX_KEY, JSON.stringify(rows))
}

async function flushBrowserDurableOutbox() {
  if (_browserDurableFlush) return _browserDurableFlush
  _browserDurableFlush = (async () => {
    for (const row of readBrowserDurableOutbox()) {
      try {
        await sendBrowserRequestAttempt(row.operation, {
          ...row.payload,
          operation_id: row.operationId,
        }, { envelope: row.envelope })
        writeBrowserDurableOutbox(readBrowserDurableOutbox().filter(item => item.operationId !== row.operationId))
      } catch {
        break
      }
    }
  })().finally(() => { _browserDurableFlush = null })
  return _browserDurableFlush
}

async function sendBrowserDurable(operation, payload = {}, options = {}) {
  const operationId = options.operationId || payload._tempId || crypto.randomUUID()
  const rows = readBrowserDurableOutbox()
  if (!rows.some(row => row.operationId === operationId)) {
    rows.push({ operationId, operation, payload, envelope: options.envelope, createdAt: new Date().toISOString() })
    writeBrowserDurableOutbox(rows)
  }
  try {
    const result = await sendBrowserRequestAttempt(operation, {
      ...payload,
      operation_id: operationId,
    }, { ...options, envelope: options.envelope })
    writeBrowserDurableOutbox(readBrowserDurableOutbox().filter(row => row.operationId !== operationId))
    return result
  } catch (error) {
    if (error?.fleetServerRejected) {
      writeBrowserDurableOutbox(readBrowserDurableOutbox().filter(row => row.operationId !== operationId))
      throw error
    }
    return { ok: true, queued: true, operation_id: operationId }
  }
}

const browserFleetTransport = createFleetOperationTransport({
  name: 'browser-fleet',
  sendEphemeral: sendBrowserRequestAttempt,
  sendDurable: sendBrowserDurable,
  resolveSender: () => _humanId,
  resolveDestination: ({ payload }) => (
    payload.to || payload.agent || payload.agent_id || payload.target || null
  ),
  observe: event => {
    if (event.stage === 'terminal' && !event.ok) {
      log.error('fleet-transport', `${event.mode} ${event.operation} failed`, event)
    }
  },
})

export function connect() {
  if (_ws) return
  const params = new URLSearchParams(location.search)
  const token = params.get('token')
  const wsUrl = FLEET_WS + '/ws/fleet'
  _ws = new WebSocket(wsUrl)
  _armConnectTimeout(_ws)

  _ws.onopen = () => {
    _clearConnectTimeout()
    _lastWsOpenAt = Date.now()
    markWsActivity()
    _wsReconnectBuffer.resolveConnected()
    _reconnectDelay = 1000
    _connected = true
    notify('connection', { type: 'connection', connected: true })
    // Re-send every chat subscription. The server's subscription registry lives
    // in the server PROCESS, so a restart or a dropped socket empties it while
    // the browser still believes it is subscribed — and a chat panel's only
    // source of events is now its subscription. Without this, every server
    // restart silently freezes every open chat: the composer works, the list
    // scrolls, and no new message ever arrives. That is precisely the failure
    // this whole change exists to remove, so it must not be reintroduced by the
    // replacement.
    //
    // resubscribeAll() was written for exactly this and was never called from
    // anywhere — dead from the day it was added, harmless while panels still
    // rendered from the client store, load-bearing the moment they stopped.
    const resent = resubscribeAll()
    if (resent) log.metric('chat-subscription', 're-subscribed after reconnect', { count: resent })
    flushBrowserDurableOutbox().catch(error => {
      log.error('fleet-transport', 'durable outbox flush failed', { error: error.message })
    })
    void checkAppShellFreshness('fleet-ws-open')
    // Log in if we have a requested or stored identity. The URL is explicit for
    // this tab and must beat stale browser storage.
    const urlName = readUrlIdentity()
    const storedName = urlName || readStoredIdentity()
    if (storedName) {
      _identifyPending = true
      _humanName = storedName
      notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
      login(storedName).catch((err) => {
        // A deploy/restart can drop or time out this login request. Do not erase
        // or mask the browser's chosen identity with a generated temporary human:
        // the stored name is the durable "who I am" claim, so keep retrying it.
        if (storedIdentityLoginFailureAction(err) !== 'register-stored') {
          _identifyPending = true
          notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
          retryStoredIdentity(storedName)
          return
        }
        // Fresh/test servers may not have the human row yet. Preserve the
        // browser identity by creating that same human instead of forcing a
        // manual switch or temporary identity.
        registerHuman(storedName, { persist: !urlName }).catch(() => {
          _identifyPending = true
          notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
        })
      })
    } else {
      _identifyPending = true
      notify('identity', { type: 'identity', id: null, name: null, needsIdentity: true })
    }
    // Roster/task lists are loaded independently; the socket stays clear for
    // request replies and incremental deltas. Chat panels resubscribe above;
    // each subscription returns its own matching history window.
    setChatSubscriptionTransport((name, payload) => browserFleetTransport.ephemeral(name, payload))
  }

  _ws.onclose = (ev) => {
    _clearConnectTimeout()
    _lastWsCloseAt = Date.now()
    resetWsRequestIdleTimers(_wsCallbacks)
    _ws = null
    _connected = false
    _disconnectedAt = _disconnectedAt || Date.now()
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null }
    _stopReceiveWatchdog()
    notify('connection', { type: 'connection', connected: false })
    setTimeout(connect, _reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, 15000) // cap at 15s, not 30s
  }

  _ws.onerror = () => {}

  _ws.onmessage = (e) => {
    let msg = null
    let eventType = null
    let data = null
    try {
      markWsActivity()
      msg = JSON.parse(e.data)
      _lastWsMessageAt = Date.now()

      // Handle request/response messages from the operation transport adapter.
      if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
        const cb = _wsCallbacks.get(msg.id)
        if (cb) {
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
          if (msg.error) {
            const detail = typeof msg.error === 'object' && msg.error !== null ? msg.error : { message: msg.error }
            const err = new Error(detail.message || String(msg.error))
            Object.assign(err, detail)
            err.fleetServerRejected = true
            cb.reject(err)
          } else cb.resolve(msg.result)
        }
        return
      }

      // Event-typed messages
      eventType = msg.event
      data = msg.data

      // Incremental fleet state — changed/removed agents and bounded task deltas.
      if (eventType === 'agents-delta') {
        _lastAgentsDeltaAt = Date.now()
        applyAgentDelta(data.changed || [], data.removed || [], data.agentTotals)
        applyTaskDelta(data.task_delta)
        applyFleetEphemeral(data)
        return
      }

      if (eventType === 'filter-event') {
        // The server's membership verdict for a subscribed filter, and now the
        // panel's only live source: dispatchFilterEvent hands it to the
        // subscription's onEvents, which puts it in that panel's buffer.
        dispatchFilterEvent(data)
        return
      } else if (eventType === 'filter-events') {
        // The initial window the server queried for a subscription — the panel's
        // own history, decided by the same predicate as the live push above.
        dispatchFilterEvents(data)
        return
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
    } catch (err) {
      browserActivityDeliveryCounters.record(ACTIVITY_DELIVERY_STAGES.BROWSER_ERRORS, data || msg || { type: eventType || 'ws-message' }, 1, {
        type: data?.type || eventType || msg?.type || 'ws-message',
        agent: data?.from_id || data?.from || data?.agent || null,
        tool: data?.metadata?.tool || data?.text || null,
        error: err instanceof Error ? err.message : String(err),
      })
      log.error('fleet-data', 'fleet websocket message handler failed', {
        eventType,
        messageType: msg?.type || null,
        dataType: data?.type || null,
        eventId: data?.id || null,
        rawLength: typeof e.data === 'string' ? e.data.length : null,
        error: err instanceof Error ? err.stack || err.message : String(err),
      })
    }
  }
}

// --- Initial load ---
async function fetchAllActiveTasks() {
  const tasks = []
  let cursor = null
  do {
    const page = await browserFleetTransport.ephemeral('tasks-page', { limit: 200, cursor })
    tasks.push(...(page.tasks || []))
    cursor = page.nextCursor || null
  } while (cursor)
  return tasks
}

export async function init() {
  // Human identity is established via WS 'login' on connect.
  // If localStorage has a stored name, login is sent automatically.
  // If not, the UI shows a picker with login/register options.

  // Establish the one fleet wire before loading state. HTTP is not a fallback
  // feature transport.
  connect()
  const [agentsRes, tasksRes] = await Promise.all([
    browserFleetTransport.ephemeral('agents-page', { limit: 100 }).catch(e => { console.warn('[fleet-data] agents transport failed:', e.message); return {} }),
    fetchAllActiveTasks().catch(e => { console.warn('[fleet-data] tasks transport failed:', e.message); return [] }),
  ])

  // Populate agents + tasks
  _nextAgentsCursor = agentsRes.nextCursor || null
  if (agentsRes.totals) _agentTotals = agentsRes.totals
  updateAgents(agentsRes.agents || [])
  updateTasks(tasksRes || [])

  const fetchItemsForHuman = () => {
    if (!_humanId) return
    browserFleetTransport.ephemeral('items', { userId: _humanId })
      .then(data => {
        _items = data.items || []
        notify('items', { userId: _humanId, items: _items })
      })
      .catch(e => console.warn('[fleet-data] items transport failed:', e.message))
  }
  const offIdentity = subscribe('identity', null, fetchItemsForHuman)
  fetchItemsForHuman()
  setTimeout(() => offIdentity?.(), 30000)

}

// --- State updates ---
function updateAgents(agents) {
  _agents = agents
  replaceFleetAgents(agents)
  notify('agents', { type: 'agents', agents })
}

// Merge an incremental agent delta into the current list, then notify with the
// full merged list (same contract subscribers already rely on for 'agents').
function applyAgentDelta(changed, removed, totals = null) {
  if (totals) _agentTotals = totals
  if (!(changed?.length || removed?.length)) {
    if (totals) notify('agents', { type: 'agents', agents: _agents })
    return
  }
  upsertFleetAgents(changed || [])
  removeFleetAgents(removed || [])
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

function applyTaskDelta(delta) {
  if (!delta) return
  if (delta.overflow) {
    fetchAllActiveTasks()
      .then(updateTasks)
      .catch(e => console.warn('[fleet-data] task refresh transport failed:', e.message))
    return
  }
  const changed = Array.isArray(delta.changed) ? delta.changed : []
  const removed = Array.isArray(delta.removed) ? delta.removed : []
  if (!(changed.length || removed.length)) return
  const byId = new Map(_tasks.map(t => [t.id, t]))
  for (const id of removed) byId.delete(id)
  for (const task of changed) {
    if (!task?.id) continue
    if (task.status === 'done' || task.status === 'retracted') byId.delete(task.id)
    else byId.set(task.id, task)
  }
  _tasks = [...byId.values()].sort((a, b) =>
    (Date.parse(b.delegated_at || '') || 0) - (Date.parse(a.delegated_at || '') || 0)
  )
  notify('tasks', { type: 'tasks', tasks: _tasks })
}

// The renderable set shared by subscription history and live delivery.
const RENDERABLE_CHAT_TYPES = new Set([
  'chat', 'delegate', 'task_done', 'terminal_user', 'terminal_assistant', 'timer',
  'compacting', 'activity', 'terminal_attention', 'terminal_card', 'plan_approval',
  'kill-session', 'interrupt',
])

function toRenderableChatEvents(rows) {
  return (rows || [])
    .filter(e => RENDERABLE_CHAT_TYPES.has(e.event_type || e.type))
    .map(convertChatEvent)
}

/**
 * Put a subscription's events into that panel's buffer. The ONE intake for a
 * server-fed chat panel — history page and live push both land here, converted
 * the same way, so a message renders identically whichever way it arrived.
 *
 * @param {string} bufferKey
 * @param {readonly object[]} rows
 * @param {{browserReceivedAtMs?: number|null}} [timing]
 */
export function receiveFilterEvents(bufferKey, rows, { browserReceivedAtMs = null } = {}) {
  if (!bufferKey) return 0
  const events = toRenderableChatEvents(rows)
  if (Number.isFinite(browserReceivedAtMs)) {
    for (const event of events) {
      if (!event?._activityLatency) continue
      event._activityLatency = {
        ...event._activityLatency,
        browserReceivedAt: new Date(browserReceivedAtMs).toISOString(),
        browserReceivedAtMs,
      }
    }
  }
  const added = applyFilterEvents(bufferKey, events)
  if (added) notify('messages', null)
  return added
}
