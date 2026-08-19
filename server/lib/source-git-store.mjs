// source-git-store.mjs — the source lifecycle, on git.
//
// A revision is a commit. Its manifest is the commit's tree. A file's bytes are
// a blob. "Which revision has this checkout applied", "which has been built",
// "which has been mirrored" are refs. Nothing here stores file content, and
// nothing here rewrites a file to record a fact.
//
// What it replaces stored every revision as a directory holding a complete
// inline copy of the project — 13 GB for one paper whose entire history is
// 22 MB of git objects — and recorded state in one JSON file that was fully
// read and fully rewritten on every update: 85 MB, 815ms per touch, on the
// server's main thread. Builds awaited those writes and hung.
//
// Refs live under refs/tlda/ so nothing a person looks at is touched:
//
//   refs/tlda/source/<project>            accepted head
//   refs/tlda/applied/<bindingId>         what a checkout has on disk
//   refs/tlda/built/<project>             last revision that built
//   refs/tlda/mirrored/<project>          last revision mirrored back
//
// Every ref move is a compare-and-swap, so two writers cannot interleave into a
// half-applied state — the failure mode that wedged a paper for three hours
// when `activeTargetRevision` was a field in a JSON file and had to be edited
// by hand to clear it.
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const NULL_SHA = '0000000000000000000000000000000000000000'

// execFile has no stdin, and half of these commands read one (hash-object
// --stdin, update-index --index-info). So: spawn, write, collect.
function run(command, args, { input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(out))
      const detail = Buffer.concat(err).toString().trim()
      reject(new Error(`${command} ${args.join(' ')} exited ${code}${detail ? `: ${detail}` : ''}`))
    })
    if (input !== null) child.stdin.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input)))
    else child.stdin.end()
  })
}

// Binding ids are `machine:env`-shaped and project names are arbitrary, but
// git refnames forbid a set of characters outright. Percent-encode them rather
// than rejecting: a name we cannot express as a ref would otherwise be a
// project that cannot sync, which is the wrong way round.
function encodeRefComponent(name) {
  const encoded = String(name).replace(/[\x00-\x20\x7f~^:?*[\\%]/g, ch =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  if (encoded.includes('..') || encoded.endsWith('.lock') || encoded.startsWith('.') || encoded.endsWith('/')) {
    throw new Error(`Cannot express as a ref: ${name}`)
  }
  return encoded
}

function refFor(kind, name) {
  if (!kind || !name) throw new Error('kind and name are required')
  return `refs/tlda/${kind}/${encodeRefComponent(name)}`
}

export function createSourceGitStore({ gitDir }) {
  if (!gitDir) throw new Error('gitDir is required')

  async function git(args, { input = null, buffer = false } = {}) {
    const out = await run('git', ['--git-dir', gitDir, ...args], { input })
    return buffer ? out : out.toString('utf8')
  }

  /** The sha a ref points at, or null when it does not exist. */
  async function readRef(kind, name) {
    try {
      return (await git(['rev-parse', '--verify', '--quiet', `${refFor(kind, name)}^{commit}`])).trim() || null
    } catch {
      return null
    }
  }

  /**
   * Move a ref, refusing unless it currently holds `expected`. Pass null to
   * require that it does not exist. This is the whole of the concurrency story:
   * a lost race fails loudly and is retried by the caller, rather than leaving
   * a field saying an apply is in progress that nothing will ever finish.
   */
  async function moveRef(kind, name, next, expected) {
    await git(['update-ref', refFor(kind, name), next, expected ?? NULL_SHA])
    return next
  }

  /**
   * Remove a ref, compare-and-swap, so that undoing the FIRST accept is
   * expressible. `moveRef` cannot express it: there is no sha meaning "back to
   * nothing", and a project's very first accept creates the ref rather than
   * moving it. Without this, a failed first accept leaves a head behind and the
   * project is permanently past a revision nobody accepted.
   */
  async function removeRef(kind, name, expected) {
    await git(['update-ref', '-d', refFor(kind, name), expected])
  }

  /** Write bytes as a blob and return its sha. Identical content is free. */
  async function writeBlob(content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
    return (await git(['hash-object', '-w', '--stdin'], { input: buffer })).trim()
  }

  /**
   * Write many blobs in ONE spawn, in order.
   *
   * **The budget is a spawn budget.** A subprocess costs ~130-150ms on this box
   * under load and everything git actually does is free next to it, so
   * `writeBlob` per file made the accept linear in a quantity that should not
   * have appeared in the cost at all -- the same harness importing 2,040 blobs
   * one at a time took six minutes.
   *
   * `--stdin-paths` reads PATHS rather than content, so in-memory bytes go
   * through a temp directory: N writes plus one spawn, against N spawns. A file
   * write is microseconds and a spawn is milliseconds, so this is a win from
   * the second blob onward and the single-blob case keeps the direct `--stdin`
   * form with no temp file at all.
   */
  async function writeBlobs(contents) {
    const buffers = contents.map(content => (Buffer.isBuffer(content) ? content : Buffer.from(String(content))))
    if (buffers.length === 0) return []
    if (buffers.length === 1) return [await writeBlob(buffers[0])]
    const dir = `${gitDir}/tlda-blobs-${process.pid}-${Date.now()}`
    try {
      await mkdir(dir, { recursive: true })
      const paths = []
      for (const [index, buffer] of buffers.entries()) {
        const file = `${dir}/${index}`
        await writeFile(file, buffer)
        paths.push(file)
      }
      const out = await git(['hash-object', '-w', '--stdin-paths'], { input: `${paths.join('\n')}\n` })
      const shas = out.split('\n').map(line => line.trim()).filter(Boolean)
      if (shas.length !== buffers.length) {
        throw new Error(`hash-object returned ${shas.length} shas for ${buffers.length} blobs`)
      }
      return shas
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // Best effort on a temp directory; the blobs are already in the object
        // store and a leftover directory is litter rather than a failure.
      })
    }
  }

  /**
   * Accept a revision: build its tree from `files` (path → bytes) applied over
   * `parent`, and commit it. Returns the commit sha, which is the revision id.
   *
   * Only changed paths are passed; everything else is inherited from the parent
   * tree, so an unchanged file costs nothing. That is the property the previous
   * store did not have and the reason it grew without bound.
   */
  async function acceptRevision({ project, parent = null, files = [], deleted = [], message = 'source revision', author = null, replaceTree = false }) {
    for (const file of files) {
      if (!file || typeof file.path !== 'string') throw new Error('Every file needs a path')
    }
    // **One spawn for every blob, not one spawn per blob.**
    //
    // A caller that already hashed the bytes passes the blob sha instead, and
    // re-writing it would be identical work for an identical result -- so only
    // the un-hashed ones are written, and they go together. On a book this is
    // the difference between a constant cost and a linear one in the quantity
    // that dominates: spawns.
    const needsWriting = files.filter(file => !file.sha)
    const written = await writeBlobs(needsWriting.map(file => file.content))
    const shaFor = new Map(needsWriting.map((file, i) => [file, written[i]]))
    const index = files.map(file => `100644 blob ${file.sha || shaFor.get(file)}\t${file.path}`)
    for (const path of deleted) index.push(`0 ${NULL_SHA}\t${path}`)

    // `replaceTree` builds the tree from `files` alone rather than over the
    // parent's. A caller holding the project's COMPLETE manifest wants that: a
    // path that left the manifest is then absent because it was not named,
    // which is exact, rather than absent because someone remembered to list it
    // as deleted — and forgetting is how a file outlives its own removal.
    const base = parent && !replaceTree ? (await git(['rev-parse', `${parent}^{tree}`])).trim() : null
    const tree = await buildTree(base, index)

    const args = ['commit-tree', tree, '-m', message]
    if (parent) args.push('-p', parent)
    const env = author
      ? { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email }
      : process.env
    return (await run('git', ['--git-dir', gitDir, ...args], { env })).toString('utf8').trim()
  }

  // read-tree the parent into a scratch index, apply the changed paths, write
  // it back out. The index is a temp file so concurrent accepts do not collide.
  async function buildTree(baseTree, indexLines) {
    const indexFile = `${gitDir}/tlda-index-${process.pid}-${Date.now()}`
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    const g = async (args, input = null) => (await run('git', ['--git-dir', gitDir, ...args], { env, input })).toString('utf8')
    try {
      if (baseTree) await g(['read-tree', baseTree])
      if (indexLines.length) await g(['update-index', '--index-info'], indexLines.join('\n') + '\n')
      return (await g(['write-tree'])).trim()
    } finally {
      // `fs.rm`, not a subprocess. A spawn costs ~130-150ms on this box under
      // load -- measured -- and everything git actually does is free next to
      // that, so a whole process to unlink one temp file was a sixth of the
      // accept's cost doing nothing. `rm` was already imported two lines above.
      await rm(indexFile, { force: true }).catch(() => {
        // Best effort on a temp index. A leftover file is litter; reporting it
        // would replace the accept's result with a cleanup error.
      })
    }
  }

  /**
   * path → sha, and size, for every file in a revision. This is the manifest.
   *
   * `-l` carries the blob sizes, which costs nothing here and saves a
   * `cat-file -s` per file at the caller: a revision record reports the
   * project's byte size, and asking per file turns one subprocess into one per
   * file on a book with 1499 of them.
   */
  async function readManifest(revision) {
    const out = await git(['ls-tree', '-r', '-l', '--full-tree', revision])
    return out.split('\n').filter(Boolean).map(line => {
      const [meta, path] = line.split('\t')
      const [, , sha, size] = meta.split(/\s+/)
      return { path, sha256: sha, size: Number(size) || 0 }
    })
  }

  /** One blob's bytes by its own sha, for a manifest entry already in hand. */
  async function readBlobBytes(sha) {
    try {
      return await git(['cat-file', 'blob', sha], { buffer: true })
    } catch {
      return null
    }
  }

  /**
   * A commit's subject, body and author date. The revision record's
   * non-tree parts — its dependency pins and when it was accepted — are
   * carried in the commit object rather than beside it, so there is one thing
   * to write and one thing that can be lost.
   */
  async function readCommitMeta(revision) {
    try {
      const out = await git(['show', '-s', '--format=%aI%n%B', revision])
      const newline = out.indexOf('\n')
      return { date: out.slice(0, newline).trim(), message: out.slice(newline + 1) }
    } catch {
      return { date: null, message: '' }
    }
  }

  /** One file's bytes out of one revision, without materialising the rest. */
  async function readRevisionFile(revision, path) {
    try {
      return await git(['cat-file', 'blob', `${revision}:${path}`], { buffer: true })
    } catch {
      return null
    }
  }

  /**
   * A blob's size in bytes, without reading it. The revision record reports a
   * project's byte size, and a file carried forward unchanged from the parent
   * revision has no bytes in hand to measure — asking git is one `cat-file -s`
   * against reading a file that did not change.
   */
  async function blobSize(sha) {
    try {
      return Number((await git(['cat-file', '-s', sha])).trim())
    } catch {
      return 0
    }
  }

  /**
   * A bundle carrying `revision`, containing only what the recipient does not
   * already have.
   *
   * `refs/tlda/mirrored/<project>` records the last revision a daemon took, so
   * it is a *have*: bundling `mirrored..revision` sends the commits since then
   * rather than the project's whole history. That is the difference between a
   * few kilobytes and a whole repository on every accept, and the whole
   * repository in one base64 RPC body is what timed out at 53 s on 2026-08-17
   * and stopped mirroring bregman altogether.
   *
   * With no `mirrored` ref there is nothing to subtract and the bundle carries
   * everything reachable — the first mirror into a checkout, which is the one
   * time the full history is the right answer.
   *
   * The bundle names a ref rather than a bare sha: `git bundle` refuses to
   * create a bundle that carries no refs, so a sha alone writes nothing.
   */
  async function bundleSince(project, revision, { includeRefused = false, have: declaredHave } = {}) {
    // `have` defaults to the `mirrored` ref because the mirror is this
    // function's original caller and that ref is what the checkout last took.
    // A proposer recovering from a refusal is asking on its OWN behalf and
    // holds something different, so it says what it has. Defaulting to the
    // mirrored ref for that caller would ship a bundle computed against a third
    // party's position -- correct-looking, and missing exactly the commits the
    // proposer needs when the two have diverged.
    const have = declaredHave !== undefined ? declaredHave : await readRef('mirrored', project)
    const ref = refFor('source', project)
    const bundlePath = `${gitDir}/tlda-bundle-${process.pid}-${revision.slice(0, 7)}`
    const range = have && await isAncestor(have, revision)
      ? [`${have}..${ref}`]
      : [ref]
    // A refused push is a real commit that never became the head. It rides the
    // same bundle so the person who made it can look at it, rather than living
    // only in a rejection payload on a server.
    if (includeRefused && await readRef('refused', project)) range.push(refFor('refused', project))
    try {
      await git(['bundle', 'create', bundlePath, ...range])
      return (await readFile(bundlePath)).toString('base64')
    } finally {
      await rm(bundlePath, { force: true }).catch(() => {})
    }
  }

  /**
   * Take a bundle a daemon has proposed and make its commits ours, under a
   * quarantine ref rather than anywhere meaningful.
   *
   * Quarantine because a bundle is somebody else's claim until it has been
   * judged: fetching it straight onto `refs/tlda/source` would make accepting
   * and receiving the same act, and the whole point of a fast-forward check is
   * that they are not. Objects are cheap and unreferenced ones are `gc`'s
   * problem; a ref that means "the paper" is not.
   *
   * Returns the proposed commit, or null when the bundle carries nothing we can
   * read — which is a refusal, not a crash.
   */
  async function ingestBundle(project, bundlePath) {
    const quarantine = refFor('proposed', project)
    try {
      await git(['bundle', 'verify', bundlePath])
    } catch (error) {
      throw new Error(`unreadable bundle for ${project}: ${error.message.split('\n')[0]}`)
    }
    const heads = (await git(['bundle', 'list-heads', bundlePath])).split('\n').filter(Boolean)
    if (!heads.length) return null
    const [proposed] = heads[heads.length - 1].split(/\s+/)
    await git(['fetch', bundlePath, `+${proposed}:${quarantine}`])
    return proposed
  }

  /**
   * Accept a proposed commit iff it descends from what the project already has.
   *
   * **This is the whole accept decision.** Fast-forward means the proposer had
   * our head when they wrote, so nothing of ours is being discarded; anything
   * else is a non-fast-forward and belongs back with the proposer to rebase.
   * There is no three-way merge here and no manifest to compare — the tree that
   * arrived IS the manifest, so a path that left the paper is absent because
   * nobody named it rather than because somebody remembered to list it.
   */
  async function fastForward(project, proposed) {
    const current = await readRef('source', project)
    if (current === proposed) return { ok: true, status: 'already-current', revision: current }
    if (current && !(await isAncestor(current, proposed))) {
      return { ok: false, status: 'non-fast-forward', revision: current, proposed }
    }
    await moveRef('source', project, proposed, current)
    return { ok: true, status: 'accepted', revision: proposed, previous: current }
  }

  /**
   * What changed between two revisions, derived rather than declared.
   *
   * The old push route is handed `files: [{path, content}]` and builds every
   * post-accept effect from that list. A bundle carries a tree and no list, so
   * the effects have to ask what moved — which is the same reason the tree is
   * authoritative in the first place: a path is gone because it is absent, not
   * because somebody remembered to name it.
   *
   * `base` is null for a project's first revision, and then every path in
   * `head` is a change. That is not an edge case to guard; it is what a first
   * revision means.
   *
   * `-z` rather than the tab-splitting the readers above use: this feeds the
   * replica fan-out, and a path this misses is a path a bound checkout never
   * hears changed. A filename containing a tab or newline is unlikely and
   * silent, which is the combination worth one flag to remove.
   */
  async function diffRevisions(base, head) {
    if (!head) return { changed: [], deleted: [] }
    // No --full-tree here: it is an ls-tree option and diff-tree rejects it
    // with a usage error, which `git()` surfaces as a throw rather than an
    // empty diff. Checked against real output rather than assumed.
    const args = base
      ? ['diff-tree', '-r', '-z', '--name-status', base, head]
      : ['diff-tree', '-r', '-z', '--name-status', '--root', head]
    const fields = (await git(args)).split('\0').filter(Boolean)
    const changed = []
    const deleted = []
    // NUL-separated status/path pairs. With --root the first field is the
    // commit id rather than a status, so anything that is not a known status
    // letter is skipped rather than read as a path.
    for (let i = 0; i < fields.length - 1; i += 1) {
      const status = fields[i]
      if (!/^[AMDTC]/.test(status) || status.length > 3) continue
      const path = fields[i + 1]
      i += 1
      if (status.startsWith('D')) deleted.push(path)
      else changed.push(path)
    }
    return { changed, deleted }
  }

  /** True when `candidate` is in `head`'s history — the stale-base test. */
  async function isAncestor(candidate, head) {
    if (!candidate || !head) return false
    try {
      await git(['merge-base', '--is-ancestor', candidate, head])
      return true
    } catch {
      return false
    }
  }

  return {
    acceptRevision,
    readManifest,
    readRevisionFile,
    isAncestor,
    ingestBundle,
    fastForward,
    diffRevisions,
    writeBlob,
    writeBlobs,
    blobSize,
    readBlobBytes,
    readCommitMeta,
    bundleSince,

    head: project => readRef('source', project),
    advanceHead: (project, next, expected) => moveRef('source', project, next, expected),
    retractHead: (project, expected) => removeRef('source', project, expected),

    applied: bindingId => readRef('applied', bindingId),
    markApplied: (bindingId, revision, expected) => moveRef('applied', bindingId, revision, expected),

    built: project => readRef('built', project),
    markBuilt: (project, revision, expected) => moveRef('built', project, revision, expected),

    mirrored: project => readRef('mirrored', project),
    markMirrored: (project, revision, expected) => moveRef('mirrored', project, revision, expected),

    // What the SERVER's own working copy holds. The fourth of these, and the
    // one whose absence let a document go missing: the effects computed what to
    // write by diffing the accepted revision against its PARENT, which assumes
    // the disk already matches the parent. After a crash before the effects
    // ran, it does not -- and the retry's clean rebase has an identical tree,
    // so the diff is empty and nothing is ever written. Accepted, reported
    // preserved, and not on disk.
    materialized: project => readRef('materialized', project),
    markMaterialized: (project, revision, expected) => moveRef('materialized', project, revision, expected),

    // The last push this project refused. Not a lifecycle phase like the others
    // — it is the pointer that makes a refused commit reachable, and reachable
    // is the whole difference between "nothing was lost" and "he can see it".
    refused: project => readRef('refused', project),
    markRefused: (project, revision, expected) => moveRef('refused', project, revision, expected),
  }
}
