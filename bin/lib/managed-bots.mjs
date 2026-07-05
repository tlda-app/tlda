import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'
import https from 'node:https'

const DEFAULT_INTERVAL_MS = 10_000
const FAST_DEATH_MS = 30_000
const MAX_RAPID_RESPAWNS = 3
const BACKOFF_MS = 5 * 60_000
const SPAWN_LOCKOUT_MS = 3000
const TODD_HEARTBEAT_TIMEOUT_MS = 3 * 60_000

function botHeartbeatTimeoutMs(spec, env) {
  const configured = Number(spec?.heartbeat_timeout_ms ?? spec?.heartbeatTimeoutMs ?? env.TLDA_BOT_HEARTBEAT_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured > 0) return configured
  return spec?.name === 'todd' ? TODD_HEARTBEAT_TIMEOUT_MS : 0
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function getJson(baseUrl, path, timeoutMs = 5000, token = null) {
  if (!baseUrl) return Promise.resolve(null)
  const url = `${baseUrl}${path}`
  const mod = url.startsWith('https') ? https : http
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.request(url, {
      method: 'GET',
      headers,
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        let json = null
        try { json = buf ? JSON.parse(buf) : {} } catch { json = { raw: buf } }
        finish({ status: res.statusCode || 0, json })
      })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ status: 0, json: { error: 'bot roster request timed out' } }) })
    req.on('error', e => finish({ status: 0, json: { error: e.message } }))
    req.end()
  })
}

export function botBelongsToMachine(spec, machineId) {
  if (!spec?.name || !spec.script) return false
  if (!spec.machine_id) return true
  return spec.machine_id === machineId
}

export function filterBotsForMachine(bots, machineId, log = console) {
  const result = []
  for (const spec of bots || []) {
    if (!spec?.name || !spec.script) continue
    if (spec.machine_id && spec.machine_id !== machineId) {
      log.info?.(`[bot-supervisor:${spec.name}] skipped; owned by machine_id=${spec.machine_id}`)
      continue
    }
    result.push(spec)
  }
  return result
}

export function createManagedBotSupervisor({
  bots,
  machineId,
  resolveScript,
  configDir = join(homedir(), '.config', 'tlda'),
  env = process.env,
  nodePath = process.execPath,
  fleetServerUrl = null,
  authToken = env.TLDA_TOKEN || env.TLDA_TOKEN_RW || null,
  installPath = process.cwd(),
  log = console,
  spawnImpl = spawn,
  timers = { setTimeout, setInterval },
  now = () => Date.now(),
} = {}) {
  if (!machineId) throw new Error('machineId is required for managed bot supervision')
  if (typeof resolveScript !== 'function') throw new Error('resolveScript is required')

  const specs = filterBotsForMachine(bots || [], machineId, log)
  const state = new Map()

  function stateFor(name) {
    let st = state.get(name)
    if (!st) {
      st = { spawnInFlight: false, lastSpawnAt: 0, rapidFails: 0, backoffUntil: 0, givingUpLogged: false }
      state.set(name, st)
    }
    return st
  }

  async function canonicalNameIsHeld(spec) {
    if (!fleetServerUrl) return false
    const res = await getJson(fleetServerUrl, '/api/store/agents', 5000, authToken)
    if (!res || res.status < 200 || res.status >= 300) {
      log.warn?.(`[bot-supervisor:${spec.name}] roster check failed (${res?.json?.error || res?.status || 'no response'}); refusing to spawn duplicate-prone bot`)
      return true
    }
    const agents = Array.isArray(res.json) ? res.json : (res.json?.agents || [])
    const target = String(spec.name || '').toLowerCase()
    return agents.some(a => !a?.dead && String(a?.friendly_name || '').toLowerCase() === target)
  }

  function managedBotEnv(spec, name, pidFile, heartbeatFile, idFile, tmuxSession) {
    return {
      ...env,
      ...(spec.env || {}),
      TMUX: undefined,
      TMUX_PANE: undefined,
      TLDA_BOT_NAME: name,
      TLDA_BOT_PIDFILE: pidFile,
      TLDA_BOT_HEARTBEAT: heartbeatFile,
      TLDA_BOT_IDFILE: idFile,
      TLDA_BOT_MACHINE_ID: machineId,
      TLDA_BOT_TMUX_SESSION: tmuxSession,
    }
  }

  function tmuxCommand(node, script, commandEnv, logFile) {
    const assignments = Object.entries(commandEnv)
      .filter(([key, value]) => (
        /^[A-Z_][A-Z0-9_]*$/.test(key)
        && value !== undefined
        && value !== null
        && (key === 'HOME' || key === 'PATH' || key === 'NODE_TLS_REJECT_UNAUTHORIZED' || key.startsWith('TLDA_'))
      ))
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(' ')
    return `exec env ${assignments} ${shellQuote(node)} ${shellQuote(script)} >> ${shellQuote(logFile)} 2>&1`
  }

  async function shouldSpawnBot(spec) {
    if (!(await canonicalNameIsHeld(spec))) return true
    log.info?.(`[bot-supervisor:${spec.name}] not spawning; canonical name is already held`)
    return false
  }

  function pidIsAlive(pid) {
    if (!(pid > 0)) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e?.code === 'EPERM'
    }
  }

  function heartbeatFresh(name, heartbeatFile, timeoutMs, t) {
    if (!timeoutMs) return true
    try {
      const st = statSync(heartbeatFile)
      return t - st.mtimeMs <= timeoutMs
    } catch {
      log.warn?.(`[bot-supervisor:${name}] heartbeat missing; recycling live pid`)
      return false
    }
  }

  function recycleStalePid(name, pid, pidFile, heartbeatFile, timeoutMs, t) {
    if (heartbeatFresh(name, heartbeatFile, timeoutMs, t)) return false
    log.warn?.(`[bot-supervisor:${name}] heartbeat stale >${Math.round(timeoutMs / 1000)}s; recycling pid ${pid}`)
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { unlinkSync(pidFile) } catch {}
    return true
  }

  async function ensureOne(spec) {
    const name = spec.name
    const scriptPath = resolveScript(spec.script)
    const pidFile = join(configDir, `${name}.pid`)
    const heartbeatFile = join(configDir, `${name}.heartbeat`)
    const idFile = join(configDir, `${name}.fleet-id`)
    const logFile = join(configDir, `${name}.log`)
    const st = stateFor(name)
    if (st.spawnInFlight) return false
    const t = now()
    if (t < st.backoffUntil) return false

    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (pidIsAlive(pid)) {
          const timeoutMs = botHeartbeatTimeoutMs(spec, env)
          if (!recycleStalePid(name, pid, pidFile, heartbeatFile, timeoutMs, t)) return false
        }
      } catch (e) {
        log.warn?.(`[bot-supervisor:${name}] stale pid file: ${e.message}`)
      }
    }

    if (!existsSync(scriptPath)) return false
    if (!(await shouldSpawnBot(spec))) return false

    if (st.lastSpawnAt > 0 && t - st.lastSpawnAt < FAST_DEATH_MS) {
      st.rapidFails++
      if (st.rapidFails >= MAX_RAPID_RESPAWNS) {
        st.backoffUntil = t + BACKOFF_MS
        if (!st.givingUpLogged) {
          log.error?.(`[bot-supervisor:${name}] crashed ${st.rapidFails}x in <${FAST_DEATH_MS}ms each; backing off ${BACKOFF_MS / 1000}s. Tail ${logFile} for the cause.`)
          st.givingUpLogged = true
        }
        st.rapidFails = 0
        return false
      }
    } else if (st.lastSpawnAt > 0) {
      st.rapidFails = 0
    }

    st.spawnInFlight = true
    try {
      if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })
      const logFd = openSync(logFile, 'a')
      const tmuxSession = `fleet-bot-${name.replace(/[^a-z0-9_-]/gi, '-')}-${t.toString(36)}`
      const childEnv = managedBotEnv(spec, name, pidFile, heartbeatFile, idFile, tmuxSession)
      const child = spawnImpl('tmux', ['new-session', '-d', '-s', tmuxSession, tmuxCommand(nodePath, scriptPath, childEnv, logFile)], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: childEnv,
      })
      child.unref?.()
      st.lastSpawnAt = t
      st.givingUpLogged = false
      log.info?.(`[bot-supervisor:${name}] respawned`)
      return true
    } catch (e) {
      log.error?.(`[bot-supervisor:${name}] spawn failed: ${e.message}`)
      return false
    } finally {
      timers.setTimeout(() => { st.spawnInFlight = false }, SPAWN_LOCKOUT_MS)
    }
  }

  async function ensureAll() {
    for (const spec of specs) {
      try { await ensureOne(spec) } catch (e) { log.error?.(`[bot-supervisor] ${spec?.name || '?'}: ${e.message}`) }
    }
  }

  function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    log.info?.(`[bot-supervisor] daemon-owned on machine_id=${machineId}; watching ${specs.map(b => b.name).join(', ') || '(none)'}`)
    ensureAll()
    const timer = timers.setInterval(() => { ensureAll() }, intervalMs)
    timer?.unref?.()
    return timer
  }

  return { specs, ensureAll, ensureOne, start, state }
}
