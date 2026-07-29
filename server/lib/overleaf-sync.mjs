/**
 * Overleaf git sync.
 *
 * Lets a project mirror an external git remote (Overleaf's git-bridge, but any
 * git URL works) and rebuild whenever the remote changes. The model:
 *
 *   Overleaf = the author's editor and source of truth.
 *   tlda     = a review/agent layer that mirrors the repo and rebuilds on change.
 *
 * The remote and tlda source tree are synchronized through the local clone.
 * Remote edits are fetched into tlda; tlda-side source edits are committed to
 * the clone and pushed upstream. The clone remains the git authority for merges,
 * but neither side is allowed to silently live as a doomed local-only edit.
 *
 * Storage:
 *   server/projects/{name}/overleaf-clone/   — the git mirror (token lives here,
 *                                              inside .git/config — never in
 *                                              project.json, which is served)
 *
 * The auth token is embedded in the clone's remote URL and persists in
 * .git/config, so pulls after a server restart need no stored secret. We record
 * only the SANITIZED remote (no token) in project.json for status/display.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
const _execRaw = promisify(execCb)
const execAsync = (cmd, opts = {}) =>
  _execRaw(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000, ...opts })

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  projectDir, readProject, updateProject, createProject,
  listProjectSourceRecoveries, rollbackProjectSourceRecovery, removeProjectSourceRecovery,
  sourceLifecycleStore,
} from './project-store.mjs'
import { isSourceFilePath, sourceManifestContext } from '../../shared/source-manifest.mjs'
import { processProjectPushSerialized, runSerializedProjectSourceOperation } from '../routes/projects.mjs'
import { createLogger } from '../../shared/logger.mjs'

const log = createLogger('overleaf-sync')

// Files we never ship to the build pipeline even if tracked in the Overleaf repo.
const SKIP_PATHS = [/(^|\/)\.git(\/|$)/, /(^|\/)\.gitignore$/]

// Active pollers, keyed by project name → { timer, intervalMs }.
const pollers = new Map()

function cloneDir(name) {
  return join(projectDir(name), 'overleaf-clone')
}

export async function readOverleafLocalHead(name) {
  const dir = cloneDir(name)
  if (!existsSync(join(dir, '.git'))) return null
  return (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
}

// Credentials only live in the userinfo of an http(s) URL. ssh remotes,
// file:// URLs, and bare local paths carry no token and aren't URL-parseable,
// so we leave them untouched.
const isHttpUrl = (s) => /^https?:\/\//i.test(s)

// Strip `//user:token@` userinfo from any string so a token-bearing remote URL
// can never leak into an error message, a log line, or an API response. Generic
// (matches the URL shape) so we don't have to know the token value.
const scrubCreds = (s) => String(s).replace(/\/\/[^/@\s]+@/g, '//***@')

/**
 * Embed an auth token into an https git URL as the password. Overleaf's
 * git-bridge authenticates with the token as the password and any (or empty)
 * username; we use `git` as the username by convention.
 */
function authedUrl(gitUrl, token) {
  if (!token || !isHttpUrl(gitUrl)) return gitUrl
  const u = new URL(gitUrl)
  u.username = 'git'
  u.password = token
  return u.toString()
}

/** Strip any embedded credentials from a URL for safe storage/display. */
function sanitizeUrl(gitUrl) {
  if (!isHttpUrl(gitUrl)) return gitUrl
  const u = new URL(gitUrl)
  u.username = ''
  u.password = ''
  return u.toString()
}

/**
 * Decide whether a file's bytes are binary (→ base64) or text (→ utf8 string).
 * A NUL byte is the standard heuristic git itself uses.
 */
function readFileForPush(absPath) {
  const buf = readFileSync(absPath)
  const isBinary = buf.includes(0)
  return isBinary
    ? { content: buf.toString('base64'), encoding: 'base64' }
    : { content: buf.toString('utf8') }
}

function shouldSkip(relPath) {
  return SKIP_PATHS.some(re => re.test(relPath))
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function pathInsideClone(name, relPath) {
  const dir = cloneDir(name)
  const full = join(dir, relPath)
  if (!full.startsWith(dir)) throw new Error('Invalid file path')
  return full
}

/**
 * Clone an Overleaf (or any) git remote into the project's mirror dir.
 * Idempotent-ish: refuses if a clone already exists (caller deletes first).
 * Returns { head } — the cloned HEAD commit.
 */
async function cloneRemote(name, gitUrl, token) {
  const dir = cloneDir(name)
  if (existsSync(join(dir, '.git'))) {
    throw new Error(`Overleaf clone already exists for ${name} — unlink first`)
  }
  const url = authedUrl(gitUrl, token)
  try {
    await execAsync(`git clone "${url}" "${dir}"`, { timeout: 180000 })
  } catch (e) {
    throw new Error(scrubCreds(e.message))
  }
  // Don't let a stray local identity break anything; set one for safety.
  await execAsync('git config user.email "tlda@local"', { cwd: dir, timeout: 5000 })
  await execAsync('git config user.name "tlda"', { cwd: dir, timeout: 5000 })
  const { stdout } = await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })
  return { head: stdout.trim() }
}

/** List every tracked file in the clone (relative paths). */
async function trackedFiles(dir) {
  const { stdout } = await execAsync('git ls-files -z', { cwd: dir, timeout: 30000 })
  return stdout.split('\0').filter(Boolean)
}

/**
 * Fetch the remote and hard-reset the mirror to upstream HEAD. Returns the
 * set of changed and deleted paths between the old and new HEAD. On the very
 * first sync (no oldHead) every tracked file counts as changed.
 */
async function fetchAndDiff(dir) {
  const before = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
  try {
    await execAsync('git fetch --quiet origin', { cwd: dir, timeout: 120000 })
  } catch (e) {
    throw new Error(scrubCreds(e.message))  // fetch error can echo the stored remote URL
  }
  const upstream = (await execAsync('git rev-parse @{u}', { cwd: dir, timeout: 5000 })).stdout.trim()

  if (upstream === before) return { changed: [], deleted: [], head: before, unchanged: true }

  // name-status diff: lines are "<status>\t<path>" (R/C give two paths).
  const { stdout } = await execAsync(
    `git diff --name-status -z ${before} ${upstream}`,
    { cwd: dir, timeout: 30000 }
  )
  const changed = new Set()
  const deleted = new Set()
  const tokens = stdout.split('\0').filter(Boolean)
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i++]
      const newPath = tokens[i++]
      if (status.startsWith('R')) deleted.add(oldPath)
      changed.add(newPath)
    } else {
      const path = tokens[i++]
      if (status === 'D') deleted.add(path)
      else changed.add(path)
    }
  }

  // Hard-reset the working tree to the fetched upstream — Overleaf is truth.
  await execAsync(`git reset --hard ${upstream}`, { cwd: dir, timeout: 30000 })

  return {
    changed: [...changed].filter(p => !shouldSkip(p)),
    deleted: [...deleted].filter(p => !shouldSkip(p)),
    head: upstream,
    unchanged: false,
  }
}

/**
 * Push tlda-side source changes back to the linked Overleaf/git remote.
 *
 * Preparation performs every fallible local git operation and returns a
 * publish closure. The normal source transaction publishes only after local
 * source and metadata are durably committed, leaving no fallible local commit
 * after remote success.
 */
export async function prepareSourcePushToOverleaf(name, { files = [], deletedFiles = [], editedBy } = {}) {
  const project = await readProject(name)
  if (!project?.overleafRemote || project.autoSync === false) return { skipped: true, reason: 'not-linked' }

  const dir = cloneDir(name)
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`No Overleaf clone for ${name} — link it first`)
  }

  const changedFiles = (files || []).filter(f => f?.path && !shouldSkip(f.path))
  const removedFiles = (deletedFiles || []).filter(p => p && !shouldSkip(p))
  if (changedFiles.length === 0 && removedFiles.length === 0) {
    return { skipped: true, reason: 'no-source-changes' }
  }

  let originalLocalHead = null
  try {
    originalLocalHead = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
    await execAsync('git fetch --quiet origin', { cwd: dir, timeout: 120000 })
    const upstreamRef = (await execAsync('git rev-parse --abbrev-ref @{u}', { cwd: dir, timeout: 5000 })).stdout.trim()
    const remoteBranch = upstreamRef.replace(/^[^/]+\//, '')
    const previousRemoteHead = (await execAsync('git rev-parse @{u}', { cwd: dir, timeout: 5000 })).stdout.trim()
    await execAsync('git reset --hard @{u}', { cwd: dir, timeout: 30000 })

    for (const file of changedFiles) {
      const full = pathInsideClone(name, file.path)
      mkdirSync(dirname(full), { recursive: true })
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content
      writeFileSync(full, content)
    }

    for (const relPath of removedFiles) {
      const full = pathInsideClone(name, relPath)
      if (existsSync(full)) unlinkSync(full)
    }

    await execAsync('git add -A', { cwd: dir, timeout: 30000 })
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: dir, timeout: 5000 })
    if (!status.trim()) {
      const head = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
      return { name, pushed: false, unchanged: true, head, previousRemoteHead, remoteBranch, originalLocalHead,
        publish: async () => ({ name, pushed: false, unchanged: true, head }),
        restoreRemote: async () => {},
        restoreLocal: async () => execAsync(`git reset --hard ${shellQuote(originalLocalHead)}`, { cwd: dir, timeout: 30000 }),
      }
    }

    const actor = editedBy ? ` by ${editedBy}` : ''
    await execAsync(`git commit -m ${shellQuote(`tlda sync${actor}`)}`, { cwd: dir, timeout: 30000 })

    const head = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
    return {
      name, pushed: true, changed: changedFiles.length, deleted: removedFiles.length,
      head, previousRemoteHead, remoteBranch, originalLocalHead,
      async publish() {
        await execAsync(`git push origin HEAD:${shellQuote(remoteBranch)}`, { cwd: dir, timeout: 120000 })
        log.info('pushed', { name, changed: changedFiles.length, deleted: removedFiles.length, head: head.slice(0, 7) })
        return { name, pushed: true, changed: changedFiles.length, deleted: removedFiles.length, head }
      },
      async restoreRemote() {
        await execAsync(
          `git push --force-with-lease=${shellQuote(`refs/heads/${remoteBranch}:${head}`)} origin ${shellQuote(`${previousRemoteHead}:refs/heads/${remoteBranch}`)}`,
          { cwd: dir, timeout: 120000 },
        )
      },
      async restoreLocal() {
        await execAsync(`git reset --hard ${shellQuote(originalLocalHead)}`, { cwd: dir, timeout: 30000 })
      },
    }
  } catch (e) {
    if (originalLocalHead) {
      await execAsync(`git reset --hard ${shellQuote(originalLocalHead)}`, { cwd: dir, timeout: 30000 })
    }
    throw new Error(scrubCreds(e.message))
  }
}

export async function recoverProjectSourceTransactions(name) {
  const dir = cloneDir(name)
  const results = []
  for (const recovery of listProjectSourceRecoveries(name)) {
    if (recovery.state === 'journal-incomplete') {
      removeProjectSourceRecovery(name, recovery.id)
      results.push({ id: recovery.id, state: 'incomplete-journal-cleaned' })
      continue
    }
    if (recovery.state === 'snapshot-ready') {
      if (existsSync(join(dir, '.git')) && recovery.originalLocalHead) {
        await execAsync(`git reset --hard ${shellQuote(recovery.originalLocalHead)}`, { cwd: dir, timeout: 30000 })
      }
      await rollbackProjectSourceRecovery(name, recovery.id)
      removeProjectSourceRecovery(name, recovery.id)
      results.push({ id: recovery.id, state: 'snapshot-rolled-back-cleaned' })
      continue
    }
    if (!existsSync(join(dir, '.git'))) {
      log.warn('source-recovery-clone-missing', { name, recoveryId: recovery.id })
      results.push({ id: recovery.id, state: 'recovery-required' })
      continue
    }
    await execAsync('git fetch --quiet origin', { cwd: dir, timeout: 120000 })
    const remoteHead = (await execAsync(`git rev-parse ${shellQuote(`refs/remotes/origin/${recovery.remoteBranch}`)}`, { cwd: dir, timeout: 5000 })).stdout.trim()
    let proposedPublished = remoteHead === recovery.proposedRemoteHead
    if (!proposedPublished) {
      try {
        await execAsync(`git merge-base --is-ancestor ${shellQuote(recovery.proposedRemoteHead)} ${shellQuote(remoteHead)}`, { cwd: dir, timeout: 5000 })
        proposedPublished = true
      } catch { /* unrelated remote head remains unresolved */ }
    }
    if (proposedPublished) {
      removeProjectSourceRecovery(name, recovery.id)
      results.push({ id: recovery.id, state: 'committed-cleaned' })
      continue
    }
    if (remoteHead === recovery.previousRemoteHead) {
      await execAsync(`git reset --hard ${shellQuote(recovery.originalLocalHead)}`, { cwd: dir, timeout: 30000 })
      await rollbackProjectSourceRecovery(name, recovery.id)
      removeProjectSourceRecovery(name, recovery.id)
      results.push({ id: recovery.id, state: 'rolled-back-cleaned' })
      continue
    }
    log.warn('source-recovery-remote-diverged', {
      name, recoveryId: recovery.id, remoteHead: remoteHead.slice(0, 7),
    })
    results.push({ id: recovery.id, state: 'recovery-required' })
  }
  return results
}

export async function pushSourceToOverleaf(name, changes = {}) {
  const prepared = await prepareSourcePushToOverleaf(name, changes)
  return prepared.publish()
}

/**
 * Run one sync cycle for a project: fetch, diff, ship changed files into the
 * normal push/build pipeline. Returns a summary. `initial` forces a full push
 * of every tracked file (used right after the first clone).
 */
export async function syncOverleaf(name, options = {}) {
  return runSerializedProjectSourceOperation(name, () => syncOverleafSerialized(name, options))
}

async function syncOverleafSerialized(name, { initial = false, testHooks = null } = {}) {
  if (testHooks?.afterLock) await testHooks.afterLock()
  const project = await readProject(name)
  if (!project) throw new Error(`Project ${name} not found`)
  const dir = cloneDir(name)
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`No Overleaf clone for ${name} — link it first`)
  }

  const recoveries = await recoverProjectSourceTransactions(name)
  const unresolved = recoveries.find(item => item.state === 'recovery-required')
  if (unresolved) return { name, recoveryRequired: true, recovery: unresolved }

  const retryHead = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
  const sourceContext = sourceManifestContext(project)
  const isAuthoredSource = path => !shouldSkip(path) && isSourceFilePath(path, sourceContext)
  let changedPaths, deletedPaths, head
  if (initial) {
    changedPaths = (await trackedFiles(dir)).filter(isAuthoredSource)
    deletedPaths = []
    head = (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim()
  } else {
    const diff = await fetchAndDiff(dir)
    if (diff.unchanged) {
      await updateProject(name, {
        overleafLastPullAt: Date.now(),
        overleafSyncStatus: 'ok',
        overleafSyncError: null,
        overleafConflictFiles: [],
      })
      return { name, changed: 0, deleted: 0, head: diff.head, unchanged: true }
    }
    changedPaths = diff.changed.filter(isAuthoredSource)
    deletedPaths = diff.deleted.filter(isAuthoredSource)
    head = diff.head
  }

  const files = changedPaths.map(p => ({ path: p, ...readFileForPush(join(dir, p)) }))
  const sourceManifest = (await trackedFiles(dir)).filter(isAuthoredSource)
  const processPush = testHooks?.processProjectPush || processProjectPushSerialized
  const expectedRevision = (await sourceLifecycleStore(name)).readAuthority().currentRevision
  const result = await processPush(name, { expectedRevision, files, deletedFiles: deletedPaths, sourceManifest, overleafSync: true })

  if (!result?.ok) {
    await execAsync(`git reset --hard ${shellQuote(retryHead)}`, { cwd: dir, timeout: 30000 })
    const message = result?.error || `Source transaction failed with status ${result?.status || 'unknown'}`
    await updateProject(name, {
      overleafSyncStatus: 'error',
      overleafSyncError: scrubCreds(message),
    })
    throw new Error(scrubCreds(message))
  }

  await updateProject(name, {
    overleafHead: head,
    overleafLastPullAt: Date.now(),
    overleafSyncStatus: 'ok',
    overleafSyncError: null,
    overleafConflictFiles: [],
  })
  log.info('synced', { name, changed: files.length, deleted: deletedPaths.length, head: head.slice(0, 7) })
  return { name, changed: files.length, deleted: deletedPaths.length, head, building: result?.building }
}

/**
 * Link a project to an Overleaf git remote: create it if missing, clone, do the
 * initial full sync, persist metadata, and start polling. Returns a summary.
 */
export async function linkOverleaf(name, { gitUrl, token, title, mainFile, pollSeconds = 60 } = {}) {
  if (!gitUrl) throw new Error('gitUrl is required')

  let project = await readProject(name)
  const remote = sanitizeUrl(gitUrl)
  if (project?.overleafRemote) {
    if (sanitizeUrl(project.overleafRemote) === remote) {
      return { linked: false, alreadyLinked: true, remote }
    }
    throw new Error(`Project "${name}" is already linked to ${project.overleafRemote}; unlink it first`)
  }
  if (!project) {
    project = createProject({ name, title: title || name, mainFile: mainFile || 'main.tex', format: 'svg' })
  }

  const dir = cloneDir(name)
  await cloneRemote(name, gitUrl, token)
  let resolvedMain = mainFile || project.mainFile
  const tracked = await trackedFiles(dir)
  if (!resolvedMain || !existsSync(join(dir, resolvedMain))) {
    const candidates = tracked.filter(file => file.endsWith('.tex') && readFileSync(join(dir, file), 'utf8').includes('\\documentclass'))
    if (candidates.length !== 1) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error('Could not infer the main file; pass --main <file>')
    }
    resolvedMain = candidates[0]
  }

  await updateProject(name, {
    overleafRemote: remote,
    overleafPollSeconds: pollSeconds,
    autoSync: true,
    mainFile: resolvedMain,
  })

  const summary = await syncOverleaf(name, { initial: true })
  startPolling(name, pollSeconds)
  return { ...summary, linked: true, alreadyLinked: false, remote }
}

/** Stop polling and remove the clone + metadata (does not delete the project). */
export async function unlinkOverleaf(name, { gitUrl } = {}) {
  const project = await readProject(name)
  if (!project?.overleafRemote) return { unlinked: false, alreadyUnlinked: true }
  if (gitUrl && sanitizeUrl(project.overleafRemote) !== sanitizeUrl(gitUrl)) {
    throw new Error(`Project "${name}" is linked to ${project.overleafRemote}, not ${sanitizeUrl(gitUrl)}`)
  }
  stopPolling(name)
  const dir = cloneDir(name)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  await updateProject(name, {
    overleafRemote: null, overleafHead: null, overleafPollSeconds: null,
    overleafLastPullAt: null, autoSync: false,
  })
  return { unlinked: true, alreadyUnlinked: false }
}

/** Start a polling loop for a project. Replaces any existing poller. */
export function startPolling(name, pollSeconds = 60) {
  stopPolling(name)
  const intervalMs = Math.max(15, pollSeconds) * 1000
  const timer = setInterval(() => {
    syncOverleaf(name).catch(e => log.warn('poll-failed', { name, error: e.message }))
  }, intervalMs)
  // Don't keep the process alive solely for polling.
  if (timer.unref) timer.unref()
  pollers.set(name, { timer, intervalMs })
  log.info('poller-started', { name, pollSeconds })
}

export function stopPolling(name) {
  const p = pollers.get(name)
  if (p) {
    clearInterval(p.timer)
    pollers.delete(name)
  }
}

export function isPolling(name) {
  return pollers.has(name)
}

/**
 * On server startup, resume pollers for every project that has an Overleaf
 * remote and autoSync enabled. Call once after the project store is initialized.
 */
export async function resumeOverleafPollers(listProjectsFn, {
  recover = recoverProjectSourceTransactions,
  start = startPolling,
} = {}) {
  let resumed = 0
  for (const project of await listProjectsFn()) {
    try {
      const recoveries = await recover(project.name)
      for (const recovery of recoveries.filter(item => item.state === 'recovery-required')) {
        log.warn('source-recovery-required', { name: project.name, recoveryId: recovery.id })
      }
      if (project.overleafRemote && project.autoSync && existsSync(join(cloneDir(project.name), '.git'))) {
        start(project.name, project.overleafPollSeconds || 60)
        resumed++
      }
    } catch (error) {
      // Startup must isolate this project so one broken recovery cannot prevent
      // every later project's poller from resuming.
      log.warn('poller-resume-failed', { name: project.name, error: scrubCreds(error.message) })
      await updateProject(project.name, {
        overleafSyncStatus: 'error',
        overleafSyncError: scrubCreds(error.message),
      })
    }
  }
  if (resumed) log.info('pollers-resumed', { count: resumed })
  return resumed
}
