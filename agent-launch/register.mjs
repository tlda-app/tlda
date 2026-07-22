import fs from 'fs'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import tls from 'tls'
import { WebSocket } from 'ws'
import { getFleetServerUrl, getMachineId } from '../shared/config.mjs'
import { prettyNameForFriendlyName } from '../shared/lineage-name.mjs'
import { activeConfigName, readConfig, sanitizeSessionName } from './identity.mjs'
import { createPermissionLedger } from './permission-ledger.mjs'
import { createLocalAgentLedger } from './local-agent-ledger.mjs'

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
  if (config !== null) throw new TypeError('resolveApi no longer accepts a legacy config object')
  return httpForm(getFleetServerUrl())
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

// A single 2s probe was too fragile against the remote Fly server's real,
// observed latency variance: one missed window silently (for non-localhost
// targets) skipped shell reservation entirely, producing a live, working
// harness process with no server-side identity and no way to ever register
// later (see server-check/registration-skipped spawn-trace events). One retry
// at a longer timeout absorbs a transient blip; both attempts are traced so a
// sustained outage is visible instead of silently deferred.
export async function ensureServer({ api = resolveApi() } = {}) {
  const isLocal = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(api)
  const attempts = [2000, 6000]
  let lastError = null
  for (let i = 0; i < attempts.length; i++) {
    try {
      await apiJson('/api/state', { api, timeoutMs: attempts[i] })
      traceServerCheck({ api, attempt: i + 1, ok: true })
      return true
    } catch (e) {
      lastError = e
      traceServerCheck({ api, attempt: i + 1, ok: false, error: e.message, timeoutMs: attempts[i] })
    }
  }
  if (isLocal) throw new Error(`server unreachable at ${api}: ${lastError?.message}`)
  return false
}

function traceServerCheck(detail) {
  process.stderr.write(`[spawn-trace] server-check ${JSON.stringify({ ts: new Date().toISOString(), ...detail })}\n`)
}

export async function checkFreshNameAvailable(name, { api = resolveApi(), serverUp = true, excludeId = null } = {}) {
  if (!serverUp || !name || name.startsWith('fleet:')) return
  const exclude = excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : ''
  const data = await apiJson(`/api/check-name?name=${encodeURIComponent(name)}${exclude}`, { api })
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
  const local = findLocalAgent(name)
  if (local) return local
  throw new Error(`local wake ledger has no record for "${name}"; this owning-box ledger integrity failure must be repaired before wake`)
}

export function findLocalAgent(name, { ledger = null } = {}) {
  const query = String(name || '').trim()
  if (!query) return null
  const ownedLocalLedger = ledger ? null : createLocalAgentLedger()
  const localSource = ledger?.get?.(query)?.localAgentId ? ledger : ownedLocalLedger
  const local = query.startsWith('local:') || query.startsWith('fleet:')
    ? localSource?.get?.(query)
    : localSource?.findByFriendlyName?.(query)
  if (local) {
    ownedLocalLedger?.close?.()
    return {
      id: local.serverAgentId || local.localAgentId,
      local_agent_id: local.localAgentId,
      server_agent_id: local.serverAgentId,
      friendly_name: local.friendlyName,
      name: local.friendlyName,
      tmux_session: local.process?.tmuxName || null,
      session_id: local.conversation?.sessionId || null,
      session_ids: local.conversation?.sessionId ? [local.conversation.sessionId] : [],
      cwd: local.process?.cwd || undefined,
      dead: false,
      metadata: {
        kind: local.conversation?.harness || undefined,
        model: local.conversation?.model || undefined,
        permissionProfile: local.process?.permissionProfile || undefined,
      },
    }
  }
  ownedLocalLedger?.close?.()
  const ownedLedger = ledger ? null : createPermissionLedger()
  const source = ledger || ownedLedger
  try {
    const rec = query.startsWith('fleet:')
      ? source.get(query)
      : source.findByFriendlyName?.(query)
    if (!rec) return null
    const friendlyName = rec.friendlyName || (!query.startsWith('fleet:') ? query : null)
    return {
      id: rec.id,
      friendly_name: friendlyName,
      name: friendlyName,
      tmux_session: friendlyName ? `fleet-${sanitizeSessionName(friendlyName)}` : null,
      session_id: rec.sessionId,
      session_ids: rec.sessionId ? [rec.sessionId] : [],
      cwd: rec.cwd || undefined,
      dead: false,
      metadata: {
        ...(rec.spawnPolicy ? { spawnPolicy: rec.spawnPolicy } : {}),
        ...(rec.permissionSet ? { permissionSet: rec.permissionSet } : {}),
        ...(rec.sessionKind ? { kind: rec.sessionKind } : {}),
      },
    }
  } finally {
    ownedLedger?.close?.()
  }
}

export async function markAgentDead(fleetId, { api = resolveApi(), timeoutMs = 5000 } = {}) {
  if (!fleetId) return { ok: false, skipped: true }
  return await apiJson(`/api/agents/${encodeURIComponent(fleetId)}/mark-dead`, {
    api,
    timeoutMs,
    method: 'POST',
  })
}

function traceIdentityAttempt(detail) {
  process.stderr.write(`[spawn-trace] identity-ws ${JSON.stringify({ ts: new Date().toISOString(), ...detail })}\n`)
}

// One connect-then-ack round trip. Failures at either stage are traced with
// the operation id and which stage failed, so a WS hiccup is diagnosable
// instead of surfacing only as an opaque "timed out" spawn failure.
async function wsIdentityAttempt(type, requestId, wsPeer, wsUrl, msg, { api, timeoutMs, attempt }) {
  const ws = new WebSocket(wsUrl, tlsOptionsForApi(api))
  try {
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`registration timed out connecting to ${wsUrl}`)), timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    try {
      await opened
    } catch (e) {
      traceIdentityAttempt({ type, requestId, wsPeer, attempt, stage: 'connect', ok: false, error: e.message, timeoutMs })
      throw e
    }
    traceIdentityAttempt({ type, requestId, wsPeer, attempt, stage: 'connect', ok: true })
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMessage)
        reject(new Error(`${type} timed out waiting for shell reservation ack from ${wsUrl}`))
      }, timeoutMs)
      const onMessage = (raw) => {
        try {
          const data = JSON.parse(raw.toString())
          if (data.id !== requestId) return
          clearTimeout(timer)
          ws.off('message', onMessage)
          if (data.error) reject(new Error(data.error.message || data.error))
          else resolve(data.result || { ok: true })
        } catch {
          clearTimeout(timer)
          ws.off('message', onMessage)
          resolve({ ok: true })
        }
      }
      ws.on('message', onMessage)
    })
    ws.send(JSON.stringify(msg))
    try {
      const result = await reply
      traceIdentityAttempt({ type, requestId, wsPeer, attempt, stage: 'ack', ok: true })
      return result
    } catch (e) {
      traceIdentityAttempt({ type, requestId, wsPeer, attempt, stage: 'ack', ok: false, error: e.message, timeoutMs })
      throw e
    }
  } finally {
    ws.close()
  }
}

async function wsIdentityMessage(type, {
  fleetId,
  localAgentId,
  name,
  tmuxSession,
  cwd,
  model,
  effort,
  refresh = false,
  kind = 'claude',
  spawnPermission,
  sessionId,
  metadata,
  shell = false,
  machineId,
  envName,
  api = resolveApi(),
  timeoutMs = 5000,
} = {}) {
  const wsPeer = fleetId || localAgentId || 'unbound-local-agent'
  const wsUrl = `${wsForm(api)}/ws/fleet?agent=${encodeURIComponent(wsPeer)}`
  const cfg = readConfig()
  const msg = {
    type,
    id: null,
    ...(fleetId ? { agent_id: fleetId } : {}),
    ...(localAgentId ? { local_agent_id: localAgentId } : {}),
    name,
    pretty_name: prettyNameForFriendlyName(name),
    tmux_session: tmuxSession,
    cwd,
    kind,
  }
  if (shell) msg.shell = true
  const resolvedMachineId = machineId || getMachineId()
  if (resolvedMachineId) msg.machine_id = resolvedMachineId
  const resolvedEnvName = envName || activeConfigName(cfg)
  if (resolvedEnvName) {
    msg.env_name = resolvedEnvName
    if (resolvedMachineId) msg.daemon_key = `${resolvedMachineId}:${resolvedEnvName}`
  }
  if (sessionId) msg.session_id = sessionId
  const meta = { ...(metadata || {}) }
  if (model) meta.model = model
  if (effort) meta.effort = effort
  if (refresh) meta.refresh = true
  if (spawnPermission) {
    meta.spawnPolicy = { ...(meta.spawnPolicy || {}), permission: spawnPermission }
  }
  if (Object.keys(meta).length) msg.metadata = meta
  const attempts = [timeoutMs, Math.max(timeoutMs * 2, 10000)]
  let lastError = null
  for (let i = 0; i < attempts.length; i++) {
    const requestId = `${type}:${wsPeer}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    try {
      return await wsIdentityAttempt(type, requestId, wsPeer, wsUrl, { ...msg, id: requestId }, { api, timeoutMs: attempts[i], attempt: i + 1 })
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

export async function wsReserveShell(options = {}) {
  return wsIdentityMessage('reserve-shell', { ...options, shell: true })
}

export async function wsMintShell(options = {}) {
  return wsIdentityMessage('mint-shell', { ...options, shell: true })
}
