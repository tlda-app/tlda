function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const DAEMON_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'machineId',
  'regions',
  'profiles',
  'grants',
  'models',
  'default',
  'tmuxSocket',
  'taskDoc',
  'spawnMachineId',
  'environments',
  // Read by getStatusScanMs(). This list is a CLOSED allow-list: the daemon
  // refuses to start on an unknown key, so a new setting is not usable until it
  // is named here. Adding the key to daemon.yaml without this line took the live
  // daemon down for 25 minutes on 2026-07-25 — it died on its next restart, with
  // a zero-byte log, so nothing pointed at the cause.
  'statusScanSeconds',
  'jsonlTailIdleSeconds',
  'terminalInputAllowed',
  // Named subscription sets, in the `{ default, values }` form `models:` and
  // `environments:` use. Additive only — an agent's reachability comes from the
  // floor in shared/subscriptions.mjs, not from here, so a machine without this
  // key (or without a daemon.yaml at all, which is the Fly server) still
  // notifies everyone.
  'subscriptions',
])

// Like DAEMON_CONFIG_TOP_LEVEL_KEYS, a CLOSED allow-list: the server refuses to
// start on an unknown key, so a new setting is not usable until it is named here.
export const SERVER_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'buildMaxConcurrency',
  'buildPriority',
  // The subscription slots every agent is minted with, and how loud each one
  // starts. Read by the server at mint. It belongs here rather than in
  // daemon.yaml because the server is not allowed to read daemon.yaml, and
  // minting happens on the server.
  'subscriptions',
  // IANA zone name (e.g. "America/New_York") that human-readable times render
  // in. DISPLAY ONLY — stored timestamps stay UTC. Read by getDisplayTimeZone()
  // in shared/display-time.mjs. Absent = render in the host machine's own zone.
  'timezone',
  'telemetryUrl',
  // How THIS SERVER reaches the one Deepgram bridge on the tlda-voice box, over
  // Fly's private 6PN (ws://tlda-voice.internal:8180). REQUIRED: when this was an
  // environment variable, leaving it unset did not fail — /api/voice/backends fell
  // through to "does this server hold a Deepgram key", so Deepgram silently
  // vanished from Skip's picker with no error anywhere.
  'deepgramBridgeUrl',
  // How THE BROWSER reaches that same bridge (the tailnet name,
  // wss://tlda-voice.<tailnet>.ts.net), handed to the client so its audio socket
  // does not terminate on this machine and therefore does not die when this
  // machine is deployed. Absent means the browser uses the same-origin proxy on
  // this server, which is the route that ships today.
  'deepgramDirectUrl',
  // Byte cap for the same-origin voice proxy's raw PCM queue while it is holding
  // browser audio before the upstream bridge opens.
  'deepgramProxyPcmBacklogMaxBytes',
  // Where uploaded and copied chat attachments live. On Fly this must name the
  // persistent volume; the container wipes anything else on restart, which once
  // wiped markdown-chip files out from under their chips. Absent = this machine's
  // ~/.config/tlda/uploads, which is correct where nothing is ephemeral.
  'uploadDir',
  // Turn token auth off entirely. True where the server is gated at the NETWORK
  // layer instead — the Fly boxes sit behind Tailscale, and the tailnet IS the
  // auth posture (Skip's chosen model).
  'tokenGating',
  // Take the read/RW tokens ONLY from the environment (`fly secrets`), never from
  // this machine's tokens.json, and refuse to start if neither is present. True on
  // a hosted deployment, where a token file on the box would be the wrong
  // authority and an absent one must not quietly disable auth.
  'tokensFromEnvironmentOnly',
])

export const PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS = Object.freeze([
  'regions',
  'profiles',
  'grants',
  'models',
  'default',
])

export const STRICT_SERVER_FIELDS = Object.freeze([
  'database',
  'store',
  'licenseKey',
])

function validateTopLevelKeys(root, allowedKeys, label) {
  if (!isRecord(root)) {
    throw new Error(`${label} must be an object`)
  }
  const config = root
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(config).filter(key => !allowed.has(key))
  if (extra.length) {
    throw new Error(`${label} supports only ${allowedKeys.join(', ')}; unknown key(s): ${extra.join(', ')}`)
  }
  return config
}

export function validateDaemonConfigTopLevel(root, label = 'daemon config') {
  const config = validateTopLevelKeys(root, DAEMON_CONFIG_TOP_LEVEL_KEYS, label)
  if (config.terminalInputAllowed !== undefined && typeof config.terminalInputAllowed !== 'boolean') {
    throw new Error(`${label}: "terminalInputAllowed" must be a boolean`)
  }
  validateDaemonSubscriptions(config.subscriptions, label)
  return config
}

// Same `{ default, values }` contract `models:` is held to, and the same errors,
// because it is the same notation. A set named as default that does not exist is
// rejected rather than ignored: a silently-dropped default is a delivery rule
// nobody is applying, and this subsystem's whole failure mode is silence.
export function validateDaemonSubscriptions(block, label = 'daemon config') {
  if (block === undefined) return
  if (!isRecord(block)) throw new Error(`${label}: "subscriptions" must be an object`)
  const extra = Object.keys(block).filter(k => k !== 'default' && k !== 'values')
  if (extra.length) throw new Error(`${label}: daemon subscriptions must use { default, values }; unknown key(s): ${extra.join(', ')}`)
  if (block.values !== undefined && !isRecord(block.values)) {
    throw new Error(`${label}: "subscriptions.values" must be an object`)
  }
  for (const [name, entries] of Object.entries(block.values || {})) {
    if (!Array.isArray(entries)) throw new Error(`${label}: subscription set "${name}" must be a list`)
    for (const entry of entries) {
      const query = typeof entry === 'string' ? entry : entry?.query
      if (typeof query !== 'string' || !query.length) {
        throw new Error(`${label}: subscription set "${name}" has an entry with no query`)
      }
    }
  }
  if (block.default === undefined) {
    if (block.values !== undefined) throw new Error(`${label}: "subscriptions.default" is required when subscriptions.values is configured`)
    return
  }
  if (typeof block.default !== 'string' || !(block.default in (block.values || {}))) {
    throw new Error(`${label}: subscriptions.default "${block.default}" is not in subscriptions.values`)
  }
}

export function validateProjectDaemonOverrideTopLevel(root, label = 'project daemon override') {
  return validateTopLevelKeys(root, PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS, label)
}

export function validateServerConfigTopLevel(root, label = 'server config') {
  const config = validateTopLevelKeys(root, SERVER_CONFIG_TOP_LEVEL_KEYS, label)
  if (config.timezone !== undefined) validateTimeZone(config.timezone, label)
  if (config.telemetryUrl !== undefined) validateTelemetryUrl(config.telemetryUrl, label)
  if (config.deepgramBridgeUrl !== undefined) validateWebSocketUrl(config.deepgramBridgeUrl, 'deepgramBridgeUrl', label)
  if (config.deepgramDirectUrl !== undefined) validateWebSocketUrl(config.deepgramDirectUrl, 'deepgramDirectUrl', label)
  if (config.deepgramProxyPcmBacklogMaxBytes !== undefined) validatePositiveInteger(config.deepgramProxyPcmBacklogMaxBytes, 'deepgramProxyPcmBacklogMaxBytes', label)
  if (config.uploadDir !== undefined && (typeof config.uploadDir !== 'string' || !config.uploadDir.trim())) {
    throw new Error(`${label}: "uploadDir" must be a nonempty path`)
  }
  for (const key of ['tokenGating', 'tokensFromEnvironmentOnly']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`${label}: "${key}" must be a boolean`)
    }
  }
  // A malformed slot list is refused at load rather than at mint. An agent that
  // comes up with no subscriptions is silent — nothing wakes it and the sender
  // gets no receipt saying so — and that is the failure this key exists to
  // prevent, so it must not be reachable by a typo.
  if (config.subscriptions !== undefined) {
    if (!Array.isArray(config.subscriptions)) {
      throw new Error(`${label}: "subscriptions" must be a list of { query, policy }`)
    }
    for (const entry of config.subscriptions) {
      const query = typeof entry === 'string' ? entry : entry?.query
      if (typeof query !== 'string' || !query.trim()) {
        throw new Error(`${label}: every "subscriptions" entry needs a nonempty query`)
      }
    }
  }
  return config
}

function validatePositiveInteger(value, key, label = 'config') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}: "${key}" must be a positive integer`)
  }
}

/**
 * A bridge address that is a string but not a WebSocket URL fails at the first
 * connect attempt, which is mid-sentence for whoever is dictating. Ask at load.
 */
export function validateWebSocketUrl(value, key, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "${key}" must be a nonempty ws(s) URL`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}: "${key}" must be a valid ws(s) URL (got ${value})`)
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`${label}: "${key}" must use ws or wss (got ${value})`)
  }
  return url.toString()
}

export function validateTelemetryUrl(value, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "telemetryUrl" must be a nonempty http(s) URL`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}: "telemetryUrl" must be a valid http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}: "telemetryUrl" must use http or https`)
  }
  return url.toString()
}

/**
 * A bad zone name must fail at config load, not silently at the first render.
 * Intl is the authority on what names exist, so ask it rather than keeping a
 * list here that would rot.
 */
export function validateTimeZone(value, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "timezone" must be a nonempty IANA zone name, e.g. America/New_York`)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    throw new Error(`${label}: "timezone" is not a zone this system knows: ${value} (expected an IANA name like America/New_York)`)
  }
  return value
}

export function validateStrictEnvironments(environments, label = 'daemon.yaml environments') {
  if (!isRecord(environments)) {
    throw new Error(`${label} must be an object with default and values`)
  }
  const extraTop = Object.keys(environments).filter(key => key !== 'default' && key !== 'values')
  if (extraTop.length) {
    throw new Error(`${label} supports only default, values; unknown key(s): ${extraTop.join(', ')}`)
  }
  if (typeof environments.default !== 'string' || !environments.default.trim()) {
    throw new Error('tlda config: "environments.default" must be a nonempty string in daemon.yaml')
  }
  if (!isRecord(environments.values)) {
    throw new Error(`${label}.values must be an object of named environment entries`)
  }
  const allowed = new Set(STRICT_SERVER_FIELDS)
  for (const [name, raw] of Object.entries(environments.values)) {
    if (!isRecord(raw)) {
      throw new Error(`tlda environment "${name}" must be an object in ${label}.values`)
    }
    const extra = Object.keys(raw).filter(key => !allowed.has(key))
    if (extra.length) {
      throw new Error(`tlda environment "${name}" supports only ${STRICT_SERVER_FIELDS.join(', ')}; unknown key(s): ${extra.join(', ')}`)
    }
    for (const field of STRICT_SERVER_FIELDS) {
      if (typeof raw[field] !== 'string') {
        throw new Error(`tlda environment "${name}": "${field}" must be a string in ${label}.${name} — declare database, store, and licenseKey explicitly (no url/database-as-store/top-level-license fallback).`)
      }
    }
  }
  return environments.values
}

export function resolveStrictEnvironmentAuthority(root, envName = null) {
  const config = validateDaemonConfigTopLevel(root, 'daemon config')
  if (envName !== null && typeof envName !== 'string') {
    throw new TypeError('tlda config: environment name override must be a string')
  }
  const environments = validateStrictEnvironments(config.environments)
  const fallbackName = config.environments.default.trim()
  if (!environments[fallbackName]) {
    throw new Error(`tlda config: no environment named "${fallbackName}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  }
  const name = envName || process.env.TLDA_ENV || fallbackName
  if (!name) throw new Error('tlda config: no active environment — set "environments.default" in daemon.yaml (or TLDA_ENV)')
  const raw = environments[name]
  if (!raw) throw new Error(`tlda config: no environment named "${name}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  return { name, raw }
}
