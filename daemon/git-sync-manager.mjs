import chokidar from 'chokidar'
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createEditClusterDebouncer } from './edit-cluster.mjs'
import { createGitProjectSync, safeRefPart } from './git-project-sync.mjs'
import { createRemoteGitBridge } from './remote-git-bridge.mjs'
import { historySeedRef } from '../shared/history-seed-ref.mjs'

const execFile = promisify(execFileCb)

function bindingId(project, sourceDir) {
  return Buffer.from(`${project}\0${path.resolve(sourceDir)}`).toString('base64url')
}

export function createGitSyncManager({ bindingsFile, daemonId, server, token = null, log = console, watch = chokidar.watch, remoteUrlFor = null, quietMs = 3000, remoteCheckoutsRoot = null } = {}) {
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

  function projectRemoteUrl(project) {
    let remoteUrl = remoteUrlFor ? remoteUrlFor(project) : new URL(`/git/${encodeURIComponent(project)}`, server)
    if (remoteUrl instanceof URL && token) { remoteUrl.username = safeRefPart(daemonId); remoteUrl.password = token }
    return remoteUrl.toString()
  }

  async function configureProjectRemote(project, sourceDir) {
    const remoteUrl = projectRemoteUrl(project)
    try { await execFile('git', ['remote', 'set-url', 'tlda', remoteUrl], { cwd: sourceDir }) }
    catch { await execFile('git', ['remote', 'add', 'tlda', remoteUrl], { cwd: sourceDir }) }
    return remoteUrl
  }

  async function ensureRepo(item) {
    fs.mkdirSync(item.sourceDir, { recursive: true })
    try { await execFile('git', ['rev-parse', '--git-dir'], { cwd: item.sourceDir }) } catch {
      await execFile('git', ['init', '-b', 'main'], { cwd: item.sourceDir })
      await execFile('git', ['config', 'user.name', 'tlda source daemon'], { cwd: item.sourceDir })
      await execFile('git', ['config', 'user.email', 'tlda@local'], { cwd: item.sourceDir })
    }
    await configureProjectRemote(item.project, item.sourceDir)
  }

  async function pushHistorySeed(project, repositoryDir, revision) {
    const ref = historySeedRef({ daemonId, revision })
    await configureProjectRemote(project, repositoryDir)
    await execFile('git', ['push', 'tlda', `${revision}:${ref}`], { cwd: repositoryDir, encoding: 'utf8', timeout: 180000 })
    return { project, ref, revision }
  }

  function authenticatedUrl(value, remoteToken) {
    if (!remoteToken || !/^https?:\/\//i.test(value)) return value
    const url = new URL(value)
    url.username = 'git'
    url.password = remoteToken
    return url.toString()
  }

  async function prepareRemote({ project, remote, token: remoteToken = null, pollSeconds = 60 } = {}) {
    if (!remoteCheckoutsRoot) throw new Error('remoteCheckoutsRoot is required for remote-backed sources')
    if (!project || !remote) throw new Error('project and remote are required')
    const sourceDir = path.join(remoteCheckoutsRoot, project)
    if (!fs.existsSync(sourceDir)) {
      fs.mkdirSync(remoteCheckoutsRoot, { recursive: true })
      await execFile('git', ['clone', '--', authenticatedUrl(remote, remoteToken), sourceDir], { encoding: 'utf8', timeout: 180000 })
      await execFile('git', ['config', 'user.name', 'tlda remote source daemon'], { cwd: sourceDir })
      await execFile('git', ['config', 'user.email', 'tlda@local'], { cwd: sourceDir })
    }
    const branch = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' })).stdout.trim()
    return { project, sourceDir, kind: 'git', remote, branch, pollSeconds: Math.max(15, Number(pollSeconds) || 60) }
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
    const watchedMembers = new Set()
    let watcher
    async function refreshWatchedMembers() {
      const next = new Set((await sync.members()).map(file => path.join(item.sourceDir, file)))
      const added = [...next].filter(file => !watchedMembers.has(file))
      const removed = [...watchedMembers].filter(file => !next.has(file))
      if (added.length) watcher.add(added)
      if (removed.length) await watcher.unwatch(removed)
      watchedMembers.clear()
      for (const file of next) watchedMembers.add(file)
    }
    const cluster = createEditClusterDebouncer({
      sourceDir: item.sourceDir,
      onSettled: async () => {
        try {
          await sync.editClusterSettled()
          await refreshWatchedMembers()
        } catch (error) {
          // Keep the watcher live after a rejected proposal so a later member edit can repair it.
          log.warn(`${item.project}: proposal failed: ${error.message}`)
        }
      },
    })
    const remoteBridge = item.remote ? createRemoteGitBridge({
      sourceDir: item.sourceDir,
      branch: item.branch || 'main',
      onRemoteSettled: () => cluster.note(path.join(item.sourceDir, item.mainFile || '.')),
      log,
    }) : null
    watcher = watch([], {
      ignoreInitial: true,
      persistent: true,
    })
    for (const event of ['add', 'change', 'unlink']) watcher.on(event, file => cluster.note(file))
    watcher.on('error', error => log.warn(`${item.project}: source watcher failed: ${error.message}`))
    const remoteTimer = remoteBridge ? setInterval(
      () => remoteBridge.poll().catch(error => log.warn(`${item.project}: remote Git poll failed: ${error.message}`)),
      Math.max(15, Number(item.pollSeconds) || 60) * 1000,
    ) : null
    remoteTimer?.unref?.()
    runtime = { item, sync, cluster, watcher, remoteBridge, remoteTimer, refreshWatchedMembers }
    runtimes.set(item.project, runtime)
    await sync.recover()
    await refreshWatchedMembers()
    if (remoteBridge) await remoteBridge.poll()
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
    if (runtime?.remoteTimer) clearInterval(runtime.remoteTimer)
    runtimes.delete(project)
    delete all[project]
    save(all)
    if (existing?.kind === 'git' && remoteCheckoutsRoot && path.dirname(path.resolve(existingDir)) === path.resolve(remoteCheckoutsRoot)) {
      fs.rmSync(existingDir, { recursive: true, force: true })
    }
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
    const result = await runtime.cluster.serializeMirror(
      () => runtime.sync.headChanged(revision),
      async () => Boolean((await execFile('git', ['status', '--porcelain', '-z'], { cwd: item.sourceDir, encoding: 'utf8' })).stdout),
    )
    await runtime.refreshWatchedMembers()
    if (result?.ok && runtime.remoteBridge && revision) await runtime.remoteBridge.publish(revision)
    return result
  }

  async function pollRemote(project) {
    const item = record(project)
    if (!item) return { skipped: true, reason: 'not-bound' }
    const runtime = await start(item)
    return runtime.remoteBridge ? runtime.remoteBridge.poll() : { skipped: true, reason: 'not-remote-backed' }
  }

  async function submit(project) {
    const item = record(project)
    if (!item) throw new Error(`project ${project} is not bound on this daemon`)
    const runtime = await start(item)
    const result = await runtime.sync.editClusterSettled()
    await runtime.refreshWatchedMembers()
    return result
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
    for (const runtime of runtimes.values()) {
      runtime.cluster.close()
      if (runtime.remoteTimer) clearInterval(runtime.remoteTimer)
      await runtime.watcher.close()
    }
    runtimes.clear()
  }

  return {
    bindSource,
    prepareRemote,
    unbindSource,
    sync,
    headChanged,
    pollRemote,
    submit,
    pushHistorySeed,
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
