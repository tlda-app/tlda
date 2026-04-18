/**
 * fleet.mjs — Fleet HTTP routes for tlda's unified server.
 *
 * Ported from fleet/dashboard/server.mjs.
 * Mounted at / (routes are already prefixed with /api/).
 *
 * createFleetRouter(deps) — factory that returns an Express router.
 * deps: { fleetStore, broadcastEvent, broadcastState, preambleStore }
 */

import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Server owner — the human running this server process. Browser users
// identify themselves via the WS 'identify' message and get their own agent.
const SERVER_OWNER_NAME = process.env.TLDA_USER || os.userInfo().username || 'user'
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_OWNER_HOST = os.hostname()

// All inline tmux operations were removed — they now route through the
// fleet-daemon WS RPC layer (`sendRpc(machineId, op, params)` injected
// from unified-server.mjs). If no daemon is connected for an agent's
// machine, the handler returns 503.

const UPLOAD_DIR = '/tmp/fleet-uploads'

// Minimal multipart/form-data parser for the single-file case used by browser
// drag-and-drop. Returns { filename, contentType, content } for the first
// part that has a filename, or null if none. Body is the raw request buffer.
function extractFirstFilePart(body, boundary) {
  const dashBoundary = Buffer.from(`--${boundary}`)
  const crlfCrlf = Buffer.from('\r\n\r\n')
  let pos = body.indexOf(dashBoundary)
  while (pos !== -1) {
    const headerStart = pos + dashBoundary.length + 2 // skip \r\n after boundary
    const headerEnd = body.indexOf(crlfCrlf, headerStart)
    if (headerEnd === -1) return null
    const headers = body.slice(headerStart, headerEnd).toString('utf8')
    const cd = headers.match(/Content-Disposition:.*?filename="([^"]*)"/i)
    if (cd) {
      const ct = headers.match(/Content-Type:\s*([^\r\n]+)/i)
      const contentStart = headerEnd + crlfCrlf.length
      const nextBoundary = body.indexOf(dashBoundary, contentStart)
      if (nextBoundary === -1) return null
      // The part ends with \r\n before the next boundary marker.
      const contentEnd = nextBoundary - 2
      return {
        filename: cd[1],
        contentType: ct ? ct[1].trim() : 'application/octet-stream',
        content: body.slice(contentStart, contentEnd),
      }
    }
    // Skip to next boundary if this part had no filename.
    const next = body.indexOf(dashBoundary, headerEnd + crlfCrlf.length)
    if (next === -1) return null
    pos = next
  }
  return null
}

function copyAttachment(srcPath) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const name = `${Date.now()}-${path.basename(srcPath)}`
    const dest = path.join(UPLOAD_DIR, name)
    fs.copyFileSync(srcPath, dest)
    return dest
  } catch { return null }
}

export function createFleetRouter({ fleetStore, broadcastEvent, broadcastState, sendRpc, resolveRpc, daemonConnections }) {
  // Helper: route an agent op through the daemon, or 503 cleanly. The
  // op-name is whatever the daemon's rpc dispatcher expects (kebab-case
  // matches the spec: 'send-key', 'capture-pane', etc.).
  async function rpcAgent(res, agent, op, params) {
    const route = resolveRpc(op, agent)
    if (route.via === 'none') {
      res.status(route.code).json({ ok: false, error: route.error })
      return null
    }
    try {
      const result = await sendRpc(route.machine_id, op, params)
      return result
    } catch (e) {
      const code = e.code === 'NO_DAEMON' ? 503 : 502
      res.status(code).json({ ok: false, error: e.message })
      return null
    }
  }

  const router = Router()

  // --- CORS ---
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-filename')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  // --- GET /api/state ---
  router.get('/api/state', (req, res) => {
    if (fleetStore) fleetStore.updateHeartbeat(SERVER_OWNER_ID)
    const agents = fleetStore ? fleetStore.getAllAgents() : []
    const tasks = fleetStore ? fleetStore.getActiveTasks() : []
    res.json({ agents, tasks })
  })

  // --- GET /api/human ---
  // Returns the server owner's identity. Used by MCP agents and CLI tools
  // to know who the "local human" is. Browser users identify via WS 'identify'.
  router.get('/api/human', (req, res) => {
    res.json({ id: SERVER_OWNER_ID, host: SERVER_OWNER_HOST, name: SERVER_OWNER_NAME })
  })

  // --- GET /api/store/events ---
  router.get('/api/store/events', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const afterId = parseInt(req.query.after || '0')
    const beforeId = req.query.before ? parseInt(req.query.before) : null
    const limit = Math.min(parseInt(req.query.limit || '200'), 5000)
    const since = req.query.since || null   // ISO timestamp lower bound
    const until = req.query.until || null   // ISO timestamp upper bound
    const type = req.query.type || null
    const agent = req.query.agent || null
    try {
      let events
      let total = null
      if (agent) {
        // Build WHERE clause with optional time filters
        let where = '(from_id = ? OR to_id = ?)'
        const baseParams = [agent, agent]
        if (since) { where += ' AND timestamp >= ?'; baseParams.push(since) }
        if (until) { where += ' AND timestamp <= ?'; baseParams.push(until) }

        // Total count within the filtered window
        total = fleetStore.db.prepare(
          `SELECT COUNT(*) as n FROM events WHERE ${where}`
        ).get(...baseParams)?.n ?? null

        const q = afterId
          ? `SELECT * FROM events WHERE ${where} AND id > ? ORDER BY id ASC LIMIT ?`
          : beforeId
          ? `SELECT * FROM events WHERE ${where} AND id < ? ORDER BY id DESC LIMIT ?`
          : `SELECT * FROM events WHERE ${where} ORDER BY timestamp ASC LIMIT ?`
        events = afterId
          ? fleetStore.db.prepare(q).all(...baseParams, afterId, limit)
          : beforeId
          ? fleetStore.db.prepare(q).all(...baseParams, beforeId, limit)
          : fleetStore.db.prepare(q).all(...baseParams, limit)
        if (beforeId) events.reverse()
      } else if (type) {
        events = fleetStore.db.prepare(
          'SELECT * FROM events WHERE type = ? AND id > ? ORDER BY id ASC LIMIT ?'
        ).all(type, afterId, limit)
      } else if (beforeId) {
        events = fleetStore.db.prepare(
          'SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?'
        ).all(beforeId, limit)
        events.reverse()
      } else {
        events = fleetStore.getEventsSince(afterId, limit)
      }
      const lastId = fleetStore.getLastEventId()
      res.json({ events, lastId, total })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // --- GET /api/store/agents ---
  router.get('/api/store/agents', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try { res.json(fleetStore.getAllAgents()) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/store/tasks ---
  router.get('/api/store/tasks', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try {
      const active = req.query.active !== 'false'
      res.json(active ? fleetStore.getActiveTasks() : fleetStore.getAllTasks?.() || fleetStore.getActiveTasks())
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/my-task ---
  router.get('/api/my-task', (req, res) => {
    const agentId = req.query.agent
    if (!agentId) { res.status(400).send('missing "agent" param'); return }
    if (fleetStore) fleetStore.updateHeartbeat(agentId)
    const task = fleetStore?.getTaskByAgent(agentId) || null
    const unread = fleetStore?.getUnread(agentId) || []
    const peek = req.query.peek === 'true'
    if (fleetStore && unread.length && !peek) {
      const readIds = fleetStore.markRead(agentId)
      if (readIds.length) broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })
    }
    if (!peek) broadcastState()
    res.json({ task, messages: unread })
  })

  // --- GET /api/chat/history ---
  router.get('/api/chat/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 1000)
    const before = req.query.before || null
    const agent = req.query.agent || null
    try {
      let events = []
      if (fleetStore) {
        const fleetEvents = fleetStore.queryChatHistory({ before, agent, limit: limit + 1 })
        events = fleetEvents.map(e => ({ ...e, event_type: e.type, from: e.from, to: e.to, agent: e.agent_id }))
      }
      const hasMore = events.length > limit
      if (hasMore) events.shift()
      events = events.filter(e => {
        const t = e.text || ''
        return !t.startsWith('<channel') && !t.startsWith('<task-notification') && !t.startsWith('<system-reminder')
      })
      const allAgents = fleetStore ? fleetStore.getAllAgents() : []
      const agentMap = {}
      for (const a of allAgents) agentMap[a.id] = a.friendly_name || a.name || a.id
      agentMap['web'] = agentMap[SERVER_OWNER_ID] || SERVER_OWNER_NAME
      const unreadIds = new Set()
      if (fleetStore) {
        try {
          const rows = fleetStore.db.prepare('SELECT event_id FROM unread WHERE read = 0').all()
          for (const r of rows) unreadIds.add(r.event_id)
        } catch {}
      }
      const resolved = events.map(e => ({
        ...e,
        read: !unreadIds.has(e.id),
        fromLabel: agentMap[e.from] || (e.from ? e.from.substring(0, 8) : ''),
        toLabel: agentMap[e.to] || agentMap[e.agent] || (e.to ? e.to.substring(0, 8) : ''),
      }))
      const nextCursor = hasMore && events.length > 0 ? events[0].timestamp : null
      res.json({ events: resolved, hasMore, nextCursor })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // --- GET /api/roll-call ---
  // Aggregates tmux session lists from every connected fleet-daemon and
  // joins against the agent registry. If a daemon is down, its agents
  // are reported as `tmux_alive: null` (unknown), not dead — we don't
  // mark something dead because we can't reach it.
  router.get('/api/roll-call', async (req, res) => {
    try {
      const agents = fleetStore ? fleetStore.getAllAgents() : []
      const ALIVE_MS = 10 * 60 * 1000
      const now = Date.now()
      const rosterDir = path.join(os.homedir(), '.claude', 'fleet-roster')
      let roster = []
      try {
        if (fs.existsSync(rosterDir)) {
          roster = fs.readdirSync(rosterDir)
            .filter(f => f.endsWith('.json'))
            .map(f => { try { return JSON.parse(fs.readFileSync(path.join(rosterDir, f), 'utf8')) } catch { return null } })
            .filter(Boolean)
        }
      } catch {}

      // Per-machine list-sessions via daemon RPC. Concurrency-safe: each
      // daemon answers its own machine; aggregate the union.
      const tmuxByMachine = new Map() // machine_id -> Set<sessionName>
      const probes = []
      for (const [mid] of daemonConnections) {
        probes.push(
          sendRpc(mid, 'list-sessions', {}).then(r => {
            const sessions = (r?.sessions || []).filter(s => s.startsWith('fleet-'))
            tmuxByMachine.set(mid, new Set(sessions))
          }).catch(() => { tmuxByMachine.set(mid, null) }) // null = unreachable
        )
      }
      await Promise.all(probes)

      const registryIds = new Set(agents.map(a => a.id))
      const allTmuxSessions = new Set()
      for (const set of tmuxByMachine.values()) if (set) for (const s of set) allTmuxSessions.add(s)

      const agentStatus = agents.map(a => {
        const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity
        const heartbeat = lastSeenMs < ALIVE_MS
        let tmuxUp = null
        if (a.tmux_session && a.machine_id) {
          const set = tmuxByMachine.get(a.machine_id)
          tmuxUp = set ? set.has(a.tmux_session) : null
        }
        let status = 'dead'
        if (heartbeat && tmuxUp !== false) status = 'alive'
        else if (heartbeat || tmuxUp) status = 'stale'
        return { ...a, status, heartbeat_alive: heartbeat, tmux_alive: tmuxUp, last_seen_ago_s: lastSeenMs === Infinity ? null : Math.round(lastSeenMs / 1000) }
      })
      const missing = roster.filter(r => !registryIds.has(r.fleet_id))
      const registeredTmux = new Set(agents.filter(a => a.tmux_session).map(a => a.tmux_session))
      const unmatchedTmux = [...allTmuxSessions].filter(s => !registeredTmux.has(s))
      res.json({ agents: agentStatus, missing_from_roster: missing, unregistered_tmux: unmatchedTmux })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/wiretaps ---
  router.get('/api/wiretaps', (req, res) => {
    if (!fleetStore) { res.status(503).send('no store'); return }
    const agent = req.query.agent
    const taps = agent ? fleetStore.getWiretapsByAgent(agent) : fleetStore.getWiretaps()
    res.json(taps)
  })

  // --- GET /api/read-file ---
  router.get('/api/read-file', (req, res) => {
    let filePath = req.query.path
    if (!filePath) { res.status(400).send('Missing path parameter'); return }
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      res.type('text/plain').send(content)
    } catch (e) {
      res.status(404).send(`Could not read file: ${filePath}\n${e.message}`)
    }
  })

  // --- GET /api/file ---
  router.get('/api/file', (req, res) => {
    const filePath = req.query.path
    if (!filePath) { res.status(400).send('Missing path'); return }
    try { res.sendFile(filePath) }
    catch (e) { res.status(404).send(e.message) }
  })

  // --- POST /api/chat ---
  router.post('/api/chat', (req, res) => {
    const { message, to, from, cc, attachments, inline_attachments, context } = req.body || {}
    if (!message && (!attachments || !attachments.length)) { res.status(400).send('missing message'); return }
    if (!to || to === 'undefined' || to === 'null') { res.status(400).send('missing "to"'); return }
    const resolve = (id) => {
      // Server owner shortcut (MCP agents send to SERVER_OWNER_NAME)
      if (id === SERVER_OWNER_NAME) return SERVER_OWNER_ID
      // Try DB lookup — finds agents and humans by ID or friendly_name
      const a = fleetStore?.findAgent(id); return a ? a.id : null
    }
    const sender = from ? (resolve(from) || from) : SERVER_OWNER_ID
    const recipient = resolve(to)
    if (!recipient) { res.status(404).send(`Recipient not found: "${to}"`); return }
    let ccResolved = cc && cc.length ? cc.map(resolve).filter(Boolean) : null
    if (ccResolved && ccResolved.length === 0) ccResolved = null
    // Auto-CC QA agents when a non-human sends to any human
    const recipientAgent = fleetStore?.getAgent(recipient)
    if (recipientAgent?.human && !fleetStore?.getAgent(sender)?.human && fleetStore) {
      const watchers = fleetStore.getAllAgents()
        .filter(a => a.labels?.includes('qa') && a.id !== sender && a.id !== recipient)
        .map(a => a.id)
      if (watchers.length) {
        ccResolved = ccResolved ? [...new Set([...ccResolved, ...watchers])] : watchers
      }
    }
    let processedAttachments = attachments
    if (attachments && attachments.length) {
      processedAttachments = attachments.map(a => {
        if (a.path && fs.existsSync(a.path)) {
          const copied = copyAttachment(a.path)
          if (copied) return { ...a, path: copied, originalPath: a.path }
        }
        return a
      })
    }
    let text = message || ''
    if (fleetStore) fleetStore.updateHeartbeat(SERVER_OWNER_ID)
    // Resolve wiretaps
    let wiretapRecipients = []
    if (fleetStore) {
      const taps = fleetStore.getWiretaps()
      for (const tap of taps) {
        if (!tap.filter) continue
        let matches = false
        try {
          const f = typeof tap.filter === 'string' ? JSON.parse(tap.filter) : tap.filter
          const fromMatch = !f.from || f.from.some(grp => grp.every(t => [sender, ...(fleetStore.findAgent(sender)?.labels || [])].includes(t)))
          const toMatch = !f.to || f.to.some(grp => grp.every(t => [recipient, ...(fleetStore.findAgent(recipient)?.labels || [])].includes(t)))
          matches = fromMatch && toMatch
        } catch {}
        if (matches && tap.agent_id !== sender && tap.agent_id !== recipient) {
          wiretapRecipients.push(tap.agent_id)
        }
      }
    }
    const allRecipients = [...new Set([recipient, ...(ccResolved || []), ...wiretapRecipients])]
    if (fleetStore) {
      const event = fleetStore.share({
        type: 'chat',
        from: sender,
        to: recipient,
        text,
        metadata: {
          cc: ccResolved || undefined,
          attachments: processedAttachments || undefined,
          inline_attachments: inline_attachments || undefined,
          wiretap_cc: wiretapRecipients.length ? wiretapRecipients : undefined,
          context: context || undefined,
        },
      })
      // No manual broadcast — share() already fires the listener that
      // broadcasts via fleetStore.onEvent → broadcastEvent('fleet-event', ...).
      // The previous manual broadcast on top of that produced duplicate
      // messages in receivers.
      res.json({ ok: true, event_id: event?.id })
    } else {
      res.json({ ok: true })
    }
  })

  // --- POST /api/tasks/delegate ---
  router.post('/api/tasks/delegate', (req, res) => {
    const { from: rawFrom, agent: agentQuery, description, message, success_criteria, blocked_by } = req.body || {}
    if (!agentQuery || !description) { res.status(400).send('missing "agent" or "description"'); return }
    const resolvedAgent = fleetStore?.findAgent(agentQuery)
    if (!resolvedAgent) { res.status(404).send(`Agent not found: "${agentQuery}"`); return }
    const agentId = resolvedAgent.id
    const from = rawFrom ? (fleetStore?.findAgent(rawFrom)?.id || rawFrom) : null
    const taskId = `${agentId.slice(0, 10)}-${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const task = {
      id: taskId, agent: agentId, description,
      message: message || description,
      delegated_by: from || null, delegated_at: now,
      status: blocked_by?.length ? 'blocked' : 'pending',
      acknowledged: false,
      blockedBy: blocked_by || undefined,
      success_criteria: success_criteria || undefined,
    }
    if (fleetStore) {
      fleetStore.upsertTask(task)
      fleetStore.delegate(from, agentId, taskId, description, {
        fromLabel: fleetStore.getAgent?.(from)?.friendly_name || from,
        toLabel: resolvedAgent.friendly_name || agentId,
        criteria: success_criteria || [],
      })
    }
    broadcastState()
    res.json({ ok: true, task_id: taskId })
  })

  // --- POST /api/tasks/done ---
  router.post('/api/tasks/done', (req, res) => {
    const { agent: rawAgent, task_id, skip_qa } = req.body || {}
    if (!rawAgent) { res.status(400).send('missing "agent"'); return }
    const agent = fleetStore?.findAgent(rawAgent)?.id || rawAgent
    const task = task_id ? fleetStore?.getTask(task_id) : fleetStore?.getTaskByAgent(agent)
    if (!task) { res.status(404).send('no active task'); return }
    if (!skip_qa && fleetStore) {
      const qaIds = fleetStore.getQaAgentIds?.() || []
      if (qaIds.length > 0) {
        const qaStatus = fleetStore.getQaStatus?.(task.id)
        if (qaStatus?.status === 'no_report') { res.status(403).json({ ok: false, error: 'Submit a report() first' }); return }
        if (qaStatus?.status === 'rejected') { res.status(403).json({ ok: false, error: `QA rejected: ${qaStatus.notes || 'no details'}` }); return }
        if (qaStatus?.status === 'pending') { res.status(403).json({ ok: false, error: `Waiting for QA sign-off` }); return }
      }
    }
    task.status = 'done'
    task.completed_at = new Date().toISOString()
    if (fleetStore) { fleetStore.upsertTask(task); fleetStore.taskDone?.(agent, task.id, task.description) }
    broadcastState()
    res.json({ ok: true, task_id: task.id })
  })

  // --- POST /api/tasks/delete ---
  router.post('/api/tasks/delete', (req, res) => {
    const { task_id } = req.body || {}
    if (!task_id) { res.status(400).send('missing task_id'); return }
    const task = fleetStore?.getTask?.(task_id)
    if (!task) { res.status(404).send('task not found'); return }
    fleetStore?.removeTask?.(task_id)
    broadcastState()
    res.json({ ok: true, task_id })
  })

  // --- POST /api/spawn ---
  // Spawn or respawn an agent via the fleet daemon RPC.
  // Body: { model?, doc?, name?, agent?, respawn? }
  // doc: project name — daemon resolves to sourceDir for the cwd
  // For respawn: { agent: "fleet:xxx" or "name", respawn: true }
  router.post('/api/spawn', async (req, res) => {
    const { name, model, doc, agent, respawn } = req.body || {}
    // For respawn, resolve agent to a name
    let spawnName = name
    if (respawn && agent) {
      const a = fleetStore?.findAgent(agent)
      spawnName = a?.friendly_name || agent
    }
    // Find a daemon to route to — use the local machine
    const machineIds = [...daemonConnections.keys()]
    if (machineIds.length === 0) {
      res.status(503).json({ error: 'No fleet daemon connected — cannot spawn agents' })
      return
    }
    try {
      const result = await sendRpc(machineIds[0], 'spawn', {
        name: spawnName || undefined,
        model: model || undefined,
        doc: doc || undefined,
        respawn: !!respawn,
      })
      broadcastState()
      res.json(result)
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // --- POST /api/kick ---
  // Kick = touch a signal file inside the agent's machine's ~/.fleet/signals.
  // Routed through the daemon so the file lands on the right host. The
  // server still emits the broadcast itself.
  router.post('/api/kick', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const result = await rpcAgent(res, agent, 'kick', { agent_id: agent.id })
    if (result === null) return // rpcAgent already wrote the response
    broadcastEvent('fleet-event', { type: 'kick', to: agent.id, from: SERVER_OWNER_ID, text: 'manual kick' })
    res.json(result)
  })

  // --- POST /api/interrupt ---
  // Two-phase: kick the agent immediately so the caller can move on, then
  // let the daemon do the polled re-interrupt loop in the background.
  router.post('/api/interrupt', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.json({ ok: false, error: 'no tmux session' }); return }
    const result = await rpcAgent(res, agent, 'interrupt', {
      agent_id: agent.id, tmux_session: agent.tmux_session,
    })
    if (result === null) return
    res.json({ ok: true, agent: agent.friendly_name || agent.id, ...result })
  })

  // --- POST /api/rename ---
  router.post('/api/rename', (req, res) => {
    const { agent: agentQuery, name: newName } = req.body || {}
    if (!agentQuery || newName == null) { res.status(400).json({ error: 'agent and name required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (newName) {
      const allAgents = fleetStore ? fleetStore.getAllAgents() : []
      const usedNames = new Set([SERVER_OWNER_NAME, ...allAgents.filter(a => a.id !== agent.id).map(a => a.friendly_name).filter(Boolean)])
      if (usedNames.has(newName)) { res.status(400).json({ error: `Name "${newName}" already in use` }); return }
    }
    agent.friendly_name = newName || undefined
    if (fleetStore) fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, name: newName })
  })

  // --- POST /api/label ---
  router.post('/api/label', (req, res) => {
    const { agent: agentQuery, labels } = req.body || {}
    if (!agentQuery || !Array.isArray(labels)) { res.status(400).json({ error: 'agent and labels[] required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const allAgents = fleetStore ? fleetStore.getAllAgents() : []
    const usedNames = new Set([SERVER_OWNER_NAME, ...allAgents.map(a => a.friendly_name).filter(Boolean)])
    const conflicts = labels.filter(l => usedNames.has(l) && l !== agent.friendly_name)
    if (conflicts.length) { res.status(400).json({ error: `Label(s) conflict with agent name(s): ${conflicts.join(', ')}` }); return }
    agent.labels = labels
    if (fleetStore) fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, labels })
  })

  // --- POST /api/send-key ---
  router.post('/api/send-key', async (req, res) => {
    const { agent: agentQuery, key } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    const result = await rpcAgent(res, agent, 'send-key', { tmux_session: agent.tmux_session, key })
    if (result !== null) res.json(result)
  })

  // --- POST /api/send-text ---
  router.post('/api/send-text', async (req, res) => {
    const { agent: agentQuery, text, enter } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    const result = await rpcAgent(res, agent, 'send-text', {
      tmux_session: agent.tmux_session, text, enter: enter !== false,
    })
    if (result !== null) res.json(result)
  })

  // --- POST /api/capture-pane ---
  // One-shot capture for terminal cards. Live-watching is the separate
  // start/stop-terminal-watch RPC pair.
  router.post('/api/capture-pane', async (req, res) => {
    const { agent: agentQuery, lines } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    const result = await rpcAgent(res, agent, 'capture-pane', {
      tmux_session: agent.tmux_session, lines: lines || 50,
    })
    if (result !== null) res.json(result)
  })

  // --- POST /api/restart-mcp ---
  router.post('/api/restart-mcp', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    const result = await rpcAgent(res, agent, 'restart-mcp', { tmux_session: agent.tmux_session })
    if (result !== null) res.json(result)
  })

  // --- POST /api/restart-my-mcp ---
  // Agents call this to restart their OWN fleet MCP out-of-band (can't use
  // the MCP tool for self-restart). Returns 202 immediately so the agent's
  // bash subprocess finishes and Claude Code is back in the foreground before
  // the daemon sends keystrokes to the session.
  // body: { agent: <id|name> }
  router.post('/api/restart-my-mcp', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    // Respond immediately — the daemon restart must happen AFTER the agent's
    // HTTP request finishes so Claude Code has re-acquired the terminal.
    res.status(202).json({ ok: true, message: 'restart scheduled' })
    // 1.5s grace: enough time for the HTTP response to arrive, the bash tool
    // to complete, and Claude Code to be back at the prompt before we type /mcp.
    await new Promise(r => setTimeout(r, 1500))
    const route = resolveRpc('restart-mcp', agent)
    if (route.via === 'none') {
      console.error(`restart-my-mcp: no daemon route for ${agent.id}: ${route.error}`)
      return
    }
    try {
      await sendRpc(route.machine_id, 'restart-mcp', {
        tmux_session: agent.tmux_session,
        skipPreflight: true,
      })
      // Notify the agent so it sees 📬 and resumes — the /mcp navigation
      // left Claude Code in an interrupted state.
      if (fleetStore) {
        fleetStore.share({
          type: 'chat',
          from: SERVER_OWNER_ID,
          to: agent.id,
          text: 'Fleet MCP restarted. Resume your task.',
        })
      }
    } catch (e) {
      console.error(`restart-my-mcp daemon call failed: ${e.message}`)
    }
  })

  // --- POST /api/plan-mode-respond ---
  // Responds to a plan-mode approval prompt for an agent.
  // body: { agent: <id|name>, response: 'approve' | 'reject' }
  // 'approve' sends key '1' + Enter (Yes, auto-accept edits)
  // 'reject' sends Escape (dismiss / let user decide later)
  router.post('/api/plan-mode-respond', async (req, res) => {
    const { agent: agentQuery, response } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    if (response !== 'approve' && response !== 'reject') {
      res.status(400).json({ error: 'response must be approve or reject' }); return
    }
    // For approve: send '1' then Enter (selects "Yes, auto-accept edits")
    // For reject: send Escape (dismiss the prompt)
    if (response === 'approve') {
      const r1 = await rpcAgent(res, agent, 'send-text', { tmux_session: agent.tmux_session, text: '1', enter: true })
      if (r1 !== null) {
        fleetStore?.updateAgentMeta(agent.id, { permission_mode: null })
        broadcastState()
        res.json(r1)
      }
    } else {
      const r1 = await rpcAgent(res, agent, 'send-key', { tmux_session: agent.tmux_session, key: 'Escape' })
      if (r1 !== null) {
        fleetStore?.updateAgentMeta(agent.id, { permission_mode: null })
        broadcastState()
        res.json(r1)
      }
    }
  })

  // --- POST /api/plan-mode-toggle ---
  // Enters plan mode by reading the current mode then sending the right number
  // of Shift+Tab (BTab) presses to land on plan mode.
  // Cycle: default → accept-edits → plan → default
  // body: { agent: <id|name> }
  router.post('/api/plan-mode-toggle', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }

    const route = resolveRpc('capture-pane', agent)
    if (route.via === 'none') { res.status(503).json({ ok: false, error: route.error }); return }

    const parseCCMode = (pane) => {
      if (/plan mode on/i.test(pane)) return 'plan'
      if (/accept edits on/i.test(pane)) return 'acceptEdits'
      if (/auto.approve/i.test(pane) || /bypass/i.test(pane)) return 'auto'
      return 'default'
    }

    try {
      // Capture current mode
      const cap1 = await sendRpc(route.machine_id, 'capture-pane', { tmux_session: agent.tmux_session, lines: 5 })
      const currentMode = parseCCMode(cap1?.content || '')

      // Toggle: if in plan mode exit to default (1 BTab); otherwise enter plan mode.
      // Cycle: default → acceptEdits → plan → default
      const btabs = currentMode === 'plan' ? 1 : currentMode === 'acceptEdits' ? 1 : 2

      for (let i = 0; i < btabs; i++) {
        await sendRpc(route.machine_id, 'send-key', { tmux_session: agent.tmux_session, key: 'BTab' })
        if (i < btabs - 1) await new Promise(r => setTimeout(r, 150))
      }

      // Confirm final mode
      if (btabs > 0) await new Promise(r => setTimeout(r, 300))
      const cap2 = await sendRpc(route.machine_id, 'capture-pane', { tmux_session: agent.tmux_session, lines: 5 })
      const finalMode = parseCCMode(cap2?.content || '')

      // Store permission mode in agent metadata so UI can show persistent badge
      fleetStore?.updateAgentMeta(agent.id, { permission_mode: finalMode === 'default' ? null : finalMode })
      broadcastState()

      res.json({ ok: true, mode: finalMode, was: currentMode })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // --- POST /api/upload ---
  // Accepts two payload shapes:
  //   1. Raw binary body with x-filename header (used by MCP screenshot
  //      uploads that go through node-fetch directly).
  //   2. multipart/form-data with a single `file` field (used by browser
  //      drag-and-drop into chat). Parsed inline — we don't pull in multer
  //      just to extract one part.
  router.post('/api/upload', (req, res) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        let body = Buffer.concat(chunks)
        let origName = req.headers['x-filename']
          ? decodeURIComponent(req.headers['x-filename'])
          : null

        // Multipart path: extract the first file part's filename + content.
        const ct = req.headers['content-type'] || ''
        if (ct.startsWith('multipart/form-data')) {
          const m = ct.match(/boundary="?([^";]+)"?/)
          if (!m) { res.status(400).json({ error: 'multipart boundary missing' }); return }
          const part = extractFirstFilePart(body, m[1])
          if (!part) { res.status(400).json({ error: 'no file part in multipart body' }); return }
          body = part.content
          if (!origName && part.filename) origName = part.filename
        }

        let name
        if (origName) {
          name = `${Date.now()}-${origName}`
        } else {
          let ext = 'png'
          if (body[0] === 0xFF && body[1] === 0xD8) ext = 'jpg'
          else if (body[0] === 0x47 && body[1] === 0x49) ext = 'gif'
          else if (body[0] === 0x52 && body[1] === 0x49) ext = 'webp'
          else if (body[0] === 0x3C) {
            const head = body.slice(0, 256).toString('utf8')
            if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))) ext = 'svg'
          }
          name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        }
        const filePath = path.join(UPLOAD_DIR, name)
        fs.writeFileSync(filePath, body)
        res.json({ name, path: filePath, url: `/api/file?path=${encodeURIComponent(filePath)}` })
      } catch (e) { res.status(500).json({ error: e.message }) }
    })
  })

  // --- POST /api/fleet-event ---
  router.post('/api/fleet-event', (req, res) => {
    const event = req.body
    if (event && event.type) {
      broadcastEvent('fleet-event', event)
    }
    res.json({ ok: true })
  })

  // --- POST /api/fleet/resync-machine-ids ---
  // One-shot migration helper for the fleet-daemon cutover. After the
  // server upgrade, every existing alive agent has machine_id = NULL
  // because their fleet MCP register payload pre-dates the new field.
  // Until each agent re-registers (which happens automatically on next
  // session start, but Skip's long-running ones won't), their RPCs
  // return 503 from the daemon-routing path.
  //
  // This endpoint walks all live agents with machine_id IS NULL and
  // sets it to a single value — defaulting to this server's hostname.
  // Single-machine assumption is fine for now; multi-user is future work.
  // Pass `?machine_id=foo` to override.
  //
  // Not a backwards-compat shim — this is a migration aid the manager
  // explicitly asked for. Run once after deploying the new server,
  // then forget about it.
  router.post('/api/fleet/resync-machine-ids', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'no fleet store' }); return }
    const machineId = (req.query.machine_id || os.hostname().split('.')[0]).toString()
    const agents = fleetStore.getAllAgents().filter(a => !a.dead && !a.machine_id)
    const updated = []
    for (const a of agents) {
      try {
        fleetStore.upsertAgent({ ...a, machine_id: machineId })
        updated.push({ id: a.id, name: a.friendly_name || null })
      } catch (e) {
        // Don't fail the whole batch on one bad row.
        console.error(`[resync] ${a.id}: ${e.message}`)
      }
    }
    broadcastState()
    res.json({ ok: true, machine_id: machineId, updated_count: updated.length, updated })
  })

  // --- POST /api/agent-status ---
  router.post('/api/agent-status', (req, res) => {
    const { agent: rawAgent, state, tool } = req.body || {}
    if (!rawAgent || !state) { res.status(400).send('missing agent or state'); return }
    const agent = fleetStore?.findAgent(rawAgent)?.id || rawAgent
    const ts = new Date().toISOString()
    if (fleetStore) fleetStore.updateAgentStatus?.(agent, state, tool || null, ts)
    broadcastEvent('agent-status', { agent, state, tool: tool || null, ts })
    res.json({ ok: true })
  })

  // --- POST /api/mark-event-read ---
  // Mark a single event read for a recipient. Used by terminal-card
  // dismissal so the dismissed card doesn't auto-pop again on reload.
  // Body: { event_id, agent }
  router.post('/api/mark-event-read', (req, res) => {
    const { event_id, agent: rawAgent } = req.body || {}
    if (!event_id || !rawAgent) { res.status(400).json({ error: 'event_id and agent required' }); return }
    const agent = fleetStore?.findAgent(rawAgent)
    const agentId = agent?.id || rawAgent
    const changed = fleetStore?.markEventRead?.(parseInt(event_id, 10), agentId)
    if (changed) {
      broadcastEvent('read-receipt', { event_ids: [parseInt(event_id, 10)], agent: agentId })
    }
    res.json({ ok: true, changed: !!changed })
  })

  // --- POST /api/terminal-card ---
  // Voluntary terminal-card request: an agent asks Skip to look at their
  // terminal — e.g., "I'm stuck on a permission prompt" or "please paste
  // this command into my session". The browser-side fleet chat listens for
  // `terminal_card` events and pops a TerminalCard for `from`.
  //
  // The involuntary equivalent is `terminal_attention`, fired by the
  // attention scanner when the watcher detects a stuck agent without the
  // agent's involvement. They render the same UI; only the trigger differs.
  router.post('/api/terminal-card', (req, res) => {
    const { from: rawFrom, reason } = req.body || {}
    if (!rawFrom) { res.status(400).json({ error: 'missing "from"' }); return }
    const agent = fleetStore?.findAgent(rawFrom)
    if (!agent) { res.status(404).json({ error: `Agent not found: "${rawFrom}"` }); return }
    if (!agent.tmux_session) {
      res.status(400).json({ error: 'agent has no tmux_session — cannot attach terminal' })
      return
    }
    if (!agent.machine_id) {
      res.status(400).json({ error: 'agent has no machine_id — fleet daemon not registered' })
      return
    }
    const label = agent.friendly_name || agent.id.slice(0, 12)
    const text = reason ? `${label}: ${reason}` : `${label}: terminal requested`
    const event = fleetStore?.share({
      type: 'terminal_card',
      from: agent.id,
      to: SERVER_OWNER_ID,
      text,
      metadata: JSON.stringify({
        reason: reason || null,
        agentId: agent.id,
        agentLabel: label,
      }),
    })
    broadcastEvent('fleet-event', {
      type: 'terminal_card',
      from: agent.id,
      to: SERVER_OWNER_ID,
      id: event?.id,
      event_id: event?.id,
      text,
      metadata: { reason: reason || null, agentId: agent.id, agentLabel: label },
    })
    res.json({ ok: true, event_id: event?.id })
  })

  // --- POST /api/cleanup ---
  // Same logic as roll-call: aggregate tmux session lists from every
  // connected daemon, then mark agents dead if they're stale on both
  // heartbeat AND tmux. An agent whose machine has no daemon connected
  // is treated as having unknown tmux state — we don't kill it just
  // because we can't see it.
  router.post('/api/cleanup', async (req, res) => {
    try {
      const agents = fleetStore ? fleetStore.getAllAgents() : []
      const tasks = fleetStore ? fleetStore.getActiveTasks() : []
      const ALIVE_MS = 10 * 60 * 1000
      const now = Date.now()

      const tmuxByMachine = new Map()
      const probes = []
      for (const [mid] of daemonConnections) {
        probes.push(
          sendRpc(mid, 'list-sessions', {}).then(r => {
            tmuxByMachine.set(mid, new Set((r?.sessions || []).filter(s => s.startsWith('fleet-'))))
          }).catch(() => { tmuxByMachine.set(mid, null) })
        )
      }
      await Promise.all(probes)

      const removed = [], orphaned = [], deadAgentIds = new Set()
      for (const a of agents) {
        const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity
        const heartbeatAlive = lastSeenMs < ALIVE_MS
        let tmuxAlive = false
        if (a.tmux_session && a.machine_id) {
          const set = tmuxByMachine.get(a.machine_id)
          // Unknown (set === null or undefined) → treat as alive to be safe.
          tmuxAlive = set ? set.has(a.tmux_session) : true
        }
        if (!heartbeatAlive && !tmuxAlive && !a.human) {
          deadAgentIds.add(a.id)
          removed.push({ id: a.id, name: a.friendly_name || a.name })
        }
      }
      for (const id of deadAgentIds) { if (fleetStore) fleetStore.markDead?.(id) }
      for (const t of tasks) {
        if (t.status !== 'done' && !t.synthetic && deadAgentIds.has(t.agent)) {
          t.status = 'done'; t.completed_at = new Date().toISOString()
          if (fleetStore) fleetStore.upsertTask(t)
          orphaned.push({ id: t.id, agent: t.agent, description: t.description })
        }
      }
      broadcastState()
      res.json({ ok: true, removed_agents: removed, abandoned_tasks: orphaned, remaining_agents: agents.length - removed.length })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- POST /api/wiretap ---
  router.post('/api/wiretap', (req, res) => {
    if (!fleetStore) { res.status(503).send('no store'); return }
    const { agent, filter } = req.body || {}
    if (!agent) { res.status(400).send('missing agent'); return }
    if (!filter) { res.status(400).send('missing filter'); return }
    const tap = fleetStore.addWiretap(agent, filter)
    res.json(tap)
  })

  // --- DELETE /api/wiretap/:id ---
  router.delete('/api/wiretap/:id', (req, res) => {
    if (!fleetStore) { res.status(503).send('no store'); return }
    const id = parseInt(req.params.id)
    if (isNaN(id)) { res.status(400).send('invalid id'); return }
    fleetStore.removeWiretap(id)
    res.json({ ok: true })
  })

  // --- GET /api/shared-docs ---
  router.get('/api/shared-docs', (req, res) => {
    const docs = fleetStore?.db?.prepare('SELECT * FROM shared_docs ORDER BY updated_at DESC').all() || []
    res.json(docs)
  })

  // --- POST /api/shared-docs ---
  router.post('/api/shared-docs', (req, res) => {
    const { doc, path: docPath, title, agent, ephemeral } = req.body || {}
    if (!doc) { res.status(400).send('missing doc'); return }
    const now = new Date().toISOString()
    if (fleetStore) {
      fleetStore.db.prepare(`
        INSERT INTO shared_docs (doc, path, title, agent, ephemeral, shared_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc) DO UPDATE SET path=excluded.path, title=excluded.title, agent=excluded.agent, ephemeral=excluded.ephemeral, updated_at=excluded.updated_at
      `).run(doc, docPath || null, title || null, agent || null, ephemeral ? 1 : 0, now, now)
    }
    res.json({ ok: true })
  })

  // --- POST /api/retract ---
  router.post('/api/retract', (req, res) => {
    const { agent: rawAgent, task_id } = req.body || {}
    if (!rawAgent) { res.status(400).send('missing agent'); return }
    const agent = fleetStore?.findAgent(rawAgent)?.id || rawAgent
    const task = task_id ? fleetStore?.getTask?.(task_id) : fleetStore?.getTaskByAgent(agent)
    if (!task) { res.status(404).send('no active task'); return }
    fleetStore?.removeTask?.(task.id)
    broadcastState()
    res.json({ ok: true, task_id: task.id })
  })

  // --- GET /api/health ---
  router.get('/api/health', (req, res) => {
    res.json({ ok: true, fleet: 'embedded', store: fleetStore ? 'up' : 'down' })
  })

  return router
}
