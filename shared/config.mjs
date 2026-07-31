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
import { resolveStrictEnvironmentAuthority, validateServerConfigTopLevel } from './daemon-config-schema.mjs'

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
 * Model (git-style): daemon.yaml `environments.values` is a map of named
 * environments, each a COMPLETE { database, store, licenseKey }.
 * `environments.default` names the active one unless TLDA_ENV overrides it.
 * That single selector is the only choice.
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
function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

const DAEMON_FILE = join(CONFIG_DIR, 'daemon.yaml')
const SERVER_FILE = join(CONFIG_DIR, 'server.yaml')
const CLI_FILE = join(CONFIG_DIR, 'cli.yaml')

/**
 * A missing config file means a fresh install, not a corrupt one — the only
 * thing wrong is that nobody has created it yet. Name the command that creates
 * it, so someone who has never read the README is one line from unblocked
 * instead of staring at the path of a file they have never heard of.
 *
 * This does NOT weaken the rule above: the load still throws, and nothing here
 * guesses a default. It only makes the failure say what to do next.
 */
function missingConfigError(file) {
  return new Error(`tlda config: ${file} not found — run \`tlda config init\` to create a starter config`)
}

function loadDaemonYaml() {
  if (!existsSync(DAEMON_FILE)) throw missingConfigError(DAEMON_FILE)
  try {
    return parseYaml(readFileSync(DAEMON_FILE, 'utf8')) || {}
  } catch (e) {
    throw new Error(`daemon.yaml is malformed: ${e.message}`)
  }
}

export function loadServerConfig() {
  if (!existsSync(SERVER_FILE)) throw missingConfigError(SERVER_FILE)
  try {
    return validateServerConfigTopLevel(parseYaml(readFileSync(SERVER_FILE, 'utf8')) || {}, 'server.yaml')
  } catch (e) {
    throw new Error(`server.yaml is malformed: ${e.message}`)
  }
}

/**
 * The subset of server.yaml a SERVER cannot start without — as opposed to
 * `loadServerConfig`, which the daemon, the CLI, and display-time also call and
 * which must stay permissive for them.
 *
 * It lives here, next to the loader, because two processes need the same answer:
 * unified-server itself, and `tlda server start`, which reads the authorities in
 * the PARENT so a fresh install fails immediately with a usable error instead of
 * surfacing 90 seconds later as "Server failed to start, check the log". Neither
 * caller restates the rule.
 */
export function loadServerRuntimeConfig() {
  const config = loadServerConfig()
  if (!config.deepgramBridgeUrl) {
    throw new Error(`${SERVER_FILE}: "deepgramBridgeUrl" is required — the Deepgram bridge has one address and no fallback`)
  }
  return config
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
 * The starter config a fresh install needs. Everything a first run reads has to
 * be here: `environments` (a COMPLETE entry, since partial entries throw) and
 * `statusScanSeconds` (read at fleet-daemon module load, so the daemon dies
 * without it). Both point at this machine, which is the only thing a new user
 * has — remote environments are something they add later, by name.
 *
 * `licenseKey: ""` is the documented "explicitly unlicensed" value, not a
 * placeholder to fill in.
 */
const STARTER_DAEMON_YAML = `# tlda daemon settings.
#
# Models tlda can launch through the installed Claude Code, Codex, and Goose
# harnesses. The app checks which harnesses are installed and authenticated on
# this machine before offering their models.
models:
  default: gpt
  values:
    opus:
      id: claude-opus-5
      harness:
        kind: claude
        required:
          - "--dangerously-load-development-channels server:tlda"
          - "--dangerously-skip-permissions"
        preferences: []
        controls: true
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: {}
    sonnet:
      id: sonnet
      harness:
        kind: claude
        required:
          - "--dangerously-load-development-channels server:tlda"
          - "--dangerously-skip-permissions"
        preferences: []
        controls: true
    haiku:
      id: haiku
      harness:
        kind: claude
        required:
          - "--dangerously-load-development-channels server:tlda"
          - "--dangerously-skip-permissions"
        preferences: []
        controls: true
    fable:
      id: fable
      harness:
        kind: claude
        required:
          - "--dangerously-load-development-channels server:tlda"
          - "--dangerously-skip-permissions"
        preferences: []
        controls: true
    gpt:
      id: gpt-5.5
      harness:
        kind: codex
        required:
          - "--dangerously-bypass-approvals-and-sandbox"
        preferences: []
        controls: false
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: {}
    sol:
      id: gpt-5.6-sol
      harness:
        kind: codex
        required:
          - "--dangerously-bypass-approvals-and-sandbox"
        preferences: []
        controls: false
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: {}
    luna:
      id: gpt-5.6-luna
      harness:
        kind: codex
        required:
          - "--dangerously-bypass-approvals-and-sandbox"
        preferences: []
        controls: false
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: {}
    terra:
      id: gpt-5.6-terra
      harness:
        kind: codex
        required:
          - "--dangerously-bypass-approvals-and-sandbox"
        preferences: []
        controls: false
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: {}
    deepseek:
      id: deepseek/deepseek-v4-pro
      harness:
        kind: goose
        required: []
        preferences: []
        controls: true
    minimax:
      id: minimax/minimax-m3
      harness:
        kind: goose
        required: []
        preferences: []
        controls: true
    qwen:
      id: qwen/qwen3.6-plus
      harness:
        kind: goose
        required: []
        preferences: []
        controls: true
    glm:
      id: z-ai/glm-5.2
      harness:
        kind: goose
        required: []
        preferences: []
        controls: true

# An environment is a COMPLETE set of three fields — there are no fallbacks, and
# a missing one fails at startup rather than being guessed:
#
#   database    fleet, chat, registry, agents
#   store       document assets and shape sync
#   licenseKey  tldraw license ("" means explicitly unlicensed)
#
# "environments.default" names the active one. Add more under "values" and
# select one for a single run with "--env <name>"; see \`tlda env\`.
#
# Terminal viewing is read-only unless this daemon explicitly opts in. When
# terminalInputAllowed is false or absent, the daemon still streams terminal
# output and accepts dedicated controls such as interrupt, but rejects terminal
# text injection.
terminalInputAllowed: false

environments:
  default: local
  values:
    local:
      database: http://localhost:${DEFAULT_PORT}
      store: http://localhost:${DEFAULT_PORT}
      licenseKey: ""

# How often the daemon asks each box which agents are running and what they are
# doing, in seconds.
statusScanSeconds: 3

# Keep an active transcript tail open across short pauses between writes.
# Dormant transcripts at EOF hold no tail.
jsonlTailIdleSeconds: 600
`

/**
 * The starter server.yaml. `deepgramBridgeUrl` is the one key a SERVER cannot
 * start without (see loadServerRuntimeConfig), so it is written out with the
 * real address rather than left as a comment someone has to discover from a
 * stack trace.
 *
 * The options are documented HERE, on the keys, rather than in a doc/ file:
 * this is the file someone is looking at when they want to change one of these
 * values, and a separate document describing it would rot unread.
 */
const STARTER_SERVER_YAML = `# tlda server settings. The file itself is required; see the note on each key
# for whether its VALUE is.
#
# Everything the server needs at runtime is here or in daemon.yaml. The only
# things still delivered as environment variables are the ones that cannot live
# in a file: secrets (TLDA_TOKEN_READ, TLDA_TOKEN_RW, DEEPGRAM_API_KEY,
# TS_AUTHKEY), values the platform sets before the app can read anything
# (PORT, NODE_ENV), and the two that say WHERE the config is — TLDA_ENV picks
# the environment, TLDA_CONFIG_DIR/TLDA_DAEMON_CONFIG_DIR pick the directory
# these files live in.

# How THIS SERVER reaches the one Deepgram bridge, which runs on its own machine
# (the tlda-voice box) over Fly's private network. REQUIRED — there is no second
# bridge and no fallback. This was an environment variable until leaving it unset
# silently removed Deepgram from the voice picker with no error anywhere.
deepgramBridgeUrl: ws://tlda-voice.internal:8180

# How THE BROWSER reaches that same bridge, if it can reach it directly (the
# tailnet name, wss://tlda-voice.<tailnet>.ts.net). Connecting direct keeps the
# audio socket off this machine, so deploying this machine cannot cut a sentence
# in half. Absent = the browser relays through the same-origin proxy here.
# deepgramDirectUrl: wss://tlda-voice.example.ts.net

# Where uploaded and copied chat attachments live. On a hosted box this MUST name
# the persistent volume — anywhere else is wiped on restart, which once 404'd
# markdown chips out from under the annotation viewer.
# Absent = ~/.config/tlda/uploads, which is right where nothing is ephemeral.
# uploadDir: /app/server/persist/uploads

# Turn token auth off entirely — true where the server is gated at the NETWORK
# layer instead, e.g. behind Tailscale, where the tailnet is the auth posture.
# authDisabled: false

# Take the read/RW tokens ONLY from TLDA_TOKEN_READ/TLDA_TOKEN_RW in the
# environment, never from this machine's tokens.json, and refuse to start if
# neither is set. True on a hosted deployment, where a token file on the box
# would be the wrong authority and an absent one must not quietly disable auth.
# tokensFromEnvironmentOnly: false

# IANA zone name (e.g. America/New_York) that human-readable times render in.
# DISPLAY ONLY — stored timestamps stay UTC. Absent = this machine's own zone.
# timezone: America/New_York

# How many document builds run at once, and build ordering across projects.
# buildMaxConcurrency: 2
# buildPriority: []

# Optional http(s) telemetry page linked from the project index.
# telemetryUrl: https://example.ts.net:3031/d/tlda/overview
`

/**
 * Create the config files a fresh install needs — and only the ones that are
 * missing. An existing file is never read, merged into, or overwritten: that
 * file carries someone's environments, and losing it would be far worse than
 * the missing-config error this exists to fix.
 *
 * The exclusive-create flag is what enforces that, rather than a check followed
 * by a write — the OS refuses the write, so there is no window in which an
 * existing config could be clobbered.
 *
 * Deliberately NOT auto-run by anything. A command someone types is
 * predictable; writing to a config directory as a side effect of a command that
 * was supposed to read it is the kind of surprise that costs someone their
 * environments later. The missing-config error names this command instead.
 *
 * Returns one { path, created } per file, in the order they are written.
 */
export function initConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  return [
    [DAEMON_FILE, STARTER_DAEMON_YAML],
    [SERVER_FILE, STARTER_SERVER_YAML],
  ].map(([path, contents]) => {
    try {
      writeFileSync(path, contents, { flag: 'wx' })
      return { path, created: true }
    } catch (e) {
      if (e.code === 'EEXIST') return { path, created: false }
      throw e
    }
  })
}

/**
 * Resolve the active environment from daemon.yaml `environments.values:` — the
 * single source of truth for which database/store pair this daemon and its
 * agents use.
 * The active environment is `envName` (a string override — used to route a
 * specific bot to its declared environment), else TLDA_ENV, else daemon.yaml
 * `environments.default`.
 *
 * Each environment entry MUST be COMPLETE: an explicit `database`, `store`, and
 * `licenseKey` (licenseKey "" = explicitly unlicensed). There are NO fallbacks —
 * no legacy `url` shorthand, no reusing `database` as `store`, no top-level
 * `licenseKey` shared across environments. A missing/partial entry THROWS.
 *
 */
export function resolveConfig(envName = null) {
  const { name, raw } = resolveStrictEnvironmentAuthority(loadDaemonYaml(), envName)
  const { database, store, licenseKey } = raw
  return {
    name,
    database: { http: _httpForm(database), ws: _wsForm(database) },
    store: { http: _httpForm(store), ws: _wsForm(store) },
    licenseKey,
  }
}

export function listEnvironments(envName = null) {
  const root = loadDaemonYaml()
  const { name } = resolveStrictEnvironmentAuthority(root, envName)
  return Object.keys(root.environments.values).map(env => ({ name: env, active: env === name }))
}

/** Server URL = the active config's STORE (doc assets + shape sync) over http. */
export function getServerUrl(envName = null) {
  return resolveConfig(envName).store.http
}

/** Fleet/event-store URL = the active config's DATABASE (chat/agents) over http. */
export function getFleetServerUrl(envName = null) {
  return resolveConfig(envName).database.http
}

/** The active environment's name — what TLDA_ENV/environments.default selected. */
export function getActiveEnvName(envName = null) {
  return resolveConfig(envName).name
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

export function getJsonlTailIdleMs() {
  const seconds = loadDaemonYaml().jsonlTailIdleSeconds ?? 600
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`daemon.yaml: jsonlTailIdleSeconds must be a positive number (got ${JSON.stringify(seconds)})`)
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
 * does not manage them. Shape:
 *
 *   bots:
 *     todd: { script: /Users/skip/work/tlda-bots/todd/todd.mjs }
 *   environments:
 *     testing: [todd]
 *
 * Bot definitions live exactly once. Environments list bot names only.
 */
function loadBotsYaml() {
  if (!existsSync(BOTS_FILE)) return []
  try {
    return parseYaml(readFileSync(BOTS_FILE, 'utf8')) || {}
  } catch (e) {
    throw new Error(`bots.yaml is malformed: ${e.message}`)
  }
}

export function getManagedBots() {
  const doc = loadBotsYaml()
  if (!doc || !doc.bots) return []
  if (!isRecord(doc.bots)) throw new Error('bots.yaml: bots must be a map of name to definition')
  return Object.entries(doc.bots).map(([name, value]) => {
    if (!isRecord(value)) throw new Error(`bots.yaml: bot ${name} must be a mapping`)
    return { name, ...value }
  })
}

export function getManagedBotEnvironments() {
  const doc = loadBotsYaml()
  if (!doc || !doc.environments) return {}
  if (!isRecord(doc.environments)) throw new Error('bots.yaml: environments must be a map of environment name to bot-name list')
  const botNames = new Set(getManagedBots().map(bot => bot.name))
  const out = {}
  for (const [envName, members] of Object.entries(doc.environments)) {
    if (!Array.isArray(members)) throw new Error(`bots.yaml: environments.${envName} must be a list`)
    out[envName] = members.map(member => {
      const name = String(member)
      if (!botNames.has(name)) throw new Error(`bots.yaml: environments.${envName} references unknown bot "${name}"`)
      return name
    })
  }
  return out
}
