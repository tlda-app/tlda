import { resolveModelSpec } from '../models.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { activeEnvName, repoRoot } from '../identity.mjs'
import { exactTmuxWindowTarget } from '../../shared/tmux-target.mjs'
import { SYSTEM_MARKER } from '../../shared/terminal-system-markers.mjs'
import { museSessionIdFromPath, museTranscriptPathForSession, resolveTranscript } from '../../agent-runtime/resolve-transcript.mjs'
import { soleOwnedRuntime } from '../process-tree.mjs'

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
    if (Object.hasOwn(launchEnv, key)) throw new Error('Provider credentials must come from the deployment environment, not daemon model configuration')
  }
  if (fleet) Object.assign(launchEnv, prepareFleetConfig(options))
  const assignments = Object.entries(launchEnv).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`)
    return `${key}=${sq(value)}`
  })
  // The launch environment has to agree with the auth decision, and it did not.
  //
  // `prepareFleetConfig` decides from the DAEMON's environment: a key there is a
  // deployment credential, so use it; no key means fall back to the account and
  // symlink its auth. But the command runs under `zsh -lc`, a LOGIN shell, which
  // sources the operator's profile -- and on a developer box that profile sets
  // META_API_KEY. So the daemon decided "account" and the child got the key
  // anyway, and muse prefers a key over an account login.
  //
  // Measured 2026-09-13: testing daemon env has no META_API_KEY, every launched
  // muse child had one, and every fresh mint died on `402 Billing verification
  // failed` while a perfectly good account login sat unused beside it.
  //
  // So unset it exactly when we decided not to use it. Two conditions, and the
  // second was caught by an existing test rather than by me:
  //
  //   - not unconditionally: that was the state before API-key support landed,
  //     and it would break the deployment case the moment a key is usable.
  //   - fleet launches only: `prepareFleetConfig` is what makes the auth
  //     decision, and it only runs for a fleet launch. A direct `muse` command
  //     has no decision to agree with, so stripping the operator's own key there
  //     would be this same defect pointing the other way.
  const unset = fleet && !launchEnvHasApiKey(options) ? 'unset META_API_KEY; ' : ''
  const command = [
    ...assignments,
    'muse',
    ...args.map(sq),
  ].join(' ')
  return `zsh -lc ${sq(`${unset}${command}`)}`
}

// The one place the auth decision is made, so `buildCmd` and `prepareFleetConfig`
// cannot drift into disagreeing about it again.
//
// Named for what it COMPUTES, not for what it currently means. It answers "does
// the launching process see a key", and today that process is the daemon, so it
// coincides with "is a deployment credential in use". Those diverge the moment
// anything other than the daemon launches muse -- the key reaching the child
// comes from the operator's profile via the login shell, not from here. Do not
// read it as a statement about deployment.
export function launchEnvHasApiKey({ env = process.env, harnessOptions = {} } = {}) {
  return Boolean({ ...env, ...(harnessOptions.env || {}) }.META_API_KEY)
}

export function prepareFleetConfig({ fleetId, localAgentId, tmuxSession, name, env = process.env, harnessOptions = {} }) {
  const sourceEnv = { ...env, ...(harnessOptions.env || {}) }
  const sourceRoot = sourceEnv.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const identity = localAgentId || fleetId
  const root = path.join(sourceEnv.TMPDIR || os.tmpdir(), 'tlda-muse-launch', encodeURIComponent(identity))
  const target = path.join(root, 'muse')
  const auth = path.join(sourceRoot, 'muse', 'auth.json')
  const usesApiKey = launchEnvHasApiKey({ env, harnessOptions })
  if (!usesApiKey && !fs.existsSync(auth)) throw new Error('Muse authentication is missing; set META_API_KEY in the deployment environment or run muse login using the configured XDG_CONFIG_HOME')
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
  if (!usesApiKey) {
    const authLink = path.join(target, 'auth.json')
    if (!fs.existsSync(authLink)) fs.symlinkSync(auth, authLink)
  }
  return { ...mcpEnv, XDG_CONFIG_HOME: root }
}

// Where Muse records the session a running process owns.
//
// RETRACTED, and recorded because it was written here as fact: an earlier
// version of this comment claimed Muse had "the tightest mapping of the
// three". It did not -- it was the shared open-fd technique reimplemented by
// hand, and codex has had that since a June spike. The resolution now goes
// through `resolveTranscript`, whose PRIMARY path is exactly this: the file
// the runtime pid holds open that the adapter recognises.
//
// `model` and `cwd` come off the observed argv rather than a second store,
// because `buildArgs` puts `--model` and `--workspace` there.
//
// Returns `jsonlPath` like claude.mjs does, but it is DERIVED rather than
// observed: muse holds no descriptor on its transcript, so the adapter binds
// the identity file and the transcript path is computed from the id.
//
// This comment used to describe `sessionDir` and `logPath`. Both were dropped
// once a grep showed nothing read them -- a grep that was scoped to this
// branch and missed a consumer on `muse-activity-ingest`, which is why
// `jsonlPath` is here.
const MUSE_RUNTIME = /(?:^|\s|[/\\])muse(?:-bin-[\w.-]+)?(?:\.exe)?(?:\s|$)/

function argFlag(args, flag) {
  const m = String(args).match(new RegExp(`(?:^|\\s)${flag}[= ](?:"([^"]+)"|'([^']+)'|(\\S+))`))
  return m ? (m[1] || m[2] || m[3] || null) : null
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
  // Exactly one, for the reason claude.mjs requires it: two owned runtimes mean
  // the pane is not evidence about which session belongs to this agent.
  const runtime = soleOwnedRuntime(panePids, psText, args => MUSE_RUNTIME.test(args))
  if (!runtime) return null
  // `processOwnedOnly` because a missing identity has to stay missing: the
  // adapter's launch-window fallback would pick the newest runtime json under
  // a shared root, which is a guess, and this resolver has never guessed.
  const open = await resolveTranscript({
    pid: runtime.pid,
    kind: 'muse',
    processOwnedOnly: true,
    ...(_deps.findOpenTranscript ? { findOpenTranscript: _deps.findOpenTranscript } : {}),
  })
  const sessionId = museSessionIdFromPath(open)
  if (!sessionId) return null
  return {
    sessionId,
    // The transcript, not the identity file the adapter bound. These are two
    // different files on muse; see `museTranscriptPathForSession`. Named
    // `jsonlPath` to match claude.mjs, because that is the field anything
    // tailing a session's activity already reads.
    jsonlPath: (_deps.transcriptPath || museTranscriptPathForSession)(sessionId),
    model: argFlag(runtime.args, '--model'),
    cwd: argFlag(runtime.args, '--workspace'),
  }
}
