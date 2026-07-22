function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const DAEMON_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'defaultServer',
  'machineId',
  'regions',
  'profiles',
  'grants',
  'models',
  'servers',
  'default',
])

export const STRICT_SERVER_FIELDS = Object.freeze([
  'database',
  'store',
  'licenseKey',
])

export function validateDaemonConfigTopLevel(root, label = 'daemon config') {
  const config = isRecord(root) ? root : {}
  const allowed = new Set(DAEMON_CONFIG_TOP_LEVEL_KEYS)
  const extra = Object.keys(config).filter(key => !allowed.has(key))
  if (extra.length) {
    throw new Error(`${label} supports only ${DAEMON_CONFIG_TOP_LEVEL_KEYS.join(', ')}; unknown key(s): ${extra.join(', ')}`)
  }
  return config
}

export function validateStrictServers(servers = {}, label = 'daemon.yaml servers') {
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
  const config = validateDaemonConfigTopLevel(root, 'daemon config')
  if (serverName !== null && typeof serverName !== 'string') {
    throw new TypeError('tlda config: server name override must be a string')
  }
  const name = serverName || process.env.TLDA_CONFIG || config.defaultServer
  if (!name) throw new Error('tlda config: no active server — set "defaultServer" in daemon.yaml (or TLDA_CONFIG)')
  const servers = validateStrictServers(config.servers || {})
  const raw = servers[name]
  if (!raw) throw new Error(`tlda config: no server named "${name}" in daemon.yaml servers — known: ${Object.keys(servers).join(', ') || '(none)'}`)
  return { name, raw }
}
