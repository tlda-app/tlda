import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { isTextSourcePath, normalizeSourceManifest } from '../../shared/source-manifest.mjs'
import { createSourceGitStore } from './source-git-store.mjs'
import { gitBlobId } from '../../shared/git-blob-id.mjs'

export const SOURCE_AUTHORITY_UNINITIALIZED = 'uninitialized'
export const SOURCE_AUTHORITY_CURRENT = 'current'
export const SOURCE_AUTHORITY_RECONCILIATION_REQUIRED = 'reconciliation-required'

export function projectRevisionStatus(lifecycles) {
  const revision = [...(lifecycles || [])].sort((a, b) => (b.acceptSeq ?? 0) - (a.acceptSeq ?? 0))[0] || null
  if (!revision) return { status: 'unknown', phase: null, sourceRevision: null, acceptSeq: null }
  // **A failed mirror is not a failed build.** The mirror stopped being a build
  // phase when it moved to the accept, and it can fail for reasons that say
  // nothing about the document: a laptop asleep, a checkout with a staged
  // conflict, a machine that does not hold this project. Letting it decide the
  // build status told an author their paper did not compile while the build log
  // said `Build complete in 20.8s` over 88 rendered pages — which is exactly the
  // class of lie this file's history is made of.
  //
  // The mirror's own state is still reported below, so nothing is hidden. It
  // simply does not get to answer the question "did this document build".
  const phases = ['build', 'version']
  const failed = phases.find(phase => ['build_failed', 'version_failed'].includes(revision[phase]?.state))
  const pending = phases.find(phase => ['pending', 'leased'].includes(revision[phase]?.state))
  const terminal = revision.build?.state
  const status = failed ? 'error'
    : pending ? 'building'
      : terminal === 'cancelled' ? 'cancelled'
        : terminal === 'superseded' ? 'superseded'
          : terminal === 'not_required' ? 'not_required'
          : 'success'
  return {
    status,
    phase: failed || pending || null,
    sourceRevision: revision.sourceRevision,
    acceptSeq: revision.acceptSeq,
    build: revision.build,
    version: revision.version,
    mirror: revision.mirror,
  }
}

// `git init --bare` on the revision repository. Async on purpose: this runs on
// the server's main thread and the whole reason the revision store is moving to
// git is that the thing it replaces did its work synchronously.
function runGitInit(gitDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '--bare', '--quiet', gitDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    const err = []
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`git init --bare ${gitDir} exited ${code}: ${Buffer.concat(err).toString().trim()}`)))
  })
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

// A replica that has been pending this long is not going to be re-sent usefully:
// its command carries base64 of every changed file, the fan-out re-sends it on
// every accepted revision, and the journal holding it is read in full by
// GET /api/projects. Measured on the live volume 2026-08-17: ONE replica pending
// since 06:55 that morning was pinning 54,374,893 bytes -- 42% of all 130 MB of
// lifecycle journals on the box.
//
// Env-overridable rather than a magic number, and expressed in hours because
// that is the unit the decision is made in.
const PENDING_REPLICA_EXPIRY_MS = Number(process.env.TLDA_PENDING_REPLICA_EXPIRY_HOURS || 6) * 60 * 60 * 1000

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
 * A revision is a commit in the project's own bare repository under
 * `.source-lifecycle/git`. Its manifest is the commit's tree, a file is a blob,
 * and the revision id is the commit sha.
 *
 * That is the whole of the storage. There is no directory per revision, no
 * parallel blob store, and no snapshot file — a push writes the blobs git does
 * not already hold and one commit, and an unchanged file costs nothing because
 * it is the same blob.
 *
 * **The history it makes is the point, not a side effect.** The commits are the
 * project's version history in accepted order, which is the thing mirrored into
 * the author's checkout: the author's work is versioned because accepting it
 * IS committing it, rather than because something later remembered to.
 *
 * Two consequences worth stating, because they are what the previous shape got
 * wrong:
 *
 * - **Advancing the head is a compare-and-swap on a ref.** Two overlapping
 *   accepts cannot interleave into a half-applied state, and the loser fails
 *   loudly instead of landing last and winning.
 * - **Identical content accepted twice is two revisions.** A commit carries when
 *   it happened and what it followed, so the id is no longer a function of the
 *   bytes alone. Anything asking "do these say the same thing" wants
 *   `manifestDigest`, not the id.
 *
 * Revisions accepted before this — ids of the form `sha256:…`, bytes under
 * `blobs/` — stay readable at the ids they already have. Nothing writes that
 * shape any more, and the first accept after the cutover carries their content
 * into git as ordinary blobs, so no project needs a migration pass.
 */
export function createSourceLifecycleStore({ root, context = {}, fault = null, project = 'project' }) {
  const statePath = join(root, 'authority.json')
  const revisionsRoot = join(root, 'revisions')
  const evidenceRoot = join(root, 'evidence')
  const blobsRoot = join(root, 'blobs')
  const operationsPath = join(root, 'operations.json')
  const gitDir = join(root, 'git')

  // One bare repository per project, created on first use. `git init` on an
  // existing repo is a no-op, but doing it once per store rather than once per
  // accept keeps a push from paying for a subprocess it does not need.
  let gitReady = null
  function sourceGit() {
    if (!gitReady) {
      gitReady = (async () => {
        if (!existsSync(join(gitDir, 'HEAD'))) {
          mkdirSync(gitDir, { recursive: true })
          await runGitInit(gitDir)
        }
        return createSourceGitStore({ gitDir })
      })()
    }
    return gitReady
  }
  /**
   * The authority, with **the ref as the answer for which revision is current**.
   *
   * `authority.json` still carries the state name and `acceptSeq`, but it is no
   * longer what says where the project is. That matters at exactly one moment
   * and it is the moment that has hurt: an accept commits, swings the ref, then
   * writes this file, and a crash in between used to leave a project claiming a
   * revision the store had not accepted. Reading the ref makes the ref the only
   * thing that can be half-written, and moving it is atomic.
   *
   * A project whose last accept predates the cutover has no ref, and its
   * `sha256:` id in the file is the answer until its next accept creates one.
   */
  async function state() {
    const stored = readJson(statePath) || { state: SOURCE_AUTHORITY_UNINITIALIZED, currentRevision: null, acceptSeq: 0 }
    if (stored.state !== SOURCE_AUTHORITY_CURRENT) return stored
    const head = await (await sourceGit()).head(project)
    return head ? { ...stored, currentRevision: head } : stored
  }

  // A `version: 1` entry stores base64 in `content` and does not say so, while
  // an entry built from a file on disk stores utf8 in `content` and also does
  // not say so. Callers carry entries from one revision into the next, so that
  // ambiguity decodes a legacy file into the literal text of its own base64 —
  // silently, and into the authority store. The store tags what it emits so no
  // caller has to remember.
  // A revision id is a commit sha. `sha256:`-prefixed ids are the shape the
  // directory-per-revision store wrote, and they stay readable at the ids they
  // already have — a project mid-cutover holds one as its `expectedRevision`,
  // and a push whose base it could not read would be refused for a reason
  // nobody caused. Nothing writes that shape any more.
  const isGitObjectId = id => /^[0-9a-f]{40}$/i.test(String(id || ''))

  async function revision(id) {
    if (!id) return null
    if (isGitObjectId(id)) return gitRevision(id)
    const record = readJson(join(revisionsRoot, encodeURIComponent(id), 'snapshot.json'))
    if (!record || record.version !== 1) return record
    return { ...record, files: (record.files || []).map(file => ({ ...file, encoding: 'base64' })) }
  }

  // The commit is the record: its tree is the manifest, and the pins ride in a
  // commit trailer rather than in the tree. They belong to the revision's
  // identity — the commit sha covers the message, so pins still change the id —
  // but they are not a file of the author's, and the tree is what gets mirrored
  // onto their disk.
  async function gitRevision(id) {
    const store = await sourceGit()
    let files
    try {
      files = await store.readManifest(id)
    } catch {
      return null
    }
    const meta = await store.readCommitMeta(id)
    return {
      version: 3,
      id,
      manifest: files.map(entry => entry.path),
      files,
      byteSize: files.reduce((total, entry) => total + (entry.size || 0), 0),
      dependencyPins: pinsFromMessage(meta.message),
      createdAt: meta.date,
    }
  }

  const blobPath = sha => join(blobsRoot, sha.slice(0, 2), sha)

  const PINS_TRAILER = 'tlda-dependency-pins: '

  function pinsTrailer(pins) {
    return `${PINS_TRAILER}${JSON.stringify(pins)}`
  }

  function pinsFromMessage(message) {
    const line = String(message || '').split('\n').find(candidate => candidate.startsWith(PINS_TRAILER))
    if (!line) return []
    try {
      return JSON.parse(line.slice(PINS_TRAILER.length))
    } catch {
      return []
    }
  }

  // Bytes for a content hash, whichever store holds it. A git blob sha is 40
  // hex and a legacy sha256 is 64, so the id says where to look and no caller
  // has to know which era its revision came from.
  async function readBlob(sha) {
    if (isGitObjectId(sha)) {
      const store = await sourceGit()
      return store.readBlobBytes(sha)
    }
    const path = blobPath(sha)
    return existsSync(path) ? readFileSync(path) : null
  }

  // Raw bytes for one snapshot entry, whichever form it is in: a v2 blob
  // reference, or a `version: 1` snapshot's inline base64 from before this
  // change. Snapshots have always stored content base64-encoded.
  async function entryContent(entry) {
    if (!entry) return null
    if (entry.content !== undefined) {
      return Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'base64')
    }
    if (!entry.sha256) throw new Error(`Corrupt revision file entry: ${entry.path || '<unknown>'} has neither content nor sha256`)
    const blob = await readBlob(entry.sha256)
    if (!blob) throw new Error(`Corrupt revision file entry: ${entry.path || '<unknown>'} blob ${entry.sha256} is missing`)
    return blob
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

  // The storage shape is enforced here, over every record, rather than only on
  // the record being written.
  //
  // Writing it only on the new record fixes nothing that already exists: each
  // caller reads the whole journal, mutates one key, and writes the object back,
  // so records written before this change carry their bytes forward verbatim on
  // every subsequent write, forever. bregman's 12.2 MB would have stayed 12.2 MB
  // and the listing would have gone on parsing it -- the growth would stop and
  // the cost would not. Applying it to the whole map means the first push after
  // this lands rewrites the file lean.
  // A refused push's `terminalResult` carries the whole stale-base evidence --
  // `classifications`, one entry per file in the project, 3.95 MB across 13
  // records on bregman. `submit` already writes that object to
  // `evidence/<id>.json`, so the journal is a second copy of a file beside it.
  //
  // It could not be dereferenced until 2026-08-18. Rollback used to `rm -rf` the
  // whole `.source-lifecycle` tree and restore the pre-push snapshot, which
  // deleted the evidence file the same refused request had just written -- so the
  // inline copy was the ONLY copy, and pointing at the file would have lost it.
  // Measured on the live volume the morning that stopped: of the evidence ids
  // inline in the journal, 0 of 13 written before the fix had a file on disk,
  // and 2 of 2 written after it did.
  //
  // So where the file is missing it is written from the inline copy before the
  // reference is taken, which restores the evidence rollback destroyed rather
  // than discarding it. Nothing is dropped that is not first on disk.
  //
  // What this does NOT survive is the file being deleted *after* the reference
  // is taken -- then the bytes are gone, because a reference is all that is
  // left. That is true of any reference and it is why this waited on the
  // rollback fix rather than shipping beside it. `hydrateOperation` returns the
  // record without its evidence in that case rather than throwing, because the
  // caller is a replay answering a push and a missing conflict report should not
  // wedge the write path.
  function evidenceReference(terminalResult) {
    const evidence = terminalResult?.evidence
    if (!evidence?.id) return terminalResult
    const path = join(evidenceRoot, `${evidence.id}.json`)
    if (!existsSync(path)) atomicJson(path, evidence, fault)
    const { evidence: _inline, ...rest } = terminalResult
    return { ...rest, evidenceId: evidence.id }
  }

  function hydrateOperation(operation) {
    const evidenceId = operation?.terminalResult?.evidenceId
    if (!evidenceId) return operation
    const evidence = readJson(join(evidenceRoot, `${evidenceId}.json`))
    if (!evidence) return operation
    const { evidenceId: _ref, ...rest } = operation.terminalResult
    return { ...operation, terminalResult: { ...rest, evidence } }
  }

  function journalStorageShape(journal) {
    const byRequestId = {}
    for (const [requestId, operation] of Object.entries(journal.byRequestId || {})) {
      const { descriptor: _unread, ...carried } = operation
      const shaped = carried.orderedEffects
        ? { ...carried, orderedEffects: withoutFileContent(carried.orderedEffects) }
        : carried
      byRequestId[requestId] = shaped.terminalResult
        ? { ...shaped, terminalResult: evidenceReference(shaped.terminalResult) }
        : shaped
    }
    return { ...journal, byRequestId }
  }

  function writeOperationJournal(journal) {
    atomicJson(operationsPath, journalStorageShape(journal), fault)
  }

  // An accepted push's effect carried `mutation.files`, and those entries carry
  // `content` -- base64 of every changed file. The source revision already holds
  // those bytes once each under `blobs/`, so the journal was a second copy of
  // them, kept forever, in the file that `GET /api/projects` parses in full and
  // synchronously on every request.
  //
  // Measured on the live volume 2026-08-18: bregman's journal was 13,346,381
  // bytes, of which `byRequestId` was 12,215,402 across 41 records. Of that,
  // `orderedEffects` was 7,455,226 -- and in its largest single effect,
  // `mutation.files[0].content` was 376,324 of the effect's 394,426 bytes.
  // `revisionLifecycle`, the only part a project listing reads, was 20,686.
  //
  // This is the same deletion `recordReplicaResult` makes for `command` below,
  // one level up: the effect keeps what identifies the mutation, and the bytes
  // stay where they already live.
  function withoutFileContent(orderedEffects) {
    return (orderedEffects || []).map(effect => (effect?.mutation?.files
      ? {
        ...effect,
        mutation: {
          ...effect.mutation,
          files: effect.mutation.files.map(({ content: _bytes, encoding: _enc, ...file }) => file),
        },
      }
      : effect))
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
  async function canonicalSnapshot(files, manifest, snapshotContext) {
    if (!Array.isArray(files) || !Array.isArray(manifest)) throw new Error('A complete files array and sourceManifest are required')
    const store = await sourceGit()
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
        // A reference carried forward from the current revision. It may name a
        // git blob (an id from this store) or a legacy sha256 from a revision
        // accepted before the cutover — in the second case the bytes are read
        // once out of the old blob store and written into git, which is what
        // moves a live project across without a migration pass.
        if (isGitObjectId(file.sha256)) {
          byPath.set(file.path, { path: file.path, sha256: file.sha256, size: file.size ?? await store.blobSize(file.sha256) })
        } else {
          const carried = await readBlob(file.sha256)
          if (!carried) throw new Error(`Missing blob for ${file.path}`)
          byPath.set(file.path, { path: file.path, sha256: await store.writeBlob(carried), size: carried.length })
        }
      } else {
        const raw = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(String(file.content ?? ''))
        byPath.set(file.path, { path: file.path, sha256: await store.writeBlob(raw), size: raw.length })
      }
    }
    if (byPath.size !== normalized.length) {
      throw new Error('Snapshot files must exactly match sourceManifest')
    }
    return normalized.map(path => byPath.get(path))
  }

  /**
   * Commit a canonical snapshot. The commit is the revision and its sha is the
   * revision id.
   *
   * The parent is the authority's current revision, so the commits form the
   * project's history in the order it was accepted — that history is the thing
   * being mirrored, and it is why the id must be a commit rather than a hash of
   * the manifest. Two accepts of identical content are two revisions, because
   * they happened at different times and the second is not the first.
   *
   * The tree is built from the complete manifest rather than over the parent's
   * tree: `entries` IS the whole project, so a path that has left the manifest
   * is absent because nobody named it.
   */
  async function persistSnapshot(entries, dependencyPins = [], parent = null) {
    const store = await sourceGit()
    const pins = canonicalPins(dependencyPins)
    const id = await store.acceptRevision({
      project,
      // A revision accepted before the cutover is not a commit, so it cannot be
      // a parent. The first commit after it is a root, and the project's git
      // history therefore begins at the cutover rather than pretending to
      // reach back through revisions git never held.
      parent: isGitObjectId(parent) ? parent : null,
      replaceTree: true,
      files: entries.map(entry => ({ path: entry.path, sha: entry.sha256 })),
      message: `source revision\n\n${pinsTrailer(pins)}`,
    })
    return {
      version: 3, id, manifest: entries.map(entry => entry.path), files: entries,
      byteSize: entries.reduce((total, entry) => total + entry.size, 0),
      dependencyPins: pins, createdAt: new Date().toISOString(),
    }
  }

  /**
   * Move `refs/tlda/source/<project>` to the accepted revision, refusing unless
   * it still holds what we accepted against.
   *
   * The ref, not `authority.json`, is what makes two overlapping accepts
   * impossible: a compare-and-swap either moves or fails, where a
   * read-modify-write of a JSON file lets the slower writer land last and put
   * the project on a revision nobody accepted. That is the shape of tonight's
   * two-builds fault, one layer down.
   *
   * A project whose previous revision predates the cutover has no ref to
   * compare against — its id is not a commit — so the first accept creates the
   * ref rather than swinging it, and the CAS is honest from the second onwards.
   */
  async function advanceSourceHead(next, expected) {
    const store = await sourceGit()
    // A legacy `sha256:` id has no ref behind it, so the first accept after the
    // cutover creates the ref instead of swinging it. From the second onwards
    // `expected` is a commit and the swap is a real one — and it must be, or
    // this is a read-modify-write wearing a compare-and-swap's name.
    await store.advanceHead(project, next, isGitObjectId(expected) ? expected : await store.head(project))
  }

  // Two snapshots say the same thing when they name the same paths with the
  // same blobs. This is identity of CONTENT, which is what bootstrap asks; a
  // revision id is identity of a COMMIT, which is content plus when and after
  // what, and two bootstraps of one project would never match on it.
  function manifestDigest(entries) {
    const hash = createHash('sha256')
    for (const entry of entries) hash.update(entry.path).update('\0').update(entry.sha256).update('\0')
    return hash.digest('hex')
  }

  function fileEntry(snapshot, path) {
    return snapshot?.files?.find(candidate => candidate.path === path) || null
  }

  function revisionFileContent(snapshot, path) {
    return entryContent(fileEntry(snapshot, path))
  }

  /**
   * A file's content hash **in one space**, so two revisions can be compared.
   *
   * This is the cutover's sharp edge and it is worth being explicit about. A
   * revision accepted before the cutover hashes raw bytes with sha256; one
   * accepted after carries git's blob sha, which is sha1 over `blob <n>\0` and
   * the bytes. Comparing the two spaces directly never matches, so on the first
   * push after the cutover EVERY path would look like both sides moved, and a
   * paper that had nothing wrong with it would come back a wall of conflicts.
   *
   * So the git blob sha is the one space, and a legacy entry is converted into
   * it. That costs reading the legacy revision's bytes — which is the thing the
   * hash comparison exists to avoid — but only for a revision written before
   * the cutover, and only until the next accept replaces it. A git-side entry
   * stays free.
   */
  async function revisionFileHash(snapshot, path) {
    const entry = fileEntry(snapshot, path)
    if (!entry) return null
    if (entry.sha256 && isGitObjectId(entry.sha256)) return entry.sha256
    const content = await entryContent(entry)
    return content ? gitBlobId(content) : null
  }

  // Only the paths that could have changed are read, and only one revision's
  // copy of each at a time. Reading all three revisions whole is what this
  // avoids: on a large book that is three full projects resident to classify a
  // handful of edited files.
  async function deriveClassifications(base, current, incoming) {
    const snapshots = [base, current, incoming]
    const paths = [...new Set(snapshots.flatMap(snapshot => (snapshot?.files || []).map(file => file.path)))].sort()
    return Promise.all(paths.map(async path => {
      const entries = snapshots.map(snapshot => fileEntry(snapshot, path))
      const [baseHash, currentHash, incomingHash] = await Promise.all(
        snapshots.map(snapshot => revisionFileHash(snapshot, path)),
      )

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
      const settled = async entry => ({
        path,
        status: 'clean-rebase-candidate',
        ...(entry.sha256 ? { sha256: entry.sha256 } : { merged: (await entryContent(entry)).toString('base64') }),
      })
      // Nobody disagrees: both sides hold the same bytes.
      if (currentHash != null && currentHash === incomingHash) return settled(entries[2])
      // Only the project moved. Their version stands; this push never touched it.
      if (baseHash != null && baseHash === incomingHash && entries[1]) return settled(entries[1])
      // Only this push moved. Its version stands; nobody else touched it.
      if (baseHash != null && baseHash === currentHash && entries[2]) return settled(entries[2])

      if (entries.some(entry => entry == null)) return { path, status: 'classification-unavailable' }
      const contents = await Promise.all(entries.map(entry => entryContent(entry)))
      if (contents.some(value => value == null)) return { path, status: 'classification-unavailable' }
      const binary = !isTextSourcePath(path) || contents.some(value => value.includes(0))
      const result = classifyThreeWay({ base: contents[0], current: contents[1], incoming: contents[2], binary })
      return {
        path,
        status: result.status,
        ...(result.merged != null ? { merged: Buffer.from(result.merged).toString('base64') } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
    }))
  }

  // Drop the payload of any replica that has been pending past the expiry, and
  // mark it terminal so the fan-out (which filters `state === 'pending'`) stops
  // re-sending it and the journal stops carrying it.
  //
  // Sweeps EVERY revision in the journal, not just the one being written. A
  // stuck replica is by definition on an older revision -- scoping this to the
  // current one made it almost a no-op, which the test caught.
  //
  // Re-materialising is always available, since the source revision still holds
  // the content, so this loses recoverable work rather than work.
  function expireStalePendingReplicas(journal, nowIso) {
    const cutoff = Date.parse(nowIso) - PENDING_REPLICA_EXPIRY_MS
    let changed = false
    for (const lifecycle of Object.values(journal.revisionLifecycle || {})) {
      const replicas = lifecycle?.replicas
      if (!replicas) continue
      // Age from when the REVISION was accepted, not from the replica's
      // updatedAt. A stuck replica is re-sent by the fan-out on every accepted
      // revision, and each attempt refreshes updatedAt -- so a replica that has
      // never once succeeded looks permanently fresh and never ages out.
      // Measured against live data 2026-08-18: the 54 MB replica had been
      // pending since 06:55 the previous morning and its updatedAt was minutes
      // old. Expiring on updatedAt reclaimed nothing from it.
      const acceptedAt = Date.parse(lifecycle.acceptedAt || '') || 0
      for (const [bindingId, replica] of Object.entries(replicas)) {
        if (replica?.state !== 'pending' || !('command' in replica)) continue
        if (acceptedAt === 0 || acceptedAt > cutoff) continue
        const { command, ...carried } = replica
        replicas[bindingId] = {
          ...carried,
          state: 'expired',
          result: { ok: false, error: `replica pending longer than ${PENDING_REPLICA_EXPIRY_MS}ms; payload dropped, re-materialise from the source revision` },
          updatedAt: nowIso,
        }
        changed = true
      }
    }
    return changed
  }

  return {
    readAuthority: state,
    readRevision: revision,

    /**
     * What a checkout needs to be brought to `id`: the commits it does not
     * have, and the paths they cover.
     *
     * `sourceScope` is this revision's manifest rather than every path the
     * project has ever held. That is narrower than the scope the build-era
     * mirror sent, and deliberately: a historical union puts files in scope
     * that this revision does not contain, and the daemon then has to decide
     * what a missing file means.
     */
    async mirrorPayload(id) {
      const store = await sourceGit()
      const record = await revision(id)
      if (!record) return null
      const refusedRevision = await store.refused(project)
      return {
        hash: id,
        bundleBase64: await store.bundleSince(project, id, { includeRefused: true }),
        sourceScope: record.manifest,
        refusedRevision,
      }
    },

    /**
     * The commits a proposer lacks, computed against what the proposer says it
     * has rather than against the mirror's position.
     *
     * This is what makes a refusal recoverable. `mirrorPayload` answers a
     * different question — what a *bound checkout* needs — and its `have` is the
     * `mirrored` ref, which is some other party's position. Asking it on a
     * proposer's behalf returns a bundle that looks right and can omit the very
     * commits the proposer is missing.
     */
    async proposerBundle(have) {
      const store = await sourceGit()
      const head = await store.head(project)
      if (!head) return null
      return {
        currentRevision: head,
        bundleBase64: await store.bundleSince(project, head, { includeRefused: true, have: have || null }),
        refusedRevision: await store.refused(project),
      }
    },

    /**
     * Take a bundle a checkout has proposed and accept it iff it fast-forwards.
     *
     * **This is the accept path with the machinery removed.** There is no
     * expected-revision handshake, no declared manifest to validate, no
     * three-way merge and no retry state machine: the proposer either had our
     * head when they wrote, in which case nothing of ours is discarded, or they
     * did not, in which case it goes back to them to rebase. Git already knows
     * how to answer that question and every bug we shipped on this path was our
     * own answer to it.
     *
     * A refusal is not a failure and costs nothing: the candidate is already in
     * the object store under a quarantine ref, so it can be named, mirrored and
     * looked at rather than existing only as a rejection payload.
     */
    async acceptBundle(bundlePath) {
      const store = await sourceGit()
      const proposed = await store.ingestBundle(project, bundlePath)
      if (!proposed) return { ok: false, status: 'empty-bundle' }
      const result = await store.fastForward(project, proposed)
      if (!result.ok) {
        await store.markRefused(project, proposed, await store.refused(project))
        return { ...result, refusedRevision: proposed }
      }
      const record = await revision(result.revision)
      const authority = {
        state: SOURCE_AUTHORITY_CURRENT,
        currentRevision: result.revision,
        acceptSeq: ((readJson(statePath) || {}).acceptSeq || 0) + 1,
      }
      atomicJson(statePath, authority, fault)
      return { ...result, authority, revision: record }
    },

    /**
     * What moved between two accepted revisions. The post-accept effects need
     * a changed-file set and a bundle does not carry one, so they ask the tree
     * rather than being handed a list the way the old push route is.
     */
    async diffRevisions(base, head) {
      return (await sourceGit()).diffRevisions(base, head)
    },

    /** The last refused push, and the record that it was refused. */
    lastRefused: async () => (await sourceGit()).refused(project),

    /** The last revision a daemon took, and the record that it did. */
    lastMirrored: async () => (await sourceGit()).mirrored(project),
    async markMirrored(id, expected) {
      const store = await sourceGit()
      return store.markMirrored(project, id, expected ?? await store.mirrored(project))
    },
    /** Raw bytes of one file in one revision, without loading the rest. */
    async readRevisionFile(id, path) {
      return revisionFileContent(await revision(id), path)
    },
    /** The same, for a snapshot record the caller already holds. */
    snapshotFile: revisionFileContent,
    snapshotFileHash: revisionFileHash,
    async readCurrentFile(path) {
      const authority = await state()
      if (authority.state !== SOURCE_AUTHORITY_CURRENT || !authority.currentRevision) return null
      return {
        sourceRevision: authority.currentRevision,
        content: await revisionFileContent(await revision(authority.currentRevision), path),
      }
    },
    readOperationByRequestId(project, requestId) {
      const operation = operationJournal().byRequestId[operationKey(requestId)] || null
      return operation?.project === project ? hydrateOperation(operation) : null
    },
    readOperationByDeliveryId(project, deliveryId) {
      if (typeof deliveryId !== 'string' || !deliveryId.trim()) throw new Error('deliveryId is required')
      const journal = operationJournal()
      const requestId = journal.requestIdByDeliveryId[deliveryId]
      if (!requestId) return null
      const operation = journal.byRequestId[requestId] || null
      return operation?.project === project ? hydrateOperation(operation) : null
    },
    prepareOperation(payload) {
      const requestId = operationKey(payload.requestId)
      const { payloadFingerprint } = operationFingerprint(payload)
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
        const hydrated = hydrateOperation(existing)
        return { replay: true, invalidReuse: false, operation: hydrated, result: hydrated.terminalResult ?? null }
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
      if (existing.terminalResult) return hydrateOperation(existing)
      const operation = {
        ...existing,
        state: stateName,
        terminalResult: stableValue(terminalResult),
        ...(acceptSeq == null ? {} : { acceptSeq }),
        ...(recoveryId == null ? {} : { recoveryId }),
        previousRevision,
        acceptedRevision,
        orderedEffects: stableValue(withoutFileContent(orderedEffects)),
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
      return hydrateOperation(operationJournal().byRequestId[requestId])
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
      expireStalePendingReplicas(journal, updatedAt)
      const replicas = { ...(journal.revisionLifecycle[sourceRevision]?.replicas || lifecycle.replicas || {}) }
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
      const previous = lifecycle.replicas?.[bindingId] || {}
      // Drop the command payload once the replica is no longer pending.
      //
      // `command` carries `blobs` -- base64 of every changed file -- plus both
      // manifests, and it exists for exactly one purpose: the fan-out at
      // unified-server.mjs re-sends it, and that path filters on
      // `state === 'pending'`. The moment a replica settles, nothing can read it
      // again, and it was being kept forever.
      //
      // Measured on the live volume 2026-08-17, before this change: bregman's
      // journal was 95.6 MB, of which `revisionLifecycle` was 82 MB across 22
      // revisions -- and in the largest single revision record, `command` was
      // 54,374,893 of its 54,376,465 bytes. 99.998%. That journal is read in
      // full, synchronously, by every `GET /api/projects`.
      //
      // The revision keeps its state, its result and its timestamps. What goes
      // is a second copy of file bytes the source revision already holds.
      const settled = stateName !== 'pending'
      const { command: previousCommand, ...carried } = previous
      const replicas = {
        ...(lifecycle.replicas || {}),
        [bindingId]: {
          ...carried,
          ...(settled ? {} : { command: previousCommand }),
          state: stateName,
          result: stableValue(result),
          updatedAt,
        },
      }
      journal.revisionLifecycle[sourceRevision] = { ...lifecycle, replicas, updatedAt }
      writeOperationJournal(journal)
      return operationJournal().revisionLifecycle[sourceRevision]
    },
    async bootstrap({ expectedRevision, files, sourceManifest, observedServerFiles = null, observedSourceManifest = null, dependencyPins = [] }) {
      const before = await state()
      if (before.state !== SOURCE_AUTHORITY_UNINITIALIZED || expectedRevision !== null) {
        return { ok: false, status: 'stale-base', authority: before }
      }
      const canonical = await canonicalSnapshot(files, sourceManifest, context)
      // Bootstrap compares the two sides by TREE, before committing either. The
      // question is whether the server's source and the submitted source say
      // the same thing, and two commits of identical content have different
      // shas — so comparing revision ids here would report every bootstrap as a
      // disagreement.
      if (observedServerFiles !== null) {
        const observed = await canonicalSnapshot(observedServerFiles, observedSourceManifest || sourceManifest, context)
        if (manifestDigest(observed) !== manifestDigest(canonical)) {
          const next = await persistSnapshot(canonical, dependencyPins)
          const evidence = await persistSnapshot(observed, [], next.id)
          const authority = { state: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, currentRevision: null, proposedRevision: next.id, evidenceRevision: evidence.id }
          atomicJson(statePath, authority, fault)
          return { ok: false, status: SOURCE_AUTHORITY_RECONCILIATION_REQUIRED, authority }
        }
      }
      const next = await persistSnapshot(canonical, dependencyPins)
      await advanceSourceHead(next.id, null)
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: next.id, acceptSeq: (before.acceptSeq || 0) + 1 }
      atomicJson(statePath, authority, fault)
      return { ok: true, status: 'accepted', authority, revision: next }
    },
    async submit({ expectedRevision, files, sourceManifest, dependencyPins = [] }) {
      const before = await state()
      const canonical = await canonicalSnapshot(files, sourceManifest, context)
      const incoming = await persistSnapshot(canonical, dependencyPins, before.currentRevision)
      if (before.state !== SOURCE_AUTHORITY_CURRENT || expectedRevision !== before.currentRevision) {
        const base = expectedRevision ? await revision(expectedRevision) : null
        const current = before.currentRevision ? await revision(before.currentRevision) : null
        const classifications = await deriveClassifications(base, current, incoming)
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
          const rebased = await persistSnapshot(
            await canonicalSnapshot(rebasedFiles, incoming.manifest, context),
            incoming.dependencyPins,
            before.currentRevision,
          )
          await advanceSourceHead(rebased.id, before.currentRevision)
          const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: rebased.id, acceptSeq: (before.acceptSeq || 0) + 1 }
          atomicJson(statePath, authority, fault)
          return { ok: true, status: 'accepted-clean-rebase', authority, revision: rebased, evidence }
        }
        // The refused push is already a commit — `persistSnapshot` ran before
        // staleness was tested — so nothing about it is lost. What it lacks is
        // a ref, and an unreachable commit is one `git gc` from gone and
        // invisible to its author meanwhile. Naming it is the difference
        // between "we still have your work" and "you can look at your work".
        const store = await sourceGit()
        await store.markRefused(project, incoming.id, await store.refused(project))
        return { ok: false, status: 'stale-base', authority: before, evidence, refusedRevision: incoming.id }
      }
      await advanceSourceHead(incoming.id, before.currentRevision)
      const authority = { state: SOURCE_AUTHORITY_CURRENT, currentRevision: incoming.id, acceptSeq: (before.acceptSeq || 0) + 1 }
      atomicJson(statePath, authority, fault)
      return { ok: true, status: 'accepted', authority, revision: incoming }
    },
  }
}
