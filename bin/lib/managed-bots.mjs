import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_INTERVAL_MS = 10_000
const FAST_DEATH_MS = 30_000
const MAX_RAPID_RESPAWNS = 3
const BACKOFF_MS = 5 * 60_000
const SPAWN_LOCKOUT_MS = 3000

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

  function ensureOne(spec) {
    const name = spec.name
    const scriptPath = resolveScript(spec.script)
    const pidFile = join(configDir, `${name}.pid`)
    const logFile = join(configDir, `${name}.log`)
    const st = stateFor(name)
    if (st.spawnInFlight) return false
    const t = now()
    if (t < st.backoffUntil) return false

    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (pid > 0) {
          try {
            process.kill(pid, 0)
            return false
          } catch (e) {
            if (e?.code === 'EPERM') return false
          }
        }
      } catch (e) {
        log.warn?.(`[bot-supervisor:${name}] stale pid file: ${e.message}`)
      }
    }

    if (!existsSync(scriptPath)) return false

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
      const child = spawnImpl(nodePath, [scriptPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...env,
          ...(spec.env || {}),
          TMUX: undefined,
          TMUX_PANE: undefined,
          TLDA_BOT_NAME: name,
          TLDA_BOT_PIDFILE: pidFile,
        },
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

  function ensureAll() {
    for (const spec of specs) {
      try { ensureOne(spec) } catch (e) { log.error?.(`[bot-supervisor] ${spec?.name || '?'}: ${e.message}`) }
    }
  }

  function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    log.info?.(`[bot-supervisor] daemon-owned on machine_id=${machineId}; watching ${specs.map(b => b.name).join(', ') || '(none)'}`)
    ensureAll()
    const timer = timers.setInterval(ensureAll, intervalMs)
    timer?.unref?.()
    return timer
  }

  return { specs, ensureAll, ensureOne, start, state }
}
