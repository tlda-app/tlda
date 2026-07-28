import fs from 'fs'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { ledgerSessionId } from '../../agent-runtime/ledger-session-tail.mjs'
import {
  codexRolloutBelongsToAgent,
  codexRolloutHasOwnerEvidence,
  codexRolloutMatchesLaunch,
  resolveTranscript,
} from '../../agent-runtime/resolve-transcript.mjs'
import { activeEnvName, gitAuthorEnv } from '../identity.mjs'
import { resolveCodexModel, resolveCodexModelSelection } from '../models.mjs'
import { loginPrompt } from './claude.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'

const CODEX_CONFIG_FILE = path.join(os.homedir(), '.codex', 'config.toml')
const execFileP = promisify(execFile)

export async function resolveLiveSessionIdentity({ agent, tmuxSession, tmuxArgs = [], tmuxSocket = null, now = Date.now, diagnose = false } = {}) {
  const unresolved = (failureStage) => diagnose ? { sessionId: null, jsonlPath: null, model: null, failureStage } : null
  if (!tmuxSession) return unresolved('pane')
  const tmuxPrefix = tmuxSocket ? ['-S', tmuxSocket] : tmuxArgs
  let paneOut
  try {
    ;({ stdout: paneOut } = await execFileP('tmux', [...tmuxPrefix, 'list-panes', '-t', tmuxSession, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' }))
  } catch {
    return unresolved('pane')
  }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return unresolved('pane')
  let psOut
  try {
    ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
  } catch {
    return unresolved('pid')
  }
  const children = new Map()
  const runtimes = new Set()
  for (const line of psOut.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, ppid, args] = match
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    if (/(?:^|\s|[/\\])codex(?:\.exe)?(?:\s|$)/.test(args)) runtimes.add(pid)
  }
  const runtimePids = codexRuntimeCandidates({ panePids, children, runtimes })
  if (!runtimePids.length) return unresolved('pid')
  const launchTs = Date.parse(agent?.registered_at || '') || (now() - 60_000)
  const jsonlPath = await resolveOwnedCodexTranscript({ runtimePids, agent, launchTs })
  if (!jsonlPath) return unresolved('runtime-rollout')
  const sessionId = ledgerSessionId({ harness_kind: 'codex', jsonl_path: jsonlPath })
  if (!sessionId) return diagnose ? { sessionId: null, jsonlPath, model: null, failureStage: 'session-id' } : null
  let model = null
  try {
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).slice(0, 200)) {
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const value = entry?.payload?.model || entry?.model || entry?.message?.model || entry?.payload?.message?.model || entry?.response?.model || entry?.payload?.response?.model
      if (typeof value === 'string' && value.trim()) { model = value.trim(); break }
    }
  } catch {
    return { sessionId, jsonlPath, model: null, ...(diagnose ? { failureStage: 'model' } : {}) }
  }
  return { sessionId, jsonlPath, model, ...(diagnose && !model ? { failureStage: 'model' } : {}) }
}

export async function resolveOwnedCodexTranscript({
  runtimePids = [],
  agent,
  launchTs,
  resolveTranscriptImpl = resolveTranscript,
} = {}) {
  const acceptTranscript = path =>
    codexRolloutBelongsToAgent(path, agent)
    || (!codexRolloutHasOwnerEvidence(path) && codexRolloutMatchesLaunch(path, agent, launchTs))
  for (const pid of runtimePids) {
    const owned = await resolveTranscriptImpl({
      pid,
      kind: 'codex',
      agent,
      launchTs,
      acceptTranscript,
    })
    if (owned) return owned
  }
  if (!runtimePids.length) return null
  return await resolveTranscriptImpl({
    pid: runtimePids[0],
    kind: 'codex',
    agent,
    launchTs,
    acceptTranscript,
  })
}

export function codexRuntimeCandidates({ panePids = [], children = new Map(), runtimes = new Set() } = {}) {
  const ordered = []
  const seen = new Set()
  function visit(pid) {
    if (seen.has(pid)) return
    seen.add(pid)
    for (const child of children.get(pid) || []) visit(child)
    if (runtimes.has(pid)) ordered.push(pid)
  }
  for (const pid of panePids) visit(pid)
  return ordered
}

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function tomlBasicString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function cenv(key, value) {
  return `-c ${sq(`mcp_servers.tlda.env.${key}=${tomlBasicString(value)}`)}`
}

function cprojectTrust(cwd) {
  if (!cwd) return null
  const project = fs.realpathSync(cwd)
  return `-c ${sq(`projects.${tomlBasicString(project)}.trust_level="trusted"`)}`
}

function appendLaunchFlags(parts, harnessOptions = {}) {
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag !== 'string' || !flag.trim()) continue
    if (!parts.includes(flag)) parts.push(flag)
  }
}

function passthroughConfigEnv(env = {}) {
  return ['TLDA_CONFIG_DIR', 'TLDA_DAEMON_CONFIG_DIR', 'CODEX_SESSIONS_DIR']
    .filter(key => env[key])
    .map(key => [key, String(env[key])])
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
  localAgentId,
  tmuxSession,
  model,
  name,
  cwd,
  api,
  dnsAlias = null,
  resumeId = null,
  env = process.env,
  config = {},
  harnessOptions = {},
} = {}) {
  const processEnv = [
    ...Object.entries(harnessOptions.env || {}).map(([key, value]) => `${key}=${sq(value)}`),
    'CODEX_CI=1',
    ...(fleetId ? [`FLEET_ID=${sq(fleetId)}`] : []),
    ...(localAgentId ? [`FLEET_LOCAL_ID=${sq(localAgentId)}`] : []),
    ...(localAgentId ? [`FLEET_MINT_ID=${sq(localAgentId)}`] : []),
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=codex',
    'TLDA_MCP_FLEET_ONLY=1',
  ]
  // Fresh spawn names can still be tentative before server confirm/rename;
  // GIT_AUTHOR_EMAIL carries the stable fleet id for authoritative attribution.
  processEnv.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  if (name) processEnv.push(`FLEET_NAME=${sq(name)}`)
  if (env.TLDA_MACHINE_ID) processEnv.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  for (const [key, value] of passthroughConfigEnv(env)) processEnv.push(`${key}=${sq(value)}`)
  const dnsAliasPreload = dnsAlias ? dnsAliasPreloadPath() : null
  if (dnsAlias && dnsAliasPreload) {
    processEnv.push(`NODE_OPTIONS=${sq(`--require=${dnsAliasPreload}`)}`)
    processEnv.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    processEnv.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  const parts = [...processEnv, 'codex', '--no-alt-screen']
  const trustOverride = cprojectTrust(cwd)
  if (trustOverride) parts.push(trustOverride)
  if (resumeId) parts.push(`resume ${sq(resumeId)}`)
  parts.push(cenv('CODEX_CI', '1'))
  if (fleetId) parts.push(cenv('FLEET_ID', fleetId))
  if (localAgentId) parts.push(cenv('FLEET_LOCAL_ID', localAgentId))
  if (localAgentId) parts.push(cenv('FLEET_MINT_ID', localAgentId))
  if (name) parts.push(cenv('FLEET_NAME', name))
  parts.push(cenv('FLEET_HARNESS', 'codex'))
  parts.push(cenv('FLEET_TMUX_SESSION', tmuxSession))
  parts.push(cenv('TLDA_MCP_FLEET_ONLY', '1'))
  const configName = activeEnvName(config, env)
  if (configName) parts.push(cenv('TLDA_ENV', configName))
  if (env.TLDA_MACHINE_ID) parts.push(cenv('TLDA_MACHINE_ID', env.TLDA_MACHINE_ID))
  if (env.TLDA_MACHINE_ID && configName) parts.push(cenv('FLEET_DAEMON_KEY', `${env.TLDA_MACHINE_ID}:${configName}`))
  for (const [key, value] of passthroughConfigEnv(env)) parts.push(cenv(key, value))
  if (dnsAlias && dnsAliasPreload) {
    parts.push(cenv('NODE_OPTIONS', `--require=${dnsAliasPreload}`))
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
  const id = handle?.rolloutId || null
  if (!id) return null
  const match = String(id).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return match ? match[1] : id
}

export function kickoffPrompt(name) {
  return `${loginPrompt()} Then, before task work, read the project guidance in AGENTS.md if it exists. Do not read CLAUDE.md; in this repo it is a template source for AGENTS.md, not agent-facing guidance. Follow the guidance you find. If a tlda MCP tool blocks on required skill(s), read each named skill with skill("<name>") or dismiss it with a specific reason, then retry the blocked tool. Non-Claude guidance contract: respond in the visible channel before acting when the user is waiting; browser-visible or user-visible reports are ground truth; do not claim fixed or done without checking the right surface; do not ask the user to verify routine fixes you can verify; if corrected, stop and change course before continuing; proof obligations are requirements, not optional suggestions.`
}
