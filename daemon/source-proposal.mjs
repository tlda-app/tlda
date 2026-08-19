import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { classifyThreeWay } from '../server/lib/source-lifecycle.mjs'

/**
 * A checkout proposing a commit to the server.
 *
 * The daemon commits the project's members onto `refs/tlda/local/<project>` in the
 * author's own repository, bundles what the server does not have, and POSTs it.
 * The server accepts iff it fast-forwards; a non-fast-forward comes back and the
 * daemon rebases onto the head it names and proposes again.
 *
 * **The invariant this exists to hold**, and the reason it is built the way it
 * is rather than from a manifest:
 *
 *   The tree committed for a revision IS the project's membership. There is no
 *   second description of what belongs, so nothing can disagree with the bytes.
 *
 * The proposal carries the project's complete member set, so the tree IS the
 * manifest and a path that left the paper is absent because nobody named it.
 * That is the store's only behaviour now rather than a flag this file passes.
 *
 * **This reverses an earlier invariant in this file, and the reversal is the
 * design's, not a relaxation.** The old form built over the parent's tree so
 * that a caller which forgot a path could not delete it — safe, and it made
 * *"we manually remove roots and then automatically delete unreferenced files"*
 * unimplementable, because automatic removal is exactly what it refuses.
 *
 * **What replaces that safety is where the member set comes from.** The closure
 * is computed from the COMMIT'S TREE, never from the moving disk: a scan of a
 * filesystem being written underneath it can shrink for reasons that are not
 * edits, and a scan cannot tell *deleted* from *mid-rename* or from a failed
 * read. A closure over a commit has no such failure mode. **That property is
 * the caller's to hold and this file cannot check it.**
 */
export function createSourceProposal({ sourceDir, project, log = null }) {
  if (!sourceDir) throw new Error('createSourceProposal requires sourceDir')
  if (!project) throw new Error('createSourceProposal requires project')

  const gitDir = join(sourceDir, '.git')
  const store = createSourceGitStore({ gitDir })
  // The revision this checkout last took from the server. The mirror writes it
  // on every successful apply, so it is the honest answer to "what does this
  // checkout hold" — and it is durable, unlike anything the daemon remembers.
  const HELD_REF = 'refs/tlda/shadow/HEAD'
  const LOCAL_REF = `refs/tlda/local/${project}`

  function git(args) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--git-dir', gitDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []
      const err = []
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      child.on('error', reject)
      child.on('close', code => (code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString().trim()}`))))
    })
  }

  async function treeOf(commit) {
    return (await git(['rev-parse', `${commit}^{tree}`])).toString('utf8').trim()
  }

  // The bytes a commit holds at a path, or null when the commit does not hold
  // it. **Null is a fact here, not a failure** -- absence from a tree is how
  // this design expresses "not a member", so the merge below reads a missing
  // path as a deletion and a throw would turn every added file into an error.
  async function readBlobAt(commit, path) {
    if (!commit) return null
    try {
      return await git(['cat-file', 'blob', `${commit}:${path}`])
    } catch {
      return null
    }
  }

  async function mergeBase(a, b) {
    try {
      return (await git(['merge-base', a, b])).toString('utf8').trim() || null
    } catch {
      return null
    }
  }

  async function readWorkingCopy(path) {
    try {
      return await readFile(join(sourceDir, path))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  const isBinary = buffer => buffer != null && buffer.includes(0)
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && a.equals(b))

  async function readRef(ref) {
    try {
      return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).toString('utf8').trim() || null
    } catch {
      return null
    }
  }

  /**
   * Commit the project's complete member set as it stands.
   *
   * **`members` is the whole project, not a delta.** The tree IS the manifest,
   * so a path that left the paper is absent because nobody named it — and
   * shedding is just a smaller tree rather than a mechanism. That is what makes
   * the wedge class stop existing: there is no second description of membership
   * to disagree with the bytes, so a member with no content and a phantom the
   * server holds and the daemon forgot are both unrepresentable.
   *
   * **This replaces the tree-over-parent form, and the replacement is
   * deliberate rather than a relaxation.** The old shape made deletion
   * inexpressible — a caller that forgot a path could not remove it — which was
   * safe and cost the feature Skip asked for: *"we manually remove roots and
   * then automatically delete unreferenced files."* Automatic removal of an
   * unreferenced file is exactly what a tree-over-parent proposal refuses to do.
   *
   * **What makes complete-tree safe is where the member set comes from: the
   * COMMIT'S TREE, never the moving disk.** A closure computed from a
   * filesystem being written underneath it can shrink for reasons that are not
   * edits; a closure computed from a commit cannot. The caller owes that
   * property — this function cannot check it — and it is the whole of why the
   * old invariant could be retired without reinstating the phantom class.
   */
  async function proposeCommit({ members = [], message = 'source revision', onto = null }) {
    const parent = onto || (await readRef(LOCAL_REF)) || (await readRef(HELD_REF))
    const files = []
    for (const rel of members) {
      // Read failures throw rather than being skipped. A file we cannot read is
      // not a file with no content — and under complete-tree semantics that
      // distinction got sharper, not softer: a skipped read is now a DELETION,
      // because the path simply would not be in the tree.
      const content = await readFile(join(sourceDir, rel))
      files.push({ path: rel, content })
    }
    const commit = await store.acceptRevision({
      project,
      parent,
      files,
      message,
      // The tree is built from `files` alone -- that is now the store's only
      // behaviour rather than an option. There is nothing to name as removed,
      // because absence IS the removal.
    })
    // **Compare TREES, not commits.** `commit-tree` mints a fresh sha every
    // time -- the timestamp is in it -- so `commit === parent` is never true
    // and this guard silently did nothing. The cost is not a wasted object: an
    // empty commit fast-forwards, so the server accepts it, `acceptSeq` moves,
    // and all six post-accept effects fire -- mirror, build, replica fan-out --
    // for a change that does not exist. A watcher that fires on a touched file
    // would have driven a build storm on his paper.
    //
    // Under complete-tree semantics this guard is load-bearing rather than
    // defensive: every settle rebuilds the whole tree, so an unchanged project
    // proposes an identical tree every time the watcher fires.
    if (parent && (await treeOf(commit)) === (await treeOf(parent))) {
      return { commit: parent, parent, changed: false }
    }
    const expected = await readRef(LOCAL_REF)
    await git(['update-ref', LOCAL_REF, commit, ...(expected ? [expected] : [])])
    log?.info?.(`${project}: proposing ${commit.slice(0, 7)} (${members.length} members)`)
    return { commit, parent, changed: true }
  }

  /**
   * The member set, derived from the last commit's tree plus what moved.
   *
   * **This is a bridge, and naming it as one matters.** The design's member set
   * is the transitive closure of the declared roots, computed from the commit's
   * tree — and that closure does not exist yet. Until it does, the members are
   * *what the previous tree held, plus what changed, minus what was observed
   * removed*, which reproduces today's behaviour through the complete-tree
   * interface rather than changing it.
   *
   * **The property the design actually requires is already held here: the set
   * comes from the TREE, not from the disk.** A scan of a filesystem being
   * written underneath it can shrink for reasons that are not edits and cannot
   * tell *deleted* from *mid-rename*; `readManifest` of a commit cannot. So
   * when the closure lands it replaces the union-and-difference below, and
   * nothing above or below this function has to move.
   */
  async function membersFrom(parent, { changed = [], deleted = [] }) {
    const held = parent ? (await store.readManifest(parent)).map(entry => entry.path) : []
    const removed = new Set(deleted)
    return [...new Set([...held.filter(path => !removed.has(path)), ...changed])].sort()
  }

  /**
   * The bundle carrying what the server does not have.
   *
   * `have` is the revision the server last accepted from anyone, so the bundle
   * is `have..local` — the commits since. With no `have` it carries everything
   * reachable, which is a checkout proposing into an empty project.
   *
   * A bundle names refs rather than shas: `git bundle` refuses to create one
   * that carries no ref, so a bare sha writes nothing.
   */
  async function bundleSince(have) {
    const bundlePath = join(gitDir, `tlda-propose-${process.pid}-${Date.now()}.bundle`)
    const range = have && await isAncestor(have, LOCAL_REF) ? [`${have}..${LOCAL_REF}`] : [LOCAL_REF]
    try {
      await git(['bundle', 'create', bundlePath, ...range])
      return await readFile(bundlePath)
    } finally {
      await rm(bundlePath, { force: true }).catch(() => {
        // A temp bundle that outlives the push is litter, not a failure, and
        // reporting it would replace the push's result with a cleanup error.
      })
    }
  }

  async function isAncestor(candidate, head) {
    try {
      await git(['merge-base', '--is-ancestor', candidate, head])
      return true
    } catch {
      return false
    }
  }

  /**
   * Re-propose this checkout's change on top of the head the server named.
   *
   * **This is the whole recovery path for a refusal**, and it replaces a retry
   * state machine with one more call of the same function. There is no blocked
   * state to get stuck in: the daemon holds the change, so the daemon is the one
   * that can move it.
   *
   * **It re-proposes our member set on THEIR head**, rather than re-parenting
   * the tree we already built. Under complete-tree semantics that distinction
   * is sharper than it was, not softer: our tree is the whole project, so
   * handing it back on their head would discard whatever they accepted from
   * anybody else — every path, not just the ones we touched.
   *
   * The members come from the caller because they come from the CLOSURE, and
   * recomputing that is not this function's job. What it owes is the base.
   *
   * If re-applying conflicts with what the head now holds, that is a genuine
   * two-writer disagreement — but it cannot conflict here, because applying a
   * path over a tree is not a merge. What it can do is overwrite a change
   * somebody else made to the SAME path, which is why the server refused in the
   * first place and why the person is told rather than the machine deciding.
   */
  /**
   * Bring the working copy forward onto the head we were refused against.
   *
   * **This is the step that makes complete-tree semantics safe, and without it
   * the rebase below is a clobber by construction.** Under a complete tree
   * every member's bytes come from the working copy — including paths we never
   * edited and whose content we are behind on. So re-proposing on their head
   * without first taking their bytes hands back OUR stale copy of THEIR file
   * and the server accepts it: their accepted paragraph is gone, with no error,
   * no refusal and no marker. That is the failure this whole mechanism exists
   * to prevent, arriving through the mechanism.
   *
   * The three sides are the design's: **base `applied`** — the revision this
   * checkout last took, which is the only honest common ancestor — **ours** the
   * working copy, **theirs** the head. Per member path:
   *
   * - only they moved it → take their bytes
   * - only we moved it → keep ours
   * - both moved it → `git merge-file`, and a clean result is written down
   * - both moved it and it does not merge → **conflicted, and we hold**
   *
   * **Deletion is a side moving too**, because absence from a tree is how this
   * design says "not a member". Their deletion of a file we did not touch
   * removes it here; their deletion of a file we edited is a conflict rather
   * than a silent choice between the two.
   *
   * **Binary files cannot be three-way merged and are not guessed at.** If both
   * sides moved one, it conflicts and a person decides.
   */
  async function mergeOnto(head, { members = [] }) {
    // **The design names the base `applied` — the revision this checkout last
    // took — and `merge-base` COMPUTES that rather than replacing it.** Our
    // local proposal is built on what we last took, so their head and our local
    // meet exactly there, and git answers it from the graph instead of from a
    // ref somebody has to have written.
    //
    // The distinction is not academic: `refs/tlda/shadow/HEAD` is the MIRROR's
    // write, so it is unset in a checkout that has never had a revision
    // delivered and stale in one whose mirror has failed. Reading it directly
    // makes every path look like it has no common ancestor, which turns a
    // one-sided edit into a conflict and stops the settle loop over nothing.
    // `merge-base` degrades the other way: worst case it finds nothing, and
    // nothing is what a genuinely unrelated history has.
    const base = (await mergeBase(LOCAL_REF, head)) || await readRef(HELD_REF)
    const merged = []
    const taken = []
    const removed = []
    const conflicted = []

    // **The member set alone cannot see a deletion, and that is the phantom
    // class.** A path they removed is absent from their head, so it is not a
    // member, so a loop over members never visits it — the proposal correctly
    // drops it and the FILE STAYS ON DISK. The author then has a checkout
    // holding a file the paper does not, which is what thirty phantom files
    // looked like on `talk-opening`.
    //
    // So the walk is members ∪ what the base held. **Not the disk**: a file the
    // author created and has not pushed is in no tree at all, and widening this
    // to a scan would delete it. Base-held-and-gone is exactly the set somebody
    // removed on purpose.
    const held = base ? (await store.readManifest(base)).map(entry => entry.path) : []
    const walk = [...new Set([...members, ...held])].sort()

    for (const path of walk) {
      const [baseContent, theirContent] = await Promise.all([readBlobAt(base, path), readBlobAt(head, path)])
      const ourContent = await readWorkingCopy(path)

      if (same(ourContent, theirContent)) continue
      // We never moved it, so whatever they did to it is simply the truth.
      if (same(baseContent, ourContent)) {
        if (theirContent == null) {
          await rm(join(sourceDir, path), { force: true })
          removed.push(path)
        } else {
          await writeFile(join(sourceDir, path), theirContent)
          taken.push(path)
        }
        continue
      }
      // They never moved it, so ours stands and there is nothing to write.
      if (same(baseContent, theirContent)) continue

      // Both sides moved it. A deletion against an edit is not a merge and not
      // ours to settle -- one of the two people has to be told.
      if (theirContent == null || ourContent == null || baseContent == null) {
        conflicted.push({ path, reason: theirContent == null ? 'deleted-and-edited' : ourContent == null ? 'added-both-sides' : 'no-common-ancestor' })
        continue
      }
      if (isBinary(baseContent) || isBinary(ourContent) || isBinary(theirContent)) {
        conflicted.push({ path, reason: 'binary' })
        continue
      }

      // `current` is what the project holds and `incoming` is our change --
      // that is the order the marker labels are written for, so the person who
      // opens this file in their own editor reads sides that name themselves.
      const result = classifyThreeWay({
        base: baseContent.toString('utf8'),
        current: theirContent.toString('utf8'),
        incoming: ourContent.toString('utf8'),
      })
      if (result.status === 'clean-rebase-candidate') {
        await writeFile(join(sourceDir, path), result.merged)
        merged.push(path)
        continue
      }
      // A conflict is written down WITH ITS MARKERS. The settle loop holds, so
      // nothing proposes this text -- but the person editing this checkout is
      // the one who resolves it, and they resolve it in the file.
      if (result.status === 'conflict') await writeFile(join(sourceDir, path), result.merged)
      conflicted.push({ path, reason: result.status === 'conflict' ? 'conflict' : (result.error || 'classification-unavailable') })
    }

    if (conflicted.length) {
      log?.warn?.(`${project}: holding — ${conflicted.length} member path(s) conflicted onto ${head.slice(0, 7)}: ${conflicted.map(item => item.path).join(', ')}`)
    } else if (merged.length || taken.length || removed.length) {
      log?.info?.(`${project}: brought forward onto ${head.slice(0, 7)} (${taken.length} taken, ${merged.length} merged, ${removed.length} removed)`)
    }
    return { conflicted, merged, taken, removed, base }
  }

  async function rebaseOnto(head, { members = [] }) {
    if (!head) throw new Error(`${project}: cannot rebase onto nothing`)
    // **The merge comes first, and a conflict stops the re-proposal rather than
    // colouring it.** A merge that resolves what it can and proposes anyway is
    // the clobber again with more steps, so the one path that refuses to
    // proceed is the one that carries the guarantee.
    const brought = await mergeOnto(head, { members })
    if (brought.conflicted.length) {
      return { commit: null, parent: head, changed: false, status: 'conflicted', conflicted: brought.conflicted }
    }
    const result = await proposeCommit({ members, onto: head, message: 'source revision' })
    log?.info?.(`${project}: re-proposed on ${head.slice(0, 7)} as ${result.commit.slice(0, 7)}`)
    return { ...result, status: 'rebased', conflicted: [] }
  }

  /**
   * Make the server's commits ours, so that a head we were refused against is
   * something we can actually rebase onto.
   *
   * Fetched into a quarantine ref for the same reason the server quarantines
   * ours: having somebody's commits and agreeing they are the paper are
   * different acts, and only the local ref says what this checkout holds.
   */
  async function ingest(bundleBase64) {
    const bundlePath = join(gitDir, `tlda-fetched-${process.pid}-${Date.now()}.bundle`)
    try {
      await writeFile(bundlePath, Buffer.from(bundleBase64, 'base64'))
      await git(['bundle', 'verify', bundlePath])
      const heads = (await git(['bundle', 'list-heads', bundlePath])).toString('utf8').split('\n').filter(Boolean)
      for (const line of heads) {
        const [sha, ref] = line.split(/\s+/)
        await git(['fetch', bundlePath, `+${sha}:refs/tlda/fetched/${project}/${(ref || sha).replace(/^refs\//, '')}`])
      }
      return heads.length
    } finally {
      await rm(bundlePath, { force: true }).catch(() => {})
    }
  }

  return {
    proposeCommit,
    membersFrom,
    bundleSince,
    mergeOnto,
    rebaseOnto,
    ingest,
    isAncestor,
    held: () => readRef(HELD_REF),
    local: () => readRef(LOCAL_REF),
    hasCommit: async sha => {
      try {
        await git(['cat-file', '-e', `${sha}^{commit}`])
        return true
      } catch {
        return false
      }
    },
  }
}
