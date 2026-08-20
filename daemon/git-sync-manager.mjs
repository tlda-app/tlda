import chokidar from 'chokidar'
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createEditClusterDebouncer } from './edit-cluster.mjs'
import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)

function bindingId(project, sourceDir) {
  return Buffer.from(`${project}\0${path.resolve(sourceDir)}`).toString('base64url')
}

export function createGitSyncManager({ bindingsFile, daemonId, server, token = null, log = console, watch = chokidar.watch, remoteUrlFor = null, quietMs = 3000 } = {}) {
  if (!bindingsFile || !daemonId || !server) throw new Error('bindingsFile, daemonId, and server are required')
  const runtimes = new Map()

  function load() { try { return JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) || {} } catch { return {} } }
  function save(value) {
    fs.mkdirSync(path.dirname(bindingsFile), { recursive: true })
    const pending = `${bindingsFile}.${process.pid}.tmp`
    fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(pending, bindingsFile)
  }
  function records() {
    return Object.entries(load()).map(([project, value]) => ({ project, ...(typeof value === 'string' ? { sourceDir: value } : value) }))
  }
  function record(project) { return records().find(item => item.project === project) || null }

  async function ensureRepo(item) {
    try { await execFile('git', ['rev-parse', '--git-dir'], { cwd: item.sourceDir }) } catch {
      await execFile('git', ['init', '-b', 'main'], { cwd: item.sourceDir })
      await execFile('git', ['config', 'user.name', 'tlda source daemon'], { cwd: item.sourceDir })
      await execFile('git', ['config', 'user.email', 'tlda@local'], { cwd: item.sourceDir })
    }
    let remoteUrl = remoteUrlFor ? remoteUrlFor(item.project) : new URL(`/git/${encodeURIComponent(item.project)}.git`, server)
    if (remoteUrl instanceof URL && token) { remoteUrl.username = daemonId; remoteUrl.password = token }
    remoteUrl = remoteUrl.toString()
    try { await execFile('git', ['remote', 'set-url', 'tlda', remoteUrl], { cwd: item.sourceDir }) }
    catch { await execFile('git', ['remote', 'add', 'tlda', remoteUrl], { cwd: item.sourceDir }) }
  }

  async function start(item) {
    if (runtimes.has(item.project)) return runtimes.get(item.project)
    await ensureRepo(item)
    let runtime
    const sync = createGitProjectSync({
      sourceDir: item.sourceDir,
      quietMs,
      project: item.project,
      daemonId,
      bindingId: item.bindingId,
      log,
      onEditClusterSettled: () => runtime.cluster.note(path.join(item.sourceDir, item.mainFile || '.')),
    })
    const cluster = createEditClusterDebouncer({
      sourceDir: item.sourceDir,
      onSettled: () => sync.editClusterSettled().catch(error => log.warn(`${item.project}: proposal failed: ${error.message}`)),
    })
    const watcher = watch(item.sourceDir, {
      ignoreInitial: true,
      persistent: true,
      ignored: file => {
        const rel = path.relative(item.sourceDir, file)
        return rel.split(path.sep).some(part => part === '.git' || /^\.tlda-(?:build|cache|output|status|staging)$/.test(part))
      },
    })
    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) watcher.on(event, file => cluster.note(file))
    watcher.on('error', error => log.warn(`${item.project}: source watcher failed: ${error.message}`))
    runtime = { item, sync, cluster, watcher }
    runtimes.set(item.project, runtime)
    await sync.recover()
    return runtime
  }

  function bindSource(project, sourceDir, metadata = {}) {
    const absolute = path.resolve(sourceDir)
    const all = load()
    const existing = all[project]
    if (existing && path.resolve(typeof existing === 'string' ? existing : existing.sourceDir) !== absolute) {
      throw new Error(`Project ${project} is already bound to another checkout`)
    }
    const value = { sourceDir: absolute, bindingId: existing?.bindingId || bindingId(project, absolute), ...metadata }
    all[project] = value
    save(all)
    return { linked: !existing, project, ...value }
  }

  function unbindSource(project, sourceDir = null) {
    const all = load()
    const existing = all[project]
    if (!existing) return { unlinked: false }
    const existingDir = typeof existing === 'string' ? existing : existing.sourceDir
    if (sourceDir && path.resolve(sourceDir) !== path.resolve(existingDir)) throw new Error(`Project ${project} is bound to ${existingDir}`)
    const runtime = runtimes.get(project)
    runtime?.cluster.close()
    runtime?.watcher.close()
    runtimes.delete(project)
    delete all[project]
    save(all)
    return { unlinked: true, project, sourceDir: existingDir }
  }

  async function sync(projects = []) {
    const byName = new Map(projects.map(project => [project.name, project]))
    for (const item of records()) {
      const project = byName.get(item.project)
      if (!project) continue
      await start({ ...item, mainFile: project.mainFile || null })
    }
  }

  async function headChanged(project, revision = null) {
    const item = record(project)
    if (!item) return { skipped: true, reason: 'not-bound' }
    const runtime = await start(item)
    return runtime.cluster.serializeMirror(
      () => runtime.sync.headChanged(revision),
      async () => Boolean((await execFile('git', ['status', '--porcelain', '-z'], { cwd: item.sourceDir, encoding: 'utf8' })).stdout),
    )
  }

  function sourceFileForAbsolutePath(filePath) {
    const matches = records().flatMap(item => {
      const rel = path.relative(path.resolve(item.sourceDir), path.resolve(filePath))
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? [{ project: item.project, file: rel.split(path.sep).join('/') }] : []
    })
    return matches.length === 1 ? matches[0] : null
  }

  function queuePaths(project, paths = []) {
    const runtime = runtimes.get(project)
    if (!runtime) throw new Error(`project ${project} is not watched on this daemon`)
    for (const rel of paths) runtime.cluster.note(path.join(runtime.item.sourceDir, rel))
    return { queued: paths.length }
  }

  async function closeAll() {
    for (const runtime of runtimes.values()) { runtime.cluster.close(); await runtime.watcher.close() }
    runtimes.clear()
  }

  return {
    bindSource,
    unbindSource,
    sync,
    headChanged,
    queuePaths,
    sourceFileForAbsolutePath,
    getSourceDir: project => record(project)?.sourceDir || null,
    bindingStatus: (project, sourceDir) => {
      const existing = record(project)
      const alreadyLinked = Boolean(existing && path.resolve(existing.sourceDir) === path.resolve(sourceDir))
      return { linked: alreadyLinked, alreadyLinked, sourceDir: existing?.sourceDir || null, binding: existing }
    },
    bindingRecords: records,
    boundProjectNames: () => records().map(item => item.project),
    closeAll,
  }
}
