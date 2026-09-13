import { resolveModelSpec } from '../models.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { activeEnvName, repoRoot } from '../identity.mjs'
import { exactTmuxWindowTarget } from '../../shared/tmux-target.mjs'
import { SYSTEM_MARKER } from '../../shared/terminal-system-markers.mjs'

const execFileP = promisify(execFile)

export const loginPrompt = () => `${SYSTEM_MARKER} Call mcp__tlda__login exactly once, then mcp__tlda__inbox exactly once. Stop after those results or the first error. Do not call any other tools.`

export const capabilities = Object.freeze({
  headlessJson: true,
  nativeResume: true,
  nativeCancellation: true,
  fleetReady: true,
  fleetBlocker: null,
})

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function resolveModelSelection(model, options = {}) {
  const spec = resolveModelSpec(model, options)
  if (spec.harness !== 'muse') {
    throw new Error(`daemon model "${model}" is configured for harness "${spec.harness}", not "muse"`)
  }
  return { model: spec.id, provider: spec.provider, alias: spec.alias, tags: spec.tags, table: 'daemon', spec }
}

export function resolveModel(model, options = {}) {
  return resolveModelSelection(model, options).model
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

export function buildArgs({
  model,
  cwd,
  effort,
  prompt,
  headless = false,
  resumeId: previous = null,
  freshSessionId = null,
  harnessOptions = {},
} = {}) {
  if (!model) throw new Error('Muse model is required')
  if (!cwd) throw new Error('Muse workspace is required')
  if (headless && previous) throw new Error('Muse exec has no verified resume flag; use native resume or MSP session/resume')
  if (freshSessionId && !headless) throw new Error('Exact session IDs are supported by Muse exec and MSP, not the verified TUI flags')
  const args = headless ? ['exec', '--json'] : []
  args.push('--model', model, '--workspace', cwd)
  if (effort) args.push('--reasoning-effort', effort)
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag === 'string' && flag.trim()) args.push(flag)
  }
  if (freshSessionId) args.push('--session-id', freshSessionId)
  if (previous) {
    if (prompt) throw new Error('A prompt on Muse resume has not been verified; resume without injecting a new turn')
    args.push('resume', previous)
  } else if (prompt != null) args.push(prompt)
  return args
}

export function buildCmd(options = {}) {
  if (!capabilities.fleetReady && (options.fleetId || options.localAgentId)) throw new Error(capabilities.fleetBlocker)
  const fleet = !!(options.fleetId || options.localAgentId)
  const args = buildArgs({ ...options, prompt: options.prompt ?? (fleet && options.includePrompt !== false && !options.resumeId ? loginPrompt() : undefined) })
  const launchEnv = { ...(options.harnessOptions?.env || {}) }
  for (const key of ['META_API_KEY', 'OPENROUTER_API_KEY']) {
    if (Object.hasOwn(launchEnv, key)) throw new Error('Use muse login for native Meta account authentication, not launch configuration credentials')
  }
  if (fleet) Object.assign(launchEnv, prepareFleetConfig(options))
  const assignments = Object.entries(launchEnv).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`)
    return `${key}=${sq(value)}`
  })
  const command = [
    ...assignments,
    'muse',
    ...args.map(sq),
  ].join(' ')
  return `zsh -lc ${sq(`unset META_API_KEY; ${command}`)}`
}

export function prepareFleetConfig({ fleetId, localAgentId, tmuxSession, name, env = process.env, harnessOptions = {} }) {
  const sourceEnv = { ...env, ...(harnessOptions.env || {}) }
  const sourceRoot = sourceEnv.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const identity = localAgentId || fleetId
  const root = path.join(sourceEnv.TMPDIR || os.tmpdir(), 'tlda-muse-launch', encodeURIComponent(identity))
  const target = path.join(root, 'muse')
  const auth = path.join(sourceRoot, 'muse', 'auth.json')
  if (!fs.existsSync(auth)) throw new Error('Muse native account login is missing; run muse login using the configured XDG_CONFIG_HOME')
  const inherited = path.join(sourceRoot, 'muse', 'settings.json')
  const settings = fs.existsSync(inherited) ? JSON.parse(fs.readFileSync(inherited, 'utf8')) : { schema_version: 1 }
  settings.provider = 'meta'
  delete settings.endpoint_transport
  delete settings.model_catalog
  const mcpEnv = {
    FLEET_ID: fleetId || '',
    FLEET_LOCAL_ID: localAgentId || '',
    FLEET_MINT_ID: localAgentId || '',
    FLEET_HARNESS: 'muse',
    FLEET_NAME: name || '',
    FLEET_TMUX_SESSION: tmuxSession || '',
    CLAUDE_SESSION: '',
    TLDA_ENV: activeEnvName(null, sourceEnv),
  }
  for (const key of ['TLDA_CONFIG_DIR', 'TLDA_DAEMON_CONFIG_DIR', 'TLDA_MACHINE_ID']) {
    if (sourceEnv[key]) mcpEnv[key] = sourceEnv[key]
  }
  if (sourceEnv.TLDA_MACHINE_ID) mcpEnv.FLEET_DAEMON_KEY = `${sourceEnv.TLDA_MACHINE_ID}:${mcpEnv.TLDA_ENV}`
  settings.mcpServers = {
    ...(settings.mcpServers || {}),
    tlda: {
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(repoRoot(), 'mcp-server', 'index.mjs')],
      env: mcpEnv,
      framing: 'line_delimited_json',
    },
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  const authLink = path.join(target, 'auth.json')
  if (!fs.existsSync(authLink)) fs.symlinkSync(auth, authLink)
  return { ...mcpEnv, XDG_CONFIG_HOME: root }
}

// Where Muse records the session a running process owns.
//
// The three resolvers differ only in this, and Muse's is the tightest of them:
// Claude's bounds candidate transcripts by launch timestamp, while a live Muse
// process holds `.session.lock` OPEN inside its own session directory, so the
// id is read off a held descriptor rather than inferred. Two Muse agents
// launched in the same second are still unambiguous.
//
// `model` and `cwd` come off the observed argv rather than a second store,
// because `buildArgs` puts `--model` and `--workspace` there.
//
// CONTRACT DIFFERENCE, deliberate: claude.mjs returns `jsonlPath`, a
// Claude-style JSONL transcript. This returns `sessionDir` and `logPath`, and
// `logPath` is the `cli-*.log` the process holds open -- NOT that format.
// Whoever wires this into the launch path must establish what reads it before
// arming an activity watcher on it; it is named differently here so the shape
// cannot be assumed.
const MUSE_RUNTIME = /(?:^|\s|[/\\])muse(?:-bin-[\w.-]+)?(?:\.exe)?(?:\s|$)/
const SESSION_DIR = /(\/\S*\/sessions\/\d{4}\/\d{2}\/\d{2}\/([0-9a-fA-F-]{36}))\//

function argFlag(args, flag) {
  const m = String(args).match(new RegExp(`(?:^|\\s)${flag}[= ](?:"([^"]+)"|'([^']+)'|(\\S+))`))
  return m ? (m[1] || m[2] || m[3] || null) : null
}

function ownedRuntimePid(panePids, psText) {
  const children = new Map()
  const argsByPid = new Map()
  for (const line of psText.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, ppid, args] = match
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    argsByPid.set(pid, args)
  }
  const stack = [...panePids]
  const seen = new Set()
  const owned = []
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    if (MUSE_RUNTIME.test(argsByPid.get(pid) || '')) owned.push(pid)
    stack.push(...(children.get(pid) || []))
  }
  // Exactly one, for the reason claude.mjs requires it: two owned runtimes mean
  // the pane is not evidence about which session belongs to this agent.
  return owned.length === 1 ? { pid: owned[0], args: argsByPid.get(owned[0]) || '' } : null
}

export async function resolveLiveSessionIdentity({ tmuxSession, tmuxArgs = [], tmuxSocket = null, _deps = {} } = {}) {
  const run = _deps.execFile || execFileP
  if (!tmuxSession) return null
  const prefix = tmuxSocket ? ['-S', tmuxSocket] : tmuxArgs
  let panePids
  try {
    const { stdout } = await run('tmux', [...prefix, 'list-panes', '-t', exactTmuxWindowTarget(tmuxSession), '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' })
    panePids = stdout.trim().split('\n').filter(Boolean)
  } catch { return null }
  if (!panePids.length) return null
  let psText
  try {
    ;({ stdout: psText } = await run('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
  } catch { return null }
  const runtime = ownedRuntimePid(panePids, psText)
  if (!runtime) return null
  let lsofText
  try {
    ;({ stdout: lsofText } = await run('lsof', ['-p', runtime.pid], { timeout: 5000, encoding: 'utf8' }))
  } catch { return null }
  let sessionDir = null
  let sessionId = null
  let logPath = null
  for (const line of lsofText.split('\n')) {
    const dir = line.match(SESSION_DIR)
    if (!dir) continue
    if (!sessionId && line.endsWith('/.session.lock')) {
      sessionDir = dir[1]
      sessionId = dir[2]
    }
    if (!logPath && /\/cli-[0-9a-fA-F-]+\.log$/.test(line)) logPath = line.slice(line.indexOf(dir[1]))
  }
  // The held lock is the identity. Without it there is no session to name, and
  // this returns null rather than guessing from the directory's newest entry --
  // a missing identity has to stay missing.
  if (!sessionId) return null
  return {
    sessionId,
    sessionDir,
    logPath,
    model: argFlag(runtime.args, '--model'),
    cwd: argFlag(runtime.args, '--workspace'),
  }
}
