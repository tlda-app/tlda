import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

/**
 * A checkout proposing a commit to the server.
 *
 * The daemon commits what changed onto `refs/tlda/local/<project>` in the
 * author's own repository, bundles what the server does not have, and POSTs it.
 * The server accepts iff it fast-forwards; a non-fast-forward comes back and the
 * daemon rebases onto the head it names and proposes again.
 *
 * **The invariant this exists to hold**, and the reason it is built the way it
 * is rather than from a manifest:
 *
 *   The tree committed for a revision is the PREVIOUS tree, plus what was
 *   added, minus what was OBSERVED being removed. A scan is evidence for
 *   adding. It is never, on its own, evidence for removing.
 *
 * `acceptRevision` is called **without `replaceTree`**, so the tree is built
 * over the parent's and every path nobody mentions is inherited unchanged. That
 * makes the invariant structural rather than a rule the caller has to remember:
 * a caller that forgets a file cannot delete it, because it never had to name
 * it. `bin/a-tree-is-not-a-scan-test.mjs` demonstrates the other way round —
 * `replaceTree: true` handed an incomplete set is a silent mass deletion — and
 * that is the call this deliberately does not make.
 *
 * It matters here more than anywhere. The reference closure that decides what
 * the daemon watches cannot distinguish *deleted* from *mid-rename*, or a failed
 * read from a file with no references — `edits-dont-reach-the-file` demonstrated
 * both on fixtures one permission bit apart. Every one of those failures is an
 * inability to observe. Inheriting the parent tree means none of them can
 * remove anything.
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

  async function readRef(ref) {
    try {
      return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).toString('utf8').trim() || null
    } catch {
      return null
    }
  }

  /**
   * Commit `changed` and `deleted` over whatever this checkout holds.
   *
   * `changed` is paths whose bytes are read from disk now; `deleted` is paths
   * the watcher **observed** being removed. A path in neither is inherited from
   * the parent tree without being read, which is why a scan that misses a file
   * costs a late push rather than a deletion.
   */
  async function proposeCommit({ changed = [], deleted = [], message = 'source revision', onto = null }) {
    const parent = onto || (await readRef(LOCAL_REF)) || (await readRef(HELD_REF))
    const files = []
    for (const rel of changed) {
      // Read failures throw rather than being skipped. A file we cannot read is
      // not a file with no content, and the push not happening is recoverable
      // where a push that silently omits it is not.
      const content = await readFile(join(sourceDir, rel))
      files.push({ path: rel, content })
    }
    const commit = await store.acceptRevision({
      project,
      parent,
      files,
      deleted,
      message,
      // Deliberately absent: replaceTree. The tree is built OVER the parent's.
    })
    // **Compare TREES, not commits.** `commit-tree` mints a fresh sha every
    // time -- the timestamp is in it -- so `commit === parent` is never true
    // and this guard silently did nothing. The cost is not a wasted object: an
    // empty commit fast-forwards, so the server accepts it, `acceptSeq` moves,
    // and all six post-accept effects fire -- mirror, build, replica fan-out --
    // for a change that does not exist. A watcher that fires on a touched file
    // would have driven a build storm on his paper.
    if (parent && (await treeOf(commit)) === (await treeOf(parent))) {
      return { commit: parent, parent, changed: false }
    }
    const expected = await readRef(LOCAL_REF)
    await git(['update-ref', LOCAL_REF, commit, ...(expected ? [expected] : [])])
    log?.info?.(`${project}: proposing ${commit.slice(0, 7)} (${changed.length} changed, ${deleted.length} deleted)`)
    return { commit, parent, changed: true }
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
   * It re-applies the SAME changed and deleted paths over the server's head —
   * it does not reuse the tree we already built. Reusing that tree would take
   * our whole view of the project and hand it back as a proposal, **silently
   * discarding whatever the server accepted from anyone else in between.** The
   * delta is ours; the base is theirs; that is what a rebase means and the
   * distinction is the difference between a merge and a clobber.
   *
   * If re-applying conflicts with what the head now holds, that is a genuine
   * two-writer disagreement — but it cannot conflict here, because applying a
   * path over a tree is not a merge. What it can do is overwrite a change
   * somebody else made to the SAME path, which is why the server refused in the
   * first place and why the person is told rather than the machine deciding.
   */
  async function rebaseOnto(head, { changed = [], deleted = [] }) {
    if (!head) throw new Error(`${project}: cannot rebase onto nothing`)
    const result = await proposeCommit({ changed, deleted, onto: head, message: 'source revision' })
    log?.info?.(`${project}: re-proposed on ${head.slice(0, 7)} as ${result.commit.slice(0, 7)}`)
    return result
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
    bundleSince,
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
