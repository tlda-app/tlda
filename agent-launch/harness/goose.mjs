import fs from 'fs'
import os from 'os'
import path from 'path'
import { activeEnvName, gitAuthorEnv, repoRoot } from '../identity.mjs'
import { gooseModelVerified, resolveGooseModel, resolveGooseModelSelection } from '../models.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'

const GOOSE_BIN = '/opt/homebrew/bin/goose'
const GOOSE_STATE_ROOT = '/tmp/tlda-goose-state'
const GOOSE_MAX_TOKENS = '32768'
const CURSOR_AGENT_COMMAND = path.join(os.homedir(), '.local/bin/cursor-agent')

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function providerForModel(model, modelProvider = null) {
  if (model?.startsWith('cursor-agent/')) return { provider: 'cursor-agent', model: model.split('/', 2)[1] || 'default' }
  if (modelProvider === 'deepseek') return { provider: 'openai', model }
  return { provider: 'openrouter', model }
}

function appendLaunchFlags(parts, harnessOptions = {}) {
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag !== 'string' || !flag.trim()) continue
    if (!parts.includes(flag)) parts.push(flag)
  }
}

function passthroughConfigEnv(env = {}) {
  return ['TLDA_CONFIG_DIR', 'TLDA_DAEMON_CONFIG_DIR']
    .filter(key => env[key])
    .map(key => [key, String(env[key])])
}

export function resolveModel(model, options = {}) {
  return resolveGooseModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveGooseModelSelection(model, options)
}

export function warnModel(model, options = {}) {
  if (gooseModelVerified(model, options)) return null
  return `Warning: '${model}' is not on the verified tool-calling list; it may narrate tool-calls as text instead of invoking them.`
}

export function buildCmd({
  fleetId,
  localAgentId,
  tmuxSession,
  model,
  name,
  api,
  dnsAlias = null,
  env = process.env,
  config = {},
  modelProvider = null,
  harnessOptions = {},
} = {}) {
  const recipe = path.join(repoRoot(), 'recipes', 'fleet-deepseek.yaml')
  const sandboxConfig = path.join(path.dirname(recipe), 'goose-sandbox')
  const stateDir = path.join(GOOSE_STATE_ROOT, String(fleetId || localAgentId).replace(/:/g, '-'))
  const cacheDir = path.join(stateDir, 'cache')
  const stateHome = path.join(stateDir, 'state')
  fs.mkdirSync(path.join(stateDir, 'data'), { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(stateHome, { recursive: true })
  const { provider, model: providerModel } = providerForModel(model, modelProvider)
  const parts = [
    ...Object.entries(harnessOptions.env || {}).map(([key, value]) => `${key}=${sq(value)}`),
    ...(fleetId ? [`FLEET_ID=${sq(fleetId)}`] : []),
    ...(localAgentId ? [`FLEET_LOCAL_ID=${sq(localAgentId)}`] : []),
    ...(localAgentId ? [`FLEET_MINT_ID=${sq(localAgentId)}`] : []),
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=goose',
  ]
  // Fresh spawn names can still be tentative before server confirm/rename;
  // GIT_AUTHOR_EMAIL carries the stable fleet id for authoritative attribution.
  parts.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  if (env.TLDA_MACHINE_ID) parts.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  const configName = activeEnvName(config, env)
  if (configName) parts.push(`TLDA_ENV=${sq(configName)}`)
  if (env.TLDA_MACHINE_ID && configName) parts.push(`FLEET_DAEMON_KEY=${sq(`${env.TLDA_MACHINE_ID}:${configName}`)}`)
  for (const [key, value] of passthroughConfigEnv(env)) parts.push(`${key}=${sq(value)}`)
  const dnsAliasPreload = dnsAlias ? dnsAliasPreloadPath() : null
  if (dnsAlias && dnsAliasPreload) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${dnsAliasPreload}`)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  parts.push(`XDG_CONFIG_HOME=${sq(sandboxConfig)}`)
  parts.push(`XDG_DATA_HOME=${sq(path.join(os.homedir(), '.local/share'))}`)
  parts.push(`XDG_CACHE_HOME=${sq(cacheDir)}`)
  parts.push(`XDG_STATE_HOME=${sq(stateHome)}`)
  parts.push('GOOSE_DISABLE_KEYRING=1')
  parts.push(`GOOSE_MAX_TOKENS=${GOOSE_MAX_TOKENS}`)
  parts.push('GOOSE_TELEMETRY_OFF=1')
  if (provider === 'cursor-agent') parts.push(`CURSOR_AGENT_COMMAND=${sq(CURSOR_AGENT_COMMAND)}`)
  if (provider === 'openai') {
    const deepseekKey = env.DEEPSEEK_API_KEY || ''
    if (deepseekKey) parts.push(`OPENAI_API_KEY=${sq(deepseekKey)}`)
    parts.push('OPENAI_HOST=https://api.deepseek.com')
  }
  if (name) parts.push(`FLEET_NAME=${sq(name)}`)
  parts.push(sq(GOOSE_BIN))
  parts.push('run')
  parts.push('--no-profile')
  parts.push(`--recipe ${sq(recipe)}`)
  parts.push('--with-builtin developer,summon')
  parts.push(`--with-extension ${sq(`/opt/homebrew/bin/node ${path.join(repoRoot(), 'mcp-server', 'index.mjs')}`)}`)
  parts.push(`--params provider=${sq(provider)}`)
  parts.push(`--params model=${sq(providerModel)}`)
  parts.push(`--name ${sq(`fleet-${String(fleetId).split(':').pop()}`)}`)
  appendLaunchFlags(parts, harnessOptions)
  parts.push('--interactive')
  return `zsh -lc ${sq(parts.join(' '))}`
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
}
