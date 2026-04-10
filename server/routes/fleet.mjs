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
import crypto from 'crypto'
import { execSync } from 'child_process'

const HUMAN_FLEET_ID = 'fleet:skip'
const HUMAN_NAME = 'skip'
const HUMAN_HOST = os.hostname()

const UPLOAD_DIR = '/tmp/fleet-uploads'

function copyAttachment(srcPath) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const name = `${Date.now()}-${path.basename(srcPath)}`
    const dest = path.join(UPLOAD_DIR, name)
    fs.copyFileSync(srcPath, dest)
    return dest
  } catch { return null }
}

function touchSignalFile(agentId) {
  const signalDir = path.join(os.homedir(), '.fleet', 'signals')
  try {
    fs.mkdirSync(signalDir, { recursive: true })
    const file = path.join(signalDir, agentId.replace(/[^a-zA-Z0-9_-]/g, '_'))
    fs.writeFileSync(file, Date.now().toString())
    return { ok: true, signal: file }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export function createFleetRouter({ fleetStore, broadcastEvent, broadcastState, preambleStore }) {
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
    if (fleetStore) fleetStore.updateHeartbeat(HUMAN_FLEET_ID)
    const agents = fleetStore ? fleetStore.getAllAgents() : []
    const tasks = fleetStore ? fleetStore.getActiveTasks() : []
    res.json({ agents, tasks })
  })

  // --- GET /api/human ---
  router.get('/api/human', (req, res) => {
    res.json({ id: HUMAN_FLEET_ID, host: HUMAN_HOST, name: HUMAN_NAME })
  })

  // --- GET /api/preamble ---
  router.get('/api/preamble', (req, res) => {
    res.json(preambleStore)
  })

  // --- GET /api/store/events ---
  router.get('/api/store/events', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const afterId = parseInt(req.query.after || '0')
    const beforeId = req.query.before ? parseInt(req.query.before) : null
    const limit = Math.min(parseInt(req.query.limit || '100'), 500)
    const type = req.query.type || null
    const agent = req.query.agent || null
    try {
      let events
      if (agent) {
        const q = afterId
          ? 'SELECT * FROM events WHERE (from_id = ? OR to_id = ?) AND id > ? ORDER BY id ASC LIMIT ?'
          : beforeId
          ? 'SELECT * FROM events WHERE (from_id = ? OR to_id = ?) AND id < ? ORDER BY id DESC LIMIT ?'
          : 'SELECT * FROM events WHERE (from_id = ? OR to_id = ?) ORDER BY id DESC LIMIT ?'
        events = afterId
          ? fleetStore.db.prepare(q).all(agent, agent, afterId, limit)
          : beforeId
          ? fleetStore.db.prepare(q).all(agent, agent, beforeId, limit)
          : fleetStore.db.prepare(q).all(agent, agent, limit)
        if (!afterId) events.reverse()
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
      res.json({ events, lastId })
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
      agentMap['web'] = agentMap[HUMAN_FLEET_ID] || HUMAN_NAME
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
  router.get('/api/roll-call', (req, res) => {
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
      let tmuxSessions = new Set()
      try {
        const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8', timeout: 3000 })
        for (const s of out.trim().split('\n').filter(Boolean)) {
          if (s.startsWith('fleet-')) tmuxSessions.add(s)
        }
      } catch {}
      const registryIds = new Set(agents.map(a => a.id))
      const agentStatus = agents.map(a => {
        const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity
        const heartbeat = lastSeenMs < ALIVE_MS
        const tmuxUp = a.tmux_session ? tmuxSessions.has(a.tmux_session) : null
        let status = 'dead'
        if (heartbeat && tmuxUp !== false) status = 'alive'
        else if (heartbeat || tmuxUp) status = 'stale'
        return { ...a, status, heartbeat_alive: heartbeat, tmux_alive: tmuxUp, last_seen_ago_s: lastSeenMs === Infinity ? null : Math.round(lastSeenMs / 1000) }
      })
      const missing = roster.filter(r => !registryIds.has(r.fleet_id))
      const registeredTmux = new Set(agents.filter(a => a.tmux_session).map(a => a.tmux_session))
      const unmatchedTmux = [...tmuxSessions].filter(s => !registeredTmux.has(s))
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
    const filePath = req.query.path
    if (!filePath) { res.status(400).send('Missing path parameter'); return }
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      res.type('text/plain').send(content)
    } catch (e) {
      res.status(404).send(`Could not read file: ${e.message}`)
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
    const { message, to, from, cc, attachments, inline_attachments } = req.body || {}
    if (!message && (!attachments || !attachments.length)) { res.status(400).send('missing message'); return }
    if (!to || to === 'undefined' || to === 'null') { res.status(400).send('missing "to"'); return }
    const resolve = (id) => { const a = fleetStore?.findAgent(id); return a ? a.id : null }
    const sender = from ? (resolve(from) || from) : HUMAN_FLEET_ID
    const recipient = resolve(to)
    if (!recipient) { res.status(404).send(`Recipient not found: "${to}"`); return }
    let ccResolved = cc && cc.length ? cc.map(resolve).filter(Boolean) : null
    if (ccResolved && ccResolved.length === 0) ccResolved = null
    if (recipient === HUMAN_FLEET_ID && sender !== HUMAN_FLEET_ID && fleetStore) {
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
    if (fleetStore) fleetStore.updateHeartbeat(HUMAN_FLEET_ID)
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
        metadata: JSON.stringify({
          cc: ccResolved || undefined,
          attachments: processedAttachments || undefined,
          inline_attachments: inline_attachments || undefined,
          wiretap_cc: wiretapRecipients.length ? wiretapRecipients : undefined,
        }),
      })
      // share() handles unread tracking internally
      broadcastEvent('fleet-event', { type: 'chat', from: sender, to: recipient, id: event?.id, text, event_id: event?.id })
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
  router.post('/api/spawn', (req, res) => {
    const { cwd, name, model, respawn, agent: agentQuery } = req.body || {}
    try {
      const fleetMcp = new URL('../../../fleet/index.mjs', import.meta.url).pathname
      const dir = cwd || os.homedir()
      const fleetId = `fleet:${crypto.randomUUID().slice(0, 8)}`
      const sessionName = `fleet-${(name || fleetId).replace(/[^a-zA-Z0-9_-]/g, '-')}`
      const effectiveModel = model || 'claude-sonnet-4-6[1m]'
      const channelFlag = ' --dangerously-load-development-channels server:fleet'
      execSync(`tmux new-session -d -s ${sessionName} -c ${JSON.stringify(dir)} "FLEET_ID=${fleetId} claude --model '${effectiveModel}' --permission-mode auto${channelFlag}"`, { encoding: 'utf8', timeout: 10000 })
      execSync(`sleep 3 && tmux send-keys -t ${sessionName} Enter`, { timeout: 10000 })
      res.json({ ok: true, tmux_session: sessionName, fleet_id: fleetId })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // --- POST /api/kick ---
  router.post('/api/kick', (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const touch = touchSignalFile(agent.id)
    broadcastEvent('fleet-event', { type: 'kick', to: agent.id, from: HUMAN_FLEET_ID, text: 'manual kick' })
    res.status(touch.ok ? 200 : 500).json(touch)
  })

  // --- POST /api/interrupt ---
  router.post('/api/interrupt', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.json({ ok: false, error: 'no tmux session' }); return }
    try { execSync(`tmux send-keys -t ${agent.tmux_session} Escape Escape`, { timeout: 3000, stdio: 'pipe' }) } catch {}
    res.json({ ok: true, agent: agent.friendly_name || agent.id })
    ;(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2500))
        try {
          const pane = execSync(`tmux capture-pane -t ${agent.tmux_session} -p -S -50`, { encoding: 'utf8', timeout: 3000 })
          const lines = pane.split('\n').filter(l => l.trim())
          const last = lines.length ? lines[lines.length - 1] : ''
          if (!pane.includes('esc to interrupt') && (/^[\s]*[❯>][\s📬]*$/.test(last) || pane.includes('Enter to continue'))) break
        } catch {}
        try { execSync(`tmux send-keys -t ${agent.tmux_session} Escape Escape`, { timeout: 3000, stdio: 'pipe' }) } catch {}
      }
    })()
  })

  // --- POST /api/rename ---
  router.post('/api/rename', (req, res) => {
    const { agent: agentQuery, name: newName } = req.body || {}
    if (!agentQuery || newName == null) { res.status(400).json({ error: 'agent and name required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (newName) {
      const allAgents = fleetStore ? fleetStore.getAllAgents() : []
      const usedNames = new Set(['skip', ...allAgents.filter(a => a.id !== agent.id).map(a => a.friendly_name).filter(Boolean)])
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
    const usedNames = new Set(['skip', ...allAgents.map(a => a.friendly_name).filter(Boolean)])
    const conflicts = labels.filter(l => usedNames.has(l) && l !== agent.friendly_name)
    if (conflicts.length) { res.status(400).json({ error: `Label(s) conflict with agent name(s): ${conflicts.join(', ')}` }); return }
    agent.labels = labels
    if (fleetStore) fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, labels })
  })

  // --- POST /api/send-key ---
  router.post('/api/send-key', (req, res) => {
    const { agent: agentQuery, key } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    try {
      const tmuxKey = key.replace(/^ctrl\+(.)/i, (_, c) => `C-${c}`)
      execSync(`tmux send-keys -t ${agent.tmux_session} ${tmuxKey}`, { timeout: 5000, stdio: 'pipe' })
      res.json({ ok: true })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // --- POST /api/send-text ---
  router.post('/api/send-text', (req, res) => {
    const { agent: agentQuery, text, enter } = req.body || {}
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (!agent.tmux_session) { res.status(400).json({ error: 'no tmux session' }); return }
    try {
      if (text) execSync(`tmux send-keys -t ${agent.tmux_session} -- ${JSON.stringify(text)}`, { timeout: 5000, stdio: 'pipe' })
      if (enter !== false) execSync(`tmux send-keys -t ${agent.tmux_session} Enter`, { timeout: 5000, stdio: 'pipe' })
      res.json({ ok: true })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // --- POST /api/upload ---
  router.post('/api/upload', (req, res) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks)
        const origName = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : null
        let name
        if (origName) {
          name = `${Date.now()}-${origName}`
        } else {
          let ext = 'png'
          if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg'
          else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif'
          else if (buf[0] === 0x52 && buf[1] === 0x49) ext = 'webp'
          else if (buf[0] === 0x3C) {
            const head = buf.slice(0, 256).toString('utf8')
            if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'))) ext = 'svg'
          }
          name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        }
        const filePath = path.join(UPLOAD_DIR, name)
        fs.writeFileSync(filePath, buf)
        res.json({ path: filePath, url: `/api/file?path=${encodeURIComponent(filePath)}` })
      } catch (e) { res.status(500).json({ error: e.message }) }
    })
  })

  // --- POST /api/fleet-event ---
  router.post('/api/fleet-event', (req, res) => {
    const event = req.body
    if (event && event.type) {
      if (event.type === 'preamble' && event.macros) {
        preambleStore[event.target || 'default'] = event.macros
      }
      broadcastEvent('fleet-event', event)
    }
    res.json({ ok: true })
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

  // --- POST /api/cleanup ---
  router.post('/api/cleanup', (req, res) => {
    try {
      const agents = fleetStore ? fleetStore.getAllAgents() : []
      const tasks = fleetStore ? fleetStore.getActiveTasks() : []
      const ALIVE_MS = 10 * 60 * 1000
      const now = Date.now()
      let tmuxSessions = new Set()
      try {
        const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8', timeout: 3000 })
        for (const s of out.trim().split('\n').filter(Boolean)) {
          if (s.startsWith('fleet-')) tmuxSessions.add(s)
        }
      } catch {}
      const removed = [], orphaned = [], deadAgentIds = new Set()
      for (const a of agents) {
        const lastSeenMs = a.last_seen ? now - new Date(a.last_seen).getTime() : Infinity
        const heartbeatAlive = lastSeenMs < ALIVE_MS
        const tmuxAlive = a.tmux_session ? tmuxSessions.has(a.tmux_session) : false
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
