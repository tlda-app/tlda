#!/usr/bin/env node
/**
 * dev bot — testing-environment noticer.
 *
 * Watches the testing fleet/store surface with real behavioral probes. Healthy
 * testing stays silent; failures nudge dev agents in fleet chat. This bot never
 * enumerates or kills processes.
 */

import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'

import {
  CONFIG_DIR,
  getActiveEnvName,
  getFleetServerUrl,
  getManagedBotEnvironments,
  getManagedBots,
  getServerUrl,
} from '../shared/config.mjs'
import { labelsForAgent } from '../shared/fleet-labels.mjs'
import { startWsRequest } from '../shared/ws-request-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const BOT_KEY = (process.env.TLDA_BOT_NAME || 'dev').toLowerCase()
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const HEARTBEAT_FILE = process.env.TLDA_BOT_HEARTBEAT || path.join(CONFIG_DIR, `${BOT_KEY}.heartbeat`)
const ID_FILE = process.env.TLDA_BOT_IDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.fleet-id`)
const MACHINE_ID = process.env.TLDA_BOT_MACHINE_ID || null
const TMUX_SESSION = process.env.TLDA_BOT_TMUX_SESSION || null
const OWNER_ID = 'fleet:skip'

const MY_BOT = getManagedBots().find(b => String(b.name || '').toLowerCase() === BOT_KEY) || {}
const CONFIG_NAME = getActiveEnvName(MY_BOT.environment)
const FLEET_SERVER = getFleetServerUrl(MY_BOT.environment)
const STORE_SERVER = getServerUrl(MY_BOT.environment)
const WS_URL = FLEET_SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const BOT_ENVIRONMENTS = getManagedBotEnvironments()
const ALLOWED_ENVIRONMENTS = Object.entries(BOT_ENVIRONMENTS)
  .filter(([, members]) => members.some(member => String(member).toLowerCase() === BOT_KEY))
  .map(([envName]) => envName)

const INTERVAL_MS = parseInt(process.env.TLDA_DEV_BOT_INTERVAL_MS || '', 10) || 60_000
const FAILURE_COOLDOWN_MS = parseInt(process.env.TLDA_DEV_BOT_FAILURE_COOLDOWN_MS || '', 10) || 5 * 60_000
const REQUEST_TIMEOUT_MS = parseInt(process.env.TLDA_DEV_BOT_REQUEST_TIMEOUT_MS || '', 10) || 15_000
const PROBE_DOC = process.env.TLDA_DEV_BOT_DOC || ''
const ASSET_PATH_OVERRIDE = process.env.TLDA_DEV_BOT_ASSET_PATH_OVERRIDE || ''
const ALLOW_NONDEFAULT = process.env.TLDA_DEV_BOT_ALLOW_NONDEFAULT === '1'
const NUDGE_TO_OVERRIDE = process.env.TLDA_DEV_BOT_NUDGE_TO || ''
const NUDGE_LABEL = (process.env.TLDA_DEV_BOT_NUDGE_LABEL || 'on-call').trim()
const NUDGE_ON_SETUP = process.env.TLDA_DEV_BOT_NUDGE_SETUP === '1'
const NUDGE_DRY_RUN = process.env.TLDA_DEV_BOT_NUDGE_DRY_RUN === '1'

if (!ALLOW_NONDEFAULT && !ALLOWED_ENVIRONMENTS.includes(CONFIG_NAME)) {
  throw new Error(`dev bot only probes configured environments ${JSON.stringify(ALLOWED_ENVIRONMENTS)}; active config is "${CONFIG_NAME}"`)
}
for (const url of [FLEET_SERVER, STORE_SERVER]) {
  if (/stable/i.test(new URL(url).hostname)) {
    throw new Error(`dev bot refuses to probe stable-looking server: ${url}`)
  }
}

function loadOrCreateFleetId() {
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim()
    if (existing) return existing
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e
  }
  const id = `fleet:${BOT_KEY}`
  try {
    fs.mkdirSync(path.dirname(ID_FILE), { recursive: true })
    fs.writeFileSync(ID_FILE, id)
  } catch (e) {
    // Best-effort persistence; deterministic id remains usable for this run.
    console.error(`[dev-bot] could not persist fleet id ${ID_FILE}: ${e.message}`)
  }
  return id
}

const AGENT_ID = loadOrCreateFleetId()
let assignedName = null
let ws = null
let reconnectTimer = null
let reconnectDelay = 500
let msgId = 1
const pendingRequests = new Map()
let sweepTimer = null
let sweepInFlight = false
let lastFailureKey = null
let lastFailureNudgeAt = 0

class ProbeSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeSetupError'
  }
}

function writeHeartbeat(reason, detail = {}) {
  try {
    fs.appendFileSync(HEARTBEAT_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      bot: BOT_KEY,
      reason,
      config: CONFIG_NAME,
      fleet: FLEET_SERVER,
      store: STORE_SERVER,
      ...detail,
    }) + '\n')
  } catch (e) {
    // Best-effort telemetry; probe state still goes to process logs.
    console.error(`[dev-bot] heartbeat write failed: ${e.message}`)
  }
}

function isCanonicalBot() {
  return assignedName === AGENT_NAME
}

function sendRequestOn(socketRef, pending, msg, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = msgId++
  return startWsRequest({
    pending,
    id,
    type: msg?.type || 'unknown',
    deadlineMs: timeoutMs,
    makeDeadlineError: () => new Error(`${msg?.type || 'ws request'} timed out after ${timeoutMs}ms`),
    makeSendError: () => new Error('ws not connected'),
    send: () => {
      const socket = socketRef()
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify({ id, ...msg }))
      return true
    },
  })
}

function sendRequest(msg, timeoutMs = REQUEST_TIMEOUT_MS) {
  return sendRequestOn(() => ws, pendingRequests, msg, timeoutMs)
}

function handleWsReply(msg, pending = pendingRequests) {
  if (msg.id == null || !pending.has(msg.id)) return false
  const p = pending.get(msg.id)
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))))
  else p.resolve(msg.result)
  return true
}

async function loginFleet() {
  const payload = {
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    cwd: REPO_ROOT,
    labels: ['bot', BOT_KEY],
    machine_id: MACHINE_ID || undefined,
    tmux_session: TMUX_SESSION || undefined,
    metadata: { bot: BOT_KEY, pid: process.pid, config: CONFIG_NAME },
  }
  await sendRequest({ ...payload, type: 'reserve-shell' })
  const result = await sendRequest({ ...payload, type: 'login' })
  assignedName = result?.agent?.friendly_name || result?.assigned_name || null
  if (!isCanonicalBot()) console.log(`[dev-bot] inert: requested "${AGENT_NAME}", assigned "${assignedName || '(none)'}"`)
  return result
}

async function fetchJson(base, urlPath, { method = 'GET', body = undefined } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${urlPath} returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch (e) {
    throw new Error(`${method} ${urlPath} returned invalid JSON: ${e.message}`)
  }
}

function basenameNoExt(file) {
  return String(file || '').replace(/\.tex$/i, '').split('/').pop()
}

function projectIsUsableSvg(project) {
  const format = project?.format || 'svg'
  return format === 'svg' && Number(project?.pages) > 0 && project?.buildStatus !== 'building'
}

async function checkDocumentLoads() {
  const listed = await fetchJson(STORE_SERVER, '/api/projects')
  const projects = Array.isArray(listed?.projects) ? listed.projects : []
  const candidate = PROBE_DOC
    ? { name: PROBE_DOC }
    : projects.find(projectIsUsableSvg)
  if (!candidate?.name) throw new Error('no built svg project with pages > 0 found on testing store')

  const project = await fetchJson(STORE_SERVER, `/api/projects/${encodeURIComponent(candidate.name)}`)
  if (!projectIsUsableSvg(project)) {
    throw new Error(`project ${candidate.name} is not a ready svg doc (format=${project?.format || 'svg'} pages=${project?.pages || 0} buildStatus=${project?.buildStatus || 'unknown'})`)
  }
  const target = Array.isArray(project.targets) && project.targets.length
    ? project.targets[0]
    : { texBase: basenameNoExt(project.mainFile) || project.name }
  const assetPath = ASSET_PATH_OVERRIDE || `/docs/${encodeURIComponent(project.name)}/${encodeURIComponent(target.texBase)}-page-1.svg`
  const res = await fetch(`${STORE_SERVER}${assetPath}?t=${Date.now()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await res.text()
  if (!res.ok) throw new Error(`doc asset ${assetPath} returned HTTP ${res.status}`)
  if (!/<svg[\s>]/i.test(text.slice(0, 1000))) throw new Error(`doc asset ${assetPath} did not return SVG content`)
  return { doc: project.name, assetPath, bytes: text.length }
}

function compactFailure(results) {
  return results
    .filter(r => !r.ok)
    .map(r => `${r.name}: ${r.error}`)
    .join('\n')
}

async function runChecks() {
  const results = []
  for (const [name, check] of [
    ['doc-load', checkDocumentLoads],
  ]) {
    try {
      results.push({ name, ok: true, detail: await check() })
    } catch (e) {
      results.push({ name, ok: false, setup: e instanceof ProbeSetupError, error: e?.message || String(e) })
    }
  }
  const failures = results.filter(r => !r.ok)
  if (!failures.length) return { ok: true, results }
  const setupFailures = failures.filter(r => r.setup)
  const testFailures = failures.filter(r => !r.setup)
  return {
    ok: false,
    setupOnly: testFailures.length === 0 && setupFailures.length > 0,
    results,
    summary: compactFailure(results),
  }
}

function isNudgeTarget(agent) {
  const status = String(agent?.status || '').toLowerCase()
  if (!agent || agent.dead || agent.human || status === 'human' || status === 'human-away' || agent.id === OWNER_ID || agent.id === AGENT_ID) return false
  const labels = labelsForAgent(agent)
  if (labels.includes('bot')) return false
  if (agent.id?.startsWith?.('fleet:dev-probe-')) return false
  return true
}

async function nudgeTargets() {
  if (NUDGE_TO_OVERRIDE) return [NUDGE_TO_OVERRIDE]
  if (!NUDGE_LABEL) return []
  const filter = encodeURIComponent(`awake & ${NUDGE_LABEL}`)
  const data = await fetchJson(FLEET_SERVER, `/api/fleet-table?filter=${filter}&limit=500`)
  const agents = Array.isArray(data?.agents) ? data.agents : []
  return agents.filter(isNudgeTarget).map(agent => agent.id)
}

async function sendChat(to, message) {
  if (!isCanonicalBot()) return null
  return sendRequest({
    type: 'chat',
    from: AGENT_ID,
    to,
    message,
    _tempId: `${BOT_KEY}:${randomUUID()}`,
  })
}

async function sendFailureNudge(report) {
  if (report.setupOnly && !NUDGE_ON_SETUP) {
    writeHeartbeat('probe-setup-suppressed', { summary: report.summary })
    return
  }
  const key = report.summary
  const now = Date.now()
  if (key === lastFailureKey && now - lastFailureNudgeAt < FAILURE_COOLDOWN_MS) return
  const targets = await nudgeTargets()
  if (!targets.length) {
    writeHeartbeat('failure-no-targets', { summary: report.summary })
    return
  }
  if (NUDGE_DRY_RUN) {
    writeHeartbeat('failure-nudge-dry-run', { targets, summary: report.summary })
    return
  }
  const message = [
    report.setupOnly ? '**dev noticer: probe setup needs repair**' : '**dev noticer: testing is failing**',
    '',
    report.summary,
    '',
    `Environment: \`${CONFIG_NAME}\``,
    `Fleet: \`${FLEET_SERVER}\``,
    `Store: \`${STORE_SERVER}\``,
    '',
    'v1 coverage: server health through real doc SVG asset load. Create/spawn/wake/mint/seat is not covered in v1.',
  ].join('\n')
  for (const target of targets) {
    await sendChat(target, message)
  }
  lastFailureKey = key
  lastFailureNudgeAt = now
  writeHeartbeat('failure-nudged', { targets, summary: report.summary })
}

async function sweep() {
  if (sweepInFlight || !isCanonicalBot()) return
  sweepInFlight = true
  try {
    const report = await runChecks()
    if (report.ok) {
      if (lastFailureKey) writeHeartbeat('recovered')
      lastFailureKey = null
      writeHeartbeat('healthy', { checks: report.results.map(r => r.name) })
      return
    }
    if (report.setupOnly) {
      writeHeartbeat('probe-setup-failed', { summary: report.summary })
    }
    await sendFailureNudge(report)
  } catch (e) {
    await sendFailureNudge({
      ok: false,
      summary: `dev-bot: ${e?.message || String(e)}`,
      results: [],
    })
  } finally {
    sweepInFlight = false
  }
}

function connect() {
  ws = new WebSocket(WS_URL, { rejectUnauthorized: false })
  ws.on('open', async () => {
    try {
      console.log(`[dev-bot] connected to ${WS_URL}`)
      reconnectDelay = 500
      await loginFleet()
      writeHeartbeat('ws-open')
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = setInterval(() => sweep().catch(e => console.error('[dev-bot] sweep failed:', e.message)), INTERVAL_MS)
      sweep().catch(e => console.error('[dev-bot] initial sweep failed:', e.message))
    } catch (e) {
      console.error('[dev-bot] login failed:', e.message)
      try {
        ws.close()
      } catch (closeError) {
        // Best-effort reconnect trigger; login error remains the primary fault.
        console.error(`[dev-bot] ws close after failed login failed: ${closeError.message}`)
      }
    }
  })
  ws.on('message', raw => {
    try {
      handleWsReply(JSON.parse(raw.toString()))
    } catch (e) {
      // Best-effort parser guard; malformed frames are not request replies.
      console.error(`[dev-bot] ignored malformed ws message: ${e.message}`)
    }
  })
  ws.on('close', () => scheduleReconnect())
  ws.on('error', e => console.error('[dev-bot] ws error:', e.message))
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 5000)
}

try {
  const prev = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (prev && prev !== process.pid) {
    try {
      process.kill(prev, 0)
      console.error(`[dev-bot] already running pid=${prev}`)
      process.exit(0)
    } catch (e) {
      if (e?.code !== 'ESRCH') throw e
    }
  }
} catch (e) {
  if (e?.code !== 'ENOENT') throw e
}

try {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))
} catch (e) {
  // Best-effort singleton guard; launch supervisor still owns restarts.
  console.error(`[dev-bot] pidfile write failed: ${e.message}`)
}

writeHeartbeat('startup', { intervalMs: INTERVAL_MS })
connect()

process.on('SIGINT', () => {
  try {
    fs.unlinkSync(PID_FILE)
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(`[dev-bot] pidfile cleanup failed: ${e.message}`)
  }
  process.exit(0)
})
process.on('exit', () => {
  try {
    fs.unlinkSync(PID_FILE)
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(`[dev-bot] pidfile cleanup failed: ${e.message}`)
  }
})
