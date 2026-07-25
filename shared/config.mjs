/**
 * Shared configuration — single source of truth for server URL, tokens, and config loading.
 *
 * Every entry point (CLI, daemon, MCP server, bots, bridges) imports from here.
 * No more 6 independent implementations of getServerUrl() with different fallback chains.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse as parseYaml, parseDocument } from 'yaml'
import { resolveStrictServerAuthority, validateServerConfigTopLevel } from './daemon-config-schema.mjs'

// Preview servers receive an isolated config directory from `tlda-dev serve`.
// Production keeps the normal shared location; previews must never mutate it.
const CONFIG_DIR = process.env.TLDA_CONFIG_DIR || join(homedir(), '.config', 'tlda')
export const DEFAULT_PORT = 5176

export { CONFIG_DIR }

const TLS_CERT_PATH = join(CONFIG_DIR, 'localhost+2.pem')
const TLS_KEY_PATH  = join(CONFIG_DIR, 'localhost+2-key.pem')
export const hasTls = existsSync(TLS_CERT_PATH) && existsSync(TLS_KEY_PATH)

export const TLS_CA_PATH = join(homedir(), 'Library/Application Support/mkcert/rootCA.pem')

// When TLS is enabled with mkcert, Node's built-in fetch won't trust the CA
// unless NODE_EXTRA_CA_CERTS was set before the process started. Since we only
// connect to our own localhost server, disabling cert validation is safe here.
if (hasTls && !process.env.NODE_EXTRA_CA_CERTS) {
  const origEmit = process.emit
  process.emit = function (name, data, ...args) {
    if (name === 'warning' && typeof data === 'object' && data.name === 'Warning' &&
        data.message?.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return false
    return origEmit.call(this, name, data, ...args)
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

/**
 * THE config resolver — single source of truth for "what does this instance
 * talk to." There is exactly one selection rule and one derivation; outside this
 * function nothing computes or branches on config.
 *
 * Model (git-style): server.yaml `servers` is a map of named servers, each a
 * COMPLETE { database, store, licenseKey }. `defaultServer` names the active one
 * unless TLDA_CONFIG overrides it. That single selector is the only choice.
 *
 *   database — fleet/chat/registry/agents (the one global event store)
 *   store    — shapes + doc assets sync (per-room/per-doc state)
 *   licenseKey — tldraw license ("" = explicitly unlicensed, written out)
 *
 * NO fallbacks: a missing config name or any missing field THROWS. There are no
 * legacy flat keys, no localhost default, no per-axis env overrides. A bad config
 * fails loud at startup instead of silently guessing — that unpredictability is
 * exactly what this design exists to remove.
 *
 * Returns the fully-derived config: http+ws forms computed once for each axis.
 */
function _httpForm(u) { return u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') }
function _wsForm(u) { return u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '') }

const DAEMON_FILE = join(CONFIG_DIR, 'daemon.yaml')
const SERVER_FILE = join(CONFIG_DIR, 'server.yaml')
const CLI_FILE = join(CONFIG_DIR, 'cli.yaml')

function loadDaemonYaml() {
  if (!existsSync(DAEMON_FILE)) throw new Error(`tlda config: ${DAEMON_FILE} not found`)
  try {
    return parseYaml(readFileSync(DAEMON_FILE, 'utf8')) || {}
  } catch (e) {
    throw new Error(`daemon.yaml is malformed: ${e.message}`)
  }
}

export function loadServerConfig() {
  if (!existsSync(SERVER_FILE)) throw new Error(`tlda config: ${SERVER_FILE} not found`)
  try {
    return validateServerConfigTopLevel(parseYaml(readFileSync(SERVER_FILE, 'utf8')) || {}, 'server.yaml')
  } catch (e) {
    throw new Error(`server.yaml is malformed: ${e.message}`)
  }
}

export function loadCliConfig() {
  if (!existsSync(CLI_FILE)) return {}
  const value = parseYaml(readFileSync(CLI_FILE, 'utf8')) || {}
  const extra = Object.keys(value).filter(key => key !== 'browser')
  if (extra.length) throw new Error(`cli.yaml supports only browser; unknown key(s): ${extra.join(', ')}`)
  return value
}

export function saveCliConfig(value = {}) {
  const browser = typeof value.browser === 'string' && value.browser.trim() ? value.browser.trim() : null
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CLI_FILE, browser ? `browser: ${JSON.stringify(browser)}\n` : '')
}

/**
 * Resolve the active server from server.yaml `servers:` — the single source of
 * truth for which server this machine talks to. The
 * active server is `serverName` (a string override — used to route a specific
 * bot to its declared `server:`), else TLDA_CONFIG, else server.yaml
 * `defaultServer`.
 *
 * Each server entry MUST be COMPLETE: an explicit `database`, `store`, and
 * `licenseKey` (licenseKey "" = explicitly unlicensed). There are NO fallbacks —
 * no legacy `url` shorthand, no reusing `database` as `store`, no top-level
 * `licenseKey` shared across servers. A missing/partial entry THROWS. This is the
 * whole point of the migration: one declared authority per server, no guessing.
 *
 */
export function resolveConfig(serverName = null) {
  const { name, raw } = resolveStrictServerAuthority(loadServerConfig(), serverName)
  const { database, store, licenseKey } = raw
  return {
    name,
    database: { http: _httpForm(database), ws: _wsForm(database) },
    store: { http: _httpForm(store), ws: _wsForm(store) },
    licenseKey,
  }
}

/** Server URL = the active config's STORE (doc assets + shape sync) over http. */
export function getServerUrl(serverName = null) {
  return resolveConfig(serverName).store.http
}

/** Fleet/event-store URL = the active config's DATABASE (chat/agents) over http. */
export function getFleetServerUrl(serverName = null) {
  return resolveConfig(serverName).database.http
}

/** The active server's name — what TLDA_CONFIG/defaultServer selected. */
export function getActiveConfigName(serverName = null) {
  return resolveConfig(serverName).name
}

/**
 * RW token resolution. Used by agents, daemon, CLI — anything that writes.
 * TLDA_TOKEN env → config.tokenRw → config.token → null
 */
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json')

/**
 * Tokens live in their own tokens.json — NOT in config.json or daemon.yaml.
 * An absent file means "no tokens here" (env may still supply one). A file that
 * EXISTS but is malformed JSON is a real misconfiguration and THROWS loudly —
 * silently treating a corrupt tokens.json as "no token" would strand every
 * authenticated caller with an opaque 401 instead of the actual cause.
 */
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {}
  const raw = readFileSync(TOKENS_FILE, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`tokens.json is malformed: ${e.message}`)
  }
}

export function getRwToken() {
  const t = loadTokens()
  return process.env.TLDA_TOKEN || t.tokenRw || t.token || null
}

/**
 * Read token resolution. Used by server auth.
 * TLDA_TOKEN_READ env → config.tokenRead → null
 */
export function getReadToken() {
  return process.env.TLDA_TOKEN_READ || loadTokens().tokenRead || null
}

/** Write tokens to tokens.json — their own file, never config.json/daemon.yaml. */
export function saveTokens(tokens) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2))
}

/** This machine's id, from daemon.yaml `machineId` (TLDA_MACHINE_ID env wins). */
export function getMachineId() {
  return process.env.TLDA_MACHINE_ID || loadDaemonYaml().machineId || null
}

/**
 * How often the daemon polls each box for agent status — `statusScanSeconds` in
 * daemon.yaml. This is the loop that runs `list-sessions` (who is running) and
 * `capture-pane` (what each agent is doing), so it is the cadence of the whole
 * liveness picture.
 *
 * Skip, 2026-07-25, setting it himself:
 *
 *   "We use list-sessions for who's running and capture-pane for what an agent
 *    is doing, and we do that at every two or three second polling interval.
 *    It's a cheap operation and there's no reason not to do it."
 *
 * A named setting with no env var and no silent default — it replaces
 * `TLDA_STATUS_SCAN_MS ... || 5000`, which is the generic-config-fallback
 * pattern that is meant to be gone. A missing or non-positive value throws
 * rather than quietly picking a number nobody chose.
 */
export function getStatusScanMs() {
  const seconds = loadDaemonYaml().statusScanSeconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`daemon.yaml: statusScanSeconds must be a positive number (got ${JSON.stringify(seconds)})`)
  }
  return Math.round(seconds * 1000)
}

/**
 * Persist a derived machineId into daemon.yaml (top-level `machineId`), used once
 * on a fresh host when it is unset. config.json is retired — the id lives with
 * the rest of the daemon's identity in daemon.yaml. Writes via the yaml Document
 * API so existing comments/structure are preserved, not flattened.
 */
export function saveMachineId(id) {
  const doc = existsSync(DAEMON_FILE)
    ? parseDocument(readFileSync(DAEMON_FILE, 'utf8'))
    : parseDocument('')
  doc.set('machineId', id)
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(DAEMON_FILE, String(doc))
}

const BOTS_FILE = join(CONFIG_DIR, 'bots.yaml')

/**
 * Managed bots for this machine, read directly from bots.yaml — the single
 * source of truth. Bots are independent, launchd-owned services; the daemon
 * does not manage them. Each entry: { name, script, machine_id?, server? }
 * where `script` is absolute or repo-relative, `machine_id` optionally pins the
 * bot to one machine, and `server` names an entry in server.yaml `servers:`
 * (omit for the machine default). No config.json fallback — if bots.yaml is
 * absent there are no managed bots; a malformed bots.yaml throws loudly.
 */
export function getManagedBots() {
  if (!existsSync(BOTS_FILE)) return []
  let doc
  try {
    doc = parseYaml(readFileSync(BOTS_FILE, 'utf8'))
  } catch (e) {
    throw new Error(`bots.yaml is malformed: ${e.message}`)
  }
  return Array.isArray(doc?.bots) ? doc.bots : []
}
