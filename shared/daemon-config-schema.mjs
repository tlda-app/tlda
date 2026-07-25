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
  // Read by getStatusScanMs(). This list is a CLOSED allow-list: the daemon
  // refuses to start on an unknown key, so a new setting is not usable until it
  // is named here. Adding the key to daemon.yaml without this line took the live
  // daemon down for 25 minutes on 2026-07-25 — it died on its next restart, with
  // a zero-byte log, so nothing pointed at the cause.
  'statusScanSeconds',
])

export const SERVER_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'defaultServer',
  'servers',
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

export function validateStrictServers(servers, label = 'server.yaml servers') {
  if (!isRecord(servers)) {
    throw new Error(`${label} must be an object of named server entries`)
  }
  const allowed = new Set(STRICT_SERVER_FIELDS)
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) {
      throw new Error(`tlda server "${name}" must be an object in ${label}`)
    }
    const extra = Object.keys(raw).filter(key => !allowed.has(key))
    if (extra.length) {
      throw new Error(`tlda server "${name}" supports only ${STRICT_SERVER_FIELDS.join(', ')}; unknown key(s): ${extra.join(', ')}`)
    }
    for (const field of STRICT_SERVER_FIELDS) {
      if (typeof raw[field] !== 'string') {
        throw new Error(`tlda server "${name}": "${field}" must be a string in ${label}.${name} — declare database, store, and licenseKey explicitly (no url/database-as-store/top-level-license fallback).`)
      }
    }
  }
  return servers
}

export function resolveStrictServerAuthority(root, serverName = null) {
  const config = validateServerConfigTopLevel(root, 'server config')
  if (serverName !== null && typeof serverName !== 'string') {
    throw new TypeError('tlda config: server name override must be a string')
  }
  const servers = validateStrictServers(config.servers)
  if (typeof config.defaultServer !== 'string' || !config.defaultServer.trim()) {
    throw new Error('tlda config: "defaultServer" must be a nonempty string in server.yaml')
  }
  const fallbackName = config.defaultServer.trim()
  if (!servers[fallbackName]) {
    throw new Error(`tlda config: no server named "${fallbackName}" in server.yaml servers — known: ${Object.keys(servers).join(', ') || '(none)'}`)
  }
  const name = serverName || process.env.TLDA_CONFIG || fallbackName
  if (!name) throw new Error('tlda config: no active server — set "defaultServer" in server.yaml (or TLDA_CONFIG)')
  const raw = servers[name]
  if (!raw) throw new Error(`tlda config: no server named "${name}" in server.yaml servers — known: ${Object.keys(servers).join(', ') || '(none)'}`)
  return { name, raw }
}
