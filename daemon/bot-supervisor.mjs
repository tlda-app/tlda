import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'

import { CONFIG_DIR as DEFAULT_CONFIG_DIR, getManagedBots } from '../shared/config.mjs'

const execFileP = promisify(execFile)
const DEFAULT_POLL_MS = 15_000
const HEARTBEAT_STALE_MS = 90_000

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function botServiceName(name) {
  return String(name || '').trim()
}

function botServiceSuffix(name) {
  const suffix = botServiceName(name).replace(/[^A-Za-z0-9_.-]/g, '-')
  if (!suffix) throw new Error('bot name is required')
  return suffix
}

export function botRuntimePaths(name, { configDir = DEFAULT_CONFIG_DIR } = {}) {
  const suffix = botServiceSuffix(name)
  return {
    logFile: join(configDir, `${suffix}.log`),
    pidFile: join(configDir, `${suffix}.pid`),
    heartbeatFile: join(configDir, `${suffix}.heartbeat`),
    idFile: join(configDir, `${suffix}.fleet-id`),
    tmuxSession: `fleet-bot-${suffix}`,
  }
}

export function resolveBotScript(script, { rootDir = process.cwd() } = {}) {
  if (!script) throw new Error('bot script is required')
  if (script.startsWith('/')) return script
  return join(rootDir, script)
}

function botMachineId(bot, fallbackMachineId) {
  return bot.machine_id || fallbackMachineId
}

function botEnvironmentEntries(bot, paths, {
  machineId,
  pathEnv = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  tlsCaPath,
  tldaConfig,
  tldaServer,
  tldaSyncServer,
} = {}) {
  const entries = [
    ['PATH', pathEnv],
    ['TLDA_BOT_NAME', bot.name],
    ['TLDA_BOT_PIDFILE', paths.pidFile],
    ['TLDA_BOT_HEARTBEAT', paths.heartbeatFile],
    ['TLDA_BOT_IDFILE', paths.idFile],
    ['TLDA_BOT_MACHINE_ID', botMachineId(bot, machineId)],
    ['TLDA_BOT_TMUX_SESSION', paths.tmuxSession],
  ]
  if (tlsCaPath) entries.push(['NODE_EXTRA_CA_CERTS', tlsCaPath])
  if (tldaConfig) entries.push(['TLDA_CONFIG', tldaConfig])
  if (tldaServer) entries.push(['TLDA_SERVER', tldaServer])
  if (tldaSyncServer) entries.push(['TLDA_SYNC_SERVER', tldaSyncServer])
  for (const [key, value] of Object.entries(bot.env || {})) entries.push([key, String(value)])
  return entries
}

function botCommandEnvironment(bot, paths, opts) {
  return botEnvironmentEntries(bot, paths, opts)
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
}

function processExists(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(pidFile) {
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function heartbeatAgeMs(heartbeatFile, now = Date.now()) {
  try {
    return now - statSync(heartbeatFile).mtimeMs
  } catch {
    return Infinity
  }
}

function heartbeatExists(heartbeatFile) {
  try {
    statSync(heartbeatFile)
    return true
  } catch {
    return false
  }
}

export function botHealth(name, opts = {}) {
  const paths = botRuntimePaths(name, opts)
  const pid = readPid(paths.pidFile)
  const heartbeatAge = heartbeatAgeMs(paths.heartbeatFile)
  const hasHeartbeat = heartbeatExists(paths.heartbeatFile)
  const heartbeatFresh = hasHeartbeat && heartbeatAge <= (opts.heartbeatStaleMs || HEARTBEAT_STALE_MS)
  const processAlive = processExists(pid)
  return {
    name,
    paths,
    pid,
    processAlive,
    hasHeartbeat,
    heartbeatAgeMs: heartbeatAge,
    heartbeatFresh,
    healthy: processAlive && (!hasHeartbeat || heartbeatFresh),
  }
}

export function createBotSupervisor({
  config,
  configDir = DEFAULT_CONFIG_DIR,
  rootDir = process.cwd(),
  machineId,
  tmuxArgs = [],
  log = console,
  pathEnv = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  tlsCaPath,
  tldaConfig = process.env.TLDA_CONFIG,
  tldaServer,
  tldaSyncServer,
  pollMs = DEFAULT_POLL_MS,
  execFileP: run = execFileP,
} = {}) {
  let timer = null
  let stopped = true
  const restarting = new Set()

  function configuredBots() {
    return getManagedBots(config).filter(bot => {
      const pinned = bot.machine_id
      return !pinned || !machineId || pinned === machineId
    })
  }

  async function tmux(...args) {
    return run('tmux', [...tmuxArgs, ...args], { timeout: 5000, encoding: 'utf8' })
  }

  async function tmuxSessionExists(session) {
    try {
      await tmux('has-session', '-t', session)
      return true
    } catch {
      return false
    }
  }

  function botCommand(bot, paths) {
    const script = resolveBotScript(bot.script, { rootDir })
    const envPrefix = botCommandEnvironment(bot, paths, { machineId, pathEnv, tlsCaPath, tldaConfig, tldaServer, tldaSyncServer })
    return `exec env ${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(script)} >> ${shellQuote(paths.logFile)} 2>&1`
  }

  async function startBot(bot, reason) {
    const paths = botRuntimePaths(bot.name, { configDir })
    mkdirSync(dirname(paths.logFile), { recursive: true })
    const sessionLive = await tmuxSessionExists(paths.tmuxSession)
    const health = botHealth(bot.name, { configDir })
    if (sessionLive && health.healthy) return { started: false, reason: 'healthy', health }
    if (sessionLive) {
      try {
        await tmux('kill-session', '-t', paths.tmuxSession)
      } catch (e) {
        log.warn?.(`bot-supervisor could not replace stale ${bot.name} session ${paths.tmuxSession}: ${e.message}`)
      }
    }
    await tmux('new-session', '-d', '-s', paths.tmuxSession, botCommand(bot, paths))
    log.info?.(`bot-supervisor started ${bot.name} (${paths.tmuxSession}) reason=${reason}`)
    return { started: true, reason, health: botHealth(bot.name, { configDir }) }
  }

  async function ensureBot(bot, reason = 'poll') {
    if (restarting.has(bot.name)) return { skipped: true, reason: 'restart-in-flight' }
    restarting.add(bot.name)
    try {
      return await startBot(bot, reason)
    } catch (e) {
      log.error?.(`bot-supervisor failed for ${bot.name}: ${e.stack || e.message}`)
      return { error: e.message }
    } finally {
      restarting.delete(bot.name)
    }
  }

  async function ensureAll(reason = 'poll') {
    const results = []
    for (const bot of configuredBots()) results.push([bot.name, await ensureBot(bot, reason)])
    return results
  }

  function start() {
    if (!stopped) return
    stopped = false
    void ensureAll('daemon-start')
    timer = setInterval(() => { void ensureAll('poll') }, pollMs)
    timer.unref?.()
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    configuredBots,
    ensureAll,
    ensureBot,
    start,
    stop,
  }
}
