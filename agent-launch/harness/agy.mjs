import fs from 'fs'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { activeEnvName, gitAuthorEnv, repoRoot } from '../identity.mjs'
import { resolveAgyModel, resolveAgyModelSelection } from '../models.mjs'
import { kickoffPrompt as codexKickoffPrompt } from './codex.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'
import { exactTmuxWindowTarget } from '../../shared/tmux-target.mjs'
import { soleOwnedRuntime } from '../process-tree.mjs'

const execFileP = promisify(execFile)

// The agy CLI keeps its auth token profile under the operator's HOME
// (~/.gemini). An isolated HOME signs the session out (measured: the TUI
// shows "You are currently not signed in" and offers Google OAuth), so the
// harness always launches with the real HOME and wires per-agent state
// through the workspace-local MCP config instead (XDG/HOME isolation, the
// muse pattern, does not apply here).
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

function mcpEnvObject({ fleetId, localAgentId, tmuxSession, name, config, env, harnessOptions = {} }) {
  const out = { ...(harnessOptions.env || {}) }
  if (fleetId) out.FLEET_ID = fleetId
  if (localAgentId) {
    out.FLEET_LOCAL_ID = localAgentId
    out.FLEET_MINT_ID = localAgentId
  }
  out.FLEET_TMUX_SESSION = tmuxSession
  out.FLEET_HARNESS = 'agy'
  if (name) out.FLEET_NAME = name
  if (env.TLDA_MACHINE_ID) out.TLDA_MACHINE_ID = env.TLDA_MACHINE_ID
  const configName = activeEnvName(config, env)
  if (configName) out.TLDA_ENV = configName
  if (env.TLDA_MACHINE_ID && configName) out.FLEET_DAEMON_KEY = `${env.TLDA_MACHINE_ID}:${configName}`
  for (const [key, value] of passthroughConfigEnv(env)) out[key] = value
  return out
}

// Per-agent tlda MCP wiring. agy has no --mcp-config flag (claude) and no
// -c config override (codex); `agy mcp add` writes the GLOBAL config, which
// cannot carry per-agent identity. The supported per-agent path is the
// workspace-local config (<cwd>/.agents/mcp_config.json), which agy merges
// over global. Merge, never overwrite: preserve operators' own servers and
// only set the `tlda` key. Concurrent agents in one workspace share this
// file (last writer wins the tlda entry); fleet seats normally have distinct
// checkouts, and the limitation is reported, not hidden.
export function prepareWorkspaceMcp({ cwd, fleetId, localAgentId, tmuxSession, name, config = {}, env = process.env, harnessOptions = {} } = {}) {
  if (!cwd) throw new Error('agy workspace MCP config requires cwd')
  const project = fs.realpathSync(cwd)
  const dir = path.join(project, '.agents')
  const file = path.join(dir, 'mcp_config.json')
  let parsed = {}
  try {
    const text = fs.readFileSync(file, 'utf8')
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`agy refuses to overwrite unreadable workspace MCP config at ${file}: ${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`agy refuses to overwrite non-object workspace MCP config at ${file}`)
  }
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? { ...parsed.mcpServers }
    : {}
  servers.tlda = {
    command: process.execPath,
    args: [path.join(repoRoot(), 'mcp-server', 'index.mjs')],
    env: mcpEnvObject({ fleetId, localAgentId, tmuxSession, name, config, env, harnessOptions }),
  }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return file
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
  parts.push('agy')
  if (model) parts.push(`--model ${sq(model)}`)
  if (effort) parts.push(`--effort ${sq(effort)}`)
  if (cwd) parts.push(`--add-dir ${sq(fs.realpathSync(cwd))}`)
  if (resume) parts.push(`--conversation ${sq(resume)}`)
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
