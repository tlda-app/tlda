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
import { gitBlobId } from '../shared/git-blob-id.mjs'

// Git's object id for a blob: sha1 over the header `blob <byte length>\0` and
// then the bytes. This is the same number `git hash-object` returns.
//
// It is git's rather than a plain sha256 because the server's manifest entries
// ARE git blob ids now — a revision is a commit and its tree names blobs. Every
// hash in this file is compared against one the server sent, so the two sides
// have to name content the same way or an untouched file reads as changed.
//
// While a daemon is older than its server the comparisons fail closed: the blob
// checks throw and materialization refuses. That is the safe direction and it is
// why this is a hash change rather than a tolerance.
const hash = gitBlobId

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

/**
 * `mayLandNow` is **the timing rule, and it is deliberately one predicate with
 * one call site.**
 *
 * Skip, 05:18: *"the subtlety is you don't want, like, mid keystroke... just
 * wait for the fucking file to — just find a moment. It's like if agents are
 * editing, then you can just do whatever."* So the agent case is *now* and the
 * human case waits.
 *
 * **The agent case is built; the human case is not, and no interval is chosen
 * here on purpose.** Measuring the daemon side established that the obvious
 * rule is wrong: the daemon cannot see whether an editor's buffer is dirty —
 * that lives in the editor's memory — so disk-quiet is not idleness. Without
 * autosave a paragraph typed into an unsaved buffer produces no disk activity
 * at all, and a settle timer fires exactly mid-sentence. The observably safe
 * moment is just AFTER A SAVE rather than after a silence.
 *
 * A configured number encoding the wrong rule is worse than an unbuilt one: it
 * reads as a decision and gets tuned instead of replaced. So this stays `() =>
 * true` until the rule is settled, and settling it is a change to one function.
 */
export function createSourceMaterializer({ journalPath, fault = null, mergeIntoWorkingCopy = null, commitWorkingCopy = null, baseBytes = null, mayLandNow = () => true } = {}) {
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

  function seedBinding(bindingId, sourceDir, serverHeadRevision = null, { authoritative = false } = {}) {
    if (!bindingId || !sourceDir) throw new Error('bindingId and sourceDir are required')
    const state = journal()
    const existing = state.bindings[bindingId]
    if (existing) {
      if (authoritative && serverHeadRevision != null && existing.materializedRevision == null) {
        state.bindings[bindingId] = {
          ...existing,
          sourceDir,
          serverHeadRevision,
          materializedRevision: serverHeadRevision,
          status: 'materialized',
        }
        writeJournal(state, 'seed-binding-authoritative-head')
        return journal().bindings[bindingId]
      }
      if (existing.serverHeadRevision == null && serverHeadRevision != null) {
        state.bindings[bindingId] = { ...existing, sourceDir, serverHeadRevision, status: 'unknown' }
        writeJournal(state, 'seed-binding-head')
        return journal().bindings[bindingId]
      }
      return existing
    }
    state.bindings[bindingId] = {
      bindingId,
      sourceDir,
      serverHeadRevision,
      materializedRevision: authoritative ? serverHeadRevision : null,
      activeTargetRevision: null,
      status: authoritative && serverHeadRevision ? 'materialized' : serverHeadRevision ? 'unknown' : 'uninitialized',
      conflicts: [],
    }
    writeJournal(state, 'seed-binding')
    return journal().bindings[bindingId]
  }

  function acceptLocalRevision(bindingId, sourceRevision) {
    const state = journal()
    const binding = state.bindings[bindingId]
    if (!binding) throw new Error(`Binding ${bindingId} is not registered`)
    state.bindings[bindingId] = {
      ...binding,
      serverHeadRevision: sourceRevision,
      materializedRevision: sourceRevision,
      activeTargetRevision: null,
      status: 'materialized',
      conflicts: [],
    }
    writeJournal(state, 'accept-local-revision')
    return journal().bindings[bindingId]
  }

  function observeServerHead(bindingId, sourceRevision) {
    const state = journal()
    const binding = state.bindings[bindingId]
    if (!binding) throw new Error(`Binding ${bindingId} is not registered`)
    state.bindings[bindingId] = { ...binding, serverHeadRevision: sourceRevision }
    writeJournal(state, 'observe-server-head')
    return journal().bindings[bindingId]
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

    // An unchanged path needs no bytes, and the server does not send bytes it
    // did not have to: `blobs` is built from the files THIS push carried, while
    // `targetManifest` is the whole revision. So asking for the blob before
    // dispatching on the action threw `Missing blob` for every file a push
    // declared and did not change -- and the throw left activeTargetRevision
    // set, which is terminal, so one unchanged file stopped the checkout
    // receiving anything at all.
    //
    // Measured on bregman's 06:55:31Z revision: baseManifest 7, targetManifest
    // 362, 357 changed with a blob for every one of them, and 5 unchanged with
    // a blob for none. bregman-macros.tex is the first of those five in path
    // order. Its bytes were identical in the base, in the target, on the
    // server, and on disk; nothing was missing except a blob nobody needed.
    if (pathRecord.action === 'unchanged') {
      if (currentHash === pathRecord.targetHash) return complete()
      return conflict('local-drift')
    }
    const target = targetBytes(record, pathRecord)
    if (pathRecord.action === 'add') {
      if (currentHash === pathRecord.targetHash) return complete()
      if (currentHash !== null) return conflict('unmanaged-add-collision')
      atomicWrite(full, target)
      if (localHash(full) !== pathRecord.targetHash) throw new Error(`Target readback failed for ${pathRecord.path}`)
      return complete()
    }
    if (pathRecord.action === 'change') {
      if (currentHash === pathRecord.targetHash) return complete()
      // The local file has moved off the base this revision expects, so the
      // person owning that checkout has been editing it.
      if (pending || currentHash !== pathRecord.baseHash) {
        // **Commit the working copy, then merge.** Skip, 05:14: *"if you have
        // to do a merge, into a working copy that isn't committed, commit the
        // fucking working copy and do a fucking merge."*
        //
        // Committing first is what makes the merge safe rather than brave:
        // whatever was on disk is recoverable from a commit before a byte is
        // touched, so the worst case stops being "their text is gone" and
        // becomes "their text is one command away". It goes onto the daemon's
        // own ref rather than the author's branch -- we are a guest in that
        // repository, and moving somebody's branch under them is not ours to do.
        //
        // What does NOT change is the conflicted case. A three-way that comes
        // back with markers still leaves the file alone, because writing both
        // copies in destroyed text being dictated into three times on
        // 2026-08-17, once wrapping a 282KB document into a 564KB whole-file
        // conflict. Merge when it is mechanical; refuse when it is a judgement.
        // The one call site. A `false` here is "not now", never "never": the
        // path stays conflicted, so the next settle retries it.
        if (!mayLandNow({ path: pathRecord.path, sourceDir: record.sourceDir })) {
          return conflict('waiting-for-a-quiet-moment')
        }
        const merged = mergeIntoWorkingCopy && baseBytes
          ? mergeIntoWorkingCopy({
            path: pathRecord.path,
            base: baseBytes(pathRecord.baseHash),
            ours: existsSync(full) ? readFileSync(full) : null,
            theirs: target,
          })
          : null
        if (!merged) return conflict(pending ? 'outbound-edit-pending' : 'local-change-conflict')
        commitWorkingCopy?.(record.sourceDir, `before merging ${pathRecord.path}`)
        atomicWrite(full, merged)
        pathRecord.merged = true
        // The readback checks the MERGED bytes rather than the target: after a
        // merge the file is deliberately neither side, so asserting it equals
        // the target would fail on every successful merge.
        if (localHash(full) !== hash(merged)) throw new Error(`Merged readback failed for ${pathRecord.path}`)
        return complete()
      }
      atomicWrite(full, target)
      if (localHash(full) !== pathRecord.targetHash) throw new Error(`Target readback failed for ${pathRecord.path}`)
      return complete()
    }
    if (currentHash === null) return complete()
    // Same rule as the change path above: an accepted deletion does not get to
    // overwrite a file whose owner is still editing it.
    if (pending || currentHash !== pathRecord.baseHash) {
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
      // **A merged path is deliberately neither side**, so it cannot be
      // required to equal the target. Its own readback already checked it
      // against the merged bytes; asserting the target here would fail on every
      // successful merge, which is the whole of what his ruling asks for.
      const mergedPaths = new Set(record.paths.filter(item => item.merged).map(item => item.path))
      for (const entry of record.targetManifest) {
        if (mergedPaths.has(entry.path)) continue
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

  return { plan, apply, readBinding, readMaterialization, seedBinding, acceptLocalRevision, observeServerHead, consumeCompletedPath }
}
