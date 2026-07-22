import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { isTextSourcePath, normalizeSourceManifest } from '../../shared/source-manifest.mjs'

export const SOURCE_AUTHORITY_UNINITIALIZED = 'uninitialized'
export const SOURCE_AUTHORITY_CURRENT = 'current'
export const SOURCE_AUTHORITY_RECONCILIATION_REQUIRED = 'reconciliation-required'

function canonicalSnapshot(files, manifest, context) {
  if (!Array.isArray(files) || !Array.isArray(manifest)) throw new Error('A complete files array and sourceManifest are required')
  const normalized = normalizeSourceManifest(manifest, context)
  if (normalized.length !== manifest.length || normalized.some((path, index) => path !== manifest[index])) {
    throw new Error('sourceManifest must be normalized, unique, and contain only authored source paths')
  }
  const byPath = new Map()
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !normalized.includes(file.path) || byPath.has(file.path)) {
      throw new Error(`Invalid or duplicate snapshot file: ${file?.path ?? ''}`)
    }
    byPath.set(file.path, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(String(file.content ?? '')))
  }
  if (byPath.size !== normalized.length || normalized.some(path => !byPath.has(path))) {
    throw new Error('Snapshot files must exactly match sourceManifest')
  }
  return normalized.map(path => ({ path, content: byPath.get(path).toString('base64') }))
}

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

function revisionFor(files, dependencyPins) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.path).update('\0').update(file.content).update('\0')
  hash.update(JSON.stringify(dependencyPins)).update('\0')
  return `sha256:${hash.digest('hex')}`
}

function byteSize(files) {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content, 'base64'), 0)
}

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicJson(path, value, fault) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, JSON.stringify(value, null, 2))
  syncFile(pending)
  fault?.('before-rename', { path, pending })
  renameSync(pending, path)
  syncFile(path)
  syncFile(dirname(path))
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
    const result = spawnSync('git', ['merge-file', '-p', '--', ...paths], { encoding: 'utf8' })
    if (result.status === 0) return { status: 'clean-rebase-candidate', merged: result.stdout }
    if (result.status === 1 && result.stdout.includes('<<<<<<<')) return { status: 'conflict', merged: result.stdout }
    return { status: 'classification-unavailable', error: result.stderr || `git merge-file exited ${result.status}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function deriveClassifications(base, current, incoming) {
  const snapshots = [base, current, incoming].map(snapshot => new Map((snapshot?.files || []).map(file => [file.path, file.content])))
  const paths = [...new Set(snapshots.flatMap(snapshot => [...snapshot.keys()]))].sort()
  return paths.map(path => {
    const encoded = snapshots.map(snapshot => snapshot.get(path))
    if (encoded.some(value => value == null)) return { path, status: 'classification-unavailable' }
    const contents = encoded.map(value => Buffer.from(value, 'base64'))
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

export function createSourceLifecycleStore({ root, context = {}, fault = null }) {
  const statePath = join(root, 'authority.json')
  const revisionsRoot = join(root, 'revisions')
  const evidenceRoot = join(root, 'evidence')
  const state = () => readJson(statePath) || { state: SOURCE_AUTHORITY_UNINITIALIZED, currentRevision: null }
  const revision = id => readJson(join(revisionsRoot, encodeURIComponent(id), 'snapshot.json'))

  function persistSnapshot(files, dependencyPins = []) {
    const pins = canonicalPins(dependencyPins)
    const id = revisionFor(files, pins)
    const record = {
      version: 1, id, manifest: files.map(file => file.path), files,
      byteSize: byteSize(files), dependencyPins: pins, createdAt: new Date().toISOString(),
    }
    const path = join(revisionsRoot, encodeURIComponent(id), 'snapshot.json')
    if (existsSync(path)) return readJson(path)
    atomicJson(path, record, fault)
    return readJson(path)
  }

  return {
    readAuthority: state,
    readRevision: revision,
    bootstrap({ expectedRevision, files, sourceManifest, observedServerFiles = null, dependencyPins = [] }) {
      const before = state()
      if (before.state !== SOURCE_AUTHORITY_UNINITIALIZED || expectedRevision !== null) {
        return { ok: false, status: 'stale-base', authority: before }
      }
      const canonical = canonicalSnapshot(files, sourceManifest, context)
      const next = persistSnapshot(canonical, dependencyPins)
      if (observedServerFiles !== null) {
        const observed = canonicalSnapshot(observedServerFiles, sourceManifest, context)
        if (revisionFor(observed, next.dependencyPins) !== next.id) {
          const evidence = persistSnapshot(observed)
          const authority = { state: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, currentRevision: null, proposedRevision: next.id, evidenceRevision: evidence.id }
          atomicJson(statePath, authority, fault)
          return { ok: false, status: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, authority }
        }
      }
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: next.id }
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
        const evidence = {
          version: 1, id: randomUUID(), status: 'stale-base', expectedRevision,
          currentRevision: before.currentRevision, incomingRevision: incoming.id,
          classifications: deriveClassifications(base, current, incoming),
          byteSize: incoming.byteSize, dependencyPins: incoming.dependencyPins,
          createdAt: new Date().toISOString(),
        }
        atomicJson(join(evidenceRoot, `${evidence.id}.json`), evidence, fault)
        return { ok: false, status: 'stale-base', authority: before, evidence }
      }
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: incoming.id }
      atomicJson(statePath, authority, fault)
      return { ok: true, status: 'accepted', authority, revision: incoming }
    },
  }
}
