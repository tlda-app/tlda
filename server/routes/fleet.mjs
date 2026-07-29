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
import { randomUUID } from 'crypto'
import { DEFAULT_PORT, loadServerConfig, resolveConfig } from '../../shared/config.mjs'
import { parseFilter, evalExpr, labelsForAgent } from '../../shared/fleet-labels.mjs'
import { fleetRosterCategory } from '../../shared/fleet-runtime-status.mjs'
import { resolveSpawnMachine } from '../lib/spawn-routing.mjs'
import { summarizeFleetRosterTruth } from '../lib/fleet-roster-truth.mjs'
import { daemonAddress, describeAgentAddress } from '../../shared/agent-move-target.mjs'
import { canReportTask, transferTaskLifecycle } from '../lib/task-lifecycle.mjs'
import { projectAgentActivityPage } from '../lib/activity-dashboard-projection.mjs'

// Server owner — the human running this server process. Browser users
// log in via the WS 'login' message or register via 'register'.
const SERVER_OWNER_NAME = process.env.TLDA_USER || os.userInfo().username || 'user'
const SERVER_OWNER_ID = `fleet:${SERVER_OWNER_NAME}`
const SERVER_OWNER_HOST = os.hostname()

// All inline tmux operations were removed — they now route through the
// fleet-daemon WS RPC layer (`sendDaemonEphemeral(machineId, op, params)` injected
// from unified-server.mjs). If no daemon is connected for an agent's
// machine, the handler returns 503.

const UPLOAD_DIR = process.env.TLDA_UPLOAD_DIR ||
  path.join(os.homedir(), '.config', 'tlda', 'uploads')
// The single source of truth for where uploaded/copied attachments live. On Fly
// this resolves to the persistent volume (TLDA_UPLOAD_DIR=/app/server/persist/uploads),
// so files survive redeploys. Exported so the chat-send attachment-copy path in
// unified-server.mjs writes to the SAME dir as /api/upload instead of an ephemeral
// container path that Fly wipes on every deploy.
export const RESOLVED_UPLOAD_DIR = path.resolve(UPLOAD_DIR)
const MY_TASK_TASK_LIMIT = 20
const MY_TASK_DELIVERY_LIMIT = 50

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

// Decide-and-persist for POST /api/upload. Given the fully-buffered request body
// plus its headers, either returns an { error, status } to reject, or writes the
// file and returns { value } (the JSON body the route sends). Exported so the
// zero-byte guard is unit-testable without mounting the whole fleet router.
//
// The guard exists because a client disconnect mid-upload (or an empty Blob)
// yields an empty body; the old handler wrote a 0-byte file and answered 200
// with a valid-looking URL, which the browser then draws as a permanent broken
// image (confirmed live: 200 · image/png · content-length 0).
export function persistUpload({ body, contentType = '', xFilename = null, uploadDir }) {
  let origName = xFilename
  if (String(contentType).startsWith('multipart/form-data')) {
    const m = String(contentType).match(/boundary="?([^";]+)"?/)
    if (!m) return { error: 'multipart boundary missing', status: 400 }
    const part = extractFirstFilePart(body, m[1])
    if (!part) return { error: 'no file part in multipart body', status: 400 }
    body = part.content
    if (!origName && part.filename) origName = part.filename
  }

  // Never persist an empty upload — the bytes never arrived.
  if (!body || body.length === 0) return { error: 'empty upload — no file bytes received', status: 422 }

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
  fs.mkdirSync(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, name)
  fs.writeFileSync(filePath, body)
  return { value: { name, path: filePath, url: `/api/file?path=${encodeURIComponent(filePath)}` } }
}

function formatNameCollisions(collisions = []) {
  return collisions.map(c => {
    if (c.kind === 'pseudo_label') return `${c.name} is a reserved routing label`
    if (c.kind === 'server_owner') return `${c.name} is the server owner name`
    if (c.kind === 'self_id') return `${c.name} is this agent's durable id`
    return `${c.name} collides with ${c.kind}${c.agent_id ? ` on ${c.agent_id}` : ''}`
  }).join('; ')
}

function mintFleetId() {
  return `fleet:${randomUUID().slice(0, 8)}`
}

function fleetTableLabelsForAgent(agent) {
  const labels = labelsForAgent(agent)
  if (agent?.metadata?.model) labels.push(`model:${agent.metadata.model}`)
  return labels
}

function fleetRosterRank(agent) {
  const category = fleetRosterCategory(agent)
  if (category === 'awake') return 0
  if (category === 'hibernating') return 1
  return 2
}

function compareFleetRosterRows(x, y) {
  return fleetRosterRank(x) - fleetRosterRank(y)
    || (new Date(y.last_seen || 0) - new Date(x.last_seen || 0))
    || String(y.id || '').localeCompare(String(x.id || ''))
}

export function filteredFleetRosterPage(roster, {
  filterAst = null,
  labelsForRow = labelsForAgent,
  limit = 50,
  cursor = null,
} = {}) {
  const ordered = roster
    .filter(a => evalExpr(filterAst, labelsForRow(a)))
    .sort(compareFleetRosterRows)
  let start = 0
  if (cursor) {
    let decoded
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    } catch {
      const error = new Error('invalid fleet roster cursor')
      error.code = 'INVALID_CURSOR'
      throw error
    }
    start = ordered.findIndex(a =>
      fleetRosterRank(a) === decoded.rank
        && a.last_seen === decoded.lastSeen
        && a.id === decoded.id
    )
    if (start < 0) {
      const error = new Error('invalid fleet roster cursor')
      error.code = 'INVALID_CURSOR'
      throw error
    }
    start += 1
  }
  const page = ordered.slice(start, start + limit)
  const tail = page[page.length - 1]
  const nextCursor = start + limit < ordered.length && tail
    ? Buffer.from(JSON.stringify({
        rank: fleetRosterRank(tail),
        lastSeen: tail.last_seen,
        id: tail.id,
      })).toString('base64url')
    : null
  return { matched: ordered.length, rows: page, nextCursor }
}

export function createFleetRouter({ fleetStore, broadcastEvent, broadcastState, clearEphemeralState, suppressEchoFor, sendDaemonEphemeral, sendDaemonDurable, resolveRpc, daemonConnections, resolveSpawnTarget, enqueueDaemonMessage, hasOpenFleetSocketForAgent = () => false, reanimateAgent, requireOperationRead }) {
  const router = Router()

  router.get('/api/fleet/operations/:operationId', requireOperationRead, async (req, res) => {
    const operation = await fleetStore.getTransportOperationStatus(req.params.operationId)
    if (!operation) {
      res.status(404).json({ ok: false, error: 'operation not found' })
      return
    }
    res.json({ ok: true, operation })
  })

  router.get('/api/fleet/native-subagent-notifications/:parentAgentId', async (req, res) => {
    const parentAgentId = req.params.parentAgentId
    const parent = await fleetStore.getAgent(parentAgentId)
    if (!parent || parent.dead) {
      res.status(404).json({ ok: false, error: 'parent agent not found' })
      return
    }
    const pending = await fleetStore.getPendingNativeSubagentNotifications(parentAgentId)
    if (!pending.length) {
      res.json({ ok: true, notifications: [] })
      return
    }
    const seat = await agentRouteOrHttpError(res, parent)
    if (!seat) return
    try {
      const routes = await sendDaemonEphemeral(seat.daemon_key, 'native-subagent-routes', {
        parent_agent_id: parentAgentId,
        child_agent_ids: [...new Set(pending.map(item => item.child_agent_id))],
      })
      const byChild = new Map((routes || []).map(route => [route.child_agent_id, route]))
      res.json({
        ok: true,
        notifications: pending.flatMap(item => {
          const route = byChild.get(item.child_agent_id)
          return route ? [{
            event_id: item.event_id,
            child_agent_id: item.child_agent_id,
            child_name: item.child_name || item.child_agent_id,
            sender_agent_id: item.sender_agent_id,
            sender_name: item.sender_name || item.sender_agent_id,
            created_at: item.created_at,
            native_agent_id: route.native_agent_id,
            harness: route.harness,
          }] : []
        }),
      })
    } catch (e) {
      res.status(e.code === 'NO_DAEMON' ? 503 : 502).json({ ok: false, error: e.message })
    }
  })

  router.get('/api/fleet/native-subagent-binding/:parentAgentId/:nativeAgentId', async (req, res) => {
    const parentAgentId = req.params.parentAgentId
    const parent = await fleetStore.getAgent(parentAgentId)
    if (!parent || parent.dead) {
      res.status(404).json({ ok: false, error: 'parent agent not found' })
      return
    }
    if (req.params.nativeAgentId === parent.session_id || req.params.nativeAgentId === parent.resume_id) {
      res.json({ ok: true, parent_agent_id: parentAgentId, native_agent_id: req.params.nativeAgentId })
      return
    }
    const seat = await agentRouteOrHttpError(res, parent)
    if (!seat) return
    try {
      const routes = await sendDaemonEphemeral(seat.daemon_key, 'native-subagent-routes', {
        parent_agent_id: parentAgentId,
        child_agent_ids: [],
      })
      const route = (routes || []).find(item => item.native_agent_id === req.params.nativeAgentId)
      if (!route) {
        res.status(404).json({ ok: false, error: 'native child binding not found' })
        return
      }
      const child = await fleetStore.getAgent(route.child_agent_id)
      res.json({
        ok: true,
        child_agent_id: route.child_agent_id,
        child_name: child?.friendly_name || route.child_agent_id,
        native_agent_id: route.native_agent_id,
        harness: route.harness,
      })
    } catch (e) {
      res.status(e.code === 'NO_DAEMON' ? 503 : 502).json({ ok: false, error: e.message })
    }
  })

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
      const result = await sendDaemonEphemeral(route.machine_id, op, params)
      return result
    } catch (e) {
      const code = e.code === 'NO_DAEMON' ? 503 : 502
      res.status(code).json({ ok: false, error: e.message })
      return null
    }
  }

  async function agentRouteOrHttpError(res, agent) {
    const seat = agent?.id ? await fleetStore.getAgentDaemonRoute(agent.id) : null
    if (!seat) {
      res.status(409).json({ error: 'agent has no daemon route' })
      return null
    }
    return seat
  }

  // --- CORS ---
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-filename')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  // --- GET /api/state ---
  router.get('/api/state', async (req, res) => {
    if (fleetStore) await fleetStore.updateHeartbeat(SERVER_OWNER_ID)
    const agentsPage = await fleetStore?.getAliveAgentsPage?.({ limit: 100 }) || { agents: [], nextCursor: null }
    const tasksPage = await fleetStore?.getActiveTasksPage?.({ limit: 100 }) || { tasks: [], nextCursor: null }
    res.json({
      agents: agentsPage.agents || [],
      tasks: tasksPage.tasks || [],
      counts: {
        agents: await fleetStore?.getAgentSummary?.() || null,
        tasks: await fleetStore?.getActiveTaskCount?.() ?? (tasksPage.tasks || []).length,
      },
      cursors: {
        agents: agentsPage.nextCursor || null,
        tasks: tasksPage.nextCursor || null,
      },
    })
  })

  // --- GET /api/human ---
  // Returns the server owner's identity. Used by MCP agents and CLI tools
  // to know who the "local human" is. Browser users log in via WS 'login'.
  router.get('/api/human', (req, res) => {
    res.json({ id: SERVER_OWNER_ID, host: SERVER_OWNER_HOST, name: SERVER_OWNER_NAME })
  })

  // --- GET /api/fleet-config ---
  // The global fleet/event-store URL this server points at (env → server.yaml
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
    const serverConfig = loadServerConfig()
    res.json({
      ...resolveConfig(),
      telemetryUrl: serverConfig.telemetryUrl || null,
      projectIndexDefaultSearch: serverConfig.projectIndexDefaultSearch || '',
    })
  })

  // --- POST /api/agents/:id/mark-dead ---
  // Called by the daemon when it detects an agent's process is gone.
  router.post('/api/agents/:id/mark-dead', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try {
      await fleetStore.markDead(req.params.id)
      clearEphemeralState?.(req.params.id)
      broadcastState()
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.post('/api/agents/:id/reanimate', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    if (!reanimateAgent) { res.status(503).json({ error: 'Reanimate is not available' }); return }
    try {
      const result = await reanimateAgent(req.params.id)
      res.json(result)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  router.get('/api/agents/summary', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    try { res.json(await fleetStore.getAgentSummary?.() || { total: 0, live: 0, dead: 0, byMachine: {} }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.get('/api/agents/lookup', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const rawIds = Array.isArray(req.query.ids) ? req.query.ids.join(',') : (req.query.ids || '')
    const ids = [...new Set(String(rawIds).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 200)
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
    if (name && ids.length) { res.status(400).json({ error: 'provide ids or name, not both' }); return }
    try {
      const agents = name
        ? [await fleetStore.findAgent(name)].filter(Boolean)
        : (await fleetStore.getAgentsByIds?.(ids) || [])
      res.json({ agents })
    }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/agents?limit=100&cursor=<opaque> ---
  // The browser agents panel is deliberately live-only.  Historical/dead
  // agents remain available through the existing targeted lookup/search
  // operations; they must never turn connection setup into a roster dump.
  router.get('/api/agents', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const requested = Number.parseInt(req.query.limit, 10)
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 200)) : 100
    try {
      const page = {
        ...await fleetStore.getAliveAgentsPage({ limit, cursor: req.query.cursor || null }),
        totals: await fleetStore.getAliveAgentCounts(),
      }
      res.json(req.query.view === 'activity-dashboard' ? projectAgentActivityPage(page) : page)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/check-name?name=foo[&exclude=fleet:abc]
  // Pre-flight collision check for fleet-spawn fresh(). Returns
  // { ok: true } or { ok: false, collisions: [...] }. The same check
  // also runs in the register and label WS handlers — this endpoint
  // lets fleet-spawn fail before launching claude.
  router.get('/api/check-name', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const name = req.query.name
    if (!name || typeof name !== 'string') { res.status(400).json({ error: 'missing name param' }); return }
    try {
      const collisions = await fleetStore.checkNameAvailable([name], { excludeId: req.query.exclude || null, asFriendlyName: true })
      if (name === SERVER_OWNER_NAME) collisions.push({ name, kind: 'server_owner' })
      res.json({
        ok: collisions.length === 0,
        collisions,
        ...(collisions.length ? { error: formatNameCollisions(collisions) } : {}),
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/tasks?limit=100&cursor=<opaque> ---
  // Automatic browser surfaces use this bounded first page plus task_delta.
  router.get('/api/tasks', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const requested = Number.parseInt(req.query.limit, 10)
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 200)) : 100
    try {
      const page = await fleetStore.getActiveTasksPage({ limit, cursor: req.query.cursor || null })
      res.json({
        ...page,
        total: await fleetStore.getActiveTaskCount?.() ?? page.tasks.length,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/my-task ---
  router.get('/api/my-task', async (req, res) => {
    const agentId = req.query.agent
    if (!agentId) { res.status(400).send('missing "agent" param'); return }
    if (fleetStore) await fleetStore.updateHeartbeat(agentId)
    const tasks = await fleetStore?.getActiveTasksByAgentLimited?.(agentId, MY_TASK_TASK_LIMIT) || []
    const taskCount = await fleetStore?.getActiveTaskCountByAgent?.(agentId) ?? tasks.length
    const task = tasks[0] || await fleetStore?.getTaskByAgent(agentId) || null
    const messages = await fleetStore?.getInboxDeliveriesLimited?.(agentId, MY_TASK_DELIVERY_LIMIT) || []
    const messageCount = await fleetStore?.getInboxDeliveryCount?.(agentId) ?? messages.length
    res.json({
      task,
      tasks: tasks.length ? tasks : (task ? [task] : []),
      messages,
      counts: {
        tasks: taskCount,
        messages: messageCount,
        task_limit: MY_TASK_TASK_LIMIT,
        message_limit: MY_TASK_DELIVERY_LIMIT,
        tasks_truncated: taskCount > tasks.length,
        messages_truncated: messageCount > messages.length,
      },
    })
  })

  // --- GET /api/fleet-table ---
  // Passive fleet roster for agents (replaces the old roll-call blob). Reads the
  // hydrated agent registry — the SAME source as the agents panel and the `awake`
  // pseudo-label (runtime projection from server evidence) — so it wakes no one and
  // costs a cached registry read. Returns whole-fleet totals plus a
  // DNF-filterable, capped slice of rows.
  //   ?filter=<json DNF>  scope rows (e.g. [[["awake"]]], a label, a name)
  //   ?limit=<n>          cap rows (default 50); totals are always whole-fleet
  router.get('/api/fleet-table', async (req, res) => {
    try {
      if (!fleetStore) { res.json({ totals: { awake: 0, hibernating: 0, dead: 0, total: 0 }, agents: [], shown: 0, matched: 0 }); return }
      const now = Date.now()
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 500))
      const roster = await fleetStore.getAliveAgents?.() || []

      // Whole-fleet totals (independent of the filter) — the at-a-glance load.
      // Optional filter expression from the query (e.g. "awake & reviewers").
      // Same matcher chat uses, so `awake` / a label / a name all work and
      // compose with & | ! and parens.
      let filterAst = null
      if (req.query.filter) {
        try { filterAst = parseFilter(req.query.filter) } catch (e) { res.status(400).json({ error: `bad filter: ${e.message}` }); return }
      }
      const page = filteredFleetRosterPage(roster, {
        filterAst,
        labelsForRow: fleetTableLabelsForAgent,
        limit,
        cursor: req.query.cursor || null,
      })

      const summary = summarizeFleetRosterTruth({ roster, matched: page.rows, limit, now })
      res.json({
        totals: summary.totals,
        wholeFleet: await fleetStore.getAgentSummary?.() || null,
        summary: summary.summary,
        agents: summary.agents,
        shown: summary.shown,
        matched: page.matched,
        nextCursor: page.nextCursor,
        page_limited: true,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.get('/api/fleet-roster-truth', async (req, res) => {
    try {
      if (!fleetStore) {
        res.json({ totals: { awake: 0, hibernating: 0, dead: 0, total: 0 }, panes: { fleet: 0, stale: 0, registry_without_pane: 0 }, machines: [], agents: [], shown: 0, matched: 0 })
        return
      }
      const now = Date.now()
      const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 500))
      const roster = await fleetStore.getAliveAgents?.() || []
      let filterAst = null
      if (req.query.filter) {
        try { filterAst = parseFilter(req.query.filter) } catch (e) { res.status(400).json({ error: `bad filter: ${e.message}` }); return }
      }
      const page = filteredFleetRosterPage(roster, {
        filterAst,
        labelsForRow: labelsForAgent,
        limit,
        cursor: req.query.cursor || null,
      })
      const machineSessions = {}
      const machineIds = [...(daemonConnections?.keys?.() || [])]
      await Promise.all(machineIds.map(async machineId => {
        try {
          const result = await sendDaemonEphemeral(machineId, 'list-sessions', {})
          machineSessions[machineId] = Array.isArray(result?.sessions) ? result.sessions : []
        } catch {
          machineSessions[machineId] = []
        }
      }))
      const summary = summarizeFleetRosterTruth({ roster, matched: page.rows, limit, machineSessions, now })
      res.json({
        ...summary,
        matched: page.matched,
        wholeFleet: await fleetStore.getAgentSummary?.() || null,
        nextCursor: page.nextCursor,
        page_limited: true,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- GET /api/file ---
  router.get('/api/file', (req, res) => {
    const filePath = req.query.path
    if (!filePath) { res.status(400).send('Missing path'); return }
    try {
      const resolved = path.resolve(filePath)
      const inUploadDir = resolved === RESOLVED_UPLOAD_DIR ||
        resolved.startsWith(`${RESOLVED_UPLOAD_DIR}${path.sep}`)
      if (!inUploadDir) {
        res.status(404).send('Artifact not found')
        return
      }
      res.sendFile(resolved, { dotfiles: 'allow' })
    }
    catch (e) { res.status(404).send(e.message) }
  })

  // --- POST /api/tasks/delegate ---
  router.post('/api/tasks/delegate', async (req, res) => {
    const { from: rawFrom, agent: agentQuery, description, message, success_criteria, blocked_by, task_id } = req.body || {}
    if (!agentQuery || (!description && !task_id)) { res.status(400).send('missing "agent" or "description"'); return }
    if (task_id && !message) { res.status(400).send('missing "message" for existing task delegation'); return }
    const resolvedAgent = await fleetStore?.findAgent(agentQuery)
    if (!resolvedAgent) { res.status(404).send(`Agent not found: "${agentQuery}"`); return }
    const agentId = resolvedAgent.id
    const from = rawFrom ? ((await fleetStore.findAgent(rawFrom))?.id || rawFrom) : null
    const now = new Date().toISOString()
    const existingTask = task_id ? await fleetStore?.getTask?.(task_id) : null
    if (task_id && !existingTask) { res.status(404).send(`Task not found: "${task_id}"`); return }
    if (existingTask && (existingTask.status === 'done' || existingTask.status === 'retracted')) { res.status(409).send(`Cannot delegate closed task: "${task_id}"`); return }
    const caller = from ? (await fleetStore?.findAgent(from) || { id: from }) : null
    if (existingTask && !await canReportTask({ caller, task: existingTask, fleetStore })) {
      res.status(403).send('not authorized to delegate this task')
      return
    }
    const taskId = task_id || `${agentId.slice(0, 10)}-${Date.now().toString(36)}`
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
      const metadata = {
        fromLabel: (await fleetStore.getAgent(from))?.friendly_name || from,
        toLabel: resolvedAgent.friendly_name || agentId,
        criteria: success_criteria || [],
        message: message || '',
        ...(existingTask ? { transfer: true, previous_agent: existingTask.agent } : {}),
      }
      if (existingTask) {
        await transferTaskLifecycle({
          fleetStore,
          task: existingTask,
          fromAgentId: from,
          toAgentId: agentId,
          message,
          delegatedAt: now,
          eventMetadata: metadata,
        })
      } else {
        await fleetStore.upsertTask(task)
        await fleetStore.delegate(from, agentId, taskId, description, metadata)
      }
    }
    broadcastState()
    res.json({ ok: true, task_id: taskId })
  })

  // --- POST /api/tasks/delete ---
  router.post('/api/tasks/delete', async (req, res) => {
    const { task_id } = req.body || {}
    if (!task_id) { res.status(400).send('missing task_id'); return }
    const task = await fleetStore?.getTask?.(task_id)
    if (!task) { res.status(404).send('task not found'); return }
    await fleetStore?.removeTask?.(task_id)
    broadcastState()
    res.json({ ok: true, task_id })
  })

  // --- POST /api/tasks/retire ---
  // Administratively close tasks nobody is going to do, recording the reason on
  // each row. The caller passes the exact ids and the reason — the server holds
  // no staleness rule of its own, so it can never decide to wipe on its own.
  // `dry_run: true` reports what would happen and changes nothing.
  router.post('/api/tasks/retire', async (req, res) => {
    if (!fleetStore) { res.status(503).json({ error: 'Fleet store not available' }); return }
    const { task_ids, reason, by, dry_run } = req.body || {}
    if (!Array.isArray(task_ids) || task_ids.length === 0) { res.status(400).json({ error: 'missing task_ids' }); return }
    // Capped low on purpose. Each retire is a synchronous SQLite write, so a
    // batch blocks the event loop for its whole duration — 500 measured at
    // ~350ms even as one transaction, which is a visible freeze on a loaded box.
    // 100 keeps a batch under ~100ms; callers page through instead.
    if (task_ids.length > 100) { res.status(400).json({ error: 'at most 100 task_ids per call — each retire is a synchronous write and a large batch blocks the event loop' }); return }
    if (!reason || typeof reason !== 'string') { res.status(400).json({ error: 'missing reason' }); return }
    const dryRun = dry_run === true
    try {
      let retired = []
      let skipped = []
      if (dryRun) {
        for (const id of task_ids) {
          const task = await fleetStore.getTask?.(id)
          if (!task) { skipped.push({ task_id: id, why: 'not found' }); continue }
          if (task.status === 'done' || task.status === 'retracted') { skipped.push({ task_id: id, why: `already ${task.status}` }); continue }
          retired.push({ task_id: id, agent: task.agent, description: task.description })
        }
      } else {
        ({ retired, skipped } = await fleetStore.retireTasks(task_ids, { reason, retiredBy: by || null }))
      }
      if (!dryRun && retired.length) broadcastState()
      res.json({ ok: true, dry_run: dryRun, reason, retired_count: retired.length, skipped_count: skipped.length, retired, skipped })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // --- POST /api/spawn ---
  // Spawn or respawn an agent via the fleet daemon RPC.
  // Body: { model?, doc?, name?, agent?, respawn? }
  // doc: project name — daemon resolves to sourceDir for the cwd
  // For respawn: { agent: "fleet:xxx" or "name", respawn: true }
  router.post('/api/spawn', async (req, res) => {
    const { name, model, doc, cwd, agent, respawn, fresh, permissionRequest, mode, effort, iLikeToLiveDangerously } = req.body || {}
    const spawnReservedKeys = new Set([
      'name', 'model', 'doc', 'cwd', 'agent', 'respawn', 'fresh', 'permissionRequest', 'mode', 'effort',
      'iLikeToLiveDangerously', 'modelOptions',
    ])
    const modelOptions = {
      ...(req.body?.modelOptions && typeof req.body.modelOptions === 'object' && !Array.isArray(req.body.modelOptions) ? req.body.modelOptions : {}),
      ...(effort ? { effort } : {}),
    }
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!spawnReservedKeys.has(key) && value != null && value !== '') modelOptions[key] = value
    }
    // HTTP auth currently proves only bearer-token level, not which fleet agent or
    // human browser session made the request. Spawning is authority-sensitive, so
    // fail closed here instead of treating all HTTP callers as the server owner.
    // MCP/agent spawns use the /ws/fleet `spawn` operation, where the caller is
    // bound to the registered WebSocket identity.
    const caller = req.fleetCallerId ? await fleetStore?.getAgent?.(req.fleetCallerId) : null
    if (!caller) {
      res.status(403).json({ error: 'spawn requires authenticated caller identity; HTTP /api/spawn has no per-caller identity. Use the fleet WS spawn path.' })
      return
    }
    // For respawn, resolve agent to a target identity. Routing is by the
    // target's machine, not by the caller's current device.
    let spawnName = name
    let routeTarget = null
    if (respawn && agent) {
      const a = await fleetStore?.findAgent(agent)
      routeTarget = a || null
      spawnName = a?.id || agent
    } else if (respawn && spawnName) {
      routeTarget = await fleetStore?.findAgent(spawnName) || null
      spawnName = routeTarget?.id || spawnName
    }
    if (respawn && !routeTarget) {
      res.status(404).json({ error: `spawn target not found: ${agent || name}` })
      return
    }
    if (fresh && name) {
      const cols = await fleetStore?.checkNameAvailable?.([name], { asFriendlyName: true }) || []
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
      const route = await resolveSpawnMachine({
        caller,
        targetAgent: routeTarget,
        fresh: !!fresh,
        respawn: !!respawn,
        refresh: false,
        fleetStore,
        daemonConnections,
      })
      const resolved = resolveSpawnTarget
        ? await resolveSpawnTarget(spawnName, !!respawn, {
            fresh: !!fresh,
            requested: { model, project: doc },
          })
        : { name: spawnName, respawn: !!respawn }
      const result = await sendDaemonDurable(route.machine_id, 'spawn', {
        name: resolved.name || undefined,
        model: model || undefined,
        modelOptions,
        doc: doc || undefined,
        cwd: cwd || undefined,
        effort: effort || undefined,
        mode: mode || undefined,
        permissionRequest: permissionRequest || undefined,
        acknowledgeNoSecurity: !!iLikeToLiveDangerously,
        requester: {
          id: caller.id,
          name: caller.friendly_name || caller.name || undefined,
          human: !!caller.human,
          permissionGrant: caller.metadata?.permissionGrant || undefined,
          daemonId: caller.daemon_key || caller.metadata?.daemon_key || undefined,
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
  router.post('/api/kick', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const result = await rpcAgent(res, agent, 'kick', { agent_id: agent.id })
    if (result === null) return // rpcAgent already wrote the response
    res.json(result)
  })

  // --- POST /api/rename ---
  router.post('/api/rename', async (req, res) => {
    const { agent: agentQuery, name: newName } = req.body || {}
    if (!agentQuery || newName == null) { res.status(400).json({ error: 'agent and name required' }); return }
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    if (newName) {
      const collisions = await fleetStore?.checkNameAvailable([newName], { excludeId: agent.id, asFriendlyName: true }) || []
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
  router.post('/api/label', async (req, res) => {
    const { agent: agentQuery, labels } = req.body || {}
    if (!agentQuery || !Array.isArray(labels)) { res.status(400).json({ error: 'agent and labels[] required' }); return }
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const collisions = await fleetStore?.checkNameAvailable(labels, { excludeId: agent.id, asFriendlyName: false }) || []
    for (const label of labels) {
      if (label === SERVER_OWNER_NAME) collisions.push({ name: label, kind: 'server_owner' })
      if (label === agent.id) collisions.push({ name: label, kind: 'self_id' })
    }
    if (collisions.length) {
      res.status(400).json({ error: `Label(s) unavailable: ${formatNameCollisions(collisions)}` })
      return
    }
    agent.labels = labels
    if (fleetStore) await fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, labels })
  })

  // --- POST /api/set-metadata ---
  // Merge key/value pairs into an agent's metadata JSON.
  router.post('/api/set-metadata', async (req, res) => {
    const { agent: agentQuery, ...fields } = req.body || {}
    if (!agentQuery) { res.status(400).json({ error: 'agent required' }); return }
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const meta = { ...(agent.metadata || {}), ...fields }
    agent.metadata = meta
    if (fleetStore) await fleetStore.upsertAgent(agent)
    broadcastState()
    res.json({ ok: true, agent: agent.id, metadata: meta })
  })

  // --- POST /api/capture-pane ---
  // One-shot capture for terminal cards. Live-watching is the separate
  // start/stop-terminal-watch RPC pair.
  router.post('/api/capture-pane', async (req, res) => {
    const { agent: agentQuery, lines } = req.body || {}
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const seat = await agentRouteOrHttpError(res, agent)
    if (!seat) return
    try {
      const result = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', {
        agent_id: agent.id, lines: lines || 50,
      })
      res.json(result)
    } catch (e) {
      const code = e.code === 'NO_DAEMON' ? 503 : 502
      res.status(code).json({ ok: false, error: e.message })
    }
  })

  // --- POST /api/plan-mode-toggle ---
  // Enters plan mode by reading the current mode then sending the right number
  // of Shift+Tab (BTab) presses to land on plan mode.
  // Cycle: default → accept-edits → plan → default
  // body: { agent: <id|name> }
  router.post('/api/plan-mode-toggle', async (req, res) => {
    const { agent: agentQuery } = req.body || {}
    const agent = await fleetStore?.findAgent(agentQuery)
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return }
    const seat = await agentRouteOrHttpError(res, agent)
    if (!seat) return

    const parseCCMode = (pane) => {
      if (/plan mode on/i.test(pane)) return 'plan'
      if (/accept edits on/i.test(pane)) return 'acceptEdits'
      if (/auto.approve/i.test(pane) || /bypass/i.test(pane)) return 'auto'
      return 'default'
    }

    try {
      // Capture current mode
      const cap1 = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', { agent_id: agent.id, lines: 5 })
      const currentMode = parseCCMode(cap1?.content || '')

      // Toggle: if in plan mode exit to default (1 BTab); otherwise enter plan mode.
      // Cycle: default → acceptEdits → plan → default
      const btabs = currentMode === 'plan' ? 1 : currentMode === 'acceptEdits' ? 1 : 2

      for (let i = 0; i < btabs; i++) {
        await sendDaemonEphemeral(seat.daemon_key, 'send-key', { agent_id: agent.id, key: 'BTab' })
        if (i < btabs - 1) await new Promise(r => setTimeout(r, 150))
      }

      // Confirm final mode
      if (btabs > 0) await new Promise(r => setTimeout(r, 300))
      const cap2 = await sendDaemonEphemeral(seat.daemon_key, 'capture-pane', { agent_id: agent.id, lines: 5 })
      const finalMode = parseCCMode(cap2?.content || '')

      // Store permission mode in agent metadata so UI can show persistent badge
      await fleetStore?.updateAgentMeta(agent.id, { permission_mode: finalMode === 'default' ? null : finalMode })
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
    // A client disconnect mid-upload (Skip's frequent frontend disconnects) must
    // never persist a truncated/empty file. Without these handlers `end` could
    // still fire with a partial buffer, and the write-below would store a 0-byte
    // file and answer 200 with a valid-looking URL — the browser then draws a
    // broken image forever. Guard the aborted/error paths so we neither write nor
    // double-respond.
    let settled = false
    const fail = (code, error) => {
      if (settled) return
      settled = true
      res.status(code).json({ error })
    }
    req.on('aborted', () => fail(400, 'upload aborted before completion'))
    req.on('error', (e) => fail(400, `upload stream error: ${e.message}`))
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (settled) return
      try {
        const result = persistUpload({
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] || '',
          xFilename: req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : null,
          uploadDir: UPLOAD_DIR,
        })
        if (result.error) { fail(result.status, result.error); return }
        settled = true
        res.json(result.value)
      } catch (e) { fail(500, e.message) }
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
    const agent = await fleetStore.findAgent?.(agentId) || await fleetStore.getAgent?.(agentId)
    if (!agent) return res.status(404).json({ error: `agent not found: ${agentId}` })

    const route = resolveRpc('rechat', agent)
    if (route.via === 'none') return res.status(503).json({ ok: false, error: route.error })

    let result
    try {
      result = await sendDaemonDurable(route.machine_id, 'rechat', {
        agent_id: agent.id,
        text: rawText,
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
      await fleetStore.chat(
        SERVER_OWNER_ID,
        agentId,
        `⚠ ${SERVER_OWNER_NAME} unquoted a file path that isn't on your machine: ${paths}. Fix the reference (the file may be at a different path) and re-send — that link is rendering dead in chat.`
      )
    }
    const markdownRenderIssues = Array.isArray(result.markdownRenderIssues) ? result.markdownRenderIssues : []
    if (markdownRenderIssues.length && typeof fleetStore?.chat === 'function') {
      for (const fileIssue of markdownRenderIssues) {
        const fileLabel = fileIssue.name || path.basename(fileIssue.path || 'markdown file')
        const issues = Array.isArray(fileIssue.issues) ? fileIssue.issues : []
        await fleetStore.chat(
          SERVER_OWNER_ID,
          agentId,
          `⚠ ${SERVER_OWNER_NAME} unquoted a shared markdown file that won't render properly: ${fileLabel}. The problem is in the file, not the chat wrapper. Edit the markdown file; the shared surface should update from the file:\n${issues.map(l => `- ${l}`).join('\n')}`
        )
      }
    }

    // Patch the stored event: replace `rawText` (with or without backticks) in the text,
    // and merge new inline_attachments into the event's metadata.
    const evId = parseInt(eventId, 10)
    const event = await fleetStore.getEventById?.(evId)
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
        await fleetStore.replaceEventTextAndMetadata(evId, newText, newMeta)
        broadcastEvent('event-update', { id: evId, text: newText, inline_attachments: mergedAtts })
      }
    }

    res.json({ ok: true, resolvedMessage, inlineAttachments: inlineAttachments || [] })
  })

  router.post('/api/agents/:agent/wake', async (req, res) => {
    const agent = await fleetStore?.findAgent?.(req.params.agent)
    if (!agent || agent.dead || agent.human) {
      res.status(404).json({ ok: false, error: `agent not found: ${req.params.agent}` })
      return
    }
    const seat = await agentRouteOrHttpError(res, agent)
    if (!seat) return
    try {
      const result = await sendDaemonDurable(seat.daemon_key, 'wake', { fleet_id: agent.id })
      broadcastState(agent.id)
      res.json({ ok: true, agent_id: agent.id, result })
    } catch (e) {
      res.status(e.code === 'NO_DAEMON' ? 503 : 502).json({ ok: false, error: e.message })
    }
  })

  router.post('/api/agents/mint', async (req, res) => {
    const { name, model, doc, cwd, permissionRequest, mode, effort, iLikeToLiveDangerously, modelOptions: bodyModelOptions } = req.body || {}
    if (!name) {
      res.status(400).json({ ok: false, error: 'mint requires name' })
      return
    }
    const collisions = await fleetStore?.checkNameAvailable?.([name], { asFriendlyName: true }) || []
    if (collisions.length) {
      res.status(409).json({
        ok: false,
        code: 'spawn_name_collision',
        error: `Spawn name "${name}" is unavailable: ${formatNameCollisions(collisions)}. Choose a different name, or wake the existing agent.`,
        collisions,
      })
      return
    }
    const caller = { id: 'localhost', human: true }
    const fleetId = mintFleetId()
    const modelOptions = {
      ...(bodyModelOptions && typeof bodyModelOptions === 'object' && !Array.isArray(bodyModelOptions) ? bodyModelOptions : {}),
      ...(effort ? { effort } : {}),
    }
    try {
      const route = await resolveSpawnMachine({
        caller,
        targetAgent: null,
        fresh: true,
        respawn: false,
        refresh: false,
        fleetStore,
        daemonConnections,
      })
      const result = await sendDaemonDurable(route.machine_id, 'spawn', {
        agent_id: fleetId,
        friendly_name: name,
        name,
        model: model || undefined,
        modelOptions,
        doc: doc || undefined,
        cwd: cwd || undefined,
        effort: effort || undefined,
        mode: mode || undefined,
        permissionRequest: permissionRequest || undefined,
        acknowledgeNoSecurity: !!iLikeToLiveDangerously,
        requester: {
          id: caller.id,
          human: true,
        },
        spawnRoute: route.source,
        daemon_env_name: route.env_name,
        fresh: true,
        respawn: false,
      })
      broadcastState()
      res.json({ ...result, agent_id: result?.agent_id || result?.fleetId || fleetId, fleet_id: result?.fleetId || result?.agent_id || fleetId })
    } catch (e) {
      res.status(e.code === 'NO_DAEMON' ? 503 : 502).json({ ok: false, fleet_id: fleetId, error: e.message })
    }
  })

  // --- POST /api/agent-status ---
  router.post('/api/agent-status', async (req, res) => {
    const { agent: rawAgent, state, tool } = req.body || {}
    if (!rawAgent || !state) { res.status(400).send('missing agent or state'); return }
    const agent = (await fleetStore.findAgent(rawAgent))?.id || rawAgent
    const ts = new Date().toISOString()
    if (fleetStore) await fleetStore.updateAgentStatus?.(agent, state, tool || null, ts)
    broadcastEvent('agent-status', { agent, state, tool: tool || null, ts })
    res.json({ ok: true })
  })

  // --- POST /api/mark-event-read ---
  // Mark a single event read for a recipient. Used by terminal-card
  // dismissal so the dismissed card doesn't auto-pop again on reload.
  // Body: { event_id, agent }
  router.post('/api/mark-event-read', async (req, res) => {
    const { event_id, agent: rawAgent } = req.body || {}
    if (!event_id || !rawAgent) { res.status(400).json({ error: 'event_id and agent required' }); return }
    const agent = await fleetStore?.findAgent(rawAgent)
    const agentId = agent?.id || rawAgent
    const changed = await fleetStore?.markEventRead?.(parseInt(event_id, 10), agentId)
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
    const agent = await fleetStore?.findAgent(rawFrom)
    if (!agent) { res.status(404).json({ error: `Agent not found: "${rawFrom}"` }); return }
    const route = await rpcAgent(res, agent, 'resolve-agent-route', { agent_id: agent.id })
    if (!route) return
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
    res.json({ ok: true, event_id: event?.id })
  })

  // --- GET /api/shared-docs ---
  router.get('/api/shared-docs', async (req, res) => {
    res.json(await fleetStore.getSharedDocs())
  })

  // --- POST /api/shared-docs ---
  router.post('/api/shared-docs', async (req, res) => {
    const { doc, path: docPath, title, agent, ephemeral } = req.body || {}
    if (!doc) { res.status(400).send('missing doc'); return }
    await fleetStore.upsertSharedDoc({ doc, path: docPath, title, agent, ephemeral })
    res.json({ ok: true })
  })

  // --- POST /api/retract ---
  router.post('/api/retract', async (req, res) => {
    const { agent: rawAgent, task_id } = req.body || {}
    if (!rawAgent) { res.status(400).send('missing agent'); return }
    const agent = (await fleetStore.findAgent(rawAgent))?.id || rawAgent
    const task = task_id ? await fleetStore?.getTask?.(task_id) : await fleetStore?.getTaskByAgent(agent)
    if (!task) { res.status(404).send('no active task'); return }
    const result = await fleetStore?.retractTask?.(task, {
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
