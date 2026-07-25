import path from 'path'
import { activeConfigName, gitAuthorEnv, repoRoot } from '../identity.mjs'

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
}

function passthroughConfigEnv(env = {}) {
  return ['TLDA_CONFIG_DIR', 'TLDA_DAEMON_CONFIG_DIR']
    .filter(key => env[key])
    .map(key => [key, String(env[key])])
}

function resolveBotScript(script) {
  if (!script) throw new Error('bot harness requires botScript')
  return path.isAbsolute(script) ? script : path.join(repoRoot(), script)
}

export function resolveModel(model = 'bot') {
  return model || 'bot'
}

export function resolveModelSelection(model = 'bot') {
  return { model: model || 'bot', provider: 'bot' }
}

export function buildCmd({
  fleetId,
  localAgentId,
  tmuxSession,
  name,
  cwd,
  env = process.env,
  config = {},
  botScript = null,
  botName = null,
  botIdFile = null,
  botPidFile = null,
  botHeartbeatFile = null,
  botWaitChannel = null,
} = {}) {
  const requestedBotName = botName || name
  const script = resolveBotScript(botScript)
  const parts = [
    ...(fleetId ? [`FLEET_ID=${sq(fleetId)}`] : []),
    ...(localAgentId ? [`FLEET_LOCAL_ID=${sq(localAgentId)}`] : []),
    ...(localAgentId ? [`FLEET_MINT_ID=${sq(localAgentId)}`] : []),
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=bot',
  ]
  parts.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  if (name) parts.push(`FLEET_NAME=${sq(name)}`)
  if (requestedBotName) {
    parts.push(`TLDA_BOT_NAME=${sq(requestedBotName)}`)
    parts.push(`TLDA_BOT_REQUESTED_NAME=${sq(requestedBotName)}`)
  }
  if (botIdFile) parts.push(`TLDA_BOT_IDFILE=${sq(botIdFile)}`)
  if (botPidFile) parts.push(`TLDA_BOT_PIDFILE=${sq(botPidFile)}`)
  if (botHeartbeatFile) parts.push(`TLDA_BOT_HEARTBEAT=${sq(botHeartbeatFile)}`)
  if (tmuxSession) parts.push(`TLDA_BOT_TMUX_SESSION=${sq(tmuxSession)}`)
  if (env.TLDA_MACHINE_ID) {
    parts.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
    parts.push(`TLDA_BOT_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  }
  const configName = activeConfigName(config, env)
  if (configName) parts.push(`TLDA_CONFIG=${sq(configName)}`)
  if (env.TLDA_MACHINE_ID && configName) parts.push(`FLEET_DAEMON_KEY=${sq(`${env.TLDA_MACHINE_ID}:${configName}`)}`)
  for (const [key, value] of passthroughConfigEnv(env)) parts.push(`${key}=${sq(value)}`)
  parts.push(sq(process.execPath))
  parts.push(sq(script))
  const signalExit = botWaitChannel ? `; tmux wait-for -S ${sq(botWaitChannel)}` : ''
  return `zsh -lc ${sq(`${parts.join(' ')}${signalExit}`)}`
}

export function resumeId(handle) {
  return handle?.sessionId || null
}
