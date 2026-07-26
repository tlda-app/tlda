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
  'defaultEnv',
  'environments',
  // Read by getStatusScanMs(). This list is a CLOSED allow-list: the daemon
  // refuses to start on an unknown key, so a new setting is not usable until it
  // is named here. Adding the key to daemon.yaml without this line took the live
  // daemon down for 25 minutes on 2026-07-25 — it died on its next restart, with
  // a zero-byte log, so nothing pointed at the cause.
  'statusScanSeconds',
])

export const SERVER_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'buildMaxConcurrency',
  'buildPriority',
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
  return validateTopLevelKeys(root, DAEMON_CONFIG_TOP_LEVEL_KEYS, label)
}

export function validateProjectDaemonOverrideTopLevel(root, label = 'project daemon override') {
  return validateTopLevelKeys(root, PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS, label)
}

export function validateServerConfigTopLevel(root, label = 'server config') {
  return validateTopLevelKeys(root, SERVER_CONFIG_TOP_LEVEL_KEYS, label)
}

export function validateStrictEnvironments(environments, label = 'daemon.yaml environments') {
  if (!isRecord(environments)) {
    throw new Error(`${label} must be an object of named environment entries`)
  }
  const allowed = new Set(STRICT_SERVER_FIELDS)
  for (const [name, raw] of Object.entries(environments)) {
    if (!isRecord(raw)) {
      throw new Error(`tlda environment "${name}" must be an object in ${label}`)
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
  return environments
}

export function resolveStrictEnvironmentAuthority(root, envName = null) {
  const config = validateDaemonConfigTopLevel(root, 'daemon config')
  if (envName !== null && typeof envName !== 'string') {
    throw new TypeError('tlda config: environment name override must be a string')
  }
  const environments = validateStrictEnvironments(config.environments)
  if (typeof config.defaultEnv !== 'string' || !config.defaultEnv.trim()) {
    throw new Error('tlda config: "defaultEnv" must be a nonempty string in daemon.yaml')
  }
  const fallbackName = config.defaultEnv.trim()
  if (!environments[fallbackName]) {
    throw new Error(`tlda config: no environment named "${fallbackName}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  }
  const name = envName || process.env.TLDA_ENV || fallbackName
  if (!name) throw new Error('tlda config: no active environment — set "defaultEnv" in daemon.yaml (or TLDA_ENV)')
  const raw = environments[name]
  if (!raw) throw new Error(`tlda config: no environment named "${name}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  return { name, raw }
}
