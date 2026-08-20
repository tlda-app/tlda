import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

function cleanUrl(value) {
  if (!/^https?:\/\//i.test(value)) return value
  const url = new URL(value)
  url.username = ''
  url.password = ''
  return url.toString()
}

function authenticatedUrl(value, token) {
  if (!token || !/^https?:\/\//i.test(value)) return value
  const url = new URL(value)
  url.username = 'git'
  url.password = token
  return url.toString()
}

async function git(cwd, args, options = {}) {
  return execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 50 * 1024 * 1024, ...options })
}

async function commit(cwd, value) {
  try {
    return (await git(cwd, ['rev-parse', '--verify', `${value}^{commit}`], { timeout: 30_000 })).stdout.trim()
  } catch (error) {
    if (error.killed || error.signal) throw error
    return null
  }
}

async function ancestor(cwd, older, newer) {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', older, newer], { timeout: 5_000 })
    return true
  } catch (error) {
    if (error.killed || error.signal) throw error
    return false
  }
}

async function changedPaths(cwd, before, after) {
  const { stdout } = await git(cwd, ['diff', '--name-only', '-z', before, after], { timeout: 30_000 })
  return stdout.split('\0').filter(Boolean)
}

export function createGitSourceManager({ stateFile, sourcesRoot, queuePaths, log = console }) {
  const timers = new Map()

  function load() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {} } catch { return {} }
  }

  function save(records) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const pending = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(pending, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(pending, stateFile)
  }

  function record(project) { return load()[project] || null }

  async function tracked(sourceDir) {
    const { stdout } = await git(sourceDir, ['ls-files', '-z'])
    return stdout.split('\0').filter(Boolean)
  }

  async function link({ project, remote, token = null, mirrorMode = 'auto-merge', pollSeconds = 60 } = {}) {
    if (!project || !remote) throw new Error('project and remote are required')
    if (!['fast-forward', 'auto-merge'].includes(mirrorMode)) throw new Error(`invalid mirror mode: ${mirrorMode}`)
    const records = load()
    const existing = records[project]
    if (existing) {
      if (existing.remote !== cleanUrl(remote)) throw new Error(`Project "${project}" is already linked to ${existing.remote}; unlink it first`)
      return { linked: false, alreadyLinked: true, ...existing, files: await tracked(existing.sourceDir) }
    }
    const sourceDir = path.join(sourcesRoot, project)
    if (fs.existsSync(sourceDir)) throw new Error(`Git source directory already exists: ${sourceDir}`)
    fs.mkdirSync(sourcesRoot, { recursive: true })
    try {
      await git(sourcesRoot, ['clone', '--', authenticatedUrl(remote, token), sourceDir], { timeout: 180_000 })
      await git(sourceDir, ['config', 'user.email', 'tlda@local'])
      await git(sourceDir, ['config', 'user.name', 'tlda'])
      const head = await commit(sourceDir, 'HEAD')
      const branch = (await git(sourceDir, ['rev-parse', '--abbrev-ref', '@{u}'])).stdout.trim().replace(/^[^/]+\//, '')
      await git(sourceDir, ['update-ref', `refs/tlda/local/${project}`, head])
      const next = { project, remote: cleanUrl(remote), sourceDir, mirrorMode, pollSeconds: Math.max(15, Number(pollSeconds) || 60), branch }
      records[project] = next
      save(records)
      return { linked: true, alreadyLinked: false, ...next, head, files: await tracked(sourceDir) }
    } catch (error) {
      fs.rmSync(sourceDir, { recursive: true, force: true })
      throw error
    }
  }

  async function poll(project) {
    const item = record(project)
    if (!item) return { skipped: true, reason: 'not-linked' }
    const { sourceDir, mirrorMode } = item
    const unresolved = (await git(sourceDir, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
    if (unresolved.length) return { ok: false, status: 'conflicted', conflicted: unresolved }
    const dirty = (await git(sourceDir, ['status', '--porcelain', '-z'])).stdout
    if (dirty) return { ok: false, status: 'working-copy-dirty' }
    await git(sourceDir, ['fetch', '--quiet', 'origin'])
    const remote = await commit(sourceDir, '@{u}')
    const base = await commit(sourceDir, 'refs/tlda/shadow/HEAD') || await commit(sourceDir, `refs/tlda/local/${project}`) || await commit(sourceDir, 'HEAD')
    if (!remote || !base || remote === base) return { ok: true, unchanged: true, head: base }
    if (await ancestor(sourceDir, remote, base)) return { ok: true, outboundPending: true, head: base, remote }
    if (await ancestor(sourceDir, base, remote)) {
      const paths = await changedPaths(sourceDir, base, remote)
      await git(sourceDir, ['reset', '--hard', remote])
      await git(sourceDir, ['update-ref', `refs/tlda/local/${project}`, remote])
      queuePaths(project, paths)
      return { ok: true, status: 'fast-forwarded', head: remote, changed: paths }
    }
    if (mirrorMode === 'fast-forward') return { ok: false, status: 'diverged', head: base, remote }
    await git(sourceDir, ['reset', '--hard', base])
    try {
      await git(sourceDir, ['merge', '--no-edit', remote])
    } catch {
      const conflicted = (await git(sourceDir, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
      if (!conflicted.length) throw new Error(`${project}: Git merge failed without unresolved paths`)
      return { ok: false, status: 'conflicted', conflicted, head: base, remote }
    }
    const merged = await commit(sourceDir, 'HEAD')
    await git(sourceDir, ['update-ref', `refs/tlda/local/${project}`, merged])
    const paths = await changedPaths(sourceDir, base, merged)
    queuePaths(project, paths)
    return { ok: true, status: 'merged', head: merged, changed: paths }
  }

  async function publishAccepted({ project, sourceRevision }) {
    const item = record(project)
    if (!item) return { skipped: true, reason: 'not-linked' }
    const { sourceDir, branch } = item
    const unresolved = (await git(sourceDir, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
    if (unresolved.length) return { ok: false, status: 'conflicted', conflicted: unresolved }
    const accepted = await commit(sourceDir, sourceRevision)
    if (!accepted) throw new Error(`${project}: accepted revision ${sourceRevision} is not present in the Git source`)
    await git(sourceDir, ['fetch', '--quiet', 'origin'])
    const remote = await commit(sourceDir, `refs/remotes/origin/${branch}`)
    if (remote && !(await ancestor(sourceDir, remote, accepted))) {
      return { ok: false, status: 'remote-diverged', sourceRevision: accepted, remote }
    }
    await git(sourceDir, ['push', 'origin', `${accepted}:refs/heads/${branch}`])
    return { ok: true, pushed: true, sourceRevision: accepted }
  }

  function start(project) {
    const item = record(project)
    if (!item || timers.has(project)) return
    const timer = setInterval(() => poll(project).catch(error => log.warn?.(`${project}: Git source poll failed: ${error.message}`)), item.pollSeconds * 1000)
    timer.unref?.()
    timers.set(project, timer)
  }

  async function activate({ project }) {
    const item = record(project)
    if (!item) throw new Error(`Project "${project}" has no Git source`)
    start(project)
    queuePaths(project, await tracked(item.sourceDir))
    return { ok: true, ...item }
  }

  function unlink({ project, remote = null } = {}) {
    const records = load()
    const item = records[project]
    if (!item) return { unlinked: false, alreadyUnlinked: true }
    if (remote && cleanUrl(remote) !== item.remote) throw new Error(`Project "${project}" is linked to ${item.remote}, not ${cleanUrl(remote)}`)
    if (timers.has(project)) clearInterval(timers.get(project))
    timers.delete(project)
    delete records[project]
    save(records)
    fs.rmSync(item.sourceDir, { recursive: true, force: true })
    return { unlinked: true, alreadyUnlinked: false, ...item }
  }

  function resume() { for (const project of Object.keys(load())) start(project) }
  function close() { for (const timer of timers.values()) clearInterval(timer); timers.clear() }

  return { activate, close, link, poll, publishAccepted, record, resume, unlink }
}
