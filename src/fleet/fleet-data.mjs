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

// --- Stores ---
let _agents = []
let _tasks = []
let _events = []          // chat + lifecycle (delegate, task_done) — capped at MAX_EVENTS
const MAX_EVENTS = 500    // keep only the most recent N events in memory; older events fetched from DB on scroll
// Activity events are now stored in the events table (type='activity')
// and flow through the same channel as chat — no separate store needed.
let _humanId = null
let _lastEventId = 0
const _preambles = {}     // target → { macro: definition }

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
  // Terminal attention events (permission prompts) bypass filters — they're urgent
  if (event._evType === 'terminal_attention' || event.type === 'terminal_attention') return true
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
    if (_humanId && agentId === _humanId) return ['skip', _humanId].includes(label)
    return false
  }
  const labels = [...(agent.labels || []), agent.friendly_name, agent.id].filter(Boolean)
  return labels.includes(label)
}

// Resolve a DNF filter to set of agent IDs that match any clause.
// Handles both [role, label] tuple terms and plain string terms.
function resolveFilter(filter) {
  if (!filter) return new Set()
  const ids = new Set()
  const allAgents = [..._agents]
  if (_humanId) allAgents.push({ id: _humanId, friendly_name: 'skip', labels: ['skip'] })
  for (const a of allAgents) {
    const labels = [...(a.labels || []), a.friendly_name, a.id].filter(Boolean)
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
export function getAgents() { return _agents }
export function getTasks() { return _tasks }
export function getEvents() { return _events }
export function getActivity(agentId) { return _events.filter(e => e._activity && e.agent === agentId) }
export function getHumanId() { return _humanId }
export function getPreambleMacros(target = 'default') { return _preambles[target] || {} }

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
  const body = { message: text, to }
  if (opts.raw) body._raw = true
  if (opts.attachments) body.attachments = opts.attachments
  if (opts.cc) body.cc = opts.cc
  if (opts.context) body.context = opts.context
  const _t0 = performance.now()
  const resp = fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  resp.then(r => r.json()).then(d => {
    console.log(`[chat-send] to=${to} id=${d.event_id} fetch=${Math.round(performance.now()-_t0)}ms text=${text.substring(0,30)}`)
  }).catch(() => {
    console.log(`[chat-send] to=${to} FAILED fetch=${Math.round(performance.now()-_t0)}ms`)
  })
  return resp
}

export async function respawnAgent(id) {
  return fetch('/api/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: id, respawn: true }),
  })
}

export async function spawnAgent(model) {
  return fetch('/api/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
}

export async function renameAgent(id, name) {
  return fetch('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: id, name }),
  })
}

export async function setAgentLabels(id, labels) {
  return fetch('/api/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: id, labels }),
  })
}

export async function kickAgent(id) {
  return fetch('/api/kick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: id }),
  })
}

export async function sendKey(session, key) {
  return fetch('/api/send-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, key }),
  })
}

export async function sendText(session, text) {
  return fetch('/api/send-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, text }),
  })
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

export function connect() {
  if (_ws) return
  const params = new URLSearchParams(location.search)
  const token = params.get('token')
  const wsUrl = location.origin.replace(/^http/, 'ws') + '/ws/fleet' + (token ? `?token=${token}` : '')
  _ws = new WebSocket(wsUrl)

  _ws.onopen = () => {
    _reconnectDelay = 1000
    _connected = true
    notify('connection', { type: 'connection', connected: true })
    // Always do a full state refresh on reconnect — not just catch-up.
    // This ensures agents/tasks are populated even if the initial load failed
    // or the server restarted and event IDs reset.
    fetch('/api/state').then(r => r.json()).then(s => {
      updateAgents(s.agents || [])
      updateTasks(s.tasks || [])
    }).catch(() => {})
    // Catch up on missed chat events
    if (_lastEventId > 0) {
      fetch(`/api/store/events?after=${_lastEventId}&limit=500`)
        .then(r => r.json())
        .then(data => {
          const missed = (data.events || []).filter(e => {
            const t = e.type || e.event_type
            return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_attention'
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
        // Preamble macros for KaTeX rendering
        if (data.type === 'preamble' && data.macros) {
          _preambles[data.target || 'default'] = data.macros
          return
        }
        const event = convertChatEvent(data)
        _events.push(event)
        if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS)
        if (data.id && data.id > _lastEventId) _lastEventId = data.id
        if (data.type === 'chat') {
          console.log(`[chat-recv] id=${data.id} from=${data.from_id||data.from} text=${(data.text||'').substring(0,30)}`)
        }
        notify('messages', event)
      } else if (eventType === 'read-receipt') {
        const ids = new Set(data.event_ids || [])
        for (const ev of _events) {
          if (ids.has(ev._dbId)) ev.read = true
        }
        if (ids.size) notify('messages', null)
      } else if (eventType === 'agent-thinking') {
        if (data.agent) notify('thinking', data)
      } else if (eventType === 'agent-compacting') {
        if (data.agent) notify('compacting', data)
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
  // Fetch human identity
  try {
    const res = await fetch('/api/human')
    if (res.ok) {
      const data = await res.json()
      _humanId = data.id || null
    }
  } catch {}

  // Fetch initial state + history + preambles in parallel
  const [stateRes, historyRes, preambleRes] = await Promise.all([
    fetch('/api/state').then(r => r.json()).catch(() => ({})),
    fetch('/api/chat/history?limit=500').then(r => r.json()).catch(() => ({ events: [] })),
    fetch('/api/preamble').then(r => r.json()).catch(() => ({})),
  ])
  // Load preamble macros
  Object.assign(_preambles, preambleRes)

  // Populate agents + tasks
  updateAgents(stateRes.agents || [])
  updateTasks(stateRes.tasks || [])

  // Populate chat events and notify subscribers
  const chatEvents = (historyRes.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention'
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

function convertChatEvent(e) {
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
    msg._toolName = tool === '_text' ? null : tool
    msg._isText = tool === '_text'
    msg._text = tool === '_text' ? (e.metadata?.arg || e.text) : null
    msg._toolArg = e.metadata?.arg || ''
    msg._toolInput = e.metadata?.input || null
    msg._toolDetail = e.metadata?.input ? toolContentDetail(tool === '_text' ? null : tool, e.metadata.input) : null
    msg.agent = msg.from
    if (msg._isText) msg.text = e.metadata?.arg || e.text
  }
  if (e.metadata?.inline_attachments) {
    msg._inlineAttachments = e.metadata.inline_attachments
  }
  if (e.metadata?.attachments) {
    msg.attachments = e.metadata.attachments
  }
  return msg
}

// --- Chat history helpers ---
// All events (chat + activity) come from the events table via /api/chat/history.
// No separate activity fetch needed.

export async function fetchHistory(agentId, limit = 200) {
  const agentParam = agentId ? `&agent=${encodeURIComponent(agentId)}` : ''
  const res = await fetch(`/api/chat/history?limit=${limit}${agentParam}`).then(r => r.json())

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention'
    })
    .map(convertChatEvent)

  return events.sort((a, b) =>
    (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
  )
}

export async function loadBefore(agentId, beforeTs, count = 100) {
  const agentParam = agentId ? `&agent=${encodeURIComponent(agentId)}` : ''
  const res = await fetch(`/api/chat/history?limit=${count}&before=${encodeURIComponent(beforeTs)}${agentParam}`).then(r => r.json())

  const events = (res.events || [])
    .filter(e => {
      const t = e.event_type || e.type
      return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'terminal_user' || t === 'terminal_assistant' || t === 'timer' || t === 'compacting' || t === 'activity' || t === 'terminal_attention'
    })
    .map(convertChatEvent)

  return events.sort((a, b) =>
    (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
  )
}
