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
])

export const SERVER_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'buildMaxConcurrency',
  'buildPriority',
  // IANA zone name (e.g. "America/New_York") that human-readable times render
  // in. DISPLAY ONLY — stored timestamps stay UTC. Read by getDisplayTimeZone()
  // in shared/display-time.mjs. Absent = render in the host machine's own zone.
  'timezone',
  'telemetryUrl',
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
  return config
}

export function validateProjectDaemonOverrideTopLevel(root, label = 'project daemon override') {
  return validateTopLevelKeys(root, PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS, label)
}

export function validateServerConfigTopLevel(root, label = 'server config') {
  const config = validateTopLevelKeys(root, SERVER_CONFIG_TOP_LEVEL_KEYS, label)
  if (config.timezone !== undefined) validateTimeZone(config.timezone, label)
  if (config.telemetryUrl !== undefined) validateTelemetryUrl(config.telemetryUrl, label)
  return config
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
