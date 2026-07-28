import fs from 'fs'
import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { resolveTranscript } from '../../agent-runtime/resolve-transcript.mjs'
import { ledgerSessionId } from '../../agent-runtime/ledger-session-tail.mjs'
import { activeEnvName, gitAuthorEnv } from '../identity.mjs'
import { resolveClaudeModel, resolveClaudeModelSelection } from '../models.mjs'
import { resolveHarnessLaunchOptions } from '../permissions.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'
import { claudeJsonlPath } from '../resume.mjs'

const LOGIN_PROMPT = 'Call login() with the tlda MCP server. Then call inbox() to check for a pending task.'
const FENCE_TMP_ROOT = '/tmp/tlda-fence-env'
const execFileP = promisify(execFile)

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
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

export function loginPrompt() {
  return LOGIN_PROMPT
}

export function resolveModel(model, options = {}) {
  return resolveClaudeModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveClaudeModelSelection(model, options)
}

export function buildCmd({
  fleetId,
  localAgentId,
  tmuxSession,
  model,
  effort,
  name,
  api,
  dnsAlias = null,
  resumeId = null,
  freshSessionId = null,
  includePrompt = true,
  env = process.env,
  config = {},
  harnessOptions = null,
} = {}) {
  const effectiveHarnessOptions = harnessOptions && Object.keys(harnessOptions).length
    ? harnessOptions
    : resolveHarnessLaunchOptions({ config, harness: 'claude', model })
  const parts = [
    ...(fleetId ? [`FLEET_ID=${sq(fleetId)}`] : []),
    ...(localAgentId ? [`FLEET_LOCAL_ID=${sq(localAgentId)}`] : []),
    ...(localAgentId ? [`FLEET_MINT_ID=${sq(localAgentId)}`] : []),
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=claude',
  ]
  if (env.TLDA_AGENT_CONFIG_DIR) parts.unshift(`TLDA_AGENT_CONFIG_DIR=${sq(env.TLDA_AGENT_CONFIG_DIR)}`)
  if (env.CLAUDE_CONFIG_DIR) parts.unshift(`CLAUDE_CONFIG_DIR=${sq(env.CLAUDE_CONFIG_DIR)}`)
  // Fresh spawn names can still be tentative before server confirm/rename;
  // GIT_AUTHOR_EMAIL carries the stable fleet id for authoritative attribution.
  parts.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  const readableLocalCert = path.join(process.env.HOME || '', '.config', 'tlda', 'localhost+2.pem')
  if (fs.existsSync(readableLocalCert)) {
    const fenceCert = path.join(FENCE_TMP_ROOT, 'localhost-ca.crt')
    try {
      fs.mkdirSync(FENCE_TMP_ROOT, { recursive: true })
      fs.copyFileSync(readableLocalCert, fenceCert)
      parts.push(`NODE_EXTRA_CA_CERTS=${sq(fenceCert)}`)
    } catch {
      // The fence may deliberately deny *.pem secrets. TLS validation is already
      // disabled for this local/tailscale dev path below, so do not point Node
      // at an unreadable cert and turn startup into an EPERM loop.
    }
  }
  parts.push('NODE_TLS_REJECT_UNAUTHORIZED=0')
  if (name) parts.push(`FLEET_NAME=${sq(name)}`)
  if (env.TLDA_MACHINE_ID) parts.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  const configName = activeEnvName(config, env)
  if (configName) parts.push(`TLDA_ENV=${sq(configName)}`)
  if (env.TLDA_MACHINE_ID && configName) parts.push(`FLEET_DAEMON_KEY=${sq(`${env.TLDA_MACHINE_ID}:${configName}`)}`)
  for (const [key, value] of passthroughConfigEnv(env)) parts.push(`${key}=${sq(value)}`)
  const fleetOauthToken = path.join(env.HOME || process.env.HOME || '', '.claude', '.fleet-oauth-token')
  if (fs.existsSync(fleetOauthToken)) {
    parts.push(`CLAUDE_CODE_OAUTH_TOKEN=$(cat ${sq(fleetOauthToken)})`)
  }
  const dnsAliasPreload = dnsAlias ? dnsAliasPreloadPath() : null
  if (dnsAlias && dnsAliasPreload) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${dnsAliasPreload}`)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  parts.push('claude')
  appendLaunchFlags(parts, effectiveHarnessOptions)
  if (resumeId) parts.push(`--resume ${sq(resumeId)}`)
  else if (freshSessionId) parts.push(`--session-id ${sq(freshSessionId)}`)
  parts.push(`--model ${sq(model)}`)
  if (effort) parts.push(`--effort ${sq(effort)}`)
  // Permission flags (--dangerously-skip-permissions / --permission-mode) are NOT
  // derived here; they come from the configured harness options via appendLaunchFlags
  // above, exactly like the codex sandbox flag. The fence (region-set lease) is the
  // security; the classifier flag is the operator's configured choice.
  if (includePrompt) parts.push(sq(loginPrompt()))
  return parts.join(' ')
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

export async function resolveLiveSessionIdentity({ agent, tmuxSession, tmuxArgs = [], tmuxSocket = null, now = Date.now, _deps = {} } = {}) {
  const run = _deps.execFile || execFileP
  const resolve = _deps.resolveTranscript || resolveTranscript
  const read = _deps.readFileSync || fs.readFileSync
  if (!tmuxSession) return null
  const prefix = tmuxSocket ? ['-S', tmuxSocket] : tmuxArgs
  let paneOut
  try {
    ;({ stdout: paneOut } = await run('tmux', [...prefix, 'list-panes', '-t', tmuxSession, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' }))
  } catch { return null }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return null
  let psOut
  try {
    ;({ stdout: psOut } = await run('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
  } catch { return null }
  const children = new Map()
  const runtimes = new Set()
  for (const line of psOut.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, ppid, args] = match
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    if (/(?:^|\s|[/\\])claude(?:\.exe)?(?:\s|$)/.test(args)) runtimes.add(pid)
  }
  const stack = [...panePids]
  const seen = new Set()
  const ownedRuntimes = []
  while (stack.length) {
    const candidate = stack.pop()
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (runtimes.has(candidate)) ownedRuntimes.push(candidate)
    stack.push(...(children.get(candidate) || []))
  }
  if (ownedRuntimes.length !== 1) return null
  const pid = ownedRuntimes[0]
  const launchTs = Date.parse(agent?.registered_at || '') || (now() - 60_000)
  const expectedSessionId = agent?.session_id || null
  const jsonlPath = await resolve({
    pid,
    kind: 'claude',
    agent,
    launchTs,
    ...(expectedSessionId ? {
      acceptTranscript: candidate => path.basename(candidate, '.jsonl') === expectedSessionId,
      findFallbackTranscript: () => claudeJsonlPath(expectedSessionId),
    } : {}),
  })
  if (!jsonlPath) return null
  const sessionId = ledgerSessionId({ harness_kind: 'claude', jsonl_path: jsonlPath }) || path.basename(jsonlPath, '.jsonl')
  let model = null
  let cwd = agent?.cwd || null
  try {
    for (const line of read(jsonlPath, 'utf8').split(/\r?\n/).slice(0, 200)) {
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
      const value = entry?.model || entry?.message?.model || entry?.payload?.model
      if (typeof value === 'string' && value.trim()) { model = value.trim(); break }
    }
  } catch { return { sessionId, jsonlPath, model: null, cwd } }
  return { sessionId, jsonlPath, model, cwd }
}

export function kickoffPrompt(name) {
  return loginPrompt()
}
