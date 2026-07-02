import fs from 'fs'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import tls from 'tls'
import { WebSocket } from 'ws'
import { getFleetServerUrl, loadConfig } from '../../../shared/config.mjs'
import { prettyNameForFriendlyName } from '../../../shared/lineage-name.mjs'
import { readConfig } from './identity.mjs'

const MKCERT_CA = path.join(os.homedir(), 'Library/Application Support/mkcert/rootCA.pem')
const TLDA_LOCAL_CERT = path.join(os.homedir(), '.config', 'tlda', 'localhost+2.pem')

function httpForm(url) {
  return String(url || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')
}

function wsForm(url) {
  return httpForm(url).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
}

export function resolveApi({ env = process.env, config = null } = {}) {
  if (env.TLDA_SERVER) return httpForm(env.TLDA_SERVER)
  try {
    return httpForm(getFleetServerUrl(config || loadConfig()))
  } catch {
    const cfg = config || readConfig()
    const name = env.TLDA_CONFIG || cfg.defaultConfig
    const raw = cfg.configs?.[name]
    if (raw?.database || raw?.store) return httpForm(raw.database || raw.store)
    if (cfg.fleetServer) return httpForm(cfg.fleetServer)
    if (cfg.server) return httpForm(cfg.server)
    const port = env.FLEET_DASH_PORT || '5176'
    const host = env.FLEET_DASH_HOST || '127.0.0.1'
    const cert = path.join(os.homedir(), '.config', 'tlda', 'localhost+2.pem')
    return `${fs.existsSync(cert) ? 'https' : 'http'}://${host}:${port}`
  }
}

export function tlsOptionsForApi(api) {
  if (!String(api).startsWith('https://') || !fs.existsSync(MKCERT_CA)) return {}
  let localCa = null
  try {
    localCa = fs.readFileSync(MKCERT_CA, 'utf8')
  } catch (e) {
    if (e?.code !== 'EPERM' && e?.code !== 'EACCES' && e?.code !== 'ENOENT') throw e
    try {
      localCa = fs.readFileSync(TLDA_LOCAL_CERT, 'utf8')
    } catch {
      return {}
    }
  }
  const ca = [...tls.rootCertificates, localCa]
  return {
    agent: new https.Agent({ ca }),
    ca,
  }
}

export async function apiJson(pathname, { api = resolveApi(), timeoutMs = 5000, method = 'GET', body = null } = {}) {
  const url = new URL(pathname, api)
  const lib = url.protocol === 'https:' ? https : http
  const payload = body == null ? null : JSON.stringify(body)
  const opts = {
    ...(url.protocol === 'https:' ? { ca: tlsOptionsForApi(api).ca } : {}),
    method,
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
  }
  return await new Promise((resolve, reject) => {
    const req = lib.request(url, opts, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}`))
          return
        }
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (e) {
          reject(e)
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export async function ensureServer({ api = resolveApi() } = {}) {
  try {
    await apiJson('/api/state', { api, timeoutMs: 2000 })
    return true
  } catch (e) {
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(api)) return false
    throw new Error(`server unreachable at ${api}: ${e.message}`)
  }
}

export async function checkFreshNameAvailable(name, { api = resolveApi(), serverUp = true } = {}) {
  if (!serverUp || !name || name.startsWith('fleet:')) return
  const data = await apiJson(`/api/check-name?name=${encodeURIComponent(name)}`, { api })
  const collisions = data.collisions || []
  if (!collisions.length) return
  const kinds = new Map()
  for (const c of collisions) {
    if (!kinds.has(c.kind)) kinds.set(c.kind, [])
    kinds.get(c.kind).push(c.agent_id)
  }
  const lines = [`'${name}' is not available:`]
  if (kinds.has('pseudo_label')) lines.push('reserved routing label (awake / hibernating / human / human-away)')
  if (kinds.has('friendly_name')) lines.push(`already the friendly_name of ${kinds.get('friendly_name')[0]}`)
  if (kinds.has('label')) lines.push(`collides with a label on ${kinds.get('label').length} live agent(s)`)
  throw new Error(lines.join(' '))
}

export async function findAgent(name, { api = resolveApi() } = {}) {
  if (!name) return null
  const agents = await apiJson('/api/store/agents', { api })
  if (name.startsWith('fleet:')) return agents.find((a) => a.id === name) || null
  const matches = agents.filter((a) => a.friendly_name === name && !a.dead)
  if (!matches.length) return null
  matches.sort((a, b) => Number(b.last_seen || b.last_active || 0) - Number(a.last_seen || a.last_active || 0))
  return matches[0]
}

export async function markAgentDead(fleetId, { api = resolveApi(), timeoutMs = 5000 } = {}) {
  if (!fleetId) return { ok: false, skipped: true }
  return await apiJson(`/api/agents/${encodeURIComponent(fleetId)}/mark-dead`, {
    api,
    timeoutMs,
    method: 'POST',
  })
}

export async function wsRegister({
  fleetId,
  name,
  tmuxSession,
  cwd,
  model,
  effort,
  refresh = false,
  kind = 'claude',
  spawnCapability,
  sessionId,
  metadata,
  shell = false,
  machineId,
  api = resolveApi(),
} = {}) {
  const wsUrl = `${wsForm(api)}/ws/fleet?agent=${encodeURIComponent(fleetId)}`
  const ws = new WebSocket(wsUrl, tlsOptionsForApi(api))
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`registration timed out connecting to ${wsUrl}`)), 5000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  await opened
  const cfg = readConfig()
  const msg = {
    type: 'register',
    id: fleetId,
    name,
    pretty_name: prettyNameForFriendlyName(name),
    tmux_session: tmuxSession,
    cwd,
    kind,
  }
  if (shell) msg.shell = true
  const resolvedMachineId = machineId || process.env.TLDA_MACHINE_ID || cfg.machineId
  if (resolvedMachineId) msg.machine_id = resolvedMachineId
  if (sessionId) msg.session_id = sessionId
  const meta = { ...(metadata || {}) }
  if (model) meta.model = model
  if (effort) meta.effort = effort
  if (refresh) meta.refresh = true
  if (spawnCapability) {
    meta.spawnPolicy = { ...(meta.spawnPolicy || {}), capability: spawnCapability }
  }
  if (Object.keys(meta).length) msg.metadata = meta
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, timeout: true }), 5000)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(raw.toString())
        if (data.error) reject(new Error(data.error.message || data.error))
        else resolve(data.result || { ok: true })
      } catch {
        resolve({ ok: true })
      }
    })
  })
  ws.send(JSON.stringify(msg))
  try {
    return await reply
  } finally {
    ws.close()
  }
}

export async function waitForAwakeRegistration(fleetId, { api = resolveApi(), librarian, timeoutMs = 60_000 } = {}) {
  const waiter = librarian.awaitRegister({ id: fleetId, name: fleetId })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const agents = await apiJson('/api/store/agents', { api, timeoutMs: 5000 })
      const agent = agents.find((a) => a.id === fleetId)
      if (agent && !agent.metadata?.shell) {
        librarian.observeRegister(agent)
        return await waiter
      }
    } catch {
      // Registration polling is best effort; keep waiting until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return await waiter
}
