import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { projectRevisionStatus } from './source-lifecycle.mjs'
import { createSourceGitStore, encodeRefComponent } from './source-git-store.mjs'
import { materializeAcceptedRevision } from './revision-tree-materializer.mjs'

const execFileAsync = promisify(execFile)
const METADATA_KEYS = new Set([
  'name', 'title', 'mainFile', 'format', 'documentRoots', 'members', 'pages',
  'createdAt', 'updatedAt', 'lastBuild', 'lastBuildSuccess', 'buildStatus',
  'renderedFormat', 'targets', 'view',
])
const ARTIFACT_KEYS = new Set(['version', 'sourceEnvironment', 'name', 'revision', 'tree', 'metadata', 'lifecycle', 'output', 'buildLog', 'bundle', 'sha256'])
const STREAM_MAGIC = Buffer.from('TLDA-PROMOTION-2\n')
const MAX_HEADER_BYTES = 1024 * 1024
const MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
const STREAM_HEADER_KEYS = new Set(['version', 'sourceEnvironment', 'name', 'revision', 'tree', 'metadata', 'lifecycle', 'members', 'sha256'])

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

async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function regularFileDescriptors(root, prefix = '') {
  const rows = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    validateRelativePath(relative)
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`project promotion refuses symlink: ${relative}`)
    if (entry.isDirectory()) rows.push(...await regularFileDescriptors(path, relative))
    else if (entry.isFile()) {
      const info = await stat(path)
      rows.push({ kind: 'output', path: relative, size: info.size, sha256: await fileDigest(path), source: path })
    } else throw new Error(`project promotion refuses non-file member: ${relative}`)
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

function streamArtifactHash({ metadata, lifecycle, members }) {
  return digest(Buffer.from(stableJson({ metadata, lifecycle, members: members.map(({ kind, path, size, sha256 }) => ({ kind, path, size, sha256 })) })))
}

async function writeChunk(destination, chunk) {
  if (destination.destroyed) throw new Error('project promotion destination disconnected')
  if (!destination.write(chunk)) {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        destination.off('drain', onDrain)
        destination.off('close', onClose)
        destination.off('error', onError)
      }
      const onDrain = () => { cleanup(); resolve() }
      const onClose = () => { cleanup(); reject(new Error('project promotion destination disconnected')) }
      const onError = error => { cleanup(); reject(error) }
      destination.once('drain', onDrain)
      destination.once('close', onClose)
      destination.once('error', onError)
    })
  }
}

export async function writeProjectPromotionStream({ name, revision, sourceEnvironment, projectRoot, lifecycleStore, serialize, destination }) {
  validatePromotionName(name)
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('exact source revision is required')
  return serialize(name, async () => {
    const before = acceptedIdentity(lifecycleStore, name)
    if (before.sourceRevision !== revision) throw new Error('accepted source revision changed')
    const raw = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8'))
    if (raw.name !== name) throw new Error('project metadata name mismatch')
    const metadata = Object.fromEntries(Object.entries(raw).filter(([key]) => METADATA_KEYS.has(key)))
    const bundlePath = join(projectRoot, `.promotion-${process.pid}-${randomUUID()}.bundle`)
    try {
      const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
      await execFileAsync('git', [`--git-dir=${join(projectRoot, '.source-lifecycle', 'git')}`, 'bundle', 'create', bundlePath, sourceRef], { timeout: 30000 })
      const output = await regularFileDescriptors(join(projectRoot, 'output'))
      const fixed = [
        { kind: 'buildLog', path: 'build.log', source: join(projectRoot, 'build.log') },
        { kind: 'bundle', path: 'source.bundle', source: bundlePath },
      ]
      for (const row of fixed) {
        const info = await stat(row.source)
        row.size = info.size
        row.sha256 = await fileDigest(row.source)
      }
      const members = [...fixed, ...output]
      const after = acceptedIdentity(lifecycleStore, name)
      if (stableJson(before) !== stableJson(after)) throw new Error('project changed during promotion snapshot')
      const tree = (await execFileAsync('git', [`--git-dir=${join(projectRoot, '.source-lifecycle', 'git')}`, 'rev-parse', `${revision}^{tree}`], { encoding: 'utf8' })).stdout.trim()
      const header = { version: 2, sourceEnvironment, name, revision, tree, metadata, lifecycle: before.lifecycle, members: members.map(({ kind, path, size, sha256 }) => ({ kind, path, size, sha256 })) }
      header.sha256 = streamArtifactHash(header)
      validateStreamHeader(header, { sourceEnvironment, name, revision })
      const encodedHeader = Buffer.from(JSON.stringify(header))
      if (encodedHeader.length > MAX_HEADER_BYTES) throw new Error('project promotion header is too large')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(encodedHeader.length)
      await writeChunk(destination, STREAM_MAGIC)
      await writeChunk(destination, length)
      await writeChunk(destination, encodedHeader)
      for (const member of members) {
        for await (const chunk of createReadStream(member.source)) await writeChunk(destination, chunk)
      }
      destination.end()
      await finished(destination)
      return { streamed: true, revision }
    } finally {
      await rm(bundlePath, { force: true })
    }
  })
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
      if (artifact.metadata.format === 'qmd') {
        const imported = createSourceGitStore({ gitDir: join(pending, '.source-lifecycle', 'git') })
        const files = await imported.readManifest(revision)
        await materializeAcceptedRevision({
          revision: { id: revision, files },
          lifecycle: { readRevisionFiles: (_id, paths) => imported.readRevisionFiles(revision, paths) },
          destination: join(pending, 'source'),
        })
      }
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

async function readExactly(iterator, state, size) {
  const chunks = []
  let remaining = size
  while (remaining > 0) {
    if (!state.chunk?.length) {
      const next = await iterator.next()
      if (next.done) throw new Error('truncated project promotion stream')
      state.chunk = Buffer.from(next.value)
    }
    const take = Math.min(remaining, state.chunk.length)
    chunks.push(state.chunk.subarray(0, take))
    state.chunk = state.chunk.subarray(take)
    remaining -= take
  }
  return Buffer.concat(chunks, size)
}

async function writeMember(iterator, state, target, member) {
  const output = createWriteStream(target, { flags: 'wx' })
  const hash = createHash('sha256')
  let remaining = member.size
  try {
    while (remaining > 0) {
      if (!state.chunk?.length) {
        const next = await iterator.next()
        if (next.done) throw new Error(`truncated project promotion member: ${member.path}`)
        state.chunk = Buffer.from(next.value)
      }
      const take = Math.min(remaining, state.chunk.length)
      const chunk = state.chunk.subarray(0, take)
      state.chunk = state.chunk.subarray(take)
      remaining -= take
      hash.update(chunk)
      await writeChunk(output, chunk)
    }
    output.end()
    await once(output, 'finish')
  } catch (error) {
    output.destroy()
    throw error
  }
  if (hash.digest('hex') !== member.sha256) throw new Error(`project promotion member hash mismatch: ${member.path}`)
}

function validateStreamHeader(header, { sourceEnvironment, name, revision }) {
  if (header?.version !== 2 || header.sourceEnvironment !== sourceEnvironment || header.name !== name || header.revision !== revision) throw new Error('trusted promotion identity mismatch')
  for (const key of Object.keys(header)) if (!STREAM_HEADER_KEYS.has(key)) throw new Error(`unexpected promotion stream header member: ${key}`)
  if (header.metadata?.name !== name || header.lifecycle?.project !== name || header.lifecycle?.sourceRevision !== revision) throw new Error('promotion metadata identity mismatch')
  if (!['built', 'not_required'].includes(header.lifecycle?.build?.state)) throw new Error('promotion lifecycle is not terminal successful')
  for (const key of Object.keys(header.metadata || {})) if (!METADATA_KEYS.has(key)) throw new Error(`unexpected promotion metadata member: ${key}`)
  if (!Array.isArray(header.members)) throw new Error('promotion artifact hash mismatch')
  const seen = new Set()
  let bundles = 0
  let logs = 0
  let totalSize = 0
  for (const member of header.members) {
    if (!member || Object.keys(member).some(key => !['kind', 'path', 'size', 'sha256'].includes(key))) throw new Error('unexpected promotion stream member')
    validateRelativePath(member.path)
    if (!['bundle', 'buildLog', 'output'].includes(member.kind)) throw new Error(`unexpected promotion stream member kind: ${member.kind}`)
    if (!Number.isSafeInteger(member.size) || member.size < 0 || member.size > MAX_MEMBER_BYTES) throw new Error(`invalid project promotion member size: ${member.path}`)
    totalSize += member.size
    if (totalSize > MAX_TOTAL_BYTES) throw new Error('project promotion stream is too large')
    if (!/^[0-9a-f]{64}$/.test(member.sha256 || '')) throw new Error(`invalid project promotion member hash: ${member.path}`)
    const identity = `${member.kind}\0${member.path}`
    if (seen.has(identity)) throw new Error(`duplicate project promotion member: ${member.path}`)
    seen.add(identity)
    if (member.kind === 'bundle') bundles++
    if (member.kind === 'buildLog') logs++
  }
  if (bundles !== 1 || logs !== 1) throw new Error('project promotion stream requires one bundle and one build log')
  if (header.sha256 !== streamArtifactHash(header)) throw new Error('promotion artifact hash mismatch')
}

/**
 * A directory the swap below moved out of the way. It holds a marker naming
 * the project it came from, so the next promotion can put it back: a crash
 * between the two renames leaves the project absent, and the recovery is to
 * run the promotion again rather than to have a startup pass for a window two
 * adjacent renames wide.
 *
 * NOT the shape build-dispatch recovers. Its window spans a cross-filesystem
 * copy of the whole render — 936 MB for the largest tree here — which is why
 * it earns a startup phase and this does not.
 */
const ASIDE_MARKER = '.promoted-aside.json'

function asidePath(projectsRoot, name) {
  return join(projectsRoot, `.promotion-aside-${name}`)
}

/**
 * Put back a project that a previous promotion moved aside and then died
 * before replacing. Runs before every promotion, so re-running the operation
 * converges instead of needing someone to notice.
 */
async function restoreInterruptedSwap(projectsRoot, name) {
  const aside = asidePath(projectsRoot, name)
  const destination = join(projectsRoot, name)
  if (!existsSync(aside) || existsSync(destination)) return
  try {
    const marker = JSON.parse(await readFile(join(aside, ASIDE_MARKER), 'utf8'))
    if (marker?.project !== name) return
  } catch {
    return
  }
  await rm(join(aside, ASIDE_MARKER), { force: true })
  await rename(aside, destination)
}

/**
 * Is the destination already holding exactly this promotion? Then say so and
 * change nothing.
 *
 * This is the idempotent retry the v1 import had and the v2 stream rewrite
 * dropped. Every member's sha256 was verified as it was written to `pending`,
 * so the staged copy is known good; the question here is only whether the LIVE
 * copy is the same revision with the same bytes. A destination carrying the
 * right revision and the wrong render must NOT report itself already promoted,
 * because that is what an interrupted earlier swap leaves behind.
 */
async function promotedRevisionMatches({ destination, name, revision, header }) {
  try {
    const operations = JSON.parse(await readFile(join(destination, '.source-lifecycle', 'operations.json'), 'utf8'))
    const live = operations.revisionLifecycle?.[revision]
    if (!live) return false
    // Compare only what the SOURCE asserted, and not `updatedAt`. The
    // destination writes its own phases onto this row after activation — the
    // `promotion` record is the first of them — so a whole-row comparison
    // reports every already-promoted revision as new, which is exactly what it
    // did until the wire test caught it. Everything the source claims must
    // still match; what this box added locally is not the source's business.
    for (const key of Object.keys(header.lifecycle)) {
      if (key === 'updatedAt') continue
      if (stableJson(live[key]) !== stableJson(header.lifecycle[key])) return false
    }
    const metadata = JSON.parse(await readFile(join(destination, 'project.json'), 'utf8'))
    if (stableJson(metadata) !== stableJson(header.metadata)) return false
    const gitDir = join(destination, '.source-lifecycle', 'git')
    const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
    const head = (await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
    if (head !== revision) return false
    for (const member of header.members) {
      if (member.kind === 'output') {
        const path = join(destination, 'output', ...member.path.split('/'))
        if (!existsSync(path) || await fileDigest(path) !== member.sha256) return false
      } else if (member.kind === 'buildLog') {
        const path = join(destination, 'build.log')
        if (!existsSync(path) || await fileDigest(path) !== member.sha256) return false
      }
    }
    // A live render with EXTRA files is not this promotion, and the digest
    // loop above cannot see them — it only checks the files the stream sent.
    // Counted by name rather than by `regularFileDescriptors`, which hashes
    // every file and would put a second full pass over a render measured at
    // 936 MB elsewhere in this tree.
    const liveOutputCount = await countRegularFiles(join(destination, 'output'))
    return liveOutputCount === header.members.filter(member => member.kind === 'output').length
  } catch {
    return false
  }
}

async function countRegularFiles(root) {
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countRegularFiles(join(root, entry.name))
    else total++
  }
  return total
}

/**
 * Carry forward everything the live project holds that this promotion did not
 * stage — `build-cache`, `latex.log`, a non-qmd `source`, and anything else
 * per-project that nobody has thought of yet.
 *
 * Written as "every entry not staged" rather than as a list of known names on
 * purpose. A list is a second place to remember something, and the entry it
 * forgets is deleted silently on the next publish. Skip's ruling, via the
 * chief: a republish that drops these is a delete, and delete-by-omission is
 * not a lesser kind. See AGENTS.md "NOTHING IN THIS APP DELETES ANYTHING".
 */
async function carryForwardUnstagedItems(destination, pending) {
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    // Another operation's scratch, including an aside this promotion is about
    // to create. Copying one in would publish a transaction directory.
    if (entry.name.startsWith('.promotion-') || entry.name.startsWith('.build-publish-')) continue
    if (entry.name === ASIDE_MARKER) continue
    if (existsSync(join(pending, entry.name))) continue
    await cp(join(destination, entry.name), join(pending, entry.name), { recursive: true, verbatimSymlinks: true })
  }
}

export async function importProjectPromotionStream({ stream, sourceEnvironment, name, revision, projectsRoot, serialize, onActivated = null, beforeActivation = null }) {
  validatePromotionName(name)
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('exact source revision is required')
  return serialize(name, async () => {
    await restoreInterruptedSwap(projectsRoot, name)
    const destination = join(projectsRoot, name)
    // A project already here is a REPUBLISH, not a collision. Refusing it is
    // what left promotion able to create a project and never able to publish a
    // second revision of one, which is the whole of why the endpoint had no
    // caller worth writing.
    const republishing = existsSync(destination)
    const pending = join(projectsRoot, `.promotion-${name}-${process.pid}-${randomUUID()}`)
    let activated = false
    let iterator = null
    try {
      await mkdir(pending, { recursive: false })
      iterator = Readable.fromWeb ? Readable.fromWeb(stream).iterator() : stream[Symbol.asyncIterator]()
      const state = { chunk: Buffer.alloc(0) }
      const magic = await readExactly(iterator, state, STREAM_MAGIC.length)
      if (!magic.equals(STREAM_MAGIC)) throw new Error('invalid project promotion stream')
      const headerLength = (await readExactly(iterator, state, 4)).readUInt32BE()
      if (!headerLength || headerLength > MAX_HEADER_BYTES) throw new Error('invalid project promotion header size')
      const header = JSON.parse((await readExactly(iterator, state, headerLength)).toString('utf8'))
      validateStreamHeader(header, { sourceEnvironment, name, revision })
      for (const member of header.members) {
        let target
        if (member.kind === 'bundle') target = join(pending, 'source.bundle')
        else if (member.kind === 'buildLog') target = join(pending, 'build.log')
        else target = join(pending, 'output', ...member.path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeMember(iterator, state, target, member)
      }
      if (state.chunk.length || !(await iterator.next()).done) throw new Error('trailing project promotion data')
      await mkdir(join(pending, '.source-lifecycle', 'git'), { recursive: true })
      await execFileAsync('git', ['init', '--bare', '--quiet', join(pending, '.source-lifecycle', 'git')])
      const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
      // On a republish, the destination's own history comes across FIRST, all
      // refs, so the promoted ref lands on top of it rather than in place of
      // it. In the ordinary case the bundle's history already contains the
      // destination's, and this adds nothing; it matters when it does not —
      // revisions the source no longer has, or refs the destination holds that
      // the source never did — and those are exactly the ones a fresh repo
      // would silently drop.
      if (republishing && existsSync(join(destination, '.source-lifecycle', 'git'))) {
        await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'fetch', join(destination, '.source-lifecycle', 'git'), '+refs/*:refs/*'], { timeout: 30000 })
      }
      // `+` so the promoted revision wins the ref against whatever the
      // destination had. The commit it replaces is still reachable by sha.
      await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'fetch', join(pending, 'source.bundle'), `+${sourceRef}:${sourceRef}`], { timeout: 30000 })
      const importedHead = (await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
      if (importedHead !== revision) throw new Error('promotion bundle head mismatch')
      const tree = (await execFileAsync('git', [`--git-dir=${join(pending, '.source-lifecycle', 'git')}`, 'rev-parse', `${revision}^{tree}`], { encoding: 'utf8' })).stdout.trim()
      if (tree !== header.tree) throw new Error('promotion revision tree mismatch')
      if (header.metadata.format === 'qmd') {
        const imported = createSourceGitStore({ gitDir: join(pending, '.source-lifecycle', 'git') })
        const files = await imported.readManifest(revision)
        await materializeAcceptedRevision({ revision: { id: revision, files }, lifecycle: { readRevisionFiles: (_id, paths) => imported.readRevisionFiles(revision, paths) }, destination: join(pending, 'source') })
      }
      // The journal is MERGED, never replaced. The promotion record lives in
      // it, so a wholesale replace would delete the one thing that answers
      // when a project was last published — and it would delete the
      // destination's earlier revisions with it.
      const priorJournal = republishing
        ? await readFile(join(destination, '.source-lifecycle', 'operations.json'), 'utf8').then(JSON.parse).catch(() => null)
        : null
      await writeFile(join(pending, '.source-lifecycle', 'operations.json'), `${JSON.stringify({
        ...(priorJournal || {}),
        version: 1,
        revisionLifecycle: { ...(priorJournal?.revisionLifecycle || {}), [revision]: header.lifecycle },
      }, null, 2)}\n`)
      await writeFile(join(pending, 'project.json'), `${JSON.stringify(header.metadata, null, 2)}\n`)
      await rm(join(pending, 'source.bundle'), { force: true })

      if (republishing) {
        if (await promotedRevisionMatches({ destination, name, revision, header })) {
          await rm(pending, { recursive: true, force: true })
          await onActivated?.()
          return { promoted: false, alreadyPromoted: true, revision, tree }
        }
        await carryForwardUnstagedItems(destination, pending)
      }

      await beforeActivation?.(pending)

      if (!republishing) {
        // Unchanged: one rename into an absent path.
        if (existsSync(destination)) throw new Error(`Project "${name}" already exists`)
        await rename(pending, destination)
        activated = true
      } else {
        // Two renames, in one directory, on one filesystem. `pending` is a
        // COMPLETE project by this point — the promoted render plus everything
        // carried forward — so the swap replaces the whole directory at once
        // rather than item by item. Item-by-item leaves a crash window per
        // item and no way to know which item was in flight.
        const aside = asidePath(projectsRoot, name)
        await rm(aside, { recursive: true, force: true })
        // The marker goes in while the directory is still live, so it travels
        // with it into `aside` and names what `restoreInterruptedSwap` should
        // put back. A crash here leaves the live project intact plus one stray
        // file, which `carryForwardUnstagedItems` is written to skip.
        await writeFile(join(destination, ASIDE_MARKER), `${JSON.stringify({ version: 1, project: name, revision })}\n`)
        await rename(destination, aside)
        try {
          await rename(pending, destination)
        } catch (error) {
          await rm(join(aside, ASIDE_MARKER), { force: true })
          await rename(aside, destination).catch(() => {})
          throw error
        }
        activated = true
        await rm(aside, { recursive: true, force: true })
      }
      await onActivated?.()
      return { promoted: true, alreadyPromoted: false, revision, tree }
    } catch (error) {
      if (!activated) await rm(pending, { recursive: true, force: true })
      throw error
    } finally {
      await iterator?.return?.()
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
