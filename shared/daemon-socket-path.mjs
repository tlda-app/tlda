import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MACOS_SUN_PATH_LIMIT = 104

function cleanSuffix(name) {
  const clean = String(name || '').trim()
  if (!clean || clean === 'default') return ''
  return `.${clean.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
}

function shortSocketName(configDir, envName) {
  const hash = createHash('sha256')
    .update(`${configDir}\0${envName || 'default'}`)
    .digest('hex')
    .slice(0, 16)
  return `fleet-daemon.${hash}.sock`
}

export function daemonStateSuffix(name) {
  return cleanSuffix(name)
}

export function daemonLifecycleSocketPath(configDir, envName) {
  const legacyPath = join(configDir, `fleet-daemon${cleanSuffix(envName)}.sock`)
  if (Buffer.byteLength(legacyPath) < MACOS_SUN_PATH_LIMIT) return legacyPath
  return join(tmpdir(), 'tlda-daemon-rpc', shortSocketName(configDir, envName))
}
