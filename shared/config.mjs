/**
 * Shared configuration — single source of truth for server URL, tokens, and config loading.
 *
 * Every entry point (CLI, daemon, MCP server, bots, bridges) imports from here.
 * No more 6 independent implementations of getServerUrl() with different fallback chains.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.config', 'tlda')
const CONFIG_FILE = process.env.TLDA_CONFIG_FILE || join(CONFIG_DIR, 'config.json')

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

export function resolveConfig(config = null) {
  const cfg = config ?? loadConfig()
  const name = process.env.TLDA_CONFIG || cfg.defaultConfig
  if (!name) throw new Error('tlda config: no active config — set "defaultConfig" in config.json (or TLDA_CONFIG)')
  const raw = cfg.configs && cfg.configs[name]
  if (!raw) throw new Error(`tlda config: no config named "${name}" — known: ${Object.keys(cfg.configs || {}).join(', ') || '(none)'}`)
  for (const field of ['database', 'store', 'licenseKey']) {
    if (typeof raw[field] !== 'string') {
      throw new Error(`tlda config "${name}": field "${field}" must be a string (got ${typeof raw[field]}). Configs are complete — no field is optional.`)
    }
  }
  return {
    name,
    database: { http: _httpForm(raw.database), ws: _wsForm(raw.database) },
    store: { http: _httpForm(raw.store), ws: _wsForm(raw.store) },
    licenseKey: raw.licenseKey,
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

/**
 * RW token resolution. Used by agents, daemon, CLI — anything that writes.
 * TLDA_TOKEN env → config.tokenRw → config.token → null
 */
export function getRwToken(config = null) {
  if (process.env.TLDA_TOKEN) return process.env.TLDA_TOKEN
  const cfg = config ?? loadConfig()
  return cfg.tokenRw || cfg.token || null
}

/**
 * Read token resolution. Used by server auth.
 * TLDA_TOKEN_READ env → config.tokenRead → null
 */
export function getReadToken(config = null) {
  if (process.env.TLDA_TOKEN_READ) return process.env.TLDA_TOKEN_READ
  const cfg = config ?? loadConfig()
  return cfg.tokenRead || null
}

/**
 * Background bots the server keeps alive — a configurable list of managed
 * processes. Each is just a script that talks to the fleet API; tlda doesn't
 * special-case any of them. Each entry: { name, script } where `script` is
 * absolute or repo-relative (the supervisor resolves it). config.bots overrides;
 * the default is the shipped example bot, Todd. Write your own by adding an entry.
 */
export function getManagedBots(config = null) {
  const cfg = config ?? loadConfig()
  if (Array.isArray(cfg.bots)) return cfg.bots
  return [{ name: 'todd', script: 'bin/todd.mjs' }]
}
