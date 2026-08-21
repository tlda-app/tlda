import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createSourceGitStore } from './source-git-store.mjs'

export function projectRevisionStatus(lifecycles) {
  const revision = [...(lifecycles || [])].sort((a, b) => (b.acceptSeq ?? 0) - (a.acceptSeq ?? 0))[0] || null
  if (!revision) return { status: 'unknown', phase: null, sourceRevision: null, acceptSeq: null }
  const phases = ['build', 'version']
  const failed = phases.find(phase => ['build_failed', 'version_failed'].includes(revision[phase]?.state))
  const pending = phases.find(phase => ['pending', 'leased'].includes(revision[phase]?.state))
  const terminal = revision.build?.state
  return {
    status: failed ? 'error'
      : pending ? 'building'
        : terminal === 'cancelled' ? 'cancelled'
          : terminal === 'superseded' ? 'superseded'
            : terminal === 'not_required' ? 'not_required'
              : 'success',
    phase: failed || pending || null,
    sourceRevision: revision.sourceRevision,
    acceptSeq: revision.acceptSeq,
    build: revision.build,
    version: revision.version,
    mirror: revision.mirror,
  }
}

function initBare(gitDir) {
  return new Promise((resolve, reject) => {
    mkdirSync(gitDir, { recursive: true })
    const child = spawn('git', ['init', '--bare', '--quiet', gitDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr = []
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`git init failed: ${Buffer.concat(stderr).toString('utf8').trim()}`)))
  })
}

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`)
  syncFile(pending)
  renameSync(pending, path)
  syncFile(dirname(path))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

export function createSourceLifecycleStore({ root, project = 'project', onStatusChange = null }) {
  const gitDir = join(root, 'git')
  const operationsPath = join(root, 'operations.json')
  let gitPromise = null

  async function gitRepository() {
    if (!gitPromise) {
      gitPromise = (async () => {
        if (!existsSync(join(gitDir, 'HEAD'))) await initBare(gitDir)
        return createSourceGitStore({ gitDir })
      })()
    }
    return gitPromise
  }

  function journal() {
    if (!existsSync(operationsPath)) return { version: 1, revisionLifecycle: {} }
    const value = JSON.parse(readFileSync(operationsPath, 'utf8'))
    return { ...value, version: 1, revisionLifecycle: value.revisionLifecycle || {} }
  }

  function notifyStatus(value, name) {
    onStatusChange?.(name, projectRevisionStatus(Object.values(value.revisionLifecycle || {})))
  }

  return {
    gitRepository,
    async isAncestor(ancestor, descendant) {
      return (await gitRepository()).isAncestor(ancestor, descendant)
    },
    async readRevision(id) {
      if (!id) return null
      try {
        const files = await (await gitRepository()).readManifest(id)
        return { id, manifest: files.map(file => file.path), files }
      } catch {
        return null
      }
    },
    async readRevisionFile(id, path) {
      if (!id) return null
      try { return await (await gitRepository()).readRevisionFile(id, path) } catch { return null }
    },
    async readCurrentFile(path) {
      const git = await gitRepository()
      const head = await git.head(project)
      if (!head) return null
      const content = await git.readRevisionFile(head, path)
      return content == null ? null : { path, content, sourceRevision: head }
    },
    listRevisionLifecycles(name = project) {
      return Object.values(journal().revisionLifecycle)
        .filter(lifecycle => lifecycle?.project === name)
        .sort((a, b) => (a.acceptSeq ?? 0) - (b.acceptSeq ?? 0))
    },
    recordRevisionAdmission(name, sourceRevision, acceptSeq) {
      const value = journal()
      const existing = value.revisionLifecycle[sourceRevision]
      if (existing) return existing
      const updatedAt = new Date().toISOString()
      value.revisionLifecycle[sourceRevision] = {
        project: name,
        sourceRevision,
        acceptSeq,
        build: { state: 'pending', result: null, updatedAt },
        updatedAt,
      }
      atomicJson(operationsPath, value)
      notifyStatus(value, name)
      return value.revisionLifecycle[sourceRevision]
    },
    recordRevisionPhase(name, sourceRevision, phase, state, result = null) {
      if (!['build', 'version', 'mirror'].includes(phase)) throw new Error(`Invalid source revision phase: ${phase}`)
      const value = journal()
      const lifecycle = value.revisionLifecycle[sourceRevision]
      if (!lifecycle || lifecycle.project !== name) throw new Error(`Source revision ${sourceRevision} is not recorded for ${name}`)
      const updatedAt = new Date().toISOString()
      value.revisionLifecycle[sourceRevision] = {
        ...lifecycle,
        [phase]: { state, result: stableValue(result), updatedAt },
        updatedAt,
      }
      atomicJson(operationsPath, value)
      notifyStatus(value, name)
      return value.revisionLifecycle[sourceRevision]
    },
  }
}
