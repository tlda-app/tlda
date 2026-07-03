import fs from 'fs'
import os from 'os'
import path from 'path'
import { activeConfigName, readConfig, repoRoot } from '../identity.mjs'
import { gooseModelVerified, resolveGooseModel, resolveGooseModelSelection } from '../models.mjs'

const GOOSE_BIN = '/opt/homebrew/bin/goose'
const GOOSE_STATE_ROOT = '/tmp/tlda-goose-state'
const GOOSE_MAX_TOKENS = '32768'
const CURSOR_AGENT_COMMAND = path.join(os.homedir(), '.local/bin/cursor-agent')
const DNS_ALIAS_PRELOAD = path.join(repoRoot(), 'shared', 'node-dns-alias.cjs')

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function providerForModel(model, modelProvider = null) {
  if (model?.startsWith('cursor-agent/')) return { provider: 'cursor-agent', model: model.split('/', 2)[1] || 'default' }
  if (modelProvider === 'deepseek') return { provider: 'openai', model }
  return { provider: 'openrouter', model }
}

export function resolveModel(model, options = {}) {
  return resolveGooseModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveGooseModelSelection(model, options)
}

export function warnModel(model) {
  if (gooseModelVerified(model)) return null
  return `Warning: '${model}' is not on the verified tool-calling list; it may narrate tool-calls as text instead of invoking them.`
}

export function buildCmd({
  fleetId,
  tmuxSession,
  model,
  name,
  api,
  dnsAlias = null,
  env = process.env,
  config = readConfig(),
  modelProvider = null,
} = {}) {
  const recipe = path.join(repoRoot(), 'recipes', 'fleet-deepseek.yaml')
  const sandboxConfig = path.join(path.dirname(recipe), 'goose-sandbox')
  const stateDir = path.join(GOOSE_STATE_ROOT, String(fleetId).replace(/:/g, '-'))
  const cacheDir = path.join(stateDir, 'cache')
  const stateHome = path.join(stateDir, 'state')
  fs.mkdirSync(path.join(stateDir, 'data'), { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(stateHome, { recursive: true })
  const { provider, model: providerModel } = providerForModel(model, modelProvider)
  const parts = [
    `FLEET_ID=${sq(fleetId)}`,
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=goose',
    `TLDA_SERVER=${sq(api)}`,
    `TLDA_SYNC_SERVER=${sq(api)}`,
  ]
  const configName = activeConfigName(config, env)
  if (configName) parts.push(`TLDA_CONFIG=${sq(configName)}`)
  if (dnsAlias && fs.existsSync(DNS_ALIAS_PRELOAD)) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${DNS_ALIAS_PRELOAD}`)}`)
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
  parts.push(`--recipe ${sq(recipe)}`)
  parts.push('--with-builtin developer,summon')
  parts.push(`--params provider=${sq(provider)}`)
  parts.push(`--params model=${sq(providerModel)}`)
  parts.push(`--name ${sq(`fleet-${String(fleetId).split(':').pop()}`)}`)
  parts.push('--interactive')
  return `zsh -lc ${sq(parts.join(' '))}`
}
