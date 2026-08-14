import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { isTextSourcePath, normalizeSourceManifest } from '../../shared/source-manifest.mjs'

export const SOURCE_AUTHORITY_UNINITIALIZED = 'uninitialized'
export const SOURCE_AUTHORITY_CURRENT = 'current'
export const SOURCE_AUTHORITY_RECONCILIATION_REQUIRED = 'reconciliation-required'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function canonicalPins(dependencyPins) {
  if (!Array.isArray(dependencyPins)) throw new Error('dependencyPins must be an array')
  return dependencyPins.map(stableValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicWrite(path, buffer, fault) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, buffer)
  syncFile(pending)
  fault?.('before-rename', { path, pending })
  renameSync(pending, path)
  syncFile(path)
  syncFile(dirname(path))
}

function atomicJson(path, value, fault) {
  atomicWrite(path, JSON.stringify(value, null, 2), fault)
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

export function classifyThreeWay({ base, current, incoming, binary = false }) {
  if (binary || base == null) return { status: 'classification-unavailable' }
  const dir = mkdtempSync(join(tmpdir(), 'tlda-source-merge-'))
  try {
    const paths = ['current', 'base', 'incoming'].map(name => join(dir, name))
    writeFileSync(paths[0], String(current))
    writeFileSync(paths[1], String(base))
    writeFileSync(paths[2], String(incoming))
    // Label the sides. Without -L, git names the conflict after the temp files
    // it was handed, so the person opening the file reads
    // `<<<<<<< /tmp/tlda-source-merge-pXOqC9/current` — an path that does not
    // exist and tells them nothing. These markers are read by a human resolving
    // the conflict in their own editor, so they say which side is which.
    const result = spawnSync(
      'git',
      ['merge-file', '-p', '-L', 'in the project', '-L', 'common ancestor', '-L', 'your change', '--', ...paths],
      { encoding: 'utf8' },
    )
    if (result.status === 0) return { status: 'clean-rebase-candidate', merged: result.stdout }
    if (result.status === 1 && result.stdout.includes('<<<<<<<')) return { status: 'conflict', merged: result.stdout }
    return { status: 'classification-unavailable', error: result.stderr || `git merge-file exited ${result.status}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A rebase is available when every path is settled: either merged cleanly, or
// carried whole because only one side moved it. The second kind arrives as a
// hash rather than bytes — canonicalSnapshot takes `{path, sha256}` as a
// reference into the blob store — so a project's untouched files cost nothing
// to carry across a rebase.
function cleanRebaseFiles(classifications) {
  if (!classifications.length) return null
  const settled = item => item.status === 'clean-rebase-candidate'
    && (typeof item.merged === 'string' || typeof item.sha256 === 'string')
  if (!classifications.every(settled)) return null
  return classifications.map(item => (item.sha256
    ? { path: item.path, sha256: item.sha256 }
    : { path: item.path, content: item.merged, encoding: 'base64' }))
}

/**
 * A revision is a manifest of content hashes; the bytes live once each under
 * `blobs/`.
 *
 * It used to be one `snapshot.json` carrying every file's base64 content, which
 * meant each push re-serialized the whole project. On the QTM 285 book — 1499
 * files, 394 MB — that is 525 MB of base64 against V8's 512 MiB ceiling on a
 * single string, so `JSON.stringify` threw `RangeError: Invalid string length`
 * before machine size was even the question. Content-addressing removes the
 * ceiling and the quadratic together: a push writes only blobs the store does
 * not already hold, and `snapshot.json` stays a few hundred kilobytes whatever
 * the project weighs.
 *
 * Snapshots written before this (`version: 1`, content inline) stay readable
 * through `entryContent` below, at the ids they already have. See `revisionFor`
 * for how new ids are computed and why that does not strand them.
 */
export function createSourceLifecycleStore({ root, context = {}, fault = null }) {
  const statePath = join(root, 'authority.json')
  const revisionsRoot = join(root, 'revisions')
  const evidenceRoot = join(root, 'evidence')
  const blobsRoot = join(root, 'blobs')
  const operationsPath = join(root, 'operations.json')
  const state = () => readJson(statePath) || { state: SOURCE_AUTHORITY_UNINITIALIZED, currentRevision: null, acceptSeq: 0 }

  // A `version: 1` entry stores base64 in `content` and does not say so, while
  // an entry built from a file on disk stores utf8 in `content` and also does
  // not say so. Callers carry entries from one revision into the next, so that
  // ambiguity decodes a legacy file into the literal text of its own base64 —
  // silently, and into the authority store. The store tags what it emits so no
  // caller has to remember.
  function revision(id) {
    const record = readJson(join(revisionsRoot, encodeURIComponent(id), 'snapshot.json'))
    if (!record || record.version !== 1) return record
    return { ...record, files: (record.files || []).map(file => ({ ...file, encoding: 'base64' })) }
  }

  const blobPath = sha => join(blobsRoot, sha.slice(0, 2), sha)

  function writeBlob(buffer) {
    const sha = createHash('sha256').update(buffer).digest('hex')
    const path = blobPath(sha)
    if (!existsSync(path)) atomicWrite(path, buffer, fault)
    return { sha256: sha, size: buffer.length }
  }

  function readBlob(sha) {
    const path = blobPath(sha)
    return existsSync(path) ? readFileSync(path) : null
  }

  // Raw bytes for one snapshot entry, whichever form it is in: a v2 blob
  // reference, or a `version: 1` snapshot's inline base64 from before this
  // change. Snapshots have always stored content base64-encoded.
  function entryContent(entry) {
    if (!entry) return null
    if (entry.content !== undefined) {
      return Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'base64')
    }
    if (!entry.sha256) throw new Error(`Corrupt revision file entry: ${entry.path || '<unknown>'} has neither content nor sha256`)
    const blob = readBlob(entry.sha256)
    if (!blob) throw new Error(`Corrupt revision file entry: ${entry.path || '<unknown>'} blob ${entry.sha256} is missing`)
    return blob
  }

  /**
   * A revision is identified by its tree of `(path, content hash)`, the way a
   * git tree is identified by the blobs it names rather than by their bytes.
   *
   * The previous definition hashed the concatenated base64 of every file, so
   * computing a revision id meant reading the whole project — measured at 2.2 s
   * per 75 MB, which is 65% of a push and would make a one-line save on a
   * 394 MB book cost about eleven seconds of blocked event loop, forever. The
   * blobs are already sha256-addressed, so hashing those instead is the same
   * collision resistance at O(files) rather than O(bytes).
   *
   * Ids therefore differ from the ones the concatenating definition produced.
   * Nothing recomputes an id to check it: `expectedRevision` is whatever the
   * server last handed the client, and old snapshots keep their old ids on disk
   * and stay resolvable, so no live project needs migrating.
   */
  function revisionFor(entries, dependencyPins) {
    const hash = createHash('sha256')
    for (const entry of entries) hash.update(entry.path).update('\0').update(entry.sha256).update('\0')
    hash.update(JSON.stringify(dependencyPins)).update('\0')
    return `sha256:${hash.digest('hex')}`
  }

  function operationKey(requestId) {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('requestId is required')
    return requestId
  }

  function operationJournal() {
    const journal = readJson(operationsPath) || {}
    return {
      version: 1,
      byRequestId: journal.byRequestId || {},
      requestIdByDeliveryId: journal.requestIdByDeliveryId || {},
      revisionLifecycle: journal.revisionLifecycle || {},
    }
  }

  function writeOperationJournal(journal) {
    atomicJson(operationsPath, journal, fault)
  }

  function operationFingerprint({ project, expectedRevision, sourceManifest, files = [], deletedFiles = [], dependencyPins = [], editedBy = null }) {
    const pins = canonicalPins(dependencyPins)
    const entries = files.map(file => {
      if (!file || typeof file.path !== 'string') throw new Error('Every changed file must have a path')
      const raw = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(String(file.content ?? ''))
      return { path: file.path, sha256: createHash('sha256').update(raw).digest('hex'), size: raw.length }
    }).sort((a, b) => a.path.localeCompare(b.path))
    const descriptor = stableValue({
      project,
      expectedRevision: expectedRevision ?? null,
      sourceManifest: [...(sourceManifest || [])],
      files: entries.map(({ path, sha256, size }) => ({ path, sha256, size })),
      deletedFiles: [...deletedFiles].sort(),
      dependencyPins: pins,
      editedBy: editedBy ?? null,
    })
    return {
      payloadFingerprint: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
      descriptor,
    }
  }

  /**
   * Validate the proposed snapshot against its manifest and put every file's
   * bytes in the blob store, returning manifest-ordered `{path, sha256, size}`.
   *
   * Entries arrive either with content (a push, or a rebase result) or as a
   * `{path, sha256}` reference carried forward from the current revision — the
   * second form is what lets an unchanged file cost nothing on the next push.
   */
  function canonicalSnapshot(files, manifest, snapshotContext) {
    if (!Array.isArray(files) || !Array.isArray(manifest)) throw new Error('A complete files array and sourceManifest are required')
    const normalized = normalizeSourceManifest(manifest, snapshotContext)
    if (normalized.length !== manifest.length || normalized.some((path, index) => path !== manifest[index])) {
      throw new Error('sourceManifest must be normalized, unique, and contain only authored source paths')
    }
    const declared = new Set(normalized)
    const byPath = new Map()
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || !declared.has(file.path) || byPath.has(file.path)) {
        throw new Error(`Invalid or duplicate snapshot file: ${file?.path ?? ''}`)
      }
      if (file.sha256 && file.content === undefined) {
        if (!existsSync(blobPath(file.sha256))) throw new Error(`Missing blob for ${file.path}`)
        byPath.set(file.path, { path: file.path, sha256: file.sha256, size: file.size ?? statSync(blobPath(file.sha256)).size })
      } else {
        const raw = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(String(file.content ?? ''))
        byPath.set(file.path, { path: file.path, ...writeBlob(raw) })
      }
    }
    if (byPath.size !== normalized.length) {
      throw new Error('Snapshot files must exactly match sourceManifest')
    }
    return normalized.map(path => byPath.get(path))
  }

  function persistSnapshot(entries, dependencyPins = []) {
    const pins = canonicalPins(dependencyPins)
    const id = revisionFor(entries, pins)
    const path = join(revisionsRoot, encodeURIComponent(id), 'snapshot.json')
    if (existsSync(path)) return readJson(path)
    const record = {
      version: 2, id, manifest: entries.map(entry => entry.path), files: entries,
      byteSize: entries.reduce((total, entry) => total + entry.size, 0),
      dependencyPins: pins, createdAt: new Date().toISOString(),
    }
    atomicJson(path, record, fault)
    // `record` is exactly what was serialized, so reading it back would be a
    // second copy for nothing.
    return record
  }

  function fileEntry(snapshot, path) {
    return snapshot?.files?.find(candidate => candidate.path === path) || null
  }

  function revisionFileContent(snapshot, path) {
    return entryContent(fileEntry(snapshot, path))
  }

  // sha256 of the file's raw bytes. Free for a v2 entry, which already is that
  // hash; computed for a `version: 1` entry. Callers comparing two revisions
  // want this rather than the content, and on a large project the difference is
  // reading nothing instead of reading everything.
  function revisionFileHash(snapshot, path) {
    const entry = fileEntry(snapshot, path)
    if (!entry) return null
    if (entry.sha256) return entry.sha256
    const content = entryContent(entry)
    return content ? createHash('sha256').update(content).digest('hex') : null
  }

  // Only the paths that could have changed are read, and only one revision's
  // copy of each at a time. Reading all three revisions whole is what this
  // avoids: on a large book that is three full projects resident to classify a
  // handful of edited files.
  function deriveClassifications(base, current, incoming) {
    const snapshots = [base, current, incoming]
    const paths = [...new Set(snapshots.flatMap(snapshot => (snapshot?.files || []).map(file => file.path)))].sort()
    return paths.map(path => {
      const entries = snapshots.map(snapshot => fileEntry(snapshot, path))
      const [baseHash, currentHash, incomingHash] = snapshots.map(snapshot => revisionFileHash(snapshot, path))

      // A path only needs merging if both sides moved away from the base. One
      // side moving is not a merge, it is a choice with one option, and a path
      // nobody moved is not a question at all.
      //
      // This is the whole of the bug it fixes. Classifying every path in the
      // union meant one unmergeable sibling refused a push it had nothing to do
      // with: a project with a single .png could never take the clean-rebase
      // path, because the figure nobody touched came back
      // `classification-unavailable` and cleanRebaseFiles requires every entry
      // to be a candidate. It worked on a probe and failed on any real paper,
      // which all have figures in them.
      const settled = entry => ({
        path,
        status: 'clean-rebase-candidate',
        ...(entry.sha256 ? { sha256: entry.sha256 } : { merged: entryContent(entry).toString('base64') }),
      })
      // Nobody disagrees: both sides hold the same bytes.
      if (currentHash != null && currentHash === incomingHash) return settled(entries[2])
      // Only the project moved. Their version stands; this push never touched it.
      if (baseHash != null && baseHash === incomingHash && entries[1]) return settled(entries[1])
      // Only this push moved. Its version stands; nobody else touched it.
      if (baseHash != null && baseHash === currentHash && entries[2]) return settled(entries[2])

      if (entries.some(entry => entry == null)) return { path, status: 'classification-unavailable' }
      const contents = entries.map(entry => entryContent(entry))
      if (contents.some(value => value == null)) return { path, status: 'classification-unavailable' }
      const binary = !isTextSourcePath(path) || contents.some(value => value.includes(0))
      const result = classifyThreeWay({ base: contents[0], current: contents[1], incoming: contents[2], binary })
      return {
        path,
        status: result.status,
        ...(result.merged != null ? { merged: Buffer.from(result.merged).toString('base64') } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
    })
  }

  return {
    readAuthority: state,
    readRevision: revision,
    /** Raw bytes of one file in one revision, without loading the rest. */
    readRevisionFile(id, path) {
      return revisionFileContent(revision(id), path)
    },
    /** The same, for a snapshot record the caller already holds. */
    snapshotFile: revisionFileContent,
    snapshotFileHash: revisionFileHash,
    readCurrentFile(path) {
      const authority = state()
      if (authority.state !== SOURCE_AUTHORITY_CURRENT || !authority.currentRevision) return null
      return {
        sourceRevision: authority.currentRevision,
        content: revisionFileContent(revision(authority.currentRevision), path),
      }
    },
    readOperationByRequestId(project, requestId) {
      const operation = operationJournal().byRequestId[operationKey(requestId)] || null
      return operation?.project === project ? operation : null
    },
    readOperationByDeliveryId(project, deliveryId) {
      if (typeof deliveryId !== 'string' || !deliveryId.trim()) throw new Error('deliveryId is required')
      const journal = operationJournal()
      const requestId = journal.requestIdByDeliveryId[deliveryId]
      if (!requestId) return null
      const operation = journal.byRequestId[requestId] || null
      return operation?.project === project ? operation : null
    },
    prepareOperation(payload) {
      const requestId = operationKey(payload.requestId)
      const { payloadFingerprint, descriptor } = operationFingerprint(payload)
      const journal = operationJournal()
      const existing = journal.byRequestId[requestId] || null
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint || (payload.deliveryId && existing.deliveryId !== payload.deliveryId)) {
          return {
            replay: true,
            invalidReuse: true,
            operation: existing,
            result: {
              ok: false,
              status: 'invalid-request-id-reuse',
              requestId: payload.requestId,
              project: existing.project,
            },
          }
        }
        return { replay: true, invalidReuse: false, operation: existing, result: existing.terminalResult ?? null }
      }
      const deliveryId = typeof payload.deliveryId === 'string' && payload.deliveryId.trim() ? payload.deliveryId : null
      if (deliveryId) {
        const boundRequestId = journal.requestIdByDeliveryId[deliveryId]
        if (boundRequestId && boundRequestId !== requestId) {
          return {
            replay: true,
            invalidReuse: true,
            operation: journal.byRequestId[boundRequestId] || null,
            result: {
              ok: false,
              status: 'invalid-delivery-id-reuse',
              requestId,
              deliveryId,
              project: payload.project,
            },
          }
        }
      }
      const now = new Date().toISOString()
      const operation = {
        version: 1,
        project: payload.project,
        requestId,
        deliveryId,
        payloadFingerprint,
        descriptor,
        state: 'prepared',
        terminalResult: null,
        createdAt: now,
        updatedAt: now,
      }
      journal.byRequestId[requestId] = operation
      if (deliveryId) journal.requestIdByDeliveryId[deliveryId] = requestId
      writeOperationJournal(journal)
      return { replay: false, invalidReuse: false, operation, result: null }
    },
    finishOperation(project, requestId, stateName, terminalResult, {
      acceptSeq = null,
      recoveryId = null,
      previousRevision = null,
      acceptedRevision = null,
      orderedEffects = [],
    } = {}) {
      if (!['accepted', 'rejected', 'recovery_required', 'invalid'].includes(stateName)) {
        throw new Error(`Invalid terminal source operation state: ${stateName}`)
      }
      const journal = operationJournal()
      const existing = journal.byRequestId[operationKey(requestId)] || null
      if (!existing) throw new Error(`Source operation ${requestId} was not prepared`)
      if (existing.project !== project) throw new Error(`Source operation ${requestId} does not belong to ${project}`)
      if (existing.terminalResult) return existing
      const operation = {
        ...existing,
        state: stateName,
        terminalResult: stableValue(terminalResult),
        ...(acceptSeq == null ? {} : { acceptSeq }),
        ...(recoveryId == null ? {} : { recoveryId }),
        previousRevision,
        acceptedRevision,
        orderedEffects: stableValue(orderedEffects),
        updatedAt: new Date().toISOString(),
      }
      journal.byRequestId[requestId] = operation
      if (stateName === 'accepted' && acceptedRevision) {
        journal.revisionLifecycle[acceptedRevision] ||= {
          project,
          sourceRevision: acceptedRevision,
          acceptSeq,
          state: 'accepted',
          build: { state: 'pending', updatedAt: operation.updatedAt },
          version: { state: 'pending', updatedAt: operation.updatedAt },
          mirror: { state: 'pending', updatedAt: operation.updatedAt },
          replicas: {},
          acceptedAt: operation.updatedAt,
          updatedAt: operation.updatedAt,
        }
      }
      writeOperationJournal(journal)
      return operationJournal().byRequestId[requestId]
    },
    readRevisionLifecycle(project, sourceRevision) {
      const lifecycle = operationJournal().revisionLifecycle[sourceRevision] || null
      return lifecycle?.project === project ? lifecycle : null
    },
    listRevisionLifecycles(project) {
      return Object.values(operationJournal().revisionLifecycle)
        .filter(lifecycle => lifecycle?.project === project)
        .sort((a, b) => (a.acceptSeq ?? 0) - (b.acceptSeq ?? 0))
    },
    recordAcceptedRevision(project, sourceRevision, acceptSeq) {
      const journal = operationJournal()
      const existing = journal.revisionLifecycle[sourceRevision]
      if (existing) {
        if (existing.project !== project) {
          throw new Error(`Accepted revision identity mismatch for ${sourceRevision}`)
        }
        return existing
      }
      const updatedAt = new Date().toISOString()
      journal.revisionLifecycle[sourceRevision] = {
        project,
        sourceRevision,
        acceptSeq,
        state: 'accepted',
        build: { state: 'pending', updatedAt },
        version: { state: 'pending', updatedAt },
        mirror: { state: 'pending', updatedAt },
        replicas: {},
        acceptedAt: updatedAt,
        updatedAt,
      }
      writeOperationJournal(journal)
      return operationJournal().revisionLifecycle[sourceRevision]
    },
    recordRevisionPhase(project, sourceRevision, phase, stateName, result = null) {
      if (!['build', 'version', 'mirror'].includes(phase)) throw new Error(`Invalid source revision phase: ${phase}`)
      const journal = operationJournal()
      const lifecycle = journal.revisionLifecycle[sourceRevision]
      if (!lifecycle || lifecycle.project !== project) throw new Error(`Source revision ${sourceRevision} is not accepted for ${project}`)
      const updatedAt = new Date().toISOString()
      journal.revisionLifecycle[sourceRevision] = {
        ...lifecycle,
        [phase]: { state: stateName, result: stableValue(result), updatedAt },
        updatedAt,
      }
      writeOperationJournal(journal)
      return operationJournal().revisionLifecycle[sourceRevision]
    },
    recordReplicaTargets(project, sourceRevision, targets, command) {
      const journal = operationJournal()
      const lifecycle = journal.revisionLifecycle[sourceRevision]
      if (!lifecycle || lifecycle.project !== project) throw new Error(`Source revision ${sourceRevision} is not accepted for ${project}`)
      if (lifecycle.replicaTargetsRecorded) return lifecycle
      const updatedAt = new Date().toISOString()
      const replicas = { ...(lifecycle.replicas || {}) }
      const uniqueTargets = new Map((targets || []).filter(target => target?.bindingId && target?.daemonKey)
        .map(target => [target.bindingId, target]))
      for (const target of [...uniqueTargets.values()].sort((a, b) => a.bindingId.localeCompare(b.bindingId))) {
        replicas[target.bindingId] ||= {
          state: 'pending',
          daemonKey: target.daemonKey,
          operationId: `materialize:${target.bindingId}:${sourceRevision}`,
          command: stableValue({ ...command, bindingId: target.bindingId }),
          result: null,
          updatedAt,
        }
      }
      journal.revisionLifecycle[sourceRevision] = { ...lifecycle, replicas, replicaTargetsRecorded: true, updatedAt }
      writeOperationJournal(journal)
      return operationJournal().revisionLifecycle[sourceRevision]
    },
    recordReplicaResult(project, sourceRevision, bindingId, stateName, result = null) {
      const journal = operationJournal()
      const lifecycle = journal.revisionLifecycle[sourceRevision]
      if (!lifecycle || lifecycle.project !== project) throw new Error(`Source revision ${sourceRevision} is not accepted for ${project}`)
      if (!bindingId) throw new Error('bindingId is required')
      const updatedAt = new Date().toISOString()
      const replicas = {
        ...(lifecycle.replicas || {}),
        [bindingId]: {
          ...(lifecycle.replicas?.[bindingId] || {}),
          state: stateName,
          result: stableValue(result),
          updatedAt,
        },
      }
      journal.revisionLifecycle[sourceRevision] = { ...lifecycle, replicas, updatedAt }
      writeOperationJournal(journal)
      return operationJournal().revisionLifecycle[sourceRevision]
    },
    bootstrap({ expectedRevision, files, sourceManifest, observedServerFiles = null, observedSourceManifest = null, dependencyPins = [] }) {
      const before = state()
      if (before.state !== SOURCE_AUTHORITY_UNINITIALIZED || expectedRevision !== null) {
        return { ok: false, status: 'stale-base', authority: before }
      }
      const canonical = canonicalSnapshot(files, sourceManifest, context)
      const next = persistSnapshot(canonical, dependencyPins)
      if (observedServerFiles !== null) {
        const observed = canonicalSnapshot(observedServerFiles, observedSourceManifest || sourceManifest, context)
        if (revisionFor(observed, next.dependencyPins) !== next.id) {
          const evidence = persistSnapshot(observed)
          const authority = { state: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, currentRevision: null, proposedRevision: next.id, evidenceRevision: evidence.id }
          atomicJson(statePath, authority, fault)
          return { ok: false, status: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, authority }
        }
      }
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: next.id, acceptSeq: (before.acceptSeq || 0) + 1 }
      atomicJson(statePath, authority, fault)
      return { ok: true, status: 'accepted', authority, revision: next }
    },
    submit({ expectedRevision, files, sourceManifest, dependencyPins = [] }) {
      const before = state()
      const canonical = canonicalSnapshot(files, sourceManifest, context)
      const incoming = persistSnapshot(canonical, dependencyPins)
      if (before.state !== SOURCE_AUTHORITY_CURRENT || expectedRevision !== before.currentRevision) {
        const base = expectedRevision ? revision(expectedRevision) : null
        const current = before.currentRevision ? revision(before.currentRevision) : null
        const classifications = deriveClassifications(base, current, incoming)
        const evidence = {
          version: 1, id: randomUUID(), status: 'stale-base', expectedRevision,
          currentRevision: before.currentRevision, incomingRevision: incoming.id,
          classifications,
          byteSize: incoming.byteSize, dependencyPins: incoming.dependencyPins,
          createdAt: new Date().toISOString(),
        }
        atomicJson(join(evidenceRoot, `${evidence.id}.json`), evidence, fault)
        const rebasedFiles = cleanRebaseFiles(classifications)
        if (rebasedFiles) {
          const rebased = persistSnapshot(canonicalSnapshot(rebasedFiles, incoming.manifest, context), incoming.dependencyPins)
          const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: rebased.id, acceptSeq: (before.acceptSeq || 0) + 1 }
          atomicJson(statePath, authority, fault)
          return { ok: true, status: 'accepted-clean-rebase', authority, revision: rebased, evidence }
        }
        return { ok: false, status: 'stale-base', authority: before, evidence }
      }
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: incoming.id, acceptSeq: (before.acceptSeq || 0) + 1 }
      atomicJson(statePath, authority, fault)
      return { ok: true, status: 'accepted', authority, revision: incoming }
    },
  }
}
