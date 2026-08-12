import { readProject, updateProject } from './project-store.mjs'

export function sourceConflictOwner(fields = {}) {
  const daemonKey = fields.sourceDaemonKey || fields.daemonKey || null
  const machineId = fields.sourceMachineId || fields.machineId || null
  const envName = fields.sourceEnvName || fields.envName || null
  const participant = fields.editedBy || fields.participant || daemonKey || machineId || null
  return {
    id: daemonKey || participant || machineId || 'unknown',
    ...(participant ? { participant } : {}),
    ...(daemonKey ? { daemonKey } : {}),
    ...(machineId ? { machineId } : {}),
    ...(envName ? { envName } : {}),
  }
}

function ownerKey(owner = {}) {
  return owner.daemonKey || owner.id || owner.participant || owner.machineId || 'unknown'
}

function normalizeConflict(entry = {}) {
  const file = typeof entry.file === 'string' ? entry.file : typeof entry.path === 'string' ? entry.path : ''
  if (!file) return null
  const owner = sourceConflictOwner(entry.owner || entry)
  return {
    kind: 'source-conflict',
    status: 'conflict',
    file,
    owner,
    ownerKey: ownerKey(owner),
    source: entry.source || 'source-authority',
    at: entry.at || new Date().toISOString(),
  }
}

export async function recordSourceSyncConflicts(projectName, conflicts = []) {
  const project = await readProject(projectName)
  if (!project) return []
  const existing = Array.isArray(project.sourceSyncConflicts) ? project.sourceSyncConflicts : []
  const byKey = new Map(existing
    .map(normalizeConflict)
    .filter(Boolean)
    .map(entry => [`${entry.file}\0${entry.ownerKey}`, entry]))
  for (const conflict of conflicts) {
    const entry = normalizeConflict(conflict)
    if (!entry) continue
    byKey.set(`${entry.file}\0${entry.ownerKey}`, entry)
  }
  const next = [...byKey.values()].sort((a, b) => a.file.localeCompare(b.file) || a.ownerKey.localeCompare(b.ownerKey))
  await updateProject(projectName, { sourceSyncConflicts: next })
  return next
}

export async function clearSourceSyncConflicts(projectName, files = [], owner = null) {
  const project = await readProject(projectName)
  if (!project) return []
  const existing = Array.isArray(project.sourceSyncConflicts) ? project.sourceSyncConflicts : []
  if (existing.length === 0) return []
  const fileSet = new Set((files || []).filter(file => typeof file === 'string' && file.length > 0))
  if (fileSet.size === 0) return existing
  const key = owner ? ownerKey(sourceConflictOwner(owner)) : null
  const next = existing.filter(entry => {
    const normalized = normalizeConflict(entry)
    if (!normalized || !fileSet.has(normalized.file)) return true
    return key ? normalized.ownerKey !== key : false
  })
  if (next.length !== existing.length) await updateProject(projectName, { sourceSyncConflicts: next })
  return next
}
