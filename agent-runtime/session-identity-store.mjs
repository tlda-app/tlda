import fs from 'fs'
import os from 'os'
import path from 'path'

export const SESSION_IDENTITY_VERSION = 1
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'tlda')

export function sessionIdentityPath(configDir) {
  return path.join(configDir || DEFAULT_CONFIG_DIR, 'session-identity.json')
}

function emptyStore() {
  return {
    version: SESSION_IDENTITY_VERSION,
    sessions: {},
    by_fleet_id: {},
    ingestion: {
      caught_up: true,
      active_tails: 0,
      pending_jobs: 0,
      updated_at: null,
    },
  }
}

function normalizeNameHistory(history = []) {
  return Array.isArray(history)
    ? history
      .filter(h => h && typeof h === 'object')
      .map(h => ({
        friendlyName: h.friendlyName ?? h.friendly_name ?? null,
        fromTs: h.fromTs ?? h.from_ts ?? null,
        toTs: h.toTs ?? h.to_ts ?? null,
      }))
    : []
}

export function normalizeSessionIdentityStore(raw = {}) {
  const store = emptyStore()
  if (raw && typeof raw === 'object') {
    store.version = raw.version || SESSION_IDENTITY_VERSION
    store.ingestion = {
      ...store.ingestion,
      ...(raw.ingestion && typeof raw.ingestion === 'object' ? raw.ingestion : {}),
    }
    for (const [sessionId, rec] of Object.entries(raw.sessions || {})) {
      if (!rec || typeof rec !== 'object') continue
      const sid = rec.session_id || sessionId
      store.sessions[sid] = {
        session_id: sid,
        harness_kind: rec.harness_kind || null,
        fleet_id: rec.fleet_id || null,
        friendly_name: rec.friendly_name || null,
        name_history: normalizeNameHistory(rec.name_history),
        cwd: rec.cwd || null,
        jsonl_path: rec.jsonl_path || null,
        updated_at: rec.updated_at || null,
        classified: !!rec.classified,
      }
    }
  }
  rebuildByFleetId(store)
  return store
}

export function loadSessionIdentityStore(filePath) {
  if (!fs.existsSync(filePath)) return emptyStore()
  try {
    return normalizeSessionIdentityStore(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return emptyStore()
  }
}

export function saveSessionIdentityStore(filePath, store) {
  const normalized = normalizeSessionIdentityStore(store)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2))
  fs.renameSync(tmp, filePath)
}

export function rebuildByFleetId(store) {
  const byFleet = {}
  for (const rec of Object.values(store.sessions || {})) {
    if (!rec?.fleet_id) continue
    if (!byFleet[rec.fleet_id]) byFleet[rec.fleet_id] = []
    byFleet[rec.fleet_id].push(rec.session_id)
  }
  for (const ids of Object.values(byFleet)) ids.sort()
  store.by_fleet_id = byFleet
  return store
}

function openNameSpan(rec, friendlyName, ts) {
  if (!friendlyName) return false
  const history = normalizeNameHistory(rec.name_history)
  const open = history.find(h => h.toTs == null)
  if (open?.friendlyName === friendlyName) {
    rec.name_history = history
    return false
  }
  if (open) open.toTs = ts
  history.push({ friendlyName, fromTs: ts, toTs: null })
  rec.name_history = history
  return true
}

export function upsertSessionIdentity(store, input, { now = () => new Date().toISOString() } = {}) {
  const sessionId = input?.session_id
  if (!sessionId) return false
  const ts = input.updated_at || now()
  const prev = store.sessions[sessionId] || {
    session_id: sessionId,
    harness_kind: null,
    fleet_id: null,
    friendly_name: null,
    name_history: [],
    cwd: null,
    jsonl_path: null,
    updated_at: null,
    classified: false,
  }
  const next = { ...prev, name_history: normalizeNameHistory(prev.name_history) }
  let changed = false
  for (const [src, dest] of [
    ['harness_kind', 'harness_kind'],
    ['fleet_id', 'fleet_id'],
    ['cwd', 'cwd'],
    ['jsonl_path', 'jsonl_path'],
  ]) {
    if (input[src] && next[dest] !== input[src]) {
      next[dest] = input[src]
      changed = true
    }
  }
  if (input.friendly_name && next.friendly_name !== input.friendly_name) {
    next.friendly_name = input.friendly_name
    changed = true
    if (openNameSpan(next, input.friendly_name, ts)) changed = true
  }
  if (input.classified === true && !next.classified) {
    next.classified = true
    changed = true
  }
  if (changed || !prev.updated_at) next.updated_at = ts
  store.sessions[sessionId] = next
  if (changed) rebuildByFleetId(store)
  return changed
}

export function updateFleetFriendlyName(store, fleetId, friendlyName, { now = () => new Date().toISOString() } = {}) {
  if (!fleetId || !friendlyName) return false
  const ts = now()
  let changed = false
  for (const rec of Object.values(store.sessions || {})) {
    if (rec.fleet_id !== fleetId) continue
    if (rec.friendly_name !== friendlyName) {
      rec.friendly_name = friendlyName
      rec.updated_at = ts
      changed = true
    }
    if (openNameSpan(rec, friendlyName, ts)) changed = true
  }
  return changed
}

export function updateIngestionStatus(store, status, { now = () => new Date().toISOString() } = {}) {
  const next = {
    caught_up: !!status.caught_up,
    active_tails: Number(status.active_tails || 0),
    pending_jobs: Number(status.pending_jobs || 0),
    updated_at: now(),
  }
  const prev = store.ingestion || {}
  const changed = prev.caught_up !== next.caught_up ||
    prev.active_tails !== next.active_tails ||
    prev.pending_jobs !== next.pending_jobs
  store.ingestion = next
  return changed
}

export function getSessionIdentity(sessionId, { configDir, filePath } = {}) {
  const f = filePath || sessionIdentityPath(configDir)
  return loadSessionIdentityStore(f).sessions[sessionId] || null
}

export function findSessionsByFleetId(fleetId, kind = null, { configDir, filePath } = {}) {
  const f = filePath || sessionIdentityPath(configDir)
  const store = loadSessionIdentityStore(f)
  const ids = store.by_fleet_id?.[fleetId] || Object.values(store.sessions)
    .filter(rec => rec.fleet_id === fleetId)
    .map(rec => rec.session_id)
  return ids
    .map(id => store.sessions[id])
    .filter(rec => rec && (!kind || rec.harness_kind === kind))
}

export function isIngestionCaughtUp({ configDir, filePath } = {}) {
  const f = filePath || sessionIdentityPath(configDir)
  return !!loadSessionIdentityStore(f).ingestion?.caught_up
}
