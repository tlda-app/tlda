/**
 * fleet.mjs — Fleet HTTP routes for tlda's unified server.
 *
 * Ported from fleet/dashboard/server.mjs.
 * Mounted at / (routes are already prefixed with /api/).
 *
 * createFleetRouter(deps) — factory that returns an Express router.
 * deps: { fleetStore, broadcastEvent, broadcastState, clearEphemeralState, ... }
 */

import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DEFAULT_PORT, loadConfig, resolveConfig } from '../../shared/config.mjs'
import { parseFilter, evalExpr, labelsForAgent } from '../../shared/fleet-labels.mjs'
import { resolveSpawnMachine } from '../lib/spawn-routing.mjs'
import { summarizeFleetRosterTruth } from '../lib/fleet-roster-truth.mjs'
import { daemonAddress, describeAgentAddress } from '../../shared/agent-move-target.mjs'

// Server owner — the human running this server process. Browser users
// log in via the WS 'login' message or register via 'register'.
const SERVER_OWNER_NAME = process.env.TLDA_USER || os.userInfo().username || 'user'
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_OWNER_HOST = os.hostname()

// All inline tmux operations were removed — they now route through the
// fleet-daemon WS RPC layer (`sendRpc(machineId, op, params)` injected
// from unified-server.mjs). If no daemon is connected for an agent's
// machine, the handler returns 503.

const UPLOAD_DIR = process.env.TLDA_UPLOAD_DIR ||
  path.join(os.homedir(), '.config', 'tlda', 'uploads')
const RESOLVED_UPLOAD_DIR = path.resolve(UPLOAD_DIR)

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

function formatNameCollisions(collisions = []) {
  return collisions.map(c => {
    if (c.kind === 'pseudo_label') return `${c.name} is a reserved routing label`
    if (c.kind === 'server_owner') return `${c.name} is the server owner name`
    if (c.kind === 'self_id') return `${c.name} is this agent's durable id`
    return `${c.name} collides with ${c.kind}${c.agent_id ? ` on ${c.agent_id}` : ''}`
  }).join('; ')
}

function fleetTableLabelsForAgent(agent) {
  const labels = labelsForAgent(agent)
  if (agent?.cwd) labels.push(`cwd:${agent.cwd}`)
  if (agent?.metadata?.model) labels.push(`model:${agent.metadata.model}`)
  return labels
}

export function createFleetRouter({ fleetStore, broadcastEvent, broadcastState, clearEphemeralState, suppressEchoFor, sendRpc, resolveRpc, daemonConnections, resolveSpawnTarget, broadcastDaemonAgentsUpdated, hasOpenFleetSocketForAgent = () => false }) {
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
  // to know who the "local human" is. Browser users log in via WS 'login'.
  router.get('/api/human', (req, res) => {
    res.json({ id: SERVER_OWNER_ID, host: SERVER_OWNER_HOST, name: SERVER_OWNER_NAME })
  })

  // --- GET /api/fleet-config ---
  // The global fleet/event-store URL this server points at (env → config.json
  // fleetServer → this server). The SPA fetches this from whatever server served
  // it, then connects its chat/fleet to the returned URL — so any UI (the Pages
  // site, the main app, or an agent's dev server) resolves chat to the same
  // global store while doc/shapes stay per-server. Unauthenticated: it's just a
  // public URL the client needs before it can authenticate.
  router.get('/api/fleet-config', (req, res) => {
    // The active named config decides what this instance talks to:
    //   database — fleet/chat/registry (what the SPA connects chat to)
    //   store    — shapes + doc-asset sync (per-room state)
    // `fleetServer` is kept as an alias for `database` so existing clients work.
    res.json(resolveConfig())
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
      const cols = 'id, type, timestamp, from_id as "from", to_id as "to", text, metadata, task_id, agent_id'
      if (agent) {
        // UNION of two indexed scans — see FleetStore.queryAgentEvents.
        events = fleetStore.queryAgentEvents({ agent, sinceTs: since, untilTs: until, afterId, beforeId, limit })
      } else if (type) {
        events = fleetStore.db.prepare(
          `SELECT ${cols} FROM events WHERE type = ? AND id > ? ORDER BY id ASC LIMIT ?`
        ).all(type, afterId, limit)
      } else if (beforeId) {
        events = fleetStore.db.prepare(
          `SELECT ${cols} FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`
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

  // --- POST /api/agents/:id/mark-dead ---
  // Called by the daemon when it detects an agent's process is gone.
  router.post('/api/agents/:id/mark-dead', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try {
      fleetStore.markDead(req.params.id)
      clearEphemeralState?.(req.params.id)
      broadcastState()
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- POST /api/agents/:id/resurrect ---
  router.post('/api/agents/:id/resurrect', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try {
      const result = fleetStore.resurrectAsZombie(req.params.id)
      broadcastState()
      res.json(result)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/store/agents ---
  router.get('/api/store/agents', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try { res.json(fleetStore.getAllAgents()) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/check-name?name=foo[&exclude=fleet:abc]
  // Pre-flight collision check for fleet-spawn fresh(). Returns
  // { ok: true } or { ok: false, collisions: [...] }. The same check
  // also runs in the register and label WS handlers — this endpoint
  // lets fleet-spawn fail before launching claude.
  router.get('/api/check-name', (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const name = req.query.name
    if (!name || typeof name !== 'string') { res.status(400).json({ error: 'missing name param' }); return }
    try {
      const collisions = fleetStore.checkNameAvailable([name], { excludeId: req.query.exclude || null, asFriendlyName: true })
      if (name === SERVER_OWNER_NAME) collisions.push({ name, kind: 'server_owner' })
      res.json({
        ok: collisions.length === 0,
        collisions,
        ...(collisions.length ? { error: formatNameCollisions(collisions) } : {}),
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
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
    const tasks = fleetStore?.getActiveTasksByAgent?.(agentId) || []
    const task = tasks[0] || fleetStore?.getTaskByAgent(agentId) || null
    const unread = fleetStore?.getUnread(agentId) || []
    const peek = req.query.peek === 'true'
    if (fleetStore && unread.length && !peek) {
      const readIds = fleetStore.markRead(agentId)
      if (readIds.length) broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })
    }
    if (!peek) broadcastState()
    res.json({ task, tasks: tasks.length ? tasks : (task ? [task] : []), messages: unread })
  })

  // --- GET /api/chat/history ---
  router.get('/api/chat/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 1000)
    const before = req.query.before || null
    // ?agents=a&agents=b (array) or ?agents=a (string) → normalize to array
    const rawAgents = req.query.agents
    const agents = Array.isArray(rawAgents) ? rawAgents : (rawAgents ? [rawAgents] : [])
    try {
      if (!fleetStore) {
        res.json({ events: [], hasMore: false, nextCursor: null })
        return
      }
      res.json(fleetStore.buildChatHistoryResponse({
        before,
        agents,
        limit,
        serverOwnerId: SERVER_OWNER_ID,
        serverOwnerName: SERVER_OWNER_NAME,
      }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // --- GET /api/fleet-table ---
  // Passive fleet roster for agents (replaces the old roll-call blob). Reads the
  // hydrated agent registry — the SAME source as the agents panel and the `awake`
  // pseudo-label (liveness via the installed oracle) — so it wakes no one and
  // costs a cached registry read. Returns whole-fleet totals plus a
  // DNF-filterable, capped slice of rows.
  //   ?filter=<json DNF>  scope rows (e.g. [[["awake"]]], a label, a name)
  //   ?limit=<n>          cap rows (default 50); totals are always whole-fleet
  router.get('/api/fleet-table', (req, res) => {
    try {
      if (!fleetStore) { res.json({ totals: { awake: 0, hibernating: 0, dead: 0, total: 0 }, agents: [], shown: 0, matched: 0 }); return }
      const now = Date.now()
      // Agent roster only — humans are not fleet agents (excluded from the view).
      const roster = fleetStore.getAllAgents().filter(a => !a.human)

      // Whole-fleet totals (independent of the filter) — the at-a-glance load.
      // Optional filter expression from the query (e.g. "awake & reviewers").
      // Same matcher chat uses, so `awake` / a label / a name all work and
      // compose with & | ! and parens.
      let filterAst = null
      if (req.query.filter) {
        try { filterAst = parseFilter(req.query.filter) } catch (e) { res.status(400).json({ error: `bad filter: ${e.message}` }); return }
      }
      const matched = roster.filter(a => evalExpr(filterAst, fleetTableLabelsForAgent(a)))

      // Awake first, then most-recently-seen.
      const rank = (a) => (a.dead ? 2 : a.status === 'awake' ? 0 : 1)
      matched.sort((x, y) => rank(x) - rank(y) || (new Date(y.last_seen || 0) - new Date(x.last_seen || 0)))

      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 500))
      const summary = summarizeFleetRosterTruth({ roster, matched, limit, now })
      res.json({ totals: summary.totals, summary: summary.summary, agents: summary.agents, shown: summary.shown, matched: summary.matched })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.get('/api/fleet-roster-truth', async (req, res) => {
    try {
      if (!fleetStore) {
        res.json({ totals: { awake: 0, hibernating: 0, dead: 0, total: 0 }, panes: { fleet: 0, stale: 0, registry_without_pane: 0 }, machines: [], agents: [], shown: 0, matched: 0 })
        return
      }
      const now = Date.now()
      const roster = fleetStore.getAllAgents().filter(a => !a.human)
      let filterAst = null
      if (req.query.filter) {
        try { filterAst = parseFilter(req.query.filter) } catch (e) { res.status(400).json({ error: `bad filter: ${e.message}` }); return }
      }
      const matched = roster.filter(a => evalExpr(filterAst, labelsForAgent(a)))
      const rank = (a) => (a.dead ? 2 : a.status === 'awake' ? 0 : 1)
      matched.sort((x, y) => rank(x) - rank(y) || (new Date(y.last_seen || 0) - new Date(x.last_seen || 0)))
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 500))
      const machineSessions = {}
      const machineIds = [...(daemonConnections?.keys?.() || [])]
      await Promise.all(machineIds.map(async machineId => {
        try {
          const result = await sendRpc(machineId, 'list-sessions', {})
          machineSessions[machineId] = Array.isArray(result?.sessions) ? result.sessions : []
        } catch {
          machineSessions[machineId] = []
        }
      }))
      res.json(summarizeFleetRosterTruth({ roster, matched, limit, machineSessions, now }))
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
    try {
      const resolved = path.resolve(filePath)
      const inUploadDir = resolved === RESOLVED_UPLOAD_DIR ||
        resolved.startsWith(`${RESOLVED_UPLOAD_DIR}${path.sep}`)
      res.sendFile(resolved, inUploadDir ? { dotfiles: 'allow' } : undefined)
    }
    catch (e) { res.status(404).send(e.message) }
  })

  // --- POST /api/tasks/delegate ---
  router.post('/api/tasks/delegate', async (req, res) => {
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
      await fleetStore.delegate(from, agentId, taskId, description, {
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
    const { name, model, doc, cwd, agent, respawn, fresh, permission, spawnPermission, permissions, requestedPermissions, kind, mode, effort, iLikeToLiveDangerously } = req.body || {}
    // HTTP auth currently proves only bearer-token level, not which fleet agent or
    // human browser session made the request. Spawning is authority-sensitive, so
    // fail closed here instead of treating all HTTP callers as the server owner.
    // MCP/agent spawns use the /ws/fleet `spawn` operation, where the caller is
    // bound to the registered WebSocket identity.
    const caller = req.fleetCallerId ? fleetStore?.getAgent?.(req.fleetCallerId) : null
    if (!caller) {
      res.status(403).json({ error: 'spawn requires authenticated caller identity; HTTP /api/spawn has no per-caller identity. Use the fleet WS spawn path.' })
      return
    }
    // For respawn, resolve agent to a target identity. Routing is by the
    // target's machine, not by the caller's current device.
    let spawnName = name
    let routeTarget = null
    if (respawn && agent) {
      const a = fleetStore?.findAgent(agent)
      routeTarget = a || null
      spawnName = a?.id || agent
    } else if (respawn && spawnName) {
      routeTarget = fleetStore?.findAgent(spawnName) || null
      spawnName = routeTarget?.id || spawnName
    }
    if (respawn && !routeTarget) {
      res.status(404).json({ error: `spawn target not found: ${agent || name}` })
      return
    }
    if (fresh && name) {
      const cols = fleetStore?.checkNameAvailable?.([name], { asFriendlyName: true }) || []
      if (cols.length) {
        res.status(409).json({
          ok: false,
          code: 'spawn_name_collision',
          error: `Spawn name "${name}" is unavailable: ${formatNameCollisions(cols)}. Choose a different name, or respawn the existing agent.`,
          collisions: cols,
        })
        return
      }
    }
    try {
      const route = resolveSpawnMachine({
        caller,
        targetAgent: routeTarget,
        fresh: !!fresh,
        respawn: !!respawn,
        refresh: false,
        fleetStore,
        daemonConnections,
      })
      const requestedPermission = permission || spawnPermission || null
      const permissionRequest = permissions || requestedPermissions || null
      const resolved = resolveSpawnTarget
        ? await resolveSpawnTarget(spawnName, !!respawn, {
            fresh: !!fresh,
            requested: { model, kind, project: doc },
          })
        : { name: spawnName, respawn: !!respawn }
      const result = await sendRpc(route.machine_id, 'spawn', {
        name: resolved.name || undefined,
        model: model || undefined,
        kind: kind || undefined,
        doc: doc || undefined,
        cwd: cwd || undefined,
        effort: effort || undefined,
        mode: mode || undefined,
        requestedPermission: requestedPermission || undefined,
        requestedPermissions: permissionRequest || undefined,
        acknowledgeNoSecurity: !!iLikeToLiveDangerously,
        requester: {
          id: caller.id,
          name: caller.friendly_name || caller.name || undefined,
          human: !!caller.human,
          spawnPolicy: caller.metadata?.spawnPolicy || undefined,
        },
        spawnRoute: route.source,
        daemon_env_name: route.env_name,
        respawn: resolved.respawn,
      })
      broadcastState()
      res.json(result)
    } catch (e) {
      if (e?.reason === 'name-bounced' || e?.name === 'SpawnBounceError') {
        res.status(409).json({
          ok: false,
          code: 'spawn_name_collision',
          error: e.message,
          ...(e.payload ? { payload: e.payload } : {}),
        })
        return
      }
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

  // --- POST /api/rename ---
  router.post('/api/rename', async (req, res) => {
    const { agent: agentQuery, name: newName } = req.body || {}
    if (!agentQuery || newName == null) { res.status(400).json({ error: 'agent and name required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (newName) {
      const collisions = fleetStore?.checkNameAvailable([newName], { excludeId: agent.id, asFriendlyName: true }) || []
      if (newName === SERVER_OWNER_NAME) collisions.push({ name: newName, kind: 'server_owner' })
      if (collisions.length) {
        res.status(400).json({ error: `Name "${newName}" unavailable: ${formatNameCollisions(collisions)}` })
        return
      }
    }
    await fleetStore?.renameAgentFriendlyName(agent.id, newName, { actorId: SERVER_OWNER_ID, reason: 'api-rename' })
    broadcastState()
    res.json({ ok: true, agent: agent.id, name: newName || null })
  })

  // --- POST /api/label ---
  router.post('/api/label', (req, res) => {
    const { agent: agentQuery, labels } = req.body || {}
    if (!agentQuery || !Array.isArray(labels)) { res.status(400).json({ error: 'agent and labels[] required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const collisions = fleetStore?.checkNameAvailable(labels, { excludeId: agent.id, asFriendlyName: false }) || []
    for (const label of labels) {
      if (label === SERVER_OWNER_NAME) collisions.push({ name: label, kind: 'server_owner' })
      if (label === agent.id) collisions.push({ name: label, kind: 'self_id' })
    }
    if (collisions.length) {
      res.status(400).json({ error: `Label(s) unavailable: ${formatNameCollisions(collisions)}` })
      return
    }
    agent.labels = labels
    if (fleetStore) fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, labels })
  })

  // --- POST /api/set-metadata ---
  // Merge key/value pairs into an agent's metadata JSON.
  router.post('/api/set-metadata', (req, res) => {
    const { agent: agentQuery, ...fields } = req.body || {}
    if (!agentQuery) { res.status(400).json({ error: 'agent required' }); return }
    const agent = fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const meta = { ...(agent.metadata || {}), ...fields }
    agent.metadata = meta
    if (fleetStore) fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, metadata: meta })
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

  // --- POST /api/unquote-file ---
  // Unquote = amend the message by removing the backticks around a quoted block,
  // then re-render it as if it had never been quoted. The full interior is run
  // through the same path-detection + upload pipeline as chat() (rechat RPC →
  // processMessageText on the sender's machine), so any file paths inside it get
  // resolved + uploaded. We patch the stored event and re-broadcast so all clients
  // re-render the whole message in place.
  // Body: { eventId, quoted, agentId } — `quoted` is the interior of the block.
  router.post('/api/unquote-file', async (req, res) => {
    const { eventId, quoted: rawText, agentId } = req.body || {}
    if (!eventId || !rawText || !agentId) {
      return res.status(400).json({ error: 'eventId, quoted, and agentId required' })
    }
    const agent = fleetStore.findAgent?.(agentId) || fleetStore.getAgent?.(agentId)
    if (!agent) return res.status(404).json({ error: `agent not found: ${agentId}` })

    const route = resolveRpc('rechat', agent)
    if (route.via === 'none') return res.status(503).json({ ok: false, error: route.error })

    let result
    try {
      result = await sendRpc(route.machine_id, 'rechat', {
        text: rawText,
        cwd: agent.cwd,
      })
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message })
    }

    let { resolvedMessage, inlineAttachments } = result

    // Warn the path's agent if the unquote resolved to a missing file on its machine.
    // The broken ref was masked at send time (backticked) and only surfaced when Skip
    // unquoted it — without this the agent never learns its path is dead; it just
    // renders a silent ⚠ chip in chat.
    const brokenAtts = (inlineAttachments || []).filter(a => a && a.broken)
    if (brokenAtts.length && typeof fleetStore?.chat === 'function') {
      const paths = brokenAtts.map(a => a.path).join(', ')
      fleetStore.chat(
        SERVER_OWNER_ID,
        agentId,
        `⚠ ${SERVER_OWNER_NAME} unquoted a file path that isn't on your machine: ${paths}. Fix the reference (the file may be at a different path) and re-send — that link is rendering dead in chat.`
      )
    }

    // Patch the stored event: replace `rawText` (with or without backticks) in the text,
    // and merge new inline_attachments into the event's metadata.
    const evId = parseInt(eventId, 10)
    const event = fleetStore.getEventById?.(evId)
    if (event && event.text) {
      // Offset new attachment indices so they don't collide with existing ones
      const existingMeta = event.metadata || {}
      const existingAtts = existingMeta.inline_attachments || []
      const offset = existingAtts.length
      if (offset > 0 && inlineAttachments?.length) {
        for (const att of inlineAttachments) att.id += offset
        resolvedMessage = resolvedMessage.replace(
          /\{\{att:(\d+)\}\}/g, (_, idx) => `{{att:${+idx + offset}}}`
        )
      }

      // Splice out the backticks around the clicked block and substitute the
      // resolved (path-uploaded) text. Every substitution uses a function replacer
      // so a resolvedMessage containing `$` (Skip's LaTeX) or `{{att:N}}` is
      // inserted literally — String.replace's string form would interpret `$&`,
      // `$1`, etc. and corrupt the message.
      const sub = () => resolvedMessage
      let newText = event.text
      const inlineForm = '`' + rawText + '`'
      if (newText.includes(inlineForm)) {
        // Inline single-backtick span: `interior`
        newText = newText.replace(inlineForm, sub)
      } else {
        // Fenced block: ```[lang]\n interior \n``` — strip the whole fence.
        let fencedDone = false
        newText = newText.replace(/```[^\n]*\n([\s\S]*?)```/g, (whole, body) => {
          if (fencedDone) return whole
          if (body.replace(/\n$/, '') === rawText || body.trim() === rawText.trim()) {
            fencedDone = true
            return resolvedMessage
          }
          return whole
        })
        // Fallback: bare interior occurrence (e.g. the block markers didn't match).
        if (!fencedDone && newText.includes(rawText)) {
          newText = newText.replace(rawText, sub)
        }
      }
      if (newText !== event.text || inlineAttachments?.length) {
        const mergedAtts = [...existingAtts, ...(inlineAttachments || [])]
        const newMeta = { ...existingMeta, inline_attachments: mergedAtts }
        fleetStore.db.prepare('UPDATE events SET text = ?, metadata = ? WHERE id = ?')
          .run(newText, JSON.stringify(newMeta), evId)
        broadcastEvent('event-update', { id: evId, text: newText, inline_attachments: mergedAtts })
      }
    }

    res.json({ ok: true, resolvedMessage, inlineAttachments: inlineAttachments || [] })
  })

  // --- POST /api/fleet-event ---
  router.post('/api/fleet-event', (req, res) => {
    const event = req.body
    if (event && event.type) {
      broadcastEvent('fleet-event', event)
    }
    res.json({ ok: true })
  })

  // --- POST /api/agents/move-daemon ---
  // Operator path for explicit daemon-address moves. The CLI does the local,
  // machine-specific context export/import; this endpoint is the registry
  // authority for switching the durable fleet identity to a new daemon lane.
  router.post('/api/agents/move-daemon', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'no fleet store' }); return }
    const { agent: agentQuery, machine_id: targetMachine, env_name: targetEnv, expected_from: expectedFrom, expected_env: expectedEnv, check_only: checkOnly } = req.body || {}
    if (!agentQuery || !targetMachine || !targetEnv) {
      res.status(400).json({ error: 'agent, machine_id, and env_name are required' })
      return
    }
    const agent = fleetStore.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: `agent not found: ${agentQuery}` }); return }
    if (agent.dead) { res.status(400).json({ error: `agent ${agent.id} is marked dead` }); return }
    if (expectedFrom && agent.machine_id !== expectedFrom) {
      res.status(409).json({
        error: `agent ${agent.id} belongs to ${agent.machine_id || 'unknown'}, not ${expectedFrom}`,
        agent: agent.id,
        current_machine_id: agent.machine_id || null,
      })
      return
    }
    if (expectedEnv && agent.env_name !== expectedEnv) {
      res.status(409).json({
        error: `agent ${agent.id} belongs to ${describeAgentAddress(agent.machine_id, agent.env_name)}, not ${describeAgentAddress(expectedFrom || agent.machine_id, expectedEnv)}`,
        agent: agent.id,
        current_machine_id: agent.machine_id || null,
        current_env_name: agent.env_name || null,
      })
      return
    }
    const targetDaemon = daemonAddress(targetMachine, targetEnv)
    const dws = daemonConnections?.get?.(targetDaemon)
    if (!dws || dws.readyState !== 1) {
      res.status(503).json({ error: `no fleet-daemon connected for ${targetDaemon}` })
      return
    }
    if (checkOnly) {
      res.json({ ok: true, agent: agent.id, from: agent.machine_id || null, from_env: agent.env_name || null, to: targetMachine, to_env: targetEnv, check_only: true })
      return
    }
    const fromMachine = agent.machine_id || null
    const fromEnv = agent.env_name || null
    fleetStore.upsertAgent({ ...agent, machine_id: targetMachine, env_name: targetEnv, last_seen: new Date().toISOString() })
    const event = await fleetStore.share?.({
      type: 'lifecycle',
      from: SERVER_OWNER_ID,
      to: agent.id,
      agentId: agent.id,
      text: `agent moved ${describeAgentAddress(fromMachine, fromEnv)} -> ${describeAgentAddress(targetMachine, targetEnv)}`,
      metadata: { from_machine_id: fromMachine, from_env_name: fromEnv, to_machine_id: targetMachine, to_env_name: targetEnv },
    })
    broadcastDaemonAgentsUpdated?.()
    broadcastState()
    res.json({ ok: true, agent: agent.id, from: fromMachine, from_env: fromEnv, to: targetMachine, to_env: targetEnv, event_id: event?.id || null })
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
  router.post('/api/terminal-card', async (req, res) => {
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
    const event = await fleetStore?.share({
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

  // --- POST /api/wiretap ---
  router.post('/api/wiretap', (req, res) => {
    if (!fleetStore) { res.status(503).send('no store'); return }
    const { agent, filter, types } = req.body || {}
    if (!agent) { res.status(400).send('missing agent'); return }
    if (!filter) { res.status(400).send('missing filter'); return }
    // Filter is a string expression with directional to:/from: prefixes;
    // addWiretap validates it via parseFilter and throws on bad syntax.
    let tap
    try { tap = fleetStore.addWiretap(agent, filter, types) }
    catch (e) { res.status(400).json({ error: `bad filter: ${e.message}` }); return }
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
    const result = fleetStore?.retractTask?.(task, {
      recipientExposed: hasOpenFleetSocketForAgent(task.agent),
      retractedBy: req.body?.from || null,
    }) || { task_id: task.id, mode: 'removed_task_only' }
    broadcastState()
    res.json({ ok: true, ...result })
  })

  // --- GET /api/health ---
  router.get('/api/health', (req, res) => {
    res.json({ ok: true, fleet: 'embedded', store: fleetStore ? 'up' : 'down' })
  })

  return router
}
