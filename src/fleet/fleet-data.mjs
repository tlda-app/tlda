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
import { matchesFleetFilter, resolveFleetFilter } from './filter-semantics.mjs'
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
} from './fleet-data.ts'
import { log } from '../logger'
import { noteProjection } from './chat-freeze-probe.mjs'
import { probe } from '../perf-probe'
import { DATABASE_HTTP, DATABASE_WS } from '../activeConfig'
import { isUsableIdentityName, sanitizeIdentityName, storedIdentityLoginFailureAction } from './identity-persistence.mjs'
import { resetWsRequestIdleTimers, startWsRequest, WsReconnectBuffer } from '../../shared/fleet-browser-transport.mjs'
import { createFleetOperationTransport } from '../../shared/fleet-operation-transport.mjs'
import { createActivityDeliveryCounters, ACTIVITY_DELIVERY_STAGES } from '../../shared/activity-delivery-counters.mjs'
import { maybeShowRadioSubtitleForIncomingChat } from '../voice.mjs'
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
let _nextTasksCursor = null
// One id-keyed ordered buffer — the SINGLE source for chat + activity, fed by
// two sources (live WS + DB history). upsert() dedups by id, binds the
// optimistic tempId→dbId handoff, and caps memory as one contiguous ordered
// window, so there's no live/older split to gap against.
const _store = makeEventStore()
// History fetched from the server is limited to this many rows per request.
const HISTORY_PAGE = 150
// Activity events are now stored in the events table (type='activity')
// and flow through the same channel as chat — no separate store needed.
let _humanId = null
let _humanName = null
let _identifyPending = false   // true while waiting for identify response
let _lastEventId = 0
let _identityRetryTimer = null
// Buffer for event-updates that arrive before their target event is in the
// store (e.g. an async file-upload's `event-update` racing ahead of the chat
// event it patches). Without this, the update is dropped and its change — most
// visibly a late `inline_attachments` → file chip — is lost until reload. Keyed
// by db event id; drained when the matching fleet-event arrives.
const _pendingEventUpdates = new Map()
const _MAX_PENDING_UPDATES = 200
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
export function getEvents() { return _store.all() }
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
  const pseudo = new Set(['awake', 'hibernating', 'unavailable', 'human', 'human-away', 'dead', 'me', 'my_labels'])
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
      pending = fetch(url)
        .then(r => r.ok ? r.json() : { agents: [] })
        .catch(() => ({ agents: [] }))
        .finally(() => _agentLookupPromises.delete(key))
      _agentLookupPromises.set(key, pending)
    }
    return pending
  }))
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
    if (_humanName === storedName) return
    browserFleetTransport.durable('login', { name: storedName }).then(res => {
      _humanId = res.id
      _humanName = res.name
      _identifyPending = false
      clearIdentityRetry()
      clearTemporaryIdentity()
      notify('identity', { type: 'identity', id: _humanId, name: _humanName })
      bumpIdentityEpoch()
      _startHeartbeat()
    }).catch(() => {
      _identifyPending = true
      notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
      retryStoredIdentity(storedName)
    })
  }, 5000)
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
    const { type, ...payload } = body
    const d = await browserFleetTransport.durable(type, payload, { operationId: body._tempId })
    console.log(`[chat-send] to=${to} id=${d.event_id} ws=${Math.round(performance.now()-_t0)}ms text=${text.substring(0,30)}`)
    return { ok: true, event_id: d.event_id || null, queued: d.queued === true, operation_id: d.operation_id || body._tempId || null }
  } catch (e) {
    console.log(`[chat-send] to=${to} FAILED ws=${Math.round(performance.now()-_t0)}ms err=${e.message}`)
    return { ok: false, event_id: null }
  }
}

/** Inject an optimistic (locally-authored) event into the event list immediately. */
export function injectOptimisticEvent(event) {
  const result = liveUpsert(event)
  projectStoreResult(result)
  notify('messages', result.event)
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
  return browserFleetTransport.durable('label', { agent: id, labels })
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
let _lastWsOpenAt = 0
let _lastWsCloseAt = 0
let _lastWsActivityAt = 0
let _lastWsMessageAt = 0
let _lastFleetEventAt = 0
let _lastFleetEventId = 0
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
    lastFleetEventAgoMs: _lastFleetEventAt ? now - _lastFleetEventAt : null,
    lastFleetEventId: _lastFleetEventId || null,
    lastEventId: _lastEventId || null,
    lastAgentsDeltaAgoMs: _lastAgentsDeltaAt ? now - _lastAgentsDeltaAt : null,
    agentCount: _agents.length,
    taskCount: _tasks.length,
    itemCount: _items.length,
    eventCount: _store.all().length,
    pendingEventUpdateCount: _pendingEventUpdates.size,
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

  _ws.onopen = () => {
    _lastWsOpenAt = Date.now()
    markWsActivity()
    _wsReconnectBuffer.resolveConnected()
    _reconnectDelay = 1000
    _connected = true
    notify('connection', { type: 'connection', connected: true })
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
      notify('identity', { type: 'identity', id: null, name: storedName, needsIdentity: true })
      browserFleetTransport.durable('login', { name: storedName }).then(res => {
        _humanId = res.id
        _humanName = res.name
        _identifyPending = false
        notify('identity', { type: 'identity', id: _humanId, name: _humanName })
        _startHeartbeat()
      }).catch((err) => {
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
    // request replies and incremental deltas.
    // Catch up on missed chat events
    if (_lastEventId > 0) {
      const reconnectTimer = probe.start('reconnect', 'reconnect-backfill')
      browserFleetTransport.ephemeral('store-events', { after: _lastEventId, limit: 500 })
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
            const { event: ev, isNew, evicted } = liveUpsert(convertChatEvent(raw))
            if (evicted.length) replaceFleetEvents(_store.all())
            else upsertFleetEvent(ev)
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

      if (eventType === 'fleet-event') {
        _lastFleetEventAt = Date.now()
        if (!data || !data.type) return
        if (data.id) _lastFleetEventId = data.id
        if (data.type === 'open-doc' && data.url) {
          notify('open-doc', data)
          return
        }
        // upsert dedups by db id and binds our optimistic send: if the echo
        // carries the _tempId we sent (or the WS reply already set the _dbId),
        // it rebinds the pending entry instead of appending a duplicate. All by
        // id — no content matching.
        const converted = convertChatEvent(data)
        if (data.type === 'activity') {
          browserActivityDeliveryCounters.record(ACTIVITY_DELIVERY_STAGES.BROWSER_CONVERTED, data, 1, {
            type: 'activity',
            agent: data.from_id || data.from || data.agent || null,
            tool: data.metadata?.tool || data.text || null,
          })
        }
        if (converted?._activityLatency) {
          const browserReceivedAtMs = Date.now()
          converted._activityLatency = {
            ...converted._activityLatency,
            browserReceivedAt: new Date(browserReceivedAtMs).toISOString(),
            browserReceivedAtMs,
          }
        }
        const result = liveUpsert(converted)
        const { event, isNew } = result
        // Drain any event-updates that arrived before this event (e.g. a late
        // file-upload's inline_attachments). Applying them now, before notify,
        // means the first render already shows the patched line.
        if (data.id != null && _pendingEventUpdates.has(data.id)) {
          for (const u of _pendingEventUpdates.get(data.id)) applyEventUpdateFields(event, u)
          _pendingEventUpdates.delete(data.id)
        }
        projectStoreResult(result)
        if (data.id && data.id > _lastEventId) _lastEventId = data.id
        if (data.type === 'chat') {
          console.log(`[chat-recv] id=${data.id} from=${data.from_id||data.from} text=${(data.text||'').substring(0,30)}`)
        }
        if (data.type === 'interrupt' || data.type === 'kill-session') {
          log.warn('interrupt-recv', 'event received', { type: data.type, id: data.id, from: data.from_id||data.from, to: data.to_id||data.to, isNew })
        }
        if (isNew && data.type === 'chat') {
          maybeShowRadioSubtitleForIncomingChat(event, _agents, _humanId)
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
export async function init() {
  // Human identity is established via WS 'login' on connect.
  // If localStorage has a stored name, login is sent automatically.
  // If not, the UI shows a picker with login/register options.

  // Establish the one fleet wire before loading state. HTTP is not a fallback
  // feature transport.
  connect()
  const [agentsRes, tasksRes, historyRes] = await Promise.all([
    browserFleetTransport.ephemeral('agents-page', { limit: 100 }).catch(e => { console.warn('[fleet-data] agents transport failed:', e.message); return {} }),
    browserFleetTransport.ephemeral('tasks-page', { limit: 100 }).catch(e => { console.warn('[fleet-data] tasks transport failed:', e.message); return {} }),
    browserFleetTransport.ephemeral('load-history', { limit: HISTORY_PAGE }).catch(e => { console.warn('[fleet-data] history transport failed:', e.message); return { events: [] } }),
  ])

  // Populate agents + tasks
  _nextAgentsCursor = agentsRes.nextCursor || null
  if (agentsRes.totals) _agentTotals = agentsRes.totals
  updateAgents(agentsRes.agents || [])
  _nextTasksCursor = tasksRes.nextCursor || null
  updateTasks(tasksRes.tasks || [])

  // Populate chat events and notify subscribers
  // One path: ingest everything (matching the live stream); the render whitelist
  // is the single gate for what displays. Mirrors the reconnect catch-up in connect().
  const chatEvents = (historyRes.events || [])
    .filter(e => (e.event_type || e.type))
    .map(convertChatEvent)
  _store.upsertMany(chatEvents)
  replaceFleetEvents(_store.all())
  // Track highest event ID for reconnect catch-up
  for (const e of historyRes.events || []) {
    if (e.id && e.id > _lastEventId) _lastEventId = e.id
  }
  for (const ev of chatEvents) notify('messages', ev)

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
    browserFleetTransport.ephemeral('tasks-page', { limit: 100 })
      .then(data => {
        _nextTasksCursor = data.nextCursor || null
        updateTasks(data.tasks || [])
      })
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

// --- Chat history helpers ---
// All events (chat + activity) come from the events table via /api/chat/history.
// No separate activity fetch needed.

export async function fetchHistory(agentIds = [], limit = 200) {
  const res = await browserFleetTransport.ephemeral('load-history', { agents: agentIds || [], limit })

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

export async function loadBefore(agentIds = [], beforeTs, count = 100, opts = {}) {
  const res = await browserFleetTransport.ephemeral('load-history', {
    agents: agentIds || [],
    before: beforeTs,
    limit: count,
  })

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session' || t === 'interrupt'
    })
    .map(convertChatEvent)

  // Fold scrollback into either the shared global store (unfiltered/global chat)
  // or a named chat buffer (filtered chats). Return the count of genuinely-new
  // rows so the caller knows whether to re-pin scroll after a prepend.
  let added = 0
  const changed = []
  let results = []
  if (opts.bufferKey) {
    changed.push(...events)
    added = upsertFleetEventsForBuffer(opts.bufferKey, changed, {
      beforeNotify: typeof opts.onBeforeNotify === 'function' ? opts.onBeforeNotify : undefined,
    })
  } else {
    results = _store.upsertMany(events, { skipTrim: true })
    for (const result of results) {
      if (result.isNew) added++
      changed.push(result.event)
    }
    if (added && typeof opts.onBeforeNotify === 'function') opts.onBeforeNotify(added)
  }
  const evicted = results.some(result => result.evicted?.length)
  if (!opts.bufferKey) {
    if (added || evicted) replaceFleetEvents(_store.all())
    else upsertFleetEvents(changed)
  }
  if (added) notify('messages', null)
  return added
}
