import path from 'path'
import { activeEnvName, gitAuthorEnv, repoRoot } from '../identity.mjs'

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
  botPidFile = null,
  botHeartbeatFile = null,
  botWaitChannel = null,
  botEnv = null,
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
  if (botPidFile) parts.push(`TLDA_BOT_PIDFILE=${sq(botPidFile)}`)
  if (botHeartbeatFile) parts.push(`TLDA_BOT_HEARTBEAT=${sq(botHeartbeatFile)}`)
  // No TLDA_BOT_TMUX_SESSION. A bot was handed a terminal name and believed it;
  // the name is only correct when the agent was created by a mint using this same
  // config, so a woken bot was told it lived somewhere it did not. Skip: "you
  // don't need to fucking know the terminal name fucking ever. And you don't need
  // to fucking pass it … that is information that should not be passed."
  if (env.TLDA_MACHINE_ID) {
    parts.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
    parts.push(`TLDA_BOT_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  }
  const configName = activeEnvName(config, env)
  if (configName) parts.push(`TLDA_ENV=${sq(configName)}`)
  if (env.TLDA_MACHINE_ID && configName) parts.push(`FLEET_DAEMON_KEY=${sq(`${env.TLDA_MACHINE_ID}:${configName}`)}`)
  for (const [key, value] of passthroughConfigEnv(env)) parts.push(`${key}=${sq(value)}`)
  for (const [key, value] of Object.entries(botEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && value !== undefined && value !== null) {
      parts.push(`${key}=${sq(value)}`)
    }
  }
  parts.push(sq(process.execPath))
  parts.push(sq(script))
  const signalExit = botWaitChannel ? `; tmux wait-for -S ${sq(botWaitChannel)}` : ''
  return `zsh -lc ${sq(`${parts.join(' ')}${signalExit}`)}`
}

export function resumeId(handle) {
  return handle?.sessionId || null
}
