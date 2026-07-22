/**
 * Shared configuration — single source of truth for server URL, tokens, and config loading.
 *
 * Every entry point (CLI, daemon, MCP server, bots, bridges) imports from here.
 * No more 6 independent implementations of getServerUrl() with different fallback chains.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse as parseYaml } from 'yaml'

// Preview servers receive an isolated config directory from `tlda-dev serve`.
// Production keeps the normal shared location; previews must never mutate it.
const CONFIG_DIR = process.env.TLDA_CONFIG_DIR || join(homedir(), '.config', 'tlda')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export const DEFAULT_PORT = 5176

export { CONFIG_DIR, CONFIG_FILE }

/**
 * Load config from ~/.config/tlda/config.json.
 * Throws on parse errors instead of silently returning {}.
 * Returns {} only if the file doesn't exist.
 */
export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {}
  const raw = readFileSync(CONFIG_FILE, 'utf8')
  return JSON.parse(raw)
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

/**
 * Server URL resolution.
 * TLDA_SERVER env → config.server → local default. The local default is
 * https://localhost:5176 when mkcert localhost certs are present, otherwise
 * http://localhost:5176.
 *
 * The CLI adds --server flag support on top of this via getFlag().
 */
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
 * Model (git-style): config.configs is a map of named configs, each a COMPLETE
 * { database, store, licenseKey }. config.defaultConfig names the active one
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

function loadDaemonYaml() {
  if (!existsSync(DAEMON_FILE)) throw new Error(`tlda config: ${DAEMON_FILE} not found`)
  try {
    return parseYaml(readFileSync(DAEMON_FILE, 'utf8')) || {}
  } catch (e) {
    throw new Error(`daemon.yaml is malformed: ${e.message}`)
  }
}

/**
 * Resolve the active server from daemon.yaml `servers:` — the single source of
 * truth for "which server this machine talks to" (config.json is gone). The
 * active server is TLDA_CONFIG or daemon.yaml `defaultServer`. Each server entry
 * is { database, store } (a bare `url` is accepted as both); `licenseKey` is a
 * top-level daemon.yaml key shared by all servers. Same return shape as before,
 * so every caller (getServerUrl/getFleetServerUrl/coherence) is unchanged.
 */
export function resolveConfig() {
  const d = loadDaemonYaml()
  const name = process.env.TLDA_CONFIG || d.defaultServer
  if (!name) throw new Error('tlda config: no active server — set "defaultServer" in daemon.yaml (or TLDA_CONFIG)')
  const raw = d.servers && d.servers[name]
  if (!raw) throw new Error(`tlda config: no server named "${name}" in daemon.yaml servers — known: ${Object.keys(d.servers || {}).join(', ') || '(none)'}`)
  const database = raw.database || raw.url
  const store = raw.store || raw.database || raw.url
  const licenseKey = raw.licenseKey || d.licenseKey
  for (const [field, val] of [['database', database], ['store', store], ['licenseKey', licenseKey]]) {
    if (typeof val !== 'string') {
      throw new Error(`tlda server "${name}": "${field}" must resolve to a string (check daemon.yaml servers.${name} and top-level licenseKey).`)
    }
  }
  return {
    name,
    database: { http: _httpForm(database), ws: _wsForm(database) },
    store: { http: _httpForm(store), ws: _wsForm(store) },
    licenseKey,
  }
}

/** Server URL = the active config's STORE (doc assets + shape sync) over http. */
export function getServerUrl(config = null) {
  return resolveConfig(config).store.http
}

/** Fleet/event-store URL = the active config's DATABASE (chat/agents) over http. */
export function getFleetServerUrl(config = null) {
  return resolveConfig(config).database.http
}

/** The active config's name — what TLDA_CONFIG/defaultConfig selected. */
export function getActiveConfigName(config = null) {
  return resolveConfig(config).name
}

/**
 * Coherence guard — fail loud when an explicit TLDA_SERVER URL disagrees with
 * the active config's resolved origin. This is the tripwire for the 6/27
 * config-split: a stray defaultConfig (or a hand-pinned TLDA_SERVER) routing a
 * process to a different server than the rest of the fleet, silently. The one
 * selector is TLDA_CONFIG (or defaultConfig) — every axis derives from it; a
 * leftover TLDA_SERVER that points somewhere else means the process refuses to
 * start rather than join a roster nobody else is on.
 *
 * Internal exception: launch harnesses project TLDA_SYNC_SERVER as the
 * room/signal/shapes transport target. It is not a user-facing config selector;
 * operators select complete named configs for database/store. (Read doc
 * assets from one origin, sync shapes to another — the published triage clone).
 * When it's set, we don't force TLDA_SERVER to match the active config.
 *
 * This THROWS — never catch-and-log. A coherent boot is the contract; every
 * entry point (daemon, MCP, server) calls this at startup. Checks store.http
 * (the historical meaning of TLDA_SERVER, and === database.http in every config
 * today); if the two axes ever split, TLDA_SERVER — a single URL — can't name
 * both, so store is the right one to pin.
 */
export function assertServerCoherence(config = null) {
  const envServer = process.env.TLDA_SERVER
  if (!envServer) return
  if (process.env.TLDA_SYNC_SERVER) return // internal harness-projected room target — see docs/live-deploy.md
  const resolved = resolveConfig(config)
  const want = resolved.store.http
  const got = _httpForm(envServer)
  if (got !== want) {
    throw new Error(
      `tlda config incoherent: TLDA_SERVER=${got} but active config "${resolved.name}" resolves to ${want}. ` +
      `Don't pin a server by URL — select a server with TLDA_CONFIG=<name> (or fix "defaultServer" in daemon.yaml).`
    )
  }
}

/**
 * RW token resolution. Used by agents, daemon, CLI — anything that writes.
 * TLDA_TOKEN env → config.tokenRw → config.token → null
 */
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json')

/** Tokens live in their own tokens.json — NOT in config.json or daemon.yaml. */
function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function getRwToken() {
  return process.env.TLDA_TOKEN || loadTokens().tokenRw || loadTokens().token || null
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

const BOTS_FILE = join(CONFIG_DIR, 'bots.yaml')

/**
 * Managed bots for this machine, read directly from bots.yaml — the single
 * source of truth. Bots are independent, launchd-owned services; the daemon
 * does not manage them. Each entry: { name, script, machine_id?, server? }
 * where `script` is absolute or repo-relative, `machine_id` optionally pins the
 * bot to one machine, and `server` names an entry in daemon.yaml `servers:`
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
