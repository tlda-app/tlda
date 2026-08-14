import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function syncPath(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, content)
  syncPath(pending)
  renameSync(pending, path)
  syncPath(path)
  syncPath(dirname(path))
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function stableManifest(entries) {
  const seen = new Set()
  return [...(entries || [])].map(entry => {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('Manifest entries require path and sha256')
    }
    if (seen.has(entry.path)) throw new Error(`Duplicate manifest path: ${entry.path}`)
    seen.add(entry.path)
    return { path: entry.path, sha256: entry.sha256, size: entry.size ?? null }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

function safePath(root, path) {
  const target = resolve(root, path)
  const rel = relative(resolve(root), target)
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) throw new Error(`Invalid managed path: ${path}`)
  return target
}

function localHash(path) {
  return existsSync(path) ? hash(readFileSync(path)) : null
}

function textBuffer(buffer) {
  return !buffer.includes(0)
}

function conflictText(label, local, accepted) {
  return Buffer.from([
    `<<<<<<< local checkout (${label})`,
    local.toString('utf8'),
    '=======',
    accepted === null ? '[deleted by accepted source]' : accepted.toString('utf8'),
    '>>>>>>> accepted source',
    '',
  ].join('\n'))
}

export function createSourceMaterializer({ journalPath, fault = null } = {}) {
  if (!journalPath) throw new Error('journalPath is required')

  function journal() {
    return readJson(journalPath) || { version: 1, bindings: {}, materializations: {} }
  }

  function writeJournal(value, point = null) {
    fault?.(point)
    atomicWrite(journalPath, JSON.stringify(value, null, 2))
  }

  function key(bindingId, sourceRevision) {
    return `${bindingId}\0${sourceRevision}`
  }

  function readBinding(bindingId) {
    return journal().bindings[bindingId] || null
  }

  function readMaterialization(bindingId, sourceRevision) {
    return journal().materializations[key(bindingId, sourceRevision)] || null
  }

  function plan(command) {
    const { bindingId, sourceRevision, previousRevision, sourceDir } = command
    if (!bindingId || !sourceRevision || !sourceDir) throw new Error('bindingId, sourceRevision, and sourceDir are required')
    const state = journal()
    const materializationKey = key(bindingId, sourceRevision)
    const existing = state.materializations[materializationKey]
    if (existing) return existing
    const binding = state.bindings[bindingId] || {
      bindingId,
      sourceDir,
      serverHeadRevision: previousRevision || null,
      materializedRevision: previousRevision || null,
      activeTargetRevision: null,
      status: 'idle',
      conflicts: [],
    }
    if (binding.activeTargetRevision && binding.activeTargetRevision !== sourceRevision) {
      throw new Error(`Binding ${bindingId} is already applying ${binding.activeTargetRevision}`)
    }
    const base = new Map(stableManifest(command.baseManifest).map(entry => [entry.path, entry]))
    const target = new Map(stableManifest(command.targetManifest).map(entry => [entry.path, entry]))
    const paths = [...new Set([...base.keys(), ...target.keys()])].sort().map(path => {
      const from = base.get(path) || null
      const to = target.get(path) || null
      return {
        path,
        action: !from ? 'add' : !to ? 'delete' : from.sha256 === to.sha256 ? 'unchanged' : 'change',
        baseHash: from?.sha256 || null,
        targetHash: to?.sha256 || null,
        state: 'planned',
        error: null,
      }
    })
    const now = new Date().toISOString()
    const record = {
      bindingId,
      sourceDir,
      sourceRevision,
      previousRevision: previousRevision || null,
      targetManifest: [...target.values()],
      blobs: command.blobs || {},
      outboundPending: [...(command.outboundPending || [])].sort(),
      state: 'planned',
      paths,
      conflicts: [],
      createdAt: now,
      completedAt: null,
    }
    state.bindings[bindingId] = {
      ...binding,
      sourceDir,
      serverHeadRevision: sourceRevision,
      activeTargetRevision: sourceRevision,
      status: 'planned',
    }
    state.materializations[materializationKey] = record
    writeJournal(state, 'after-plan')
    return record
  }

  function targetBytes(record, pathRecord) {
    if (!pathRecord.targetHash) return null
    const encoded = record.blobs[pathRecord.targetHash]
    if (typeof encoded !== 'string') throw new Error(`Missing blob ${pathRecord.targetHash} for ${pathRecord.path}`)
    const buffer = Buffer.from(encoded, 'base64')
    if (hash(buffer) !== pathRecord.targetHash) throw new Error(`Incorrect blob ${pathRecord.targetHash} for ${pathRecord.path}`)
    return buffer
  }

  function persistPath(state, record, pathRecord, point) {
    state.materializations[key(record.bindingId, record.sourceRevision)] = record
    writeJournal(state, point)
  }

  function applyPath(state, record, pathRecord) {
    const full = safePath(record.sourceDir, pathRecord.path)
    const currentHash = localHash(full)
    const pending = record.outboundPending.includes(pathRecord.path)
    const target = targetBytes(record, pathRecord)
    const complete = () => {
      pathRecord.state = 'complete'
      pathRecord.error = null
      persistPath(state, record, pathRecord, `after-path:${pathRecord.path}`)
    }
    const conflict = reason => {
      pathRecord.state = 'conflicted'
      pathRecord.error = reason
      record.state = 'conflicted'
      record.conflicts.push({ path: pathRecord.path, reason })
      persistPath(state, record, pathRecord, `after-conflict:${pathRecord.path}`)
    }

    if (pathRecord.action === 'unchanged') {
      if (currentHash === pathRecord.targetHash) return complete()
      return conflict('local-drift')
    }
    if (pathRecord.action === 'add') {
      if (currentHash === pathRecord.targetHash) return complete()
      if (currentHash !== null) return conflict('unmanaged-add-collision')
      atomicWrite(full, target)
      if (localHash(full) !== pathRecord.targetHash) throw new Error(`Target readback failed for ${pathRecord.path}`)
      return complete()
    }
    if (pathRecord.action === 'change') {
      if (currentHash === pathRecord.targetHash) return complete()
      if (pending || currentHash !== pathRecord.baseHash) {
        const local = existsSync(full) ? readFileSync(full) : Buffer.alloc(0)
        if (textBuffer(local) && textBuffer(target)) atomicWrite(full, conflictText(pathRecord.path, local, target))
        return conflict(pending ? 'outbound-edit-pending' : 'local-change-conflict')
      }
      atomicWrite(full, target)
      if (localHash(full) !== pathRecord.targetHash) throw new Error(`Target readback failed for ${pathRecord.path}`)
      return complete()
    }
    if (currentHash === null) return complete()
    if (pending || currentHash !== pathRecord.baseHash) {
      const local = readFileSync(full)
      if (textBuffer(local)) atomicWrite(full, conflictText(pathRecord.path, local, null))
      return conflict(pending ? 'outbound-edit-pending' : 'local-delete-conflict')
    }
    unlinkSync(full)
    syncPath(dirname(full))
    if (existsSync(full)) throw new Error(`Deletion readback failed for ${pathRecord.path}`)
    complete()
  }

  function apply(bindingId, sourceRevision) {
    const state = journal()
    const materializationKey = key(bindingId, sourceRevision)
    const record = state.materializations[materializationKey]
    if (!record) throw new Error(`Materialization ${bindingId}/${sourceRevision} was not planned`)
    if (record.state === 'materialized' || record.state === 'conflicted') return record
    record.state = 'applying'
    state.bindings[bindingId].status = 'applying'
    persistPath(state, record, null, 'before-apply')
    try {
      for (const pathRecord of record.paths) {
        if (pathRecord.state === 'complete') continue
        applyPath(state, record, pathRecord)
        if (record.state === 'conflicted') break
      }
      if (record.state === 'conflicted') {
        state.bindings[bindingId] = {
          ...state.bindings[bindingId],
          activeTargetRevision: sourceRevision,
          status: 'conflicted',
          conflicts: record.conflicts,
        }
        persistPath(state, record, null, 'terminal-conflict')
        return record
      }
      for (const entry of record.targetManifest) {
        if (localHash(safePath(record.sourceDir, entry.path)) !== entry.sha256) {
          throw new Error(`Final manifest readback failed for ${entry.path}`)
        }
      }
      for (const pathRecord of record.paths) {
        if (pathRecord.action === 'delete' && existsSync(safePath(record.sourceDir, pathRecord.path))) {
          throw new Error(`Final tombstone readback failed for ${pathRecord.path}`)
        }
      }
      record.state = 'materialized'
      record.completedAt = new Date().toISOString()
      state.bindings[bindingId] = {
        ...state.bindings[bindingId],
        materializedRevision: sourceRevision,
        activeTargetRevision: null,
        status: 'materialized',
        conflicts: [],
      }
      persistPath(state, record, null, 'before-terminal-materialized')
      return record
    } catch (error) {
      record.state = 'retry_wait'
      record.lastError = error?.message || String(error)
      state.bindings[bindingId].status = 'retry_wait'
      persistPath(state, record, null, 'retry-wait')
      throw error
    }
  }

  function consumeCompletedPath(bindingId, path, targetHash) {
    const state = journal()
    const binding = state.bindings[bindingId]
    if (!binding?.activeTargetRevision && binding?.materializedRevision == null) return false
    const revisions = [binding.activeTargetRevision, binding.materializedRevision].filter(Boolean)
    for (const revision of revisions) {
      const record = state.materializations[key(bindingId, revision)]
      const match = record?.paths.find(item => item.path === path && item.targetHash === targetHash && item.state === 'complete')
      if (match) return true
    }
    return false
  }

  return { plan, apply, readBinding, readMaterialization, consumeCompletedPath }
}
