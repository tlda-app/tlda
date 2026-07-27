import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRepoIdentity } from '../../shared/repo-identity.mjs'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SERVER_DIR, '..', '..')
const DEFAULT_BUILD_INFO = join(REPO_ROOT, 'server', 'build-info.json')

function maybeIdentity(path, reason = 'unavailable') {
  if (!path || !existsSync(path)) return { available: false, reason }
  try {
    return { available: true, ...resolveRepoIdentity(path) }
  } catch (e) {
    return { available: false, reason: e?.message || reason }
  }
}

export function readBuildInfo(path = DEFAULT_BUILD_INFO) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function summarizeAgents(agents = []) {
  const live = agents.filter(a => !a.dead)
  return {
    total: agents.length,
    live: live.length,
    dead: agents.length - live.length,
    byMachine: live.reduce((acc, a) => {
      const key = a.machine_id || '(none)'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {}),
    agents: live.map(a => ({
      id: a.id,
      name: a.friendly_name || null,
      machine_id: a.machine_id || null,
      cwd: a.cwd || null,
      last_seen: a.last_seen || null,
      last_active: a.last_active || null,
    })),
  }
}

export function daemonRuntimeStatus({
  daemonConnections,
  localHostname = hostname(),
  resolveIdentity = maybeIdentity,
} = {}) {
  const hostShort = (localHostname || '').split('.')[0]
  return [...(daemonConnections || new Map()).entries()].map(([machineId, ws]) => {
    const installPath = ws?._installPath || null
    const daemonHost = ws?._hostname || null
    let identity = { available: false, reason: 'install_path unavailable' }
    if (installPath) {
      if (daemonHost && daemonHost !== localHostname && daemonHost !== hostShort) {
        identity = { available: false, reason: 'daemon is on a remote host' }
      } else {
        identity = resolveIdentity(installPath, 'install_path not stat-able on server host')
      }
    }
    return {
      machine_id: machineId,
      hostname: daemonHost,
      install_path: installPath,
      connected: ws?.readyState === 1,
      identity,
    }
  }).sort((a, b) => a.machine_id.localeCompare(b.machine_id))
}

export function buildRuntimeStatus({
  env = process.env,
  serverScriptPath = join(REPO_ROOT, 'server', 'unified-server.mjs'),
  fleetDbPath = null,
  fleetStore = null,
  daemonConnections = new Map(),
  resolveIdentity = maybeIdentity,
  buildInfo = readBuildInfo(),
  fleetSummary = null,
  agents = [],
  localHostname = hostname(),
} = {}) {
  const configName = env.TLDA_ENV || 'default'
  return {
    server: {
      mode: env.TLDA_DEV_SERVER ? 'test' : 'prod',
      config: configName,
      fleet_db: fleetDbPath || env.TLDA_FLEET_DB || null,
      store_target: fleetStore?.dbPath || fleetDbPath || env.TLDA_FLEET_DB || null,
      identity: resolveIdentity(serverScriptPath),
    },
    daemon: daemonRuntimeStatus({ daemonConnections, localHostname, resolveIdentity }),
    deploy: buildInfo ? {
      gitSha: buildInfo.gitSha || buildInfo.sha || null,
      sha: buildInfo.sha || buildInfo.gitSha || null,
      ref: buildInfo.ref || null,
      branch: buildInfo.branch || null,
      dirty: buildInfo.dirty ?? null,
      builtAt: buildInfo.builtAt || null,
    } : { unavailable: true, reason: 'server/build-info.json not found' },
    fleet: fleetSummary || summarizeAgents(agents),
  }
}
