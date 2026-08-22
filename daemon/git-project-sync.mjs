import { execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { scanTexDependencyClosure } from '../shared/tex-deps.mjs'
import { scanMarkdownDependencyClosure } from '../shared/markdown-deps.mjs'

const execFile = promisify(execFileCb)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export function safeRefPart(value) {
  const part = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!part || part.startsWith('.') || part.endsWith('.')) throw new Error(`invalid ref component: ${value}`)
  return part
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
  onWrongHead = () => {},
  onMirrorArrived = () => {},
  runGit = null,
} = {}) {
  if (!sourceDir || !project || !daemonId || !bindingId) throw new Error('sourceDir, project, daemonId, and bindingId are required')
  const projectPart = safeRefPart(project)
  const daemonPart = safeRefPart(daemonId)
  const branchPart = safeRefPart(branch)
  const bindingPart = safeRefPart(bindingId)
  const localRef = `refs/tlda/project/${projectPart}`
  const appliedRef = `refs/tlda/applied/${bindingPart}`
  const sharedRef = `refs/tlda/source/${projectPart}`
  const fetchedRef = `refs/tlda/fetched/${projectPart}`
  let chain = Promise.resolve()
  let configuredRoots = []
  function setDocumentRoots(values = []) {
    configuredRoots = [...new Set(values.map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean))]
  }
  setDocumentRoots(documentRoots)

  async function git(args, options = {}) {
    if (runGit) return runGit(args, options)
    return execFile('git', args, { cwd: sourceDir, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options })
  }

  async function rev(ref) {
    try { return (await git(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim() } catch { return null }
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
      const paths = (await git(['ls-tree', '-r', '--name-only', workingCommit])).stdout.split('\n').filter(Boolean)
      const candidates = configuredRoots.length
        ? configuredRoots
        : paths.filter(file => /\.(?:tex|md|qmd)$/i.test(file))
      if (!candidates.length) throw new Error(`${project}: no document roots in settled tree`)
      for (const candidate of candidates) {
        if (!paths.includes(candidate)) throw new Error(`${project}: configured document root is absent: ${candidate}`)
      }
      const closures = new Map()
      for (const candidate of candidates) {
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
            if (/\.(?:tex|md|qmd)$/i.test(file) && !scanned.has(file)) pending.push(file)
          }
          missing.push(...closure.missing)
        }
        if (missing.length) throw new Error(`${project}: ${candidate} has missing dependencies: ${missing.map(item => item.path).join(', ')}`)
        closures.set(candidate, files)
      }
      const pulled = new Set()
      for (const [candidate, files] of closures) {
        for (const other of candidates) if (other !== candidate && files.has(other)) pulled.add(other)
      }
      const roots = candidates.filter(candidate => !pulled.has(candidate))
      if (!roots.length) throw new Error(`${project}: document dependency graph contains a cycle`)
      const members = new Set(roots.flatMap(root => [...closures.get(root)]))
      const index = path.join(archiveDir, 'index')
      const env = { ...process.env, GIT_INDEX_FILE: index }
      await git(['read-tree', '--empty'], { env })
      for (const member of [...members].sort()) {
        const line = (await git(['ls-tree', workingCommit, '--', member])).stdout.trim()
        if (!line) throw new Error(`${project}: immutable closure member is absent: ${member}`)
        const match = line.match(/^(\d+)\s+\w+\s+([0-9a-f]{40})\t(.+)$/)
        if (!match) throw new Error(`${project}: could not read tree entry for ${member}`)
        await git(['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${match[3]}`], { env })
      }
      const tree = (await git(['write-tree'], { env })).stdout.trim()
      // Fetched server history is never proposal ancestry. This chain used to
      // fall through to the fetched and applied refs, so on a FIRST sync — when
      // localRef does not exist yet — the app's own project commit was parented
      // on the server's revision, with no merge involved anywhere. A first
      // revision with no local ancestor is a root commit instead; the person's
      // own workingCommit is already a parent candidate below.
      const parent = await rev(localRef)
      if (parent && (await git(['rev-parse', `${parent}^{tree}`])).stdout.trim() === tree) return { commit: parent, tree, roots, members: [...members], changed: false }
      const args = ['commit-tree', tree, '-m', 'tlda project revision']
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
      return { commit, tree, roots, members: [...members], changed: true }
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
      await git(['add', '-u', '--', '.'], { env })
      const tree = (await git(['write-tree'], { env })).stdout.trim()
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
    await git(['update-ref', localRef, filtered.commit])
    return { ok: true, revision: filtered.commit, changed: filtered.changed, roots: filtered.roots, members: filtered.members }
  }

  async function pushRevision(revision, { forceRebuild = false } = {}) {
    const proposalRef = `refs/tlda/proposals/${daemonPart}/${branchPart}/${revision}`
    try {
      const result = await git(['push', '--porcelain', remote, `${revision}:${proposalRef}`])
      const submitted = { status: 'SubmittedToBuildQueue', revision, proposalRef, output: `${result.stdout || ''}${result.stderr || ''}` }
      await onSubmitted({ ...submitted, forceRebuild })
      return { ok: true, ...submitted }
    } catch (error) {
      const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`
      const match = output.match(/WrongHead\s+([0-9a-f]{40})/i)
      if (!match) throw error
      const wrong = { ok: false, status: 'WrongHead', head: match[1], revision }
      await onWrongHead(wrong)
      await headChanged(match[1])
      return wrong
    }
  }

  async function settle() {
    const committed = await commitSettledTree()
    if (!committed.ok) return committed
    const shared = await rev(fetchedRef) || await rev(appliedRef)
    if (shared) {
      const [oursTree, sharedTree] = await Promise.all([
        git(['rev-parse', `${committed.revision}^{tree}`]),
        git(['rev-parse', `${shared}^{tree}`]),
      ])
      if (oursTree.stdout.trim() === sharedTree.stdout.trim()) return { ok: true, status: 'equal-tree', revision: committed.revision }
    }
    return pushRevision(committed.revision)
  }

  async function submitCurrent(options = {}) {
    const committed = await commitSettledTree()
    if (!committed.ok) return committed
    return pushRevision(committed.revision, options)
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
  async function headChanged(revision = null) {
    const fetched = await fetchHead(revision)
    if (!fetched) return { ok: true, status: 'no-shared-head', revision: null }
    return { ok: true, status: 'observed', revision: fetched }
  }

  function serialized(fn) {
    const run = () => fn()
    chain = chain.then(run, run)
    return chain
  }

  async function recover() {
    const conflicts = await unresolved()
    if (conflicts.length) return { ok: false, status: 'conflicted', conflicted: conflicts }
    const fetched = await rev(fetchedRef)
    const applied = await rev(appliedRef)
    const local = await rev(localRef)
    if (local && fetched && !(await isAncestor(local, fetched)) && !(await isAncestor(fetched, local))) {
      // Diverged: local holds work the shared head does not, and the shared head
      // holds work local does not. Resubmitting local here would propose it OVER
      // the accepted revision and move the shared head backwards, losing an edit
      // that was already accepted.
      //
      // Parking is the same answer headChanged gives. The accepted revision stays
      // reachable at the fetched ref, local stays authoritative in the checkout,
      // and the person reconciles the two. Nothing is merged and nothing is lost.
      return { ok: true, status: 'diverged', revision: fetched, localRevision: local }
    }
    if (local && (!fetched || !(await isAncestor(local, fetched)))) return pushRevision(local)
    return { ok: true, status: 'current', revision: applied || fetched || local }
  }

  async function members() {
    const revision = await rev(localRef) || await rev(appliedRef) || await rev(fetchedRef)
    if (!revision) return []
    return (await git(['ls-tree', '-r', '--name-only', revision])).stdout.split('\n').filter(Boolean)
  }

  return {
    refs: { localRef, appliedRef, sharedRef, fetchedRef },
    editClusterSettled: () => serialized(settle),
    submitCurrent: options => serialized(() => submitCurrent(options)),
    headChanged: revision => serialized(() => headChanged(revision)),
    recover: () => serialized(recover),
    members: () => serialized(members),
    fetchHead,
    pushRevision,
    setDocumentRoots,
  }
}
