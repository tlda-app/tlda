import { randomUUID } from 'crypto'
import dns from 'dns'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function resolveSpawnCwd(cwd) {
  const resolved = path.resolve(cwd || process.cwd())
  return resolved === path.parse(resolved).root ? repoRoot() : resolved
}

export function sanitizeSessionName(name) {
  const safe = String(name || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return safe || 'agent'
}

export function newFleetId() {
  return `fleet:${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export function newLocalAgentId() {
  return `local:${randomUUID()}`
}

export function gitAuthorEnv(fleetId, friendlyName) {
  if (!fleetId) return []
  const env = [`GIT_AUTHOR_EMAIL=${fleetId}@fleet.local`]
  if (friendlyName) env.unshift(`GIT_AUTHOR_NAME=${friendlyName}`)
  return env
}

export function readConfig(configFile = path.join(os.homedir(), '.config', 'tlda', 'config.json')) {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    return {}
  }
}

export function activeConfigName(config = readConfig(), env = process.env) {
  if (env.TLDA_CONFIG) return env.TLDA_CONFIG
  if (env.TLDA_SERVER) return null
  return config.defaultConfig || null
}

export async function resolveDnsAlias(api) {
  let host = null
  try {
    host = new URL(api).hostname
  } catch {
    return null
  }
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null
  try {
    const addresses = await dns.promises.lookup(host, { all: true })
    const found = addresses.find((a) => a.family === 4) || addresses[0]
    return found?.address ? { host, address: found.address } : null
  } catch {
    return null
  }
}
