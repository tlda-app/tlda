import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

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
  async function mirrorShadowRef({ project, hash, bundleBase64, sourceScope }) {
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
      log.info(`mirrored ${project}@${hash7} into ${sourceDir}`)
      return { ok: true, project, hash, sourceDir, tag: `shadow/${hash7}`, preservation }
    } finally {
      try {
        fs.rmSync(bundlePath, { force: true })
      } catch (e) {
        // Temporary bundle cleanup must not mask the mirror result.
        log.warn(`failed to remove temporary shadow bundle ${bundlePath}: ${e.message}`)
      }
    }
  }

  return { mirrorShadowRef }
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
      if (fs.existsSync(path.join(sourceDir, rel))) {
        throw new Error(`cannot preserve ${project}@${hash7}: local ${rel} exists but shadow deleted it`)
      }
      entries.push({ path: rel, deleted: true })
      continue
    }

    const localEntry = await worktreeEntry(sourceDir, rel)
    if (!localEntry) throw new Error(`cannot preserve ${project}@${hash7}: local ${rel} is missing`)
    if (localEntry.blob !== shadowEntry.blob) {
      throw new Error(`cannot preserve ${project}@${hash7}: local ${rel} changed after build`)
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
