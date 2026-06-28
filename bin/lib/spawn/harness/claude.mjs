import fs from 'fs'
import path from 'path'
import { activeConfigName, readConfig, repoRoot } from '../identity.mjs'
import { resolveClaudeModel } from '../models.mjs'

const REGISTER_PROMPT = 'Call register() with the fleet MCP server. Then call my_task() to check for a pending task.'
const DNS_ALIAS_PRELOAD = path.join(repoRoot(), 'shared', 'node-dns-alias.cjs')

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function registerPrompt(name) {
  return name
    ? `Call register(name="${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}") with the fleet MCP server. Then call my_task() to check for a pending task.`
    : REGISTER_PROMPT
}

export function resolveModel(model) {
  return resolveClaudeModel(model)
}

export function buildCmd({
  fleetId,
  tmuxSession,
  model,
  effort,
  mode,
  name,
  api,
  dnsAlias = null,
  resumeId = null,
  includePrompt = true,
  env = process.env,
  config = readConfig(),
} = {}) {
  const parts = [
    `FLEET_ID=${sq(fleetId)}`,
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
  ]
  if (name) parts.push(`FLEET_NAME=${sq(name)}`)
  const configName = activeConfigName(config, env)
  if (configName) parts.push(`TLDA_CONFIG=${sq(configName)}`)
  if (api) {
    parts.push(`TLDA_SERVER=${sq(api)}`)
    parts.push(`TLDA_SYNC_SERVER=${sq(api)}`)
  }
  if (dnsAlias && fs.existsSync(DNS_ALIAS_PRELOAD)) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${DNS_ALIAS_PRELOAD}`)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  parts.push('claude')
  if (resumeId) parts.push(`--resume ${sq(resumeId)}`)
  parts.push('--dangerously-load-development-channels server:tlda')
  parts.push(`--model ${sq(model)}`)
  if (effort) parts.push(`--effort ${sq(effort)}`)
  if (mode === 'bypassPermissions') parts.push('--dangerously-skip-permissions')
  else if (mode) parts.push(`--permission-mode ${sq(mode)}`)
  if (includePrompt) parts.push(sq(registerPrompt(name)))
  return parts.join(' ')
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

export function kickoffPrompt(name) {
  return `${registerPrompt(name)} Then, before task work, read the project guidance in AGENTS.md if it exists. Do not read CLAUDE.md; in this repo it is a template source for AGENTS.md, not agent-facing guidance. Follow the guidance you find.`
}
