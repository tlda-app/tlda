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
import { setActiveMacros } from '../katexMacros'

// Fleet is embedded in tlda — use same-origin (no separate server)
const FLEET = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'
const FLEET_WS = typeof window !== 'undefined' ? window.location.origin.replace(/^http/, 'ws') : 'ws://localhost:5176'

// --- Stores ---
let _agents = []
let _tasks = []
let _events = []          // chat + lifecycle (delegate, task_done) — capped at MAX_EVENTS
const MAX_EVENTS = 150    // keep only the most recent N events in memory; older events fetched from DB on scroll
// Activity events are now stored in the events table (type='activity')
// and flow through the same channel as chat — no separate store needed.
let _reaperStatus = null     // latest reaper-status from daemon
let _humanId = null
let _humanName = null
let _identifyPending = false   // true while waiting for identify response
let _lastEventId = 0

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

// Filter is DNF of terms: [[["to","skip"],["from","math"]]] or plain [["label"]] or null (match all).
// Term formats: [role, label] tuple (directional) or plain string (matches from OR to).
export function matchesFilter(filter, event) {
  if (!event) return true  // broadcast (e.g. read-receipt refresh)
  if (!filter || filter.length === 0) return true
  // System notifications from fleet:tlda show in the agent's chat view (not bypassed globally)
  // Terminal cards are filtered like regular chat — they show in chats
  // whose filter matches the agent that triggered them.
  return filter.some(clause =>
    clause.every(term => {
      if (Array.isArray(term)) {
        const [role, label] = term
        const agentId = role === 'from' ? (event.from || event.agent) : (event.to || event.agent)
        return agentMatchesLabel(agentId, label)
      }
      // Plain string — match from OR to
      return agentMatchesLabel(event.from || event.agent, term) ||
             agentMatchesLabel(event.to || event.agent, term)
    })
  )
}

function agentMatchesLabel(agentId, label) {
  if (!agentId) return false
  if (agentId === label) return true
  const agent = _agents.find(a => a.id === agentId)
  if (!agent) {
    // Check human
    if (_humanId && agentId === _humanId) return [_humanName, _humanId].filter(Boolean).includes(label)
    return false
  }
  // Virtual labels derived from agent.status (mirrors server-side resolution).
  const virtual = agent.status === 'awake' ? ['awake'] : agent.status === 'hibernating' ? ['hibernating'] : []
  const labels = [...(agent.labels || []), ...virtual, agent.friendly_name, agent.id].filter(Boolean)
  return labels.includes(label)
}

// Resolve a DNF filter to set of agent IDs that match any clause.
// Handles both [role, label] tuple terms and plain string terms.
function resolveFilter(filter) {
  if (!filter) return new Set()
  const ids = new Set()
  const allAgents = [..._agents]
  if (_humanId) allAgents.push({ id: _humanId, friendly_name: _humanName || 'user', labels: [_humanName || 'user'] })
  for (const a of allAgents) {
    const virtual = a.status === 'awake' ? ['awake'] : a.status === 'hibernating' ? ['hibernating'] : []
    const labels = [...(a.labels || []), ...virtual, a.friendly_name, a.id].filter(Boolean)
    const matches = filter.some(clause =>
      clause.every(term => {
        const label = Array.isArray(term) ? term[1] : term
        return labels.includes(label)
      })
    )
    if (matches) ids.add(a.id)
  }
  return ids
}

export { resolveFilter }

// --- Read API ---
export function getReaperStatus() { return _reaperStatus }
export function getAgents() { return _agents }
export function getTasks() { return _tasks }
export function getEvents() { return _events }
export function getActivity(agentId) { return _events.filter(e => e._activity && e.agent === agentId) }
export function getHumanId() { return _humanId }
export function getHumanName() { return _humanName }
export function needsIdentity() { return !_humanId && _identifyPending }

/** Log in as an existing agent. Used by returning users and ?name= auto-login. */
export async function login(name) {
  const res = await wsSend({ type: 'login', name })
  _humanId = res.id
  _humanName = res.name
  _identifyPending = false
  localStorage.setItem('tlda-identity', res.name)
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  return res
}

/** Register a new human agent. Used by the IdentityPicker for new users. */
export async function registerHuman(name) {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const humanId = `fleet:${sanitized}`
  const res = await wsSend({ type: 'register', id: humanId, name: sanitized, human: true })
  _humanId = res.agent?.id || humanId
  _humanName = sanitized
  _identifyPending = false
  localStorage.setItem('tlda-identity', sanitized)
  notify('identity', { type: 'identity', id: _humanId, name: _humanName })
  return res
}

// Returns { agentId: count } for unread messages from agents to the human
export function getUnreadCountsForHuman() {
  const counts = {}
  for (const ev of _events) {
    if (ev.type === 'chat' && !ev.read && ev.to === _humanId && ev.from) {
      counts[ev.from] = (counts[ev.from] || 0) + 1
    }
  }
  return counts
}

export function getAgent(id) {
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
  _events.push(event)
  if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS)
  notify('messages', event)
}

/** Update fields on an optimistic event (e.g. mark _failed, or set _dbId on reconcile). */
export function updateOptimisticEvent(tempId, updates) {
  const ev = _events.find(e => e._tempId === tempId)
  if (ev) { Object.assign(ev, updates); notify('messages', null) }
}

export function updateEventById(dbId, updates) {
  const ev = _events.find(e => e._dbId === dbId || e._dbId === Number(dbId))
  if (!ev) return
  if (updates.metadata && ev.metadata) {
    Object.assign(ev.metadata, updates.metadata)
    delete updates.metadata
  }
  Object.assign(ev, updates)
  notify('messages', null)
}

/** Link an optimistic event to its server-assigned ID (if SSE hasn't already done it). */
export function reconcileOptimistic(tempId, serverEventId, newTo) {
  const ev = _events.find(e => e._tempId === tempId)
  // SSE handler may have already reconciled — only act if _tempId still present
  if (ev) {
    ev._dbId = serverEventId
    // For broadcasts, the optimistic event was injected with `to: <label>` (e.g. "awake").
    // On reconcile we rewrite it to the first concrete recipient so the line transitions
    // from "Skip → awake" to "Skip → alice" — a delivery confirmation for the first agent.
    // Broadcasts for the remaining recipients arrive as separate events with their own to_id.
    if (newTo) ev.to = newTo
    delete ev._tempId
    notify('messages', null)
  }
}

export function respawnAgent(id) {
  return wsSend({ type: 'spawn', agent: id, respawn: true })
}

export function spawnAgent(model, doc, name) {
  return wsSend({ type: 'spawn', model, ...(doc ? { doc } : {}), ...(name ? { name } : {}) })
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

// --- WebSocket connection ---
let _ws = null
let _reconnectDelay = 1000
let _connected = false
let _disconnectedAt = 0

/** Returns true if the WS is currently connected */
export function isConnected() { return _connected }

/** Returns ms since disconnect, or 0 if connected */
export function disconnectedFor() { return _connected ? 0 : (_disconnectedAt ? Date.now() - _disconnectedAt : 0) }

// WS request/response: pending callbacks keyed by message ID
let _wsReqId = 0
const _wsCallbacks = new Map()

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
      }).catch(() => {
        // Login failed — agent may have been removed. Show picker.
        _identifyPending = true
        localStorage.removeItem('tlda-identity')
        notify('identity', { type: 'identity', id: null, name: null, needsIdentity: true })
      })
    } else {
      _identifyPending = true
      notify('identity', { type: 'identity', id: null, name: null, needsIdentity: true })
    }
    // State (agents/tasks) is pushed by the server on WS connect — no need to re-fetch.
    // Catch up on missed chat events
    if (_lastEventId > 0) {
      fetch(`${FLEET}/api/store/events?after=${_lastEventId}&limit=500`)
        .then(r => r.json())
        .then(data => {
          const missed = (data.events || []).filter(e => {
            const t = e.type || e.event_type
            return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval'
          })
          const newEvents = []
          for (const raw of missed) {
            const event = convertChatEvent(raw)
            const eid = raw.id || raw._dbId
            if (eid && eid > _lastEventId) _lastEventId = eid
            // Deduplicate against existing events
            const key = `${event.timestamp}:${event.from}`
            if (_events.some(e => (e._dbId || `${e.timestamp}:${e.from}`) === (eid || key))) continue
            _events.push(event)
            newEvents.push(event)
          }
          if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS)
          for (const ev of newEvents) notify('messages', ev)
        })
        .catch(() => {})
    }
  }

  _ws.onclose = (ev) => {
    _ws = null
    _connected = false
    _disconnectedAt = _disconnectedAt || Date.now()
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

      // State updates (agents + tasks + ephemeral state) — no event field
      if (msg.agents && !msg.event) {
        updateAgents(msg.agents || [])
        updateTasks(msg.tasks || [])
        // Sync thinking/compacting state from server (authoritative)
        // Clear agents no longer thinking, add/update those that are
        const serverThinking = new Set(Object.keys(msg.thinking || {}))
        const serverCompacting = new Set(Object.keys(msg.compacting || {}))
        // Notify all — subscribers track their own state and will reconcile
        for (const [agent, ts] of Object.entries(msg.thinking || {})) {
          notify('thinking', { agent, thinking: true, ts })
        }
        for (const [agent, ts] of Object.entries(msg.compacting || {})) {
          notify('compacting', { agent, compacting: true, ts })
        }
        // Context percent state
        for (const [agent, ctx] of Object.entries(msg.context || {})) {
          notify('context', { agent, percent: ctx.percent, inputTokens: ctx.inputTokens })
        }
        // Clear any agent NOT in the server's set
        notify('thinking-sync', serverThinking)
        notify('compacting-sync', serverCompacting)
        return
      }

      // Event-typed messages
      const eventType = msg.event
      const data = msg.data

      if (eventType === 'fleet-event') {
        if (!data || !data.type) return
        if (data.type === 'open-doc' && data.url) {
          notify('open-doc', data)
          return
        }
        // Preamble macros for KaTeX rendering — set_preamble broadcasts these
        if (data.type === 'preamble' && data.macros) {
          setActiveMacros(data.macros)
          return
        }
        const event = convertChatEvent(data)
        // Dedup: skip if this event was already added (optimistic send or prior echo)
        if (data.id && _events.some(e => e._dbId === data.id)) {
          if (data.id > _lastEventId) _lastEventId = data.id
          return
        }
        _events.push(event)
        if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS)
        if (data.id && data.id > _lastEventId) _lastEventId = data.id
        if (data.type === 'chat') {
          console.log(`[chat-recv] id=${data.id} from=${data.from_id||data.from} text=${(data.text||'').substring(0,30)}`)
        }
        notify('messages', event)
      } else if (eventType === 'event-update') {
        const ev = _events.find(e => e._dbId === data.id)
        if (ev) {
          if (data.text !== undefined) ev.text = data.text
          if (data.inline_attachments) ev._inlineAttachments = data.inline_attachments
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
          }
          notify('messages', null)
        }
      } else if (eventType === 'read-receipt') {
        const ids = new Set(data.event_ids || [])
        for (const ev of _events) {
          if (ids.has(ev._dbId)) ev.read = true
        }
        if (ids.size) notify('messages', null)
      } else if (eventType === 'reaper-status') {
        _reaperStatus = data
        notify('reaper', data)
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

  // Fetch initial state + history in parallel
  const [stateRes, historyRes] = await Promise.all([
    fetch(`${FLEET}/api/state`).then(r => r.json()).catch(() => ({})),
    fetch(`${FLEET}/api/chat/history?limit=${MAX_EVENTS}`).then(r => r.json()).catch(() => ({ events: [] })),
  ])

  // Populate agents + tasks
  updateAgents(stateRes.agents || [])
  updateTasks(stateRes.tasks || [])

  // Populate chat events and notify subscribers
  const chatEvents = (historyRes.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session'
    })
    .map(convertChatEvent)
  _events = chatEvents
  // Track highest event ID for reconnect catch-up
  for (const e of historyRes.events || []) {
    if (e.id && e.id > _lastEventId) _lastEventId = e.id
  }
  for (const ev of chatEvents) notify('messages', ev)

  // Connect SSE for live updates
  connect()
}

// --- State updates ---
function updateAgents(agents) {
  _agents = agents
  notify('agents', { type: 'agents', agents })
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
    if (e.metadata?.pending) {
      msg._timerCountdown = true
      msg._timerUntil = e.metadata.fire_at
      msg._timerMessage = e.metadata.message || (e.text || '').replace(/^⏰\s*/, '')
      msg._timerRemaining = Math.max(0, Math.ceil((new Date(e.metadata.fire_at) - Date.now()) / 1000))
    } else {
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
  if (e.metadata?.context?.bullets) {
    msg._bullets = e.metadata.context.bullets
  }
  return msg
}

// --- Chat history helpers ---
// All events (chat + activity) come from the events table via /api/chat/history.
// No separate activity fetch needed.

export async function fetchHistory(agentId, limit = 200) {
  const agentParam = agentId ? `&agent=${encodeURIComponent(agentId)}` : ''
  const res = await fetch(`${FLEET}/api/chat/history?limit=${limit}${agentParam}`).then(r => r.json())

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session'
    })
    .map(convertChatEvent)

  return events.sort((a, b) =>
    (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
  )
}

export async function loadBefore(agentId, beforeTs, count = 100) {
  // Use WebSocket for history to avoid racing with live events.
  // Falls back to HTTP if WS is not connected.
  let res
  if (_ws && _ws.readyState === 1) {
    res = await wsSend({ type: 'load-history', agent: agentId || null, before: beforeTs, limit: count })
  } else {
    const agentParam = agentId ? `&agent=${encodeURIComponent(agentId)}` : ''
    res = await fetch(`${FLEET}/api/chat/history?limit=${count}&before=${encodeURIComponent(beforeTs)}${agentParam}`).then(r => r.json())
  }

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval' || t === 'kill-session'
    })
    .map(convertChatEvent)

  return events.sort((a, b) =>
    (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
  )
}
