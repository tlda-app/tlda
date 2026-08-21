import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { scanTexDependencyClosure } from '../shared/tex-deps.mjs'
import { scanMarkdownDependencyClosure } from '../shared/markdown-deps.mjs'

const execFileP = promisify(execFile)

// The ref mirrorShadowRef maintains in the working copy: the tip of this
// project's mirrored version history.
const SHADOW_HEAD_REF = 'refs/tlda/shadow/HEAD'

async function gitRetryOnLock(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i < retries - 1 && /index\.lock|Unable to create.*lock|cannot lock ref|unable to update local ref/i.test(e.message || '')) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        continue
      }
      throw e
    }
  }
}

export function createShadowMirror({ getSourceDir, log, beforePreserveUpdateRef = null }) {
  async function mirrorShadowRef({ project, hash, bundleBase64, sourceScope, sourceRevision, acceptSeq, refusedRevision = null }) {
    if (!project) throw new Error('missing project')
    if (!/^[0-9a-f]{40}$/i.test(String(hash || ''))) throw new Error(`invalid shadow hash: ${hash}`)
    if (!bundleBase64) throw new Error('missing shadow bundle')

    const sourceDir = getSourceDir(project)
    if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)

    try {
      await execFileP('git', ['rev-parse', '--git-dir'], { cwd: sourceDir, timeout: 5000 })
    } catch {
      throw new Error(`sourceDir is not a git repo: ${sourceDir}`)
    }

    const hash7 = hash.slice(0, 7)
    const bundlePath = path.join(os.tmpdir(), `tlda-shadow-${project}-${hash7}-${Date.now()}.bundle`)
    try {
      fs.writeFileSync(bundlePath, Buffer.from(bundleBase64, 'base64'))
      await execFileP('git', ['bundle', 'verify', bundlePath], { cwd: sourceDir, timeout: 10000 })
      await gitRetryOnLock(() => execFileP('git', ['fetch', bundlePath, `+${hash}:refs/tags/shadow/${hash7}`], { cwd: sourceDir, timeout: 30000 }))
      await execFileP('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: sourceDir, timeout: 5000 })
      const preservation = await preserveAuthorCommit({ sourceDir, project, hash, sourceScope, log, beforeUpdateRef: beforePreserveUpdateRef })
      await gitRetryOnLock(() => execFileP('git', ['update-ref', 'refs/tlda/shadow/HEAD', hash], { cwd: sourceDir, timeout: 5000 }))
      // A push the server refused is carried in the same bundle, and it gets a
      // ref here for one reason: so the person who made it can see it. Without
      // one it is an unreachable commit — not lost, but invisible to them and
      // one `git gc` from actually being lost.
      //
      // It is deliberately NOT merged, applied, or offered as a choice. The
      // refusal stands; this is `git diff HEAD refs/tlda/refused/HEAD` existing
      // at all, instead of their work sitting in a rejection payload on a
      // server where the one person who can fix it cannot look at it.
      let refused = null
      if (refusedRevision && /^[0-9a-f]{40}$/i.test(String(refusedRevision))) {
        try {
          // Fetched separately, because it is a SIBLING of the accepted commit
          // rather than an ancestor: the fetch above carries only what is
          // reachable from the head, so a refused push is in the bundle's
          // objects and reachable from nothing. Naming it in its own refspec is
          // what actually brings it across.
          await gitRetryOnLock(() => execFileP('git', ['fetch', bundlePath, `+${refusedRevision}:refs/tlda/refused/HEAD`], { cwd: sourceDir, timeout: 30000 }))
          refused = refusedRevision
        } catch (e) {
          // Never let this cost the mirror. The accepted revision reaching their
          // checkout is the thing that matters; a pointer to a refused one is
          // strictly extra, and failing the whole checkpoint over it would
          // trade the important half for the informative half.
          log.warn(`could not record refused ${project}@${String(refusedRevision).slice(0, 7)}: ${e.message}`)
        }
      }

      log.info(`mirrored ${project}@${hash7} into ${sourceDir}`)
      return { ok: true, project, hash, sourceRevision, acceptSeq, sourceDir, tag: `shadow/${hash7}`, preservation, refused }
    } finally {
      try {
        fs.rmSync(bundlePath, { force: true })
      } catch (e) {
        // Temporary bundle cleanup must not mask the mirror result.
        log.warn(`failed to remove temporary shadow bundle ${bundlePath}: ${e.message}`)
      }
    }
  }

  /**
   * The other direction. `mirrorShadowRef` writes the server's history into the
   * working copy on every build; this reads it back out, so a server that has
   * no history for a project can get it from the machine that does.
   *
   * That is what makes a project movable. A move re-links the paper to another
   * environment, and the new server starts with no history — but the working
   * copy has been accumulating it all along, under refs this daemon wrote. The
   * daemon pushes that history through the canonical authenticated Git HTTP
   * repository before it asks the server to promote the immutable ref.
   *
   * Returns `{ empty: true }` rather than throwing when the working copy holds
   * no shadow history: a paper that has never been built has none, and that is
   * an ordinary state, not a failure.
   */
  async function prepareHistorySeed({ project, sourceDir: explicitSourceDir = null, seedBranch = null, seedRevision = 'HEAD', documentRoots = [] }) {
    if (!project) throw new Error('missing project')
    // The caller may name the directory instead of letting us resolve it. A link
    // pushes this history BEFORE it writes the binding — so that a failed push
    // leaves nothing behind — and at that moment there is no binding to resolve.
    const sourceDir = explicitSourceDir || getSourceDir(project)
    if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)

    let head
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--verify', SHADOW_HEAD_REF], { cwd: sourceDir, timeout: 5000 })
      head = stdout.trim()
    } catch {
      return prepareProjectHistorySeed({ project, sourceDir, seedBranch, seedRevision, documentRoots, log })
    }
    if (!/^[0-9a-f]{40}$/i.test(head)) return { ok: true, empty: true, project, sourceDir }
    return { ok: true, empty: false, project, sourceDir, head, repositoryDir: sourceDir, cleanup: async () => {} }
  }

  return { mirrorShadowRef, prepareHistorySeed }
}

export async function prepareProjectHistorySeed({ project, sourceDir, seedBranch = null, seedRevision = 'HEAD', documentRoots = [], log = console }) {
  const roots = [...new Set(documentRoots.map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean))]
  if (!roots.length) return { ok: true, empty: true, project, sourceDir }

  const { stdout: seedOut } = await execFileP('git', ['rev-parse', '--verify', `${seedRevision}^{commit}`], { cwd: sourceDir, timeout: 5000 })
  const seed = seedOut.trim()
  if (seedBranch) {
    const { stdout: branchOut } = await execFileP('git', ['rev-parse', '--verify', `${seedBranch}^{commit}`], { cwd: sourceDir, timeout: 5000 })
    const branch = branchOut.trim()
    try {
      await execFileP('git', ['merge-base', '--is-ancestor', seed, branch], { cwd: sourceDir, timeout: 5000 })
    } catch {
      throw new Error(`${project}: ${seedRevision} is not on branch ${seedBranch}`)
    }
  }
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tlda-history-seed-${project}-`))
  const treeDir = path.join(workDir, 'tree')
  const filteredDir = path.join(workDir, 'filtered')
  const archivePath = path.join(workDir, 'tree.tar')
  try {
    await fs.promises.mkdir(treeDir)
    await execFileP('git', ['archive', '--format=tar', `--output=${archivePath}`, seed], { cwd: sourceDir, timeout: 60000 })
    await execFileP('tar', ['-xf', archivePath, '-C', treeDir], { timeout: 30000 })

    const members = new Set()
    for (const root of roots) {
      const closure = /\.tex$/i.test(root)
        ? scanTexDependencyClosure(root, treeDir)
        : /\.(?:md|markdown|qmd)$/i.test(root)
          ? scanMarkdownDependencyClosure(root, treeDir)
          : { files: [root], missing: fs.existsSync(path.join(treeDir, root)) ? [] : [{ path: root }] }
      if (closure.missing.length) {
        throw new Error(`${project}: ${root} has missing dependencies at ${seed.slice(0, 7)}: ${closure.missing.map(item => item.path).join(', ')}`)
      }
      for (const file of closure.files) members.add(file)
    }

    await execFileP('git', ['clone', '--no-local', '--no-checkout', '--', sourceDir, filteredDir], { timeout: 120000 })
    const refs = (await execFileP('git', ['for-each-ref', '--format=%(refname)'], { cwd: filteredDir, timeout: 10000 })).stdout.split('\n').filter(Boolean)
    for (const ref of refs) await execFileP('git', ['update-ref', '-d', ref], { cwd: filteredDir, timeout: 5000 })
    await execFileP('git', ['update-ref', 'refs/heads/main', seed], { cwd: filteredDir, timeout: 5000 })
    await execFileP('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: filteredDir, timeout: 5000 })
    const filterArgs = [...members].sort().flatMap(file => ['--path', file])
    await execFileP('git-filter-repo', [...filterArgs, '--force'], { cwd: filteredDir, timeout: 600000 })
    const { stdout: headOut } = await execFileP('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: filteredDir, timeout: 5000 })
    const head = headOut.trim()
    await execFileP('git', ['update-ref', SHADOW_HEAD_REF, head], { cwd: filteredDir, timeout: 5000 })
    log.info(`prepared ${project}@${head.slice(0, 7)} project history from ${seed.slice(0, 7)} (${members.size} member(s))`)
    return {
      ok: true, empty: false, project, sourceDir, head, seed, roots, members: [...members].sort(), repositoryDir: filteredDir,
      cleanup: () => fs.promises.rm(workDir, { recursive: true, force: true }),
    }
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true })
    throw error
  }
}

async function preserveAuthorCommit({ sourceDir, project, hash, sourceScope, log, beforeUpdateRef = null }) {
  const hash7 = hash.slice(0, 7)
  const { stdout: headRefRaw } = await execFileP('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: sourceDir, timeout: 5000 })
  const headRef = headRefRaw.trim()
  if (!headRef) throw new Error(`cannot preserve ${project}@${hash7}: source repo is detached`)

  const { stdout: baseRaw } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, timeout: 5000 })
  const base = baseRaw.trim()
  const scopedPaths = normalizeSourceScope(sourceScope, project, hash7)

  const entries = []
  for (const rel of scopedPaths) {
    const baseEntry = await treeEntryOrNull(sourceDir, base, rel)
    const shadowEntry = await treeEntryOrNull(sourceDir, hash, rel)
    if (entriesMatch(baseEntry, shadowEntry)) continue

    if (!shadowEntry) {
      // The scope is HISTORICAL: readShadowSourceScope unions every path that has
      // ever appeared in ANY commit of the shadow repo, then we compare it against
      // ONE commit. So a file that legitimately left the paper's build scope — an
      // input no longer \input{}, a scratch file the author keeps — is in scope,
      // absent from this shadow tree, and still present in the checkout.
      //
      // Throwing there aborts the whole checkpoint, so every OTHER file in the
      // build loses its preservation commit too, permanently and on every build.
      // balancing-act was stuck on `.scratchinputs/scratch-template.tex` from
      // 2026-07-20: tracked in HEAD, unmodified since May, and absent from a
      // shadow tree that carries no `.scratchinputs` at all.
      //
      // Skipping is strictly safer than throwing and preserves the guard's actual
      // purpose. The guard exists so we never stage the deletion of a file that
      // exists locally — and skipping does not stage it. The path simply keeps
      // whatever HEAD already had, which is the author's own file. We only record
      // a deletion when the working copy agrees the file is gone.
      if (fs.existsSync(path.join(sourceDir, rel))) {
        log.info(`preserve ${project}@${hash7}: ${rel} is outside this build's shadow tree but present locally; leaving it untouched`)
        continue
      }
      entries.push({ path: rel, deleted: true })
      continue
    }

    const localEntry = await worktreeEntry(sourceDir, rel)
    if (!localEntry) throw new Error(`cannot preserve ${project}@${hash7}: local ${rel} is missing`)
    if (localEntry.blob !== shadowEntry.blob) {
      // The author edited during the build, so the working copy no longer matches
      // what was rendered. That is the normal state of a paper someone is actively
      // writing, and it used to abort the entire checkpoint — which is why
      // eiv-paper had NEVER mirrored and balancing-act-jose stopped on 2026-08-04.
      //
      // Skip ruled on this directly, 2026-08-11 19:41:53 EDT, asked in plain terms
      // whether the saved snapshot should record the version that was built or
      // skip the file: "The version that was built, please."
      //
      // Recording it cannot touch their edit. This function commits through a TEMP
      // index (GIT_INDEX_FILE) via read-tree/update-index/write-tree/commit-tree,
      // then a compare-and-swap `update-ref <ref> <new> <base>`. Nothing writes the
      // working tree, and the CAS fails rather than clobbers if the branch moved.
      // Their newer text stays on disk and reads as an uncommitted modification,
      // which is the truth: they changed it after the build.
      //
      // validateTargetIndex still refuses separately when the author has STAGED a
      // conflicting change — that guard is untouched and still tested.
      log.info(`preserve ${project}@${hash7}: ${rel} changed after the build; recording the built version and leaving the working copy alone`)
    }
    if (localEntry.mode !== shadowEntry.mode) {
      throw new Error(`cannot preserve ${project}@${hash7}: local ${rel} mode ${localEntry.mode} differs from shadow ${shadowEntry.mode}`)
    }
    entries.push({ path: rel, mode: shadowEntry.mode, blob: shadowEntry.blob, deleted: false })
  }
  if (entries.length === 0) return { committed: false, reason: 'already preserved', files: [] }

  const tmpIndex = path.join(os.tmpdir(), `tlda-preserve-${project}-${hash7}-${process.pid}-${Date.now()}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
  try {
    await execFileP('git', ['read-tree', 'HEAD'], { cwd: sourceDir, env, timeout: 5000 })
    for (const entry of entries) {
      if (entry.deleted) {
        await execFileP('git', ['update-index', '--force-remove', '--', entry.path], { cwd: sourceDir, env, timeout: 5000 })
      } else {
        await execFileP('git', ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${entry.path}`], { cwd: sourceDir, env, timeout: 5000 })
      }
    }
    const { stdout: treeRaw } = await execFileP('git', ['write-tree'], { cwd: sourceDir, env, timeout: 5000 })
    const tree = treeRaw.trim()
    const { stdout: headTreeRaw } = await execFileP('git', ['rev-parse', 'HEAD^{tree}'], { cwd: sourceDir, timeout: 5000 })
    if (tree === headTreeRaw.trim()) return { committed: false, reason: 'already preserved', files: entries.map(e => e.path) }

    await validateTargetIndex(sourceDir, entries, { base, project, hash7 })
    const message = await preservationCommitMessage(sourceDir, hash)
    const commitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'tlda-preservation',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'tlda-preservation@local',
      GIT_COMMITTER_NAME: 'tlda-preservation',
      GIT_COMMITTER_EMAIL: 'tlda-preservation@local',
    }
    const { stdout: commitRaw } = await execFileP('git', ['commit-tree', tree, '-p', base, '-m', message], { cwd: sourceDir, env: commitEnv, timeout: 10000 })
    const commit = commitRaw.trim()
    if (beforeUpdateRef) await beforeUpdateRef({ sourceDir, project, hash, base, commit })
    await gitRetryOnLock(() => execFileP('git', ['update-ref', headRef, commit, base], { cwd: sourceDir, timeout: 5000 }))
    await refreshRealIndex(sourceDir, entries, { commit, project, hash7 })
    log.info(`preserved ${project}@${hash7} as ${commit.slice(0, 7)} on ${headRef}`)
    return { committed: true, commit, ref: headRef, files: entries.map(e => e.path) }
  } finally {
    try {
      fs.rmSync(tmpIndex, { force: true })
    } catch (e) {
      // Cleanup-only: the temporary index is not reused, so preserve the mirror result.
      log.warn(`failed to remove temporary preserve index ${tmpIndex}: ${e.message}`)
    }
  }
}

async function validateTargetIndex(sourceDir, entries, { base, project, hash7 }) {
  for (const entry of entries) {
    const staged = await indexEntry(sourceDir, entry.path)
    const baseEntry = await treeEntryOrNull(sourceDir, base, entry.path)
    const stagedMatchesBase = entriesMatch(staged, baseEntry)
    if (entry.deleted) {
      if (staged && !stagedMatchesBase) {
        throw new Error(`cannot preserve ${project}@${hash7}: staged ${entry.path} differs from shadow deletion`)
      }
    } else if (staged && !stagedMatchesBase && !entriesMatch(staged, entry)) {
      throw new Error(`cannot preserve ${project}@${hash7}: staged ${entry.path} differs from shadow`)
    }
  }
}

async function refreshRealIndex(sourceDir, entries, { commit, project, hash7 }) {
  const { stdout: headNowRaw } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, timeout: 5000 })
  if (headNowRaw.trim() !== commit) {
    throw new Error(`cannot refresh preserve index for ${project}@${hash7}: branch advanced concurrently`)
  }
  await updateIndexInfo(sourceDir, entries)
}

async function indexEntry(cwd, rel) {
  const { stdout } = await execFileP('git', ['ls-files', '-s', '-z', '--', rel], { cwd, encoding: 'buffer', timeout: 5000 })
  const line = stdout.toString('utf8').replace(/\0$/, '')
  if (!line) return null
  const match = line.match(/^(\d+)\s+([0-9a-f]{40})\s+\d+\t/)
  if (!match) return null
  return { mode: match[1], blob: match[2] }
}

function normalizeSourceScope(sourceScope, project, hash7) {
  if (!Array.isArray(sourceScope) || sourceScope.length === 0) {
    throw new Error(`cannot preserve ${project}@${hash7}: missing source scope`)
  }
  const scoped = new Set()
  for (const raw of sourceScope) {
    if (typeof raw !== 'string') continue
    const parts = raw.split(/[\\/]+/).filter(Boolean)
    const rel = parts.join('/')
    if (!rel || parts.includes('..') || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
      throw new Error(`cannot preserve ${project}@${hash7}: invalid source scope path ${raw}`)
    }
    scoped.add(rel)
  }
  if (scoped.size === 0) throw new Error(`cannot preserve ${project}@${hash7}: empty source scope`)
  return [...scoped].sort()
}

async function treeEntry(cwd, hash, rel) {
  const { stdout } = await execFileP('git', ['ls-tree', '-z', hash, '--', rel], { cwd, encoding: 'buffer', timeout: 5000 })
  const line = stdout.toString('utf8').replace(/\0$/, '')
  const match = line.match(/^(\d+)\s+blob\s+([0-9a-f]{40})\t/)
  if (!match) throw new Error(`shadow commit does not contain ${rel}`)
  return { mode: match[1], blob: match[2] }
}

async function treeEntryOrNull(cwd, hash, rel) {
  try {
    return await treeEntry(cwd, hash, rel)
  } catch {
    return null
  }
}

async function worktreeEntry(cwd, rel) {
  const full = path.join(cwd, rel)
  let stat
  try {
    stat = fs.lstatSync(full)
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(full)
    const blob = await gitHashObject(cwd, Buffer.from(link))
    return { mode: '120000', blob }
  }
  if (!stat.isFile()) throw new Error(`not a regular source file: ${rel}`)
  const { stdout: blobRaw } = await execFileP('git', ['hash-object', full], { cwd, timeout: 5000 })
  return { mode: (stat.mode & 0o111) ? '100755' : '100644', blob: blobRaw.trim() }
}

async function gitHashObject(cwd, input) {
  const { stdout } = await execFileWithInput('git', ['hash-object', '--stdin'], { cwd, input, timeout: 5000 })
  return stdout.trim()
}

async function updateIndexInfo(cwd, entries) {
  const input = entries.map(entry => {
    if (entry.deleted) return `0 0000000000000000000000000000000000000000\t${entry.path}\n`
    return `${entry.mode} ${entry.blob}\t${entry.path}\n`
  }).join('')
  await gitRetryOnLock(() => execFileWithInput('git', ['update-index', '--index-info'], { cwd, input, timeout: 10000 }))
}

function execFileWithInput(command, args, { cwd, input, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeout}ms`))
    }, timeout)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const err = new Error(`${command} ${args.join(' ')} failed${signal ? ` (${signal})` : ''}: ${stderr || stdout}`)
        err.code = code
        err.signal = signal
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      }
    })
    child.stdin.end(input)
  })
}

function entriesMatch(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.mode === b.mode && a.blob === b.blob
}

async function preservationCommitMessage(cwd, hash) {
  const { stdout } = await execFileP('git', ['log', '-1', '--format=%s', hash], { cwd, timeout: 5000 })
  const subject = stdout.trim()
  if (subject) return `Preserve tlda ${subject}`
  return `Preserve tlda build ${hash.slice(0, 7)}`
}
