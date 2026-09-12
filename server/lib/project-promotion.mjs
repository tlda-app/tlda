import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { projectRevisionStatus } from './source-lifecycle.mjs'
import { encodeRefComponent } from './source-git-store.mjs'

const execFileAsync = promisify(execFile)
const METADATA_KEYS = new Set([
  'name', 'title', 'mainFile', 'format', 'documentRoots', 'members', 'pages',
  'createdAt', 'updatedAt', 'lastBuild', 'lastBuildSuccess', 'buildStatus',
  'renderedFormat', 'targets', 'view',
])
const ARTIFACT_KEYS = new Set(['version', 'sourceEnvironment', 'name', 'revision', 'tree', 'metadata', 'lifecycle', 'output', 'buildLog', 'bundle', 'sha256'])

export function validatePromotionName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error('invalid project promotion name')
  }
  return name
}

function validateRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || posix.normalize(path) !== path || path.split('/').includes('..')) {
    throw new Error(`invalid project promotion path: ${path}`)
  }
  return path
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function regularFiles(root, prefix = '') {
  const rows = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    validateRelativePath(path)
    if (entry.isSymbolicLink()) throw new Error(`project promotion refuses symlink: ${path}`)
    if (entry.isDirectory()) rows.push(...await regularFiles(join(root, entry.name), path))
    else if (entry.isFile()) rows.push({ path, content: (await readFile(join(root, entry.name))).toString('base64') })
    else throw new Error(`project promotion refuses non-file member: ${path}`)
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

export function promotionArtifactHash({ metadata, lifecycle, output, buildLog, bundle }) {
  return digest(Buffer.from(stableJson({ metadata, lifecycle, output: output.map(row => ({ path: row.path, sha256: digest(Buffer.from(row.content, 'base64')) })), buildLog: digest(Buffer.from(buildLog, 'base64')), bundle: digest(Buffer.from(bundle, 'base64')) })))
}

function acceptedIdentity(lifecycleStore, name) {
  const rows = lifecycleStore.listRevisionLifecycles(name)
  const status = projectRevisionStatus(rows)
  const row = rows.find(item => item.sourceRevision === status.sourceRevision)
  if (!row || status.status !== 'success') throw new Error(`project ${name} has no terminal successful accepted revision`)
  return { sourceRevision: status.sourceRevision, acceptSeq: status.acceptSeq, lifecycle: row }
}

export async function exportProjectPromotion({ name, revision, sourceEnvironment, projectRoot, lifecycleStore, serialize }) {
  validatePromotionName(name)
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('exact source revision is required')
  return serialize(name, async () => {
    const before = acceptedIdentity(lifecycleStore, name)
    if (before.sourceRevision !== revision) throw new Error('accepted source revision changed')
    const raw = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8'))
    if (raw.name !== name) throw new Error('project metadata name mismatch')
    const metadata = Object.fromEntries(Object.entries(raw).filter(([key]) => METADATA_KEYS.has(key)))
    const output = await regularFiles(join(projectRoot, 'output'))
    const buildLog = (await readFile(join(projectRoot, 'build.log'))).toString('base64')
    const bundlePath = join(projectRoot, `.promotion-${process.pid}-${randomUUID()}.bundle`)
    try {
      const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
      await execFileAsync('git', [`--git-dir=${join(projectRoot, '.source-lifecycle', 'git')}`, 'bundle', 'create', bundlePath, sourceRef], { timeout: 30000 })
      const bundle = (await readFile(bundlePath)).toString('base64')
      const after = acceptedIdentity(lifecycleStore, name)
      if (stableJson(before) !== stableJson(after)) throw new Error('project changed during promotion snapshot')
      const git = await lifecycleStore.gitRepository()
      const tree = (await execFileAsync('git', [`--git-dir=${join(projectRoot, '.source-lifecycle', 'git')}`, 'rev-parse', `${revision}^{tree}`], { encoding: 'utf8' })).stdout.trim()
      const artifact = { version: 1, sourceEnvironment, name, revision, tree, metadata, lifecycle: before.lifecycle, output, buildLog, bundle }
      return { ...artifact, sha256: promotionArtifactHash(artifact) }
    } finally {
      await rm(bundlePath, { force: true })
    }
  })
}

export async function importProjectPromotion({ artifact, sourceEnvironment, name, revision, projectsRoot, serialize, onActivated = null, beforeActivation = null }) {
  validatePromotionName(name)
  if (artifact?.version !== 1 || artifact.sourceEnvironment !== sourceEnvironment || artifact.name !== name || artifact.revision !== revision) throw new Error('trusted promotion identity mismatch')
  for (const key of Object.keys(artifact)) if (!ARTIFACT_KEYS.has(key)) throw new Error(`unexpected promotion artifact member: ${key}`)
  for (const key of Object.keys(artifact.metadata || {})) if (!METADATA_KEYS.has(key)) throw new Error(`unexpected promotion metadata member: ${key}`)
  for (const row of artifact.output || []) {
    if (!row || Object.keys(row).some(key => !['path', 'content'].includes(key))) throw new Error('unexpected promotion output member')
  }
  if (artifact.sha256 !== promotionArtifactHash(artifact)) throw new Error('promotion artifact hash mismatch')
  if (artifact.metadata?.name !== name || artifact.lifecycle?.project !== name || artifact.lifecycle?.sourceRevision !== revision) throw new Error('promotion metadata identity mismatch')
  if (!['built', 'not_required'].includes(artifact.lifecycle?.build?.state)) throw new Error('promotion lifecycle is not terminal successful')
  return serialize(name, async () => {
    const destination = join(projectsRoot, name)
    if (existsSync(destination)) {
      if (await existingPromotionMatches(destination, artifact)) {
        await onActivated?.()
        return { promoted: false, alreadyPromoted: true, revision }
      }
      throw new Error(`Project "${name}" already exists`)
    }
    const pending = join(projectsRoot, `.promotion-${name}-${process.pid}-${randomUUID()}`)
    let activated = false
    try {
      await mkdir(join(pending, '.source-lifecycle', 'git'), { recursive: true })
      await writeFile(join(pending, 'source.bundle'), Buffer.from(artifact.bundle, 'base64'))
      await execFileAsync('git', ['init', '--bare', '--quiet', join(pending, '.source-lifecycle', 'git')])
      const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
      await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'fetch', join(pending, 'source.bundle'), `${sourceRef}:${sourceRef}`], { timeout: 30000 })
      const importedHead = (await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
      if (importedHead !== revision) throw new Error('promotion bundle head mismatch')
      const tree = (await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'rev-parse', `${revision}^{tree}`], { encoding: 'utf8' })).stdout.trim()
      if (tree !== artifact.tree) throw new Error('promotion revision tree mismatch')
      await mkdir(join(pending, 'output'), { recursive: true })
      for (const row of artifact.output) {
        validateRelativePath(row.path)
        const target = join(pending, 'output', ...row.path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(row.content, 'base64'))
      }
      await writeFile(join(pending, 'build.log'), Buffer.from(artifact.buildLog, 'base64'))
      await writeFile(join(pending, '.source-lifecycle', 'operations.json'), `${JSON.stringify({ version: 1, revisionLifecycle: { [revision]: artifact.lifecycle } }, null, 2)}\n`)
      await writeFile(join(pending, 'project.json'), `${JSON.stringify(artifact.metadata, null, 2)}\n`)
      await rm(join(pending, 'source.bundle'), { force: true })
      await beforeActivation?.(pending)
      if (existsSync(destination)) throw new Error(`Project "${name}" already exists`)
      await rename(pending, destination)
      activated = true
      await onActivated?.()
      return { promoted: true, alreadyPromoted: false, revision, tree }
    } catch (error) {
      await rm(pending, { recursive: true, force: true })
      throw error
    }
  })
}

async function existingPromotionMatches(destination, artifact) {
  try {
    const metadata = JSON.parse(await readFile(join(destination, 'project.json'), 'utf8'))
    const operations = JSON.parse(await readFile(join(destination, '.source-lifecycle', 'operations.json'), 'utf8'))
    const lifecycle = operations.revisionLifecycle?.[artifact.revision]
    if (stableJson(metadata) !== stableJson(artifact.metadata) || stableJson(lifecycle) !== stableJson(artifact.lifecycle)) return false
    const output = await regularFiles(join(destination, 'output'))
    const expectedOutput = artifact.output.map(row => ({ path: row.path, sha256: digest(Buffer.from(row.content, 'base64')) }))
    const actualOutput = output.map(row => ({ path: row.path, sha256: digest(Buffer.from(row.content, 'base64')) }))
    if (stableJson(actualOutput) !== stableJson(expectedOutput)) return false
    if (!(await readFile(join(destination, 'build.log'))).equals(Buffer.from(artifact.buildLog, 'base64'))) return false
    const gitDir = join(destination, '.source-lifecycle', 'git')
    const sourceRef = `refs/tlda/source/${encodeRefComponent(artifact.name)}`
    const head = (await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
    const tree = (await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', `${artifact.revision}^{tree}`], { encoding: 'utf8' })).stdout.trim()
    return head === artifact.revision && tree === artifact.tree
  } catch {
    return false
  }
}
