/**
 * Shared configuration — single source of truth for server URL, tokens, and config loading.
 *
 * Every entry point (CLI, daemon, MCP server, eliza, bridges) imports from here.
 * No more 6 independent implementations of getServerUrl() with different fallback chains.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.config', 'tlda')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

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
 * TLDA_SERVER env → config.server → http://localhost:5176
 *
 * The CLI adds --server flag support on top of this via getFlag().
 */
export function getServerUrl(config = null) {
  if (process.env.TLDA_SERVER) return process.env.TLDA_SERVER
  const cfg = config ?? loadConfig()
  return cfg.server || 'http://localhost:5176'
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
