import { execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { scanTexDependencyClosure } from '../shared/tex-deps.mjs'
import { scanMarkdownDependencyClosure } from '../shared/markdown-deps.mjs'
import { documentRootsIn } from '../shared/document-roots.mjs'
import { isQuartoRenderOutput, isSourceFilePath } from '../shared/source-manifest.mjs'

const execFile = promisify(execFileCb)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// What this file means by a document: the candidate rule below, the
// keep-scanning rule inside a closure, and the dropped-document report all ask
// the same question, so they ask it in one place.
const DOCUMENT_FILE = /\.(?:tex|md|qmd)$/i
// The subject `filteredProjectCommit` writes on every revision-chain commit.
// Named once because it is also how a work branch that is REALLY the chain is
// recognised during migration — see adoptWorkBranch. Two copies of this string
// would drift and the migration would silently stop working.
const REVISION_COMMIT_SUBJECT = 'tlda project revision'

export function safeRefPart(value) {
  const part = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!part || part.startsWith('.') || part.endsWith('.')) throw new Error(`invalid ref component: ${value}`)
  return part
}

/**
 * The branch this project's work is committed to, in one place.
 *
 * The daemon writes here on every settle. A person whose checkout stands on
 * this branch therefore sees their edits committed under them and a clean
 * working tree; a person standing anywhere else sees the daemon commit to a
 * branch they are not on, and is dirty against their own from the first edge.
 *
 * Skip, 2026-08-25: "if you have a daemon-managed branch checked out — it
 * commits, and pushes, and all that shit. otherwise it doesn't."
 */
export function projectBranchRef(project) {
  return `refs/heads/tlda/${safeRefPart(project)}`
}

export function createGitProjectSync({
  sourceDir,
  project,
  daemonId,
  bindingId,
  remote = 'tlda',
  branch = 'main',
  documentRoots = [],
  log = console,
  onSubmitted = () => {},
  onMirrorArrived = () => {},
  runGit = null,
} = {}) {
  if (!sourceDir || !project || !daemonId || !bindingId) throw new Error('sourceDir, project, daemonId, and bindingId are required')
  const projectPart = safeRefPart(project)
  const daemonPart = safeRefPart(daemonId)
  const branchPart = safeRefPart(branch)
  const bindingPart = safeRefPart(bindingId)
  // TWO refs, because there are two objects. Conflating them is what broke this.
  //
  // Skip, 2026-08-23: "there is meant to be a branch tracking" ... "OBVIOUSLY
  // YOU FUCKING WANT A FUCKING BRANCH WITH YOUR SHIT ON IT".
  //
  // That was answered by RENAMING the revision chain into `refs/heads/`, which
  // gave it a branch's name without making it a branch. The chain is the
  // publishing projection: `filteredProjectCommit` keeps the document roots and
  // their dependency closure and drops everything else, so the "branch" held a
  // SUBSET of the person's tracked files. Measured 2026-08-25 on a checkout with
  // `demo.md` and `notes.txt` committed: the branch contained `demo.md` alone.
  //
  // A branch you cannot stand on without losing files is one nobody stands on,
  // so the daemon committed to a branch the person was not on, their own branch
  // never moved, and their working tree was dirty against it from the first edit
  // — which is why `git checkout` and `tlda project remote pull` both refused
  // forever. Skip, 2026-08-25: "if you have a daemon-managed branch checked out
  // — it commits, and pushes, and all that shit. otherwise it doesn't."
  //
  //   revisionRef   the chain. Filtered, internal, never a branch. It is the
  //                 parent of the next revision, what recover() re-pushes after
  //                 a restart, and what members() lists. Nothing about it
  //                 changes here except that it keeps its own name.
  //   workBranchRef the person's branch. The real settled tree, standable,
  //                 advanced under them on every settle.
  const revisionRef = `refs/tlda/project/${projectPart}`
  const workBranchRef = projectBranchRef(project)
  const localRef = revisionRef
  const appliedRef = `refs/tlda/applied/${bindingPart}`
  const sharedRef = `refs/tlda/source/${projectPart}`
  const fetchedRef = `refs/tlda/fetched/${projectPart}`
  let chain = Promise.resolve()
  let configuredRoots = []
  function setDocumentRoots(values = []) {
    configuredRoots = [...new Set(values
      .map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter(Boolean))]
  }
  setDocumentRoots(documentRoots)

  async function git(args, options = {}) {
    if (runGit) return runGit(args, options)
    return execFile('git', args, { cwd: sourceDir, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options })
  }

  async function rev(ref) {
    try { return (await git(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim() } catch { return null }
  }

  /** The full ref HEAD is on, or null when HEAD is detached. */
  async function currentBranchRef() {
    try { return (await git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim() || null } catch { return null }
  }

  /**
   * Hand the branch name over to the person's real work, once per process.
   *
   * The rename that created this mess left `revisionRef` frozen at the moment of
   * promotion while the branch kept advancing, so the newer projection commits
   * are reachable ONLY through the branch. This carries the chain forward onto
   * its own name FIRST, so that when the branch starts holding real settled
   * trees nothing that was ever committed becomes unreachable. Nothing is
   * deleted; a ref is moved forward along its own history.
   *
   * `refs/heads/tlda` and `refs/heads/tlda/<p>` cannot coexist, because git
   * stores heads as paths and a file cannot also be a directory. A repository
   * that already has a branch literally named `tlda` keeps syncing — the
   * revision chain does not depend on the branch existing — and is told why its
   * work branch is missing. Deleting somebody's branch to make room is not ours
   * to do.
   *
   * Memoized so a blocked repository says it once rather than on every settle.
   */
  let workBranchAdoption = null
  function adoptWorkBranch() {
    workBranchAdoption ||= (async () => {
      try {
        if (await rev('refs/heads/tlda')) {
          log.warn?.(`${project}: this checkout has a branch named "tlda", which blocks the branch tlda/${projectPart}. Syncing continues; rename that branch to get your work branch.`)
          return { ok: false, reason: 'blocked-by-tlda-branch' }
        }
        const branchTip = await rev(workBranchRef)
        const chainTip = await rev(revisionRef)
        // TWO ways a work branch turns out to be the revision chain wearing a
        // branch's name, and a project falls into one or the other depending on
        // when it was created.
        //
        // Both refs present and related: promotion created the branch AT the old
        // ref and left the old ref in place, so a repository that lived through
        // the rename has both.
        //
        // Or the branch's own tip is a chain commit. A project created AFTER the
        // rename never had the old ref at all — the branch was made directly, so
        // there is nothing to compare it against. Measured on such a project: the
        // branch held `tlda project revision` commits and `refs/tlda/project/<p>`
        // did not exist, so requiring both refs refused to migrate it and
        // relinking could not fix it. That is most projects created recently.
        //
        // The subject is the discriminator because this file writes it: a chain
        // commit says REVISION_COMMIT_SUBJECT, a settled one says `tlda settled
        // edit cluster`. It is not a heuristic about someone else's commits.
        //
        // What is NOT adopted is a branch holding real settled work, which is
        // what standOnWorkBranch creates at HEAD on a new link. Adopting that
        // made `recover()` push it as an outstanding revision that had never been
        // sent — one extra admission in the readmit test.
        const tipSubject = branchTip
          ? (await git(['log', '-1', '--format=%s', branchTip]).catch(() => ({ stdout: '' }))).stdout.trim()
          : ''
        const branchIsChain = Boolean(branchTip) && (
          (Boolean(chainTip) && await isAncestor(chainTip, branchTip))
          || tipSubject === REVISION_COMMIT_SUBJECT
        )
        if (branchIsChain) await git(['update-ref', revisionRef, branchTip])
        return { ok: true }
      } catch (error) {
        log.warn?.(`${project}: could not adopt the work branch ${workBranchRef}: ${error.message}`)
        return { ok: false, reason: error.message }
      }
    })()
    return workBranchAdoption
  }

  async function isAncestor(older, newer) {
    if (!older || !newer) return false
    try { await git(['merge-base', '--is-ancestor', older, newer]); return true } catch { return false }
  }

  async function unresolved() {
    return (await git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
  }

  async function filteredProjectCommit(workingCommit) {
    const archiveDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-project-tree-'))
    const archive = path.join(archiveDir, 'tree.tar')
    const extracted = path.join(archiveDir, 'tree')
    await fs.promises.mkdir(extracted)
    try {
      await git(['archive', '--format=tar', `--output=${archive}`, workingCommit])
      await execFile('tar', ['-xf', archive, '-C', extracted], { timeout: 30000 })
      // Read the immutable tree once. The projection used to spawn `git
      // ls-tree <commit> -- <path>` twice per member below. A book-sized tree
      // therefore turned one settle into thousands of sequential Git processes
      // before its proposal could even be submitted.
      //
      // `-t` includes directory and symlink entries needed by
      // resolveThroughSymlinks; `-z` keeps path parsing independent of quoting.
      const treeEntries = new Map()
      for (const record of (await git(['ls-tree', '-r', '-t', '-z', workingCommit])).stdout.split('\0').filter(Boolean)) {
        const tab = record.indexOf('\t')
        if (tab < 0) throw new Error(`${project}: could not parse immutable tree entry`)
        const [mode, type, sha] = record.slice(0, tab).split(/\s+/)
        treeEntries.set(record.slice(tab + 1), { mode, type, sha })
      }
      const paths = [...treeEntries.entries()]
        .filter(([, entry]) => entry.type !== 'tree')
        .map(([file]) => file)
      // A project that declares roots publishes those roots and their build
      // dependencies. Discovering every root in a course checkout on each save
      // made a one-page project scan the entire course before it could submit.
      // Projects without declared roots retain branch-derived discovery.
      const computedRoots = configuredRoots.length
        ? configuredRoots
        : (await documentRootsIn(paths, async file => {
            try { return await fs.promises.readFile(path.join(extracted, file), 'utf8') } catch { return null }
          })).map(root => root.path)
      if (!computedRoots.length) throw new Error(`${project}: no document roots in settled tree`)
      for (const root of computedRoots) {
        if (!treeEntries.has(root)) throw new Error(`${project}: configured document root is absent: ${root}`)
      }
      const qmdRoots = computedRoots.filter(file => /\.qmd$/i.test(file))
      // `talk.html` beside `talk.qmd` is that root's render output, not a document.
      // Nothing includes it, so the graph returns it as a root of its own, and an
      // html root carries its whole sibling tree — which is right for an html
      // project and is how a stale local render gets published by a qmd one.
      // `isQuartoRenderOutput` already keeps it out of the qmd closure; this is the
      // same rule applied one step earlier, to roothood. A project with no qmd root
      // has an empty `qmdRoots` and is untouched.
      const candidates = computedRoots.filter(file =>
        !(/\.html?$/i.test(file) && qmdRoots.some(root => isQuartoRenderOutput(file, root))))
      const qmdFiles = qmdRoots.length
        ? paths.filter(file =>
            isSourceFilePath(file, { format: 'qmd', mainFile: qmdRoots[0] })
            && !qmdRoots.some(root => isQuartoRenderOutput(file, root)))
        : []
      const htmlRoots = candidates.filter(file => /\.html?$/i.test(file))
      const htmlFiles = htmlRoots.length
        ? paths.filter(file => isSourceFilePath(file, { format: 'html', mainFile: htmlRoots[0] }))
        : []
      const closures = new Map()
      for (const candidate of candidates) {
        if (/\.qmd$/i.test(candidate)) {
          closures.set(candidate, new Set(qmdFiles))
          continue
        }
        if (/\.html?$/i.test(candidate)) {
          closures.set(candidate, new Set(htmlFiles))
          continue
        }
        const files = new Set()
        const pending = [candidate]
        const scanned = new Set()
        const missing = []
        while (pending.length) {
          const document = pending.shift()
          if (scanned.has(document)) continue
          scanned.add(document)
          const closure = /\.tex$/i.test(document)
            ? scanTexDependencyClosure(document, extracted)
            : scanMarkdownDependencyClosure(document, extracted)
          for (const file of closure.files) {
            files.add(file)
            if (DOCUMENT_FILE.test(file) && !scanned.has(file)) pending.push(file)
          }
          missing.push(...closure.missing)
        }
        // A missing dependency does not abort the checkpoint. shadow-mirror.mjs:148
        // makes this exact call in this repository already, and the reasoning is
        // written out there: "Throwing there aborts the whole checkpoint, so every
        // OTHER file in the build loses its preservation commit too, permanently
        // and on every build. … Skipping is strictly safer than throwing."
        //
        // The same shape reaches here by a different route. Under tracked-only
        // staging, a file the author has written and not yet staged is absent from
        // the settled tree and therefore missing — so throwing would stop the whole
        // project submitting anything, on this settle and on every settle after,
        // because nothing ever stages it. The catch at git-sync-manager.mjs:97
        // logs at warn, so a person would get no other trace.
        //
        // The closure is scanned against `extracted`, a materialisation of the
        // settled tree, so existence is checked against `sourceDir` — the real
        // working tree — which is the only thing that tells the two cases apart.
        // Both skip. They are logged differently because they send a reader
        // looking in different places.
        //
        // A path that is not there is simply not in the closure. There is no
        // deletion to record: this function computes a closure, where
        // shadow-mirror was building a commit over a known path set.
        for (const item of missing) {
          log.info?.(fs.existsSync(path.join(sourceDir, item.path))
            ? `${project}: ${candidate} references ${item.path}, which is present but untracked — it joins the revision once it is staged`
            : `${project}: ${candidate} references ${item.path}, which is not in the project — leaving it out of the revision`)
        }
        closures.set(candidate, files)
      }
      const pulled = new Set()
      for (const [candidate, files] of closures) {
        if (/\.(?:qmd|html?)$/i.test(candidate)) continue
        for (const other of candidates) if (other !== candidate && files.has(other)) pulled.add(other)
      }
      const roots = candidates.filter(candidate => !pulled.has(candidate))
      if (!roots.length) throw new Error(`${project}: document dependency graph contains a cycle`)
      const members = new Set(roots.flatMap(root => [...closures.get(root)]))
      // A tracked document no root reaches is not in the closure, so it is not in
      // the revision. That is the design and this does not change it — what it
      // changes is that the settle now says which documents it left behind.
      //
      // The person has already staged the file, so from where they stand they have
      // done everything the app asks and the push answers SubmittedToBuildQueue,
      // ok=true. Their only other evidence is the document never appearing.
      //
      // Distinct from the missing-dependency notes above: those are a root asking
      // for a path that is not in the settled tree. This is a path that IS in the
      // settled tree that no root asks for. Callers carry it out to a person.
      // A closure member may point through a committed symlink, which git will
      // not traverse in a tree: `scratch/book/figs -> ../../lectures/figs` makes
      // the walk record `scratch/book/figs/plot.png`, and only
      // `lectures/figs/plot.png` is a tree entry. Resolve the member to its
      // canonical committed path, and carry the link itself so the built
      // document can still find its figures. The check below is unchanged: a
      // member that resolves to nothing still stops the revision.
      const committedEntry = candidatePath => treeEntries.get(candidatePath) || null
      const resolveThroughSymlinks = async (member, links, seen = new Set()) => {
        if (committedEntry(member)) return member
        const parts = member.split('/')
        // Longest prefix first: the nearest enclosing entry is the one that
        // decides. A shorter prefix that happens to exist says nothing about
        // whether the rest of the path does.
        for (let index = parts.length - 1; index >= 1; index--) {
          const prefix = parts.slice(0, index).join('/')
          const entry = committedEntry(prefix)
          if (!entry) continue
          // A real directory here means the remainder genuinely is not in the
          // tree. That is an absent file, and it belongs to the check below.
          if (entry.mode !== '120000') return null
          const target = (await git(['cat-file', 'blob', entry.sha])).stdout.trim()
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(prefix), target, parts.slice(index).join('/')))
          // A link pointing outside the repository, or a cycle, resolves to
          // nothing rather than to something outside the project.
          if (resolved.startsWith('..') || resolved.startsWith('/') || seen.has(resolved)) return null
          seen.add(resolved)
          links.add(prefix)
          return resolveThroughSymlinks(resolved, links, seen)
        }
        return null
      }
      const symlinkMembers = new Set()
      for (const member of [...members]) {
        if (committedEntry(member)) continue
        const canonical = await resolveThroughSymlinks(member, symlinkMembers)
        if (!canonical) continue
        members.delete(member)
        members.add(canonical)
      }
      for (const link of symlinkMembers) members.add(link)

      const dropped = paths.filter(file => DOCUMENT_FILE.test(file) && !members.has(file))
      const index = path.join(archiveDir, 'index')
      const env = { ...process.env, GIT_INDEX_FILE: index }
      await git(['read-tree', '--empty'], { env })
      const indexArgs = ['update-index', '--add']
      for (const member of [...members].sort()) {
        const entry = committedEntry(member)
        if (!entry) throw new Error(`${project}: immutable closure member is absent: ${member}`)
        indexArgs.push('--cacheinfo', `${entry.mode},${entry.sha},${member}`)
      }
      await git(indexArgs, { env })
      const tree = (await git(['write-tree'], { env })).stdout.trim()
      // Fetched server history is never proposal ancestry. This chain used to
      // fall through to the fetched and applied refs, so on a FIRST sync — when
      // localRef does not exist yet — the app's own project commit was parented
      // on the server's revision, with no merge involved anywhere. A first
      // revision with no local ancestor is a root commit instead; the person's
      // own workingCommit is already a parent candidate below.
      const parent = await rev(localRef)
      if (parent && (await git(['rev-parse', `${parent}^{tree}`])).stdout.trim() === tree) return { commit: parent, tree, roots, members: [...members], dropped, changed: false }
      const args = ['commit-tree', tree, '-m', REVISION_COMMIT_SUBJECT]
      const remoteParent = await rev('refs/tlda/remote/observed')
      const parents = []
      for (const candidate of [parent, workingCommit, remoteParent]) {
        if (!candidate || parents.includes(candidate)) continue
        let redundant = false
        for (let index = parents.length - 1; index >= 0; index--) {
          if (await isAncestor(candidate, parents[index])) {
            redundant = true
            break
          }
          if (await isAncestor(parents[index], candidate)) parents.splice(index, 1)
        }
        if (!redundant) parents.push(candidate)
      }
      for (const commit of parents) args.push('-p', commit)
      const commit = (await git(args)).stdout.trim()
      return { commit, tree, roots, members: [...members], dropped, changed: true }
    } finally {
      await fs.promises.rm(archiveDir, { recursive: true, force: true })
    }
  }

  // `git commit -a` names WHICH FILES, not where the commit goes. It selects
  // tracked modifications and deletions plus whatever is already staged — and it
  // also moves HEAD and the branch, which is the person's to move.
  //
  // So we compose that same selection in a temporary GIT_INDEX_FILE and write a
  // commit object with `commit-tree`. Their real index is never written, their
  // branch never advances, and their tree stays dirty until they commit it
  // themselves. This is the shape `filteredProjectCommit` above already uses.
  //
  // The person's index is the starting point rather than HEAD, so paths they have
  // already staged are carried exactly as `commit -a` would carry them.
  async function settledCommit() {
    const head = await rev('HEAD')
    const indexPath = path.resolve(sourceDir, (await git(['rev-parse', '--git-path', 'index'])).stdout.trim())
    const tmpIndex = path.join(os.tmpdir(), `tlda-settle-${projectPart}-${process.pid}-${Date.now()}.index`)
    try {
      if (fs.existsSync(indexPath)) await fs.promises.copyFile(indexPath, tmpIndex)
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
      // `-u` is the untracked exclusion: `add -A -- .` swept every untracked file
      // in the checkout — scratch files, editor droppings, anything they had not
      // chosen to track — into the commit and into their index besides. The cost
      // is stated rather than discovered: a NEW file is not submitted until the
      // author `git add`s it.
      // No `-- .` pathspec. In a repository with nothing tracked, `git add -u -- .`
      // fails the pathspec outright — "did not match any file(s) known to git",
      // exit 128 — while bare `git add -u` exits 0 and stages nothing, which is
      // what lets the EMPTY_TREE guard below produce an honest refusal.
      //
      // That matters because settle's throw is caught at git-sync-manager.mjs:97
      // and logged at warn, so the crash is silent. And a repository with no
      // commits is an ordinary state here, not an error: it is what ensureRepo()
      // leaves behind, and what a person's freshly `git init`ed checkout is.
      // In a working tree the app owns there is no author to stage anything, so
      // `-A`. Getting this wrong in the direction of `-u` everywhere loses a
      // document created in the browser: nothing there is ever tracked, so the
      // settle produces no commit and the document reaches the store never.
      //
      // `-A` here is not a hole in the territory rule. That rule is about a
      // repository someone else owns; this branch only runs where the app is the
      // only writer.
      await git(['add', '-u'], { env })
      const tree = (await git(['write-tree'], { env })).stdout.trim()
      // An empty answer is not a tree, and passing it on produces `git
      // commit-tree  -m ...` with the argument silently missing — which is what
      // reached the log as `proposal failed: Command failed: git commit-tree  -m
      // tlda settled edit cluster`, a message that names the wrapper and hides
      // that its input was blank. `write-tree` returns nothing when the index it
      // was pointed at is unreadable, which happens when something else is
      // rewriting the real index as this copies it.
      if (!/^[0-9a-f]{40}$/.test(tree)) {
        throw new Error(`${project}: write-tree produced no tree id (${JSON.stringify(tree)}) — the staged index was unreadable, so nothing was committed`)
      }
      if (head && (await git(['rev-parse', `${head}^{tree}`])).stdout.trim() === tree) return head
      if (!head && tree === EMPTY_TREE) return null
      const args = ['commit-tree', tree, '-m', 'tlda settled edit cluster']
      if (head) args.push('-p', head)
      return (await git(args)).stdout.trim()
    } finally {
      await fs.promises.rm(tmpIndex, { force: true })
    }
  }

  async function commitSettledTree() {
    const conflicts = await unresolved()
    if (conflicts.length) return { ok: false, status: 'conflicted', conflicted: conflicts }
    // A merge the PERSON started is theirs to finish, and MERGE_HEAD is theirs too.
    if (await rev('MERGE_HEAD')) return { ok: false, status: 'merge-in-progress' }
    const settled = await settledCommit()
    if (!settled) return { ok: false, status: 'empty-checkout' }
    const filtered = await filteredProjectCommit(settled)
    // The chain gets the projection; the BRANCH gets the person's real tree.
    // These were one ref, and the branch held the projection — a subset of the
    // author's tracked files, which is why it could not be stood on. settle()
    // has already established that HEAD is this branch, so moving it to a commit
    // parented on HEAD is a fast-forward and the working tree goes CLEAN: the
    // author's edits are now committed under them, which is the whole design.
    await git(['update-ref', localRef, filtered.commit])
    await git(['update-ref', workBranchRef, settled])
    // Bring the author's index up to the commit we just made under them.
    //
    // settledCommit stages into a COPY of their index, deliberately, so that
    // settling never disturbs what they have staged. The consequence is that
    // after the branch moves, their real index still holds the pre-edit blob:
    // index differs from HEAD and the working tree differs from the index, so
    // `git status` reports `MM` and `git checkout` still refuses. Moving the
    // branch without this leaves the checkout exactly as unusable as before,
    // which is the entire symptom — caught by the property test, not by reading.
    //
    // `reset --mixed` and nothing else: it rewrites the index to HEAD and does
    // not touch the working tree, so no edit of theirs is at risk. Nothing
    // tracked is lost because the commit it resets to is the one that just
    // captured the whole tracked tree, and untracked files are outside what
    // `--mixed` looks at.
    //
    // Only when HEAD really is this branch. settle() guarantees that for a
    // person's checkout, but the app-owned working tree is exempt from that gate
    // and may be sitting anywhere, and resetting an index against a branch the
    // tree is not on would be a corruption rather than a repair.
    if (await currentBranchRef() === workBranchRef) await git(['reset', '-q', '--mixed'])
    if (filtered.dropped.length) {
      log.warn?.(`${project}: not in the revision — tracked, but no document root reaches them: ${filtered.dropped.join(', ')}`)
    }
    return { ok: true, revision: filtered.commit, changed: filtered.changed, roots: filtered.roots, members: filtered.members, dropped: filtered.dropped }
  }

  // `members` rides along so the caller can say WHO edited. The daemon knows --
  // jsonl-ingestor records every agent Edit/Write/MultiEdit and `resolveEditor`
  // answers "who touched these paths recently" -- but the answer needs the paths,
  // and this is the only place that has both the revision and its file list.
  //
  // Optional because `recover()` also pushes, and a revision recovered at startup
  // has no edit cluster behind it to attribute.
  /**
   * Combine the accepted head with our revision WITHOUT touching this
   * repository's checkout, index, or branches.
   *
   * `merge-tree --write-tree` merges two commits entirely in the object
   * database: it writes a tree and prints its id, and it reads nothing from the
   * working tree and writes nothing to it or to the index. That is what makes
   * it usable here at all -- `d60d18573` removed five mutations of a repository
   * the app does not own, and none of them may come back.
   *
   * Exit 0 means a clean merge; exit 1 means a real conflict, and the stdout
   * carries the conflicted paths. That distinction is why this uses the
   * `--write-tree` form and not the legacy one, which prints `changed in both`
   * for any file both sides touched -- a report that is not about conflicts at
   * all and reads as one.
   */
  async function combineWithAcceptedHead(accepted, revision) {
    try {
      const result = await git(['merge-tree', '--write-tree', accepted, revision])
      const tree = String(result.stdout || '').trim().split('\n')[0]
      // THROWN, never returned as a conflict. Exit 0 means git merged the two
      // cleanly, so output that is not a tree id is this code being wrong --
      // a bad invocation, a git that does not support `--write-tree`, a stubbed
      // runner. Returning it as `ok: false` let `pushRevision` label it
      // `conflict-held`, which tells the person their collaborator's edit
      // conflicts with theirs when nothing of the kind happened. An
      // implementation failure must never be reported as a fact about two
      // authors, and that is the same rule as the exit-code check below.
      if (!/^[0-9a-f]{40}$/.test(tree)) {
        throw new Error(`merge-tree reported success but wrote no tree for ${accepted.slice(0, 7)}+${revision.slice(0, 7)}: ${JSON.stringify(tree.slice(0, 80))}`)
      }
      return { ok: true, tree }
    } catch (error) {
      // Exit 1 is the answer "these genuinely conflict", not a failure to run.
      // Anything else is a broken invocation and must not be reported as a
      // conflict -- that would turn a bug in this code into a story about the
      // two authors.
      if (error?.code !== 1) throw error
      const lines = String(error.stdout || '').split('\n')
      const conflicted = [...new Set(lines
        .map(line => line.match(/^\d{6} [0-9a-f]{40} [123]\t(.+)$/))
        .filter(Boolean)
        .map(match => match[1]))]
      return { ok: false, conflicted }
    }
  }

  async function pushRevision(revision, { forceRebuild = false, members = null, combined = false } = {}) {
    const proposalRef = `refs/tlda/proposals/${daemonPart}/${branchPart}/${revision}`
    try {
      const result = await git(['push', '--porcelain', remote, `${revision}:${proposalRef}`])
      const submitted = { status: 'SubmittedToBuildQueue', revision, proposalRef, output: `${result.stdout || ''}${result.stderr || ''}` }
      await onSubmitted({ ...submitted, forceRebuild, members })
      return { ok: true, ...submitted }
    } catch (error) {
      const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`
      const match = output.match(/WrongHead\s+([0-9a-f]{40})/i)
      if (!match) throw error

      // Park the accepted head first. This is unchanged: the person's checkout
      // is not moved onto it, it simply becomes reachable at fetchedRef.
      await headChanged(match[1])

      // ONE attempt, never a loop. If a proposal built on the accepted head is
      // ALSO rejected, the head moved again while we were working, and the next
      // edit cluster will settle it. Retrying here would spin against a project
      // somebody else is actively pushing to.
      if (combined) return { ok: false, status: 'WrongHead', head: match[1], revision }

      const accepted = (await rev(fetchedRef)) || match[1]
      const merge = await combineWithAcceptedHead(accepted, revision)
      if (!merge.ok) {
        // HELD, and named as what it is. Both sides are recoverable: the
        // person's work is their own commit on their branch, and the accepted
        // head is parked at fetchedRef. Nothing is discarded and no winner is
        // picked -- choosing one is not this code's decision to make.
        log.warn?.(`${project}: holding — the accepted source and this checkout both changed ${merge.conflicted?.join(', ') || 'the same content'}`)
        return {
          ok: false,
          status: 'conflict-held',
          head: accepted,
          revision,
          conflicted: merge.conflicted || [],
        }
      }

      // A two-parent commit whose tree is the combination. The accepted head is
      // a parent, so the server's ancestry rule is satisfied; our revision is
      // the other, so nothing of the person's is orphaned. It is created as a
      // loose object and pushed -- no local ref, no branch move, no checkout.
      const combinedRevision = (await git([
        'commit-tree', merge.tree, '-p', accepted, '-p', revision,
        '-m', `combine ${revision.slice(0, 7)} with accepted ${accepted.slice(0, 7)}`,
      ])).stdout.trim()
      return pushRevision(combinedRevision, { forceRebuild, members, combined: true })
    }
  }

  async function settle() {
    await adoptWorkBranch()
    // Skip, 2026-08-25: "if you have a daemon-managed branch checked out — it
    // commits, and pushes, and all that shit. otherwise it doesn't."
    //
    // It used to commit and push regardless, to a branch the author was not
    // standing on. That is what left every checkout permanently dirty against
    // its own HEAD, and it is not a smaller version of the right behaviour — it
    // is the thing that made the branch useless.
    //
    // Declined LOUDLY and by name. A sync that quietly stops is the failure this
    // whole area is made of, so the reason travels back to the caller instead of
    // being a silent no-op.
    // The rule is about a PERSON's checkout — "if you have a daemon-managed
    // branch checked out". `.source-room/working` is the app's own tree, created
    // by ensureRepo with nobody standing in it, so there is no author to commit
    // under and nothing to be dirty against. Gating it would stop the browser
    // source editor's path outright, which is the opposite of the repair.
    const head = await currentBranchRef()
    if (head !== workBranchRef) {
      return {
        ok: false,
        status: 'not-on-work-branch',
        head,
        workBranch: workBranchRef,
        reason: `${project} is not syncing because this checkout is on ${head || 'a detached HEAD'} rather than its work branch tlda/${projectPart}. Run \`git checkout tlda/${projectPart}\` to sync.`,
      }
    }
    const committed = await commitSettledTree()
    if (!committed.ok) return committed
    const shared = await rev(fetchedRef) || await rev(appliedRef)
    if (shared) {
      const [oursTree, sharedTree] = await Promise.all([
        git(['rev-parse', `${committed.revision}^{tree}`]),
        git(['rev-parse', `${shared}^{tree}`]),
      ])
      if (oursTree.stdout.trim() === sharedTree.stdout.trim()) return { ok: true, status: 'equal-tree', revision: committed.revision, dropped: committed.dropped }
    }
    // A push that reports success has to report what it left out in the same
    // breath, so `dropped` rides every settle result a caller can reach.
    return { ...(await pushRevision(committed.revision, { members: committed.members })), dropped: committed.dropped }
  }

  async function submitCurrent(options = {}) {
    const committed = await commitSettledTree()
    if (!committed.ok) return committed
    return { ...(await pushRevision(committed.revision, options)), dropped: committed.dropped }
  }

  async function fetchHead(expected = null) {
    try {
      await git(['fetch', '--no-tags', remote, `+${sharedRef}:${fetchedRef}`])
    } catch (error) {
      const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`
      if (!output.includes(`couldn't find remote ref ${sharedRef}`)) throw error
      await git(['update-ref', '-d', fetchedRef])
      return null
    }
    const revision = await rev(fetchedRef)
    if (!revision) throw new Error(`${project}: shared head was not fetched`)
    if (expected && revision !== expected) log.info?.(`${project}: announced ${expected.slice(0, 7)}, fetched ${revision.slice(0, 7)}`)
    await onMirrorArrived({ project, revision })
    return revision
  }

  // The accepted revision is PARKED, not applied. `fetchHead` has already put it
  // at `refs/tlda/fetched/<project>`, which is app territory and reachable, and
  // that is the whole obligation: the person can see it, diff it, and merge it
  // with their own git whenever they choose to.
  //
  // What used to happen here instead: the person's dirty tree was committed
  // unasked, `checkout --force -B <branch>` moved and checked out their branch, a
  // synthetic bridge commit was written onto their HEAD, and fetched server
  // history was merged into their checkout — which left an unresolved merge in
  // it whenever the two diverged. Local is authoritative. Divergence is theirs to
  // resolve, and it does not stop the project working.

  /**
   * Advance the work branch to the accepted head, but ONLY where doing so
   * cannot lose anything.
   *
   * Everything above about parking still holds for every other case. What it
   * left behind is that a browser edit reaches the server, is fetched into this
   * very checkout, and then sits there. Measured on `apptester-sync3`:
   * `refs/tlda/fetched/<p>` contained the edit while the working branch and the
   * disk did not. Nothing was missing and no refspec was wrong — it was fetched
   * and unapplied.
   *
   * Four conditions, and each protects something specific:
   *
   *   on the work branch    a checkout parked elsewhere is somebody standing in
   *                         their own history; not ours to move.
   *   HEAD is an ancestor   no divergence, so no merge is possible and nothing
   *                         of theirs is behind us.
   *   no tracked changes    their edits are never committed unasked, which is
   *                         the exact damage the note above records.
   *   not already there     nothing to do.
   *
   * `merge --ff-only` is the primitive because **it refuses anything that is not
   * a fast-forward**, so git independently re-checks the conclusion reached
   * here. It creates no commit, synthesizes no history, forces no checkout, and
   * cannot conflict: on a fast-forward the branch pointer and the tree move
   * together. If any condition fails this returns false and the revision stays
   * parked exactly as it was.
   */
  async function fastForwardToAcceptedHead(fetched) {
    if (await currentBranchRef() !== workBranchRef) return false
    // NEVER ONTO OUR OWN PROJECTION. When this daemon's push is accepted, the
    // head that comes back is the FILTERED projection we just published —
    // `refs/tlda/project/<p>` — which contains only the document closure and is
    // "not a tree anyone can stand on". Fast-forwarding onto it would quietly
    // reparent the person's branch onto a filtered view of their own work and
    // drop everything the closure leaves out. Caught by
    // `git-project-sync.test.mjs`, which asserts this exact sequence still parks.
    //
    // The point of advancing is to take in work that arrived from SOMEWHERE
    // ELSE, which is never equal to what we just published.
    if (fetched === await rev(localRef)) return false
    const head = await rev('HEAD')
    if (!head || head === fetched) return false
    if (!(await isAncestor(head, fetched))) return false
    // Staged AND unstaged, against HEAD. Untracked files are deliberately not
    // counted: they are not part of the project's history, and a fast-forward
    // does not touch them.
    try {
      await git(['diff', '--quiet', 'HEAD'])
    } catch {
      return false
    }
    await git(['merge', '--ff-only', fetched])
    return true
  }

  async function headChanged(revision = null) {
    const fetched = await fetchHead(revision)
    if (!fetched) return { ok: true, status: 'no-shared-head', revision: null }
    if (await fastForwardToAcceptedHead(fetched)) {
      return { ok: true, status: 'advanced', revision: fetched }
    }
    // An app-owned working tree is a VIEW of the project's source, not a history
    // of its own. It is created by `git init` with no commits, so a commit built
    // on its HEAD descends from nothing the server knows, and the pre-receive
    // check in server/lib/git-proposals.mjs -- "is the project head an ancestor
    // of this proposal" -- rejects every one of them with WrongHead.
    //
    // That rejection is silent all the way up: pushRevision matches WrongHead and
    // returns it as a VALUE rather than throwing, settle passes the value on, and
    // git-sync-manager's onSettled discards the return. No log, no retry, no state
    // change -- the source room sits at `queued` with lastError null forever, which
    // is what "editing in the app produces no build and no version" was.
    //
    // Moving HEAD is enough and is all that is wanted: the tree comes from
    // `git add -A` over the working directory, so the room's content is untouched
    // and only the parent changes. A person-owned checkout keeps its own history
    // and is deliberately not reparented here.
    return { ok: true, status: 'observed', revision: fetched }
  }

  function serialized(fn) {
    const run = () => fn()
    chain = chain.then(run, run)
    return chain
  }

  async function recover() {
    await adoptWorkBranch()
    const conflicts = await unresolved()
    if (conflicts.length) return { ok: false, status: 'conflicted', conflicted: conflicts }
    const fetched = await rev(fetchedRef)
    const local = await rev(localRef)
    if (local && (!fetched || !(await isAncestor(local, fetched)))) return pushRevision(local)
    // Not `applied || fetched || local`. Every write to refs/tlda/applied/<binding>
    // was inside the accept path, so it never advances again — reporting it as the
    // current revision would report a fossil. Existing values are left alone on
    // disk: stopped writing, did not remove.
    return { ok: true, status: 'current', revision: local || fetched }
  }

  /**
   * Put this checkout on its work branch, so the daemon commits under the author.
   *
   * Called at link. Nothing else moved a checkout onto the branch, which is why
   * every checkout on this machine was standing somewhere the daemon never wrote.
   *
   * Three cases, and the middle one is the migration:
   *
   *   no branch yet          `checkout -b` — creates it at HEAD. The working
   *                          tree is not touched at all, so this cannot lose an
   *                          edit, staged or not.
   *   branch IS the chain    the old rename: the branch is the filtered
   *                          projection, which is not a tree anyone can stand on.
   *                          `-B` resets it to HEAD. Safe only because
   *                          adoptWorkBranch has just carried that history onto
   *                          `revisionRef`, so nothing becomes unreachable — the
   *                          equality below is what proves it is that history.
   *   branch is real work    an ordinary `checkout`. If git refuses, the person
   *                          has something here we must not overwrite, so the
   *                          refusal is reported verbatim rather than forced.
   */
  async function standOnWorkBranch() {
    const adopted = await adoptWorkBranch()
    if (!adopted?.ok) return { ok: false, status: adopted?.reason || 'adoption-failed', branch: workBranchRef }
    const head = await currentBranchRef()
    if (head === workBranchRef) return { ok: true, status: 'already-on-it', branch: workBranchRef }
    const shortBranch = `tlda/${projectPart}`
    const branchTip = await rev(workBranchRef)
    try {
      if (!branchTip) {
        // A tree with NO COMMITS AT ALL is a fresh checkout of this project, and
        // a fresh checkout of a project starts at the project's head -- that is
        // what cloning it would give you. Creating the branch at nothing instead
        // produces an empty tree, and settle then refuses it as `empty-checkout`.
        //
        // This is the source editor's case: its tree is created empty and it is
        // another daemon like any other, so it gets the project the same way a
        // person's clone would. Narrowed to the no-commits case on purpose -- a
        // person's checkout that already has history keeps starting the branch
        // from their own HEAD, which is what they would expect.
        const hasCommits = await rev('HEAD')
        // No flag, and no caller opting in. A checkout with no commits is a
        // fresh checkout of this project, and a fresh checkout of a project
        // starts at the project's head -- that is simply what checking a
        // project out means, for the editor and for a person alike.
        //
        // It does not change linking a NEW directory as a new project: there is
        // no project head yet, so this resolves to null and the branch is
        // unborn exactly as before.
        //
        // ASK FOR THE HEAD BEFORE READING IT. `fetchedRef` is a local ref that
        // only exists once something has fetched, and on a brand-new source room
        // nothing has yet -- `ensureRepo` does `git init` and stops. So this read
        // returned null for exactly the case the paragraph above is about, the
        // branch was born empty, and the room's first commit was a ROOT commit
        // unrelated to the project. Every later proposal was then rejected
        // `WrongHead`, and `combineWithAcceptedHead` could not rescue it either:
        // `merge-tree` on unrelated histories exits 128, which `pushRevision`
        // rethrows, so the settle died after the caller had already been told
        // `202 queued`. Measured on deployed 594900c02.
        //
        // Fetching here costs one call on the no-commits path only, and it is
        // the same call `settle` makes anyway. It cannot invent a head: for a
        // genuinely new project the shared ref does not exist, `fetchHead`
        // answers null, and the branch is unborn exactly as before.
        if (!hasCommits) { try { await fetchHead() } catch { /* no shared head yet: the branch is unborn, as before */ } }
        const projectHead = hasCommits ? null : (await rev(fetchedRef)) || (await rev(revisionRef))
        if (projectHead) await git(['checkout', '-b', shortBranch, projectHead])
        else await git(['checkout', '-b', shortBranch])
      }
      else if (branchTip === await rev(revisionRef)) await git(['checkout', '-B', shortBranch])
      else await git(['checkout', shortBranch])
    } catch (error) {
      return {
        ok: false,
        status: 'checkout-refused',
        branch: workBranchRef,
        head,
        reason: `${project} could not be moved onto ${shortBranch}: ${(error.stderr || error.message || '').trim()}`,
      }
    }
    return { ok: true, status: 'moved', branch: workBranchRef, from: head }
  }

  async function members() {
    await adoptWorkBranch()
    const revision = await rev(localRef) || await rev(appliedRef) || await rev(fetchedRef)
    if (!revision) return []
    return (await git(['ls-tree', '-r', '--name-only', revision])).stdout.split('\n').filter(Boolean)
  }

  return {
    // appliedRef is not exported. Nothing writes it any more, so publishing the
    // name invites a reader that would be reading a fossil. The refs themselves
    // stay on disk in people's checkouts, untouched.
    // `localRef` no longer moves — it is the revision chain and keeps its own
    // name for the life of the runtime, which is the whole point of the split
    // above. The getter stays because callers destructure it and a plain object
    // reads the same; `workBranchRef` joins it so a caller can name the person's
    // branch without rebuilding the string.
    get refs() { return { localRef, revisionRef, workBranchRef, sharedRef, fetchedRef } },
    editClusterSettled: () => serialized(settle),
    standOnWorkBranch: () => serialized(standOnWorkBranch),
    submitCurrent: options => serialized(() => submitCurrent(options)),
    headChanged: revision => serialized(() => headChanged(revision)),
    recover: () => serialized(recover),
    members: () => serialized(members),
    setDocumentRoots,
    fetchHead,
    pushRevision,
  }
}
