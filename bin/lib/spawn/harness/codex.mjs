import fs from 'fs'
import os from 'os'
import path from 'path'
import { activeConfigName, gitAuthorEnv, readConfig, repoRoot } from '../identity.mjs'
import { resolveCodexModel, resolveCodexModelSelection } from '../models.mjs'
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

function appendLaunchFlags(parts, harnessOptions = {}) {
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag !== 'string' || !flag.trim()) continue
    if (!parts.includes(flag)) parts.push(flag)
  }
}

export function resolveModel(model, options = {}) {
  return resolveCodexModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveCodexModelSelection(model, options)
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
  dnsAlias = null,
  resumeId = null,
  env = process.env,
  config = readConfig(),
  harnessOptions = {},
} = {}) {
  const processEnv = [
    `FLEET_ID=${sq(fleetId)}`,
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
  ]
  // Fresh spawn names can still be tentative before server confirm/rename;
  // GIT_AUTHOR_EMAIL carries the stable fleet id for authoritative attribution.
  processEnv.push(...gitAuthorEnv(fleetId, name).map(v => sqEnv(v)))
  if (name) processEnv.push(`FLEET_NAME=${sq(name)}`)
  if (env.TLDA_MACHINE_ID) processEnv.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
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
  const configName = activeConfigName(config, env)
  if (configName) parts.push(cenv('TLDA_CONFIG', configName))
  if (env.TLDA_MACHINE_ID) parts.push(cenv('TLDA_MACHINE_ID', env.TLDA_MACHINE_ID))
  if (dnsAlias && fs.existsSync(DNS_ALIAS_PRELOAD)) {
    parts.push(cenv('NODE_OPTIONS', `--require=${DNS_ALIAS_PRELOAD}`))
    parts.push(cenv('TLDA_NODE_DNS_ALIAS_HOST', dnsAlias.host))
    parts.push(cenv('TLDA_NODE_DNS_ALIAS_ADDR', dnsAlias.address))
  }
  if (model) parts.push(`-m ${sq(model)}`)
  if (cwd) parts.push(`-C ${sq(cwd)}`)
  // The code decides no sandbox/permission argument. Every launch flag — including
  // the sandbox setting — comes from the daemon config (harnessOptions) and is
  // appended here. Containment is whatever the config specifies (fence and/or a
  // harness sandbox flag); the code only passes it through.
  appendLaunchFlags(parts, harnessOptions)
  return parts.join(' ')
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
}

export function resumeId(handle) {
  return handle?.rolloutId || null
}

export function kickoffPrompt(name) {
  return `${registerPrompt(name)} Then, before task work, read the project guidance in AGENTS.md if it exists. Do not read CLAUDE.md; in this repo it is a template source for AGENTS.md, not agent-facing guidance. Follow the guidance you find. If a tlda MCP tool blocks on required skill(s), read each named skill with skill("<name>") or dismiss it with a specific reason, then retry the blocked tool. Non-Claude guidance contract: respond in the visible channel before acting when the user is waiting; browser-visible or user-visible reports are ground truth; do not claim fixed or done without checking the right surface; do not ask the user to verify routine fixes you can verify; if corrected, stop and change course before continuing; proof obligations are requirements, not optional suggestions.`
}
