import fs from 'fs'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { activeEnvName, gitAuthorEnv } from '../identity.mjs'
import { resolveAgyModel, resolveAgyModelSelection } from '../models.mjs'
import { kickoffPrompt as codexKickoffPrompt } from './codex.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'
import { exactTmuxWindowTarget } from '../../shared/tmux-target.mjs'
import { soleOwnedRuntime } from '../process-tree.mjs'

const execFileP = promisify(execFile)

// The agy CLI keeps its auth token profile under the operator's HOME
// (~/.gemini). An isolated HOME signs the session out (measured: the TUI
// shows "You are currently not signed in" and offers Google OAuth), so the
// harness always launches with the real HOME (XDG/HOME isolation, the muse
// pattern, does not apply here). Per-agent identity rides the process
// environment instead: the MCP server child inherits agy's FLEET_*,
// measured on a live spawn.
const AGY_RUNTIME = /(?:^|\s|[/\\])agy(?:\.exe)?(?:\s|$)/

export const capabilities = Object.freeze({
  headlessJson: true,
  nativeResume: true,
  nativeCancellation: false,
  fleetReady: true,
  fleetBlocker: null,
})

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
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
  return resolveAgyModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveAgyModelSelection(model, options)
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

// Same fleet kickoff contract as the other non-Claude harnesses. The text
// lives in one place (codex) so the contract cannot drift between adapters.
export function kickoffPrompt(name) {
  return codexKickoffPrompt(name)
}

// The standby rendezvous. agy's MCP tools arrive ~15s after startup while
// the --prompt-interactive turn fires at ~5s, so a bare kickoff burns its
// first turn on recon (measured: `which tlda || find / ...`, then stuck on
// a permission prompt). The prefix below sequences instead of contradicting:
// turn 1 ends as a fast harmless STANDBY42 reply, and the harness wakes the
// agent with a short follow-up once the tools are up. Framed as "do nothing"
// the model reads it as an injection against the kickoff and ignores it
// (measured); framed as step 1 of 2 it complies (measured).
export const AGY_STANDBY_MARKER = 'STANDBY42'
const AGY_STANDBY_PREFIX = 'Your tlda MCP tools arrive about 30 seconds after startup. Step 1, do it now: reply with exactly STANDBY42 and nothing else. Your actual task arrives as my next message; do not act on it until then. --- '
export function standbyKickoffPrompt(name) {
  return `${AGY_STANDBY_PREFIX}${kickoffPrompt(name)}`
}
// Short follow-up the rendezvous injects once the tools are up. Short on
// purpose: agy's composer digests ~20 chars/sec and Enter never submits a
// long single line (both measured), so the wake must stay small.
export const AGY_WAKE_LOGIN_TEXT = 'Your tlda tools are loaded. Call login() now, then follow your kickoff.'

function fleetEnvEntries({ fleetId, localAgentId, tmuxSession, name, config, env }) {
  const entries = []
  if (fleetId) entries.push(`FLEET_ID=${sq(fleetId)}`)
  if (localAgentId) entries.push(`FLEET_LOCAL_ID=${sq(localAgentId)}`)
  if (localAgentId) entries.push(`FLEET_MINT_ID=${sq(localAgentId)}`)
  entries.push(`FLEET_TMUX_SESSION=${sq(tmuxSession)}`)
  entries.push('FLEET_HARNESS=agy')
  if (name) entries.push(`FLEET_NAME=${sq(name)}`)
  if (env.TLDA_MACHINE_ID) entries.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  const configName = activeEnvName(config, env)
  if (configName) entries.push(`TLDA_ENV=${sq(configName)}`)
  if (env.TLDA_MACHINE_ID && configName) entries.push(`FLEET_DAEMON_KEY=${sq(`${env.TLDA_MACHINE_ID}:${configName}`)}`)
  for (const [key, value] of passthroughConfigEnv(env)) entries.push(`${key}=${sq(value)}`)
  return { entries, configName }
}

// Workspace trust pre-seed, the codex ensureProjectTrusted precedent: agy
// asks "Do you trust the contents of this project?" on first launch per
// cwd, and the answer persists in ~/.gemini/antigravity-cli/settings.json
// under `trustedWorkspaces` (measured: exact paths, no parent-dir
// inheritance). Pre-writing the cwd keeps the trust dialog out of the mint
// path. Merge, never overwrite: preserve operators' own settings and only
// append the project path.
export function ensureAgyProjectTrusted(cwd, home = os.homedir()) {
  if (!cwd) return false
  const project = fs.realpathSync(cwd)
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  let parsed = {}
  try {
    const text = fs.readFileSync(file, 'utf8')
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch (e) {
    if (e.code === 'ENOENT') parsed = {}
    else throw new Error(`agy refuses to overwrite unreadable settings at ${file}: ${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`agy refuses to overwrite non-object settings at ${file}`)
  }
  const trusted = parsed.trustedWorkspaces
  if (trusted !== undefined && !Array.isArray(trusted)) {
    throw new Error(`agy refuses to overwrite non-array trustedWorkspaces at ${file}`)
  }
  const list = trusted ? [...trusted] : []
  if (list.includes(project)) return false
  list.push(project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...parsed, trustedWorkspaces: list }, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return true
}

// Bare `agy` fails lookup inside the fenced shell (measured: the first
// lookup misses while an immediate retry hits, so mints die before agy ever
// runs). Resolve here, in the unsandboxed spawner, and embed the absolute
// path so the child never searches. A missing binary throws now, with the
// searched PATH in the message, instead of dying as a bare session.
function resolveAgyBinary({ pathValue }) {
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'agy')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Not executable here; keep searching.
    }
  }
  throw new Error(`agy binary not found on PATH (${pathValue || '(empty)'})`)
}

export function buildCmd({
  fleetId,
  localAgentId,
  tmuxSession,
  model,
  name,
  cwd,
  effort,
  resumeId: resume = null,
  includePrompt = true,
  dnsAlias = null,
  env = process.env,
  config = {},
  harnessOptions = {},
} = {}) {
  const { entries } = fleetEnvEntries({ fleetId, localAgentId, tmuxSession, name, config, env })
  const parts = [
    ...Object.entries(harnessOptions.env || {}).map(([key, value]) => `${key}=${sq(value)}`),
    ...entries,
  ]
  parts.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  const dnsAliasPreload = dnsAlias ? dnsAliasPreloadPath() : null
  if (dnsAlias && dnsAliasPreload) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${dnsAliasPreload}`)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  const childPath = harnessOptions?.env?.PATH ?? env?.PATH ?? process.env.PATH ?? ''
  parts.push(sq(resolveAgyBinary({ pathValue: childPath })))
  if (model) parts.push(`--model ${sq(model)}`)
  if (effort) parts.push(`--effort ${sq(effort)}`)
  if (cwd) parts.push(`--add-dir ${sq(fs.realpathSync(cwd))}`)
  if (resume) parts.push(`--conversation ${sq(resume)}`)
  // The kickoff rides --prompt-interactive, never the composer: pasted text
  // digests at ~20 chars/sec and Enter submits no long single line (both
  // measured), so paste-and-submit cannot deliver it. The standby wrapper
  // keeps turn 1 harmless until the MCP tools arrive; the rendezvous wakes
  // the agent after. On resume the same turn replays into the old
  // conversation (measured: --conversation + --prompt-interactive combine),
  // which is what drives the resumed agent to log back in.
  if (includePrompt) parts.push('--prompt-interactive', sq(standbyKickoffPrompt(name)))
  appendLaunchFlags(parts, harnessOptions)
  return parts.join(' ')
}

function lastConversationsPath(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json')
}

function summariesDbPath(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
}

// Live session identity for an agy TUI. The only owner-neutral signals agy
// records are process-shaped: exactly one `agy` runtime under the tmux pane
// (soleOwnedRuntime, the claude rule) plus the cwd-scoped last-conversation
// pointer (<cwd> -> conversation id) gated on the row's workspace URIs and
// last-modified time vs launch. Message text lives in per-conversation
// sqlite blobs (protobuf), so there is no cheap kickoff-marker owner check;
// concurrent agents sharing one workspace cwd share the pointer (last writer
// wins), the same race class as the workspace MCP file. Reported, not hidden.
export async function resolveLiveSessionIdentity({
  agent,
  tmuxSession,
  tmuxArgs = [],
  tmuxSocket = null,
  now = Date.now,
  diagnose = false,
  processOwnedOnly = false,
  _deps = {},
} = {}) {
  const unresolved = (failureStage) => diagnose ? { sessionId: null, conversationId: null, model: null, cwd: null, failureStage } : null
  const run = _deps.execFile || execFileP
  if (!tmuxSession) return unresolved('pane')
  const prefix = tmuxSocket ? ['-S', tmuxSocket] : tmuxArgs
  let paneOut
  try {
    ;({ stdout: paneOut } = await run('tmux', [...prefix, 'list-panes', '-t', exactTmuxWindowTarget(tmuxSession), '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' }))
  } catch {
    return unresolved('pane')
  }
  const panePids = paneOut.trim().split('\n').filter(Boolean)
  if (!panePids.length) return unresolved('pane')
  let psOut
  try {
    ;({ stdout: psOut } = await run('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
  } catch {
    return unresolved('pid')
  }
  const owned = soleOwnedRuntime(panePids, psOut, args => AGY_RUNTIME.test(args))
  if (!owned) return unresolved('pid')
  // processOwnedOnly is honoured by construction: the store match below is
  // required on every path, so there is no lax fallback to skip.
  void processOwnedOnly
  const rawCwd = agent?.cwd || null
  if (!rawCwd) return unresolved('cwd')
  let cwd = null
  try {
    cwd = fs.realpathSync(rawCwd)
  } catch {
    return unresolved('cwd')
  }
  let pointer = null
  try {
    const text = (_deps.readFileSync || fs.readFileSync)(_deps.lastConversationsPath || lastConversationsPath(), 'utf8')
    pointer = JSON.parse(text)
  } catch {
    return unresolved('conversations')
  }
  // The pointer is keyed by launch cwd verbatim, which may or may not have
  // symlinks resolved (/tmp vs /private/tmp on macOS): match the resolved
  // form, the raw form, then every key resolved. Measured live: the pointer
  // held /tmp/... while the row's workspace URIs held both forms.
  let conversationId = pointer?.[cwd] || pointer?.[rawCwd] || null
  if (!conversationId && pointer && typeof pointer === 'object') {
    for (const key of Object.keys(pointer)) {
      let resolvedKey = null
      try {
        resolvedKey = fs.realpathSync(key)
      } catch {
        continue
      }
      if (resolvedKey === cwd) {
        conversationId = pointer[key]
        break
      }
    }
  }
  if (!conversationId) return unresolved('conversations')
  const launchTs = Date.parse(agent?.registered_at || '') || (now() - 60_000)
  try {
    const { DatabaseSync } = _deps.sqlite || await import('node:sqlite')
    const db = new DatabaseSync(_deps.summariesDbPath || summariesDbPath(), { readOnly: true })
    try {
      const row = db.prepare(
        'SELECT conversation_id, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?',
      ).get(conversationId)
      const uris = row?.workspace_uris ? JSON.parse(row.workspace_uris) : []
      const scoped = Array.isArray(uris) && uris.some(uri => {
        try {
          const p = new URL(uri).pathname
          return p === cwd || decodeURIComponent(p) === cwd
        } catch {
          return uri === cwd || uri === `file://${cwd}`
        }
      })
      if (!scoped) return unresolved('workspace')
      const modifiedTs = row?.last_modified_time ? Date.parse(row.last_modified_time) : NaN
      if (!Number.isFinite(modifiedTs) || modifiedTs < launchTs - 60_000) return unresolved('launch')
      return { sessionId: conversationId, conversationId, model: null, cwd }
    } finally {
      db.close()
    }
  } catch {
    return unresolved('store')
  }
}
