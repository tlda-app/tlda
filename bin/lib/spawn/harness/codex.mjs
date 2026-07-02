import fs from 'fs'
import os from 'os'
import path from 'path'
import { activeConfigName, readConfig, repoRoot } from '../identity.mjs'
import { resolveCodexModel } from '../models.mjs'
import { registerPrompt } from './claude.mjs'

const CODEX_CONFIG_FILE = path.join(os.homedir(), '.codex', 'config.toml')
const DNS_ALIAS_PRELOAD = path.join(repoRoot(), 'shared', 'node-dns-alias.cjs')

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function tomlBasicString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function cenv(key, value) {
  return `-c ${sq(`mcp_servers.tlda.env.${key}=${value}`)}`
}

function cconfig(key, value) {
  return `-c ${sq(`${key}=${value}`)}`
}

export function resolveModel(model) {
  return resolveCodexModel(model)
}

export function buildWorkspaceWriteConfigArgs({ writableRoots = [], networkAccess = true } = {}) {
  const args = []
  args.push(`-c ${sq(`sandbox_workspace_write.network_access=${networkAccess !== false ? 'true' : 'false'}`)}`)
  if (writableRoots.length) {
    args.push(`-c ${sq(`sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`)}`)
  }
  return args
}

export function ensureProjectTrusted(cwd, configFile = CODEX_CONFIG_FILE) {
  if (!cwd) return false
  const project = fs.realpathSync(cwd)
  const section = `[projects.${tomlBasicString(project)}]`
  let text = ''
  try {
    text = fs.readFileSync(configFile, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const sectionRe = new RegExp(`(^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n)([\\s\\S]*?)(?=^\\[|\\s*$)`, 'm')
  const match = text.match(sectionRe)
  if (match) {
    let body = match[2]
    if (/^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/m.test(body)) return false
    if (/^\s*trust_level\s*=/m.test(body)) body = body.replace(/^\s*trust_level\s*=.*$/m, 'trust_level = "trusted"')
    else body = `trust_level = "trusted"\n${body}`
    text = `${text.slice(0, match.index + match[1].length)}${body}${text.slice(match.index + match[0].length)}`
  } else {
    const prefix = !text || text.endsWith('\n') ? '' : '\n'
    text = `${text}${prefix}\n${section}\ntrust_level = "trusted"\n`
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const tmp = `${configFile}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, configFile)
  return true
}

export function buildCmd({
  fleetId,
  tmuxSession,
  model,
  name,
  cwd,
  api,
  sandboxMode = 'workspace-write',
  workspaceWriteConfigArgs = [],
  dnsAlias = null,
  resumeId = null,
  env = process.env,
  config = readConfig(),
} = {}) {
  const processEnv = [
    `FLEET_ID=${sq(fleetId)}`,
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
  ]
  if (name) processEnv.push(`FLEET_NAME=${sq(name)}`)
  if (dnsAlias && fs.existsSync(DNS_ALIAS_PRELOAD)) {
    processEnv.push(`NODE_OPTIONS=${sq(`--require=${DNS_ALIAS_PRELOAD}`)}`)
    processEnv.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    processEnv.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  const parts = [...processEnv, 'codex']
  if (resumeId) parts.push(`resume ${sq(resumeId)}`)
  parts.push(cenv('FLEET_ID', fleetId))
  if (name) parts.push(cenv('FLEET_NAME', name))
  parts.push(cenv('FLEET_HARNESS', 'codex'))
  parts.push(cenv('FLEET_TMUX_SESSION', tmuxSession))
  parts.push(cenv('TLDA_SERVER', api))
  parts.push(cenv('TLDA_SYNC_SERVER', api))
  const mcpEntrypoint = path.join(repoRoot(), 'mcp-server', 'index.mjs')
  if (fs.existsSync(mcpEntrypoint)) {
    parts.push(cconfig('mcp_servers.tlda.args', JSON.stringify([mcpEntrypoint])))
  }
  const configName = activeConfigName(config, env)
  if (configName) parts.push(cenv('TLDA_CONFIG', configName))
  if (dnsAlias && fs.existsSync(DNS_ALIAS_PRELOAD)) {
    parts.push(cenv('NODE_OPTIONS', `--require=${DNS_ALIAS_PRELOAD}`))
    parts.push(cenv('TLDA_NODE_DNS_ALIAS_HOST', dnsAlias.host))
    parts.push(cenv('TLDA_NODE_DNS_ALIAS_ADDR', dnsAlias.address))
  }
  parts.push(...workspaceWriteConfigArgs)
  if (model) parts.push(`-m ${sq(model)}`)
  if (cwd) parts.push(`-C ${sq(cwd)}`)
  if (sandboxMode === 'danger-full-access') {
    parts.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    parts.push(`-s ${sq(sandboxMode)}`)
    parts.push('-a never')
  }
  return parts.join(' ')
}

export function resumeId(handle) {
  return handle?.rolloutId || null
}

export function kickoffPrompt(name) {
  return `${registerPrompt(name)} Then, before task work, read the project guidance in AGENTS.md if it exists. Do not read CLAUDE.md; in this repo it is a template source for AGENTS.md, not agent-facing guidance. Follow the guidance you find. If a tlda MCP tool blocks on required skill(s), read each named skill with skill("<name>") or dismiss it with a specific reason, then retry the blocked tool. Non-Claude guidance contract: respond in the visible channel before acting when the user is waiting; browser-visible or user-visible reports are ground truth; do not claim fixed or done without checking the right surface; do not ask the user to verify routine fixes you can verify; if corrected, stop and change course before continuing; proof obligations are requirements, not optional suggestions.`
}
