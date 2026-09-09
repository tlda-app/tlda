import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createEditClusterDebouncer } from './edit-cluster.mjs'
import { createGitProjectSync, safeRefPart } from './git-project-sync.mjs'
import { createRemoteGitBridge } from './remote-git-bridge.mjs'
import { historySeedRef } from '../shared/history-seed-ref.mjs'
import { createGitRemotes } from '../shared/git-remotes.mjs'

const defaultExecFile = promisify(execFileCb)
const watchSourceTree = (root, onChange) => fs.watch(root, { recursive: true, persistent: true }, onChange)

export function createRuntimeSourceWatcher({ sourceDir, watchedMembers, note, watch = watchSourceTree }) {
  return watch(sourceDir, (_eventType, filename) => {
    if (filename == null) {
      note(watchedMembers.values().next().value || path.join(sourceDir, '__tlda_ambiguous_source_event__'))
      return
    }
    const file = path.resolve(sourceDir, String(filename))
    if (watchedMembers.has(file)) note(file)
  })
}

function bindingId(project, sourceDir) {
  return Buffer.from(`${project}\0${path.resolve(sourceDir)}`).toString('base64url')
}

export function createGitSyncManager({ bindingsFile, daemonId, server, token = null, log = console, watch = watchSourceTree, execFile = defaultExecFile, remoteUrlFor = null, quietMs = 250, onProposalSubmitted = async () => {}, onDocumentsDropped = async () => {}, onSyncRefused = async () => {} } = {}) {
  if (!bindingsFile || !daemonId || !server) throw new Error('bindingsFile, daemonId, and server are required')
  const runtimes = new Map()
  const starts = new Map()

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

  function projectRemoteUrl(project, serverOverride = null) {
    // A project bound with an explicit server pushes THERE. `--server` names the
    // server for that command, and the git remote is part of what that command
    // does -- it was governing the API call while the remote still came from the
    // daemon's own config, so `tlda project scratch --server <preview>` created
    // the project on the preview and pushed its content to the configured
    // server instead. The binding is where a project's other facts already live,
    // so this needs no new record.
    // AND AN EXPLICIT OVERRIDE WINS, because the binding does not exist yet at
    // the moment of the first push. `project link --server <host>` creates the
    // project on <host> and then pushes its history seed BEFORE `bindSource`
    // records anything, so this read found no binding, fell through to the
    // daemon's own server, and pushed to the wrong box:
    //
    //   Created markdown project "…"                        <- on the named server
    //   fatal: repository 'https://<daemon's server>/git/…'  <- seed push
    //           not found
    //
    // Measured against pic-dev on 2026-08-29. The link then fails outright, so
    // a classroom cannot be set up on a box that is not the daemon's default.
    // Threading the caller's server through the push is narrower than reordering
    // the link: `bindSource` deliberately runs after adoption is confirmed, so
    // that a failed link leaves nothing behind, and that ordering must not move.
    const bound = load()[project]
    const base = serverOverride || (bound && typeof bound === 'object' && bound.server) || server
    let remoteUrl = remoteUrlFor ? remoteUrlFor(project) : new URL(`/git/${encodeURIComponent(project)}`, base)
    // The daemon id is the username and it is always known; the token is the
    // password and may legitimately be empty. Both were attached only when a
    // token existed, so a tokenless server got NEITHER -- and `/git` requires
    // Basic credentials to exist before it will look at them, so git fell
    // through to prompting: `could not read Username for '…'`.
    //
    // This does not weaken anything. `validateToken` returns 'rw' for any token
    // only when gating is OFF, which is what a tokenless preview is; with gating
    // ON an empty password still fails the check and still 401s.
    if (remoteUrl instanceof URL) {
      remoteUrl.username = safeRefPart(daemonId)
      if (token) remoteUrl.password = token
    }
    return remoteUrl.toString()
  }

  async function configureProjectRemote(project, sourceDir, serverOverride = null) {
    const remoteUrl = projectRemoteUrl(project, serverOverride)
    const { stdout } = await execFile('git', ['remote'], { cwd: sourceDir, encoding: 'utf8' })
    const hasTransportRemote = stdout.split(/\r?\n/).includes('tlda')
    await execFile('git', ['remote', hasTransportRemote ? 'set-url' : 'add', 'tlda', remoteUrl], { cwd: sourceDir })
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

  async function pushHistorySeed(project, repositoryDir, revision, serverOverride = null) {
    const ref = historySeedRef({ daemonId, revision })
    await configureProjectRemote(project, repositoryDir, serverOverride)
    await execFile('git', ['push', 'tlda', `${revision}:${ref}`], { cwd: repositoryDir, encoding: 'utf8', timeout: 180000 })
    return { project, ref, revision }
  }

  async function initialize(item) {
    await ensureRepo(item)
    let runtime
    const sync = createGitProjectSync({
      sourceDir: item.sourceDir,
      quietMs,
      project: item.project,
      daemonId,
      bindingId: item.bindingId,
      remote: projectRemoteUrl(item.project),
      documentRoots: item.documentRoots || [],
      log,
      // sourceDir rides along because the members in `event` are project-relative
      // and the attribution lookup needs absolute paths.
      onSubmitted: event => onProposalSubmitted({ project: item.project, sourceDir: item.sourceDir, ...event }),
    })
    const watchedMembers = new Set()
    let watcher
    // A settle driven by the file watcher has nobody at a terminal reading its
    // return value, so the documents it left out are said out loud instead. Only
    // when the set CHANGES: the same settle runs on every save, and a warning
    // that repeats on every save is one people stop reading — which is the same
    // silence one layer up. This is the shape reportInvalidProjectSourceOwners
    // already uses in bin/fleet-daemon.mjs for the same reason.
    let reportedDropped = null
    let reportedRefusal = null
    async function reportDroppedDocuments(dropped = []) {
      const signature = dropped.join('\n')
      if (signature === reportedDropped) return
      reportedDropped = signature
      if (!dropped.length) return
      await onDocumentsDropped({ project: item.project, sourceDir: item.sourceDir, dropped })
    }
    /**
     * Report a settle that was refused, once per distinct refusal.
     *
     * The reason string is `settle`'s, verbatim. Rewriting it here would be a
     * second place that has to know what a work branch is called, and the two
     * would drift -- so if a status has no reason, this reports the status
     * rather than inventing prose for it.
     */
    async function reportSyncRefusal(result) {
      const signature = `${result.status || 'unknown'}\n${result.head || ''}\n${result.reason || ''}`
      if (signature === reportedRefusal) return
      reportedRefusal = signature
      await onSyncRefused({
        project: item.project,
        sourceDir: item.sourceDir,
        status: result.status || 'unknown',
        head: result.head || null,
        workBranch: result.workBranch || null,
        reason: result.reason || `${item.project}: proposal not accepted: ${result.status || 'unknown'}`,
      })
    }
    async function refreshWatchedMembers() {
      const next = new Set((await sync.members()).map(file => path.join(item.sourceDir, file)))
      watchedMembers.clear()
      for (const file of next) watchedMembers.add(file)
    }
    // Named so `start()` can run it once, below. It is the ONE settle path:
    // the watcher reaches it through the debouncer, and startup reaches it
    // directly. Nothing else should grow a second way in.
    // `fromEdit` says whether a PERSON's edit is what reached here. The watcher
    // path sets it; the startup sweep does not, and that distinction is the
    // difference between a useful warning and a flood.
    const settleEditCluster = async ({ fromEdit = false } = {}) => {
      try {
        // settle() reports failure two ways and only one of them was audible.
        // A THROW is logged below; a returned { ok: false } was dropped on the
        // floor. WrongHead, conflicted, merge-in-progress and empty-checkout all
        // take the second path, so a proposal could be rejected on every attempt
        // and leave no trace anywhere -- no log, no retry, no state change. That
        // silence is what made "in-app editing does nothing" cost hours to find.
        const result = await sync.editClusterSettled()
        if (result && result.ok === false) {
          log.warn(`${item.project}: proposal not accepted: ${result.status || 'unknown'}`)
          // AND SAY IT WHERE A PERSON IS. The log line above is on the machine
          // and nowhere else, so the person edits, the daemon commits, their
          // tree goes clean, nothing errors, and the project never receives a
          // revision. Measured on testing 2026-08-29: 1702 such refusals across
          // 85 distinct projects, the newest minutes old, none of them visible
          // anywhere but this file.
          //
          // `settle` already composes the whole sentence -- project, the branch
          // this checkout is on, the managed branch it must be on, and the
          // command that fixes it -- so nothing is written here that the daemon
          // did not already know. It only stopped being silent.
          //
          // Deduplicated on purpose. This fires on EVERY settle, so reporting
          // each one would put thousands of messages in front of somebody,
          // which is a worse failure than the silence it replaces. The
          // signature is the same shape `reportedDropped` uses above.
          //
          // AND ONLY FOR AN ACTUAL EDIT. The first version of this reported
          // from the startup sweep too, which runs once per binding at daemon
          // start regardless of whether anybody touched anything. Measured the
          // moment it shipped: a single daemon restart put **42 messages** into
          // root's chat in 90 seconds, one per misconfigured binding on the
          // machine. That is the flood this warning exists to avoid being.
          //
          // The narrower rule is also the true one. The claim being made is
          // "the edit you just made did not reach the project" -- at startup
          // nobody made one, so there is nothing to say. A binding parked on
          // the wrong branch with no edits is not a person losing work; it is
          // an inventory question, and inventory does not belong in a chat.
          if (fromEdit) await reportSyncRefusal(result)
        }
        if (result?.ok) {
          reportedRefusal = null
          await reportDroppedDocuments(result.dropped || [])
        }
        await refreshWatchedMembers()
      } catch (error) {
        // Keep the watcher live after a rejected proposal so a later member edit can repair it.
        log.warn(`${item.project}: proposal failed: ${error.message}`)
      }
    }
    const cluster = createEditClusterDebouncer({
      sourceDir: item.sourceDir,
      // The watcher path: a file actually changed, so a refusal here is somebody's
      // edit not reaching the project, and that is worth saying.
      onSettled: () => settleEditCluster({ fromEdit: true }),
    })
    const remoteBridge = item.remote ? createRemoteGitBridge({
      sourceDir: item.sourceDir,
      remote: item.remote,
      branch: item.branch || 'main',
      onRemoteSettled: () => cluster.note(path.join(item.sourceDir, item.mainFile || '.')),
      log,
    }) : null
    watcher = createRuntimeSourceWatcher({
      sourceDir: item.sourceDir,
      watchedMembers,
      note: file => cluster.note(file),
      watch,
    })
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
    // Re-derive what the working tree says, once, at startup.
    //
    // An edit made while this daemon was down reaches nothing otherwise. The
    // The watcher starts after the edit, so no event fires and recover() cannot
    // help: it only re-pushes a revision already at `localRef`, and the missed
    // edit never became one. The debouncer is pure memory, so anything pending
    // when the process died is gone too.
    //
    // The file therefore only reached the server when the author happened to
    // edit again — the settle stages the whole tree, so a later edit swept it
    // in. That is convergence by coincidence: one edit inside the window
    // followed by a pause was never submitted at all, silently and forever.
    //
    // This is a re-derivation, not a queue: nothing remembers the missed edit
    // because the working tree already does. It is also idempotent — `settle()`
    // compares its tree against the shared one and returns `equal-tree` without
    // pushing when they match, so a startup with nothing outstanding costs a
    // comparison and submits nothing.
    await settleEditCluster()
    if (remoteBridge) await remoteBridge.poll()
    return runtime
  }

  function start(item) {
    if (runtimes.has(item.project)) return Promise.resolve(runtimes.get(item.project))
    if (starts.has(item.project)) return starts.get(item.project)
    const starting = Promise.resolve().then(() => initialize(item))
    starts.set(item.project, starting)
    starting.then(
      () => starts.delete(item.project),
      () => starts.delete(item.project),
    )
    return starting
  }

  function bindSource(project, sourceDir, metadata = {}) {
    const absolute = path.resolve(sourceDir)
    const all = load()
    const existing = all[project]
    if (existing && path.resolve(typeof existing === 'string' ? existing : existing.sourceDir) !== absolute) {
      throw new Error(`Project ${project} is already bound to another checkout`)
    }
    // AND THE CONVERSE, which was missing: one checkout carries one project.
    //
    // Skip, 2026-08-27: *"maybe let's just disallow that"* / *"like, just clone
    // right?"*
    //
    // A checkout stands on ONE work branch, and a project syncs only while its
    // own branch is checked out -- *"if you have a daemon-managed branch checked
    // out, it commits, and pushes, and all that shit. otherwise it doesn't."* So
    // of N projects sharing a directory, N-1 never sync, and the person is told
    // nothing: the edit commits, the tree is clean, and the only trace is a
    // `not-on-work-branch` line in a daemon log. Measured the day this was
    // added: 10 checkouts carried 27 projects, so at least 17 could not sync.
    //
    // Rejected at bind, which is the one place every route arrives -- the CLI,
    // the source room, and the server-side room manager all come through here.
    const taken = Object.entries(all).find(([name, value]) => name !== project
      && path.resolve(typeof value === 'string' ? value : value.sourceDir) === absolute)
    if (taken) {
      throw new Error(`${absolute} is already the checkout for project ${taken[0]}. `
        + 'One checkout carries one project: clone the repository again and link '
        + `${project} to the new clone.`)
    }
    const prior = existing && typeof existing === 'object' ? existing : {}
    const definedMetadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
    const value = { ...prior, sourceDir: absolute, bindingId: prior.bindingId || bindingId(project, absolute), ...definedMetadata }
    all[project] = value
    save(all)
    const runtime = runtimes.get(project)
    if (runtime) {
      Object.assign(runtime.item, value)
      runtime.sync.setDocumentRoots(value.documentRoots || [])
    }
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
    return { unlinked: true, project, sourceDir: existingDir }
  }

  async function sync(projects = []) {
    const byName = new Map(projects.map(project => [project.name, project]))
    const failures = []
    for (const item of records()) {
      const project = byName.get(item.project)
      if (!project) continue
      try {
        await start({ ...item, mainFile: project.mainFile || null })
      } catch (error) {
        failures.push(new Error(`${item.project}: ${error.message}`, { cause: error }))
      }
    }
    if (failures.length) {
      const summary = failures.map(failure => failure.message).join('; ')
      throw new AggregateError(failures, `${failures.length} project Git sync binding${failures.length === 1 ? '' : 's'} failed: ${summary}`)
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

  /** Put a bound checkout on its work branch. Called at link; see git-project-sync. */
  async function standOnWorkBranch(project, options = {}) {
    const item = record(project)
    if (!item) throw new Error(`project ${project} is not bound on this daemon`)
    const runtime = await start(item)
    return runtime.sync.standOnWorkBranch(options)
  }

  async function submit(project, options = {}) {
    const item = record(project)
    if (!item) throw new Error(`project ${project} is not bound on this daemon`)
    const runtime = await start(item)
    const result = await runtime.sync.submitCurrent(options)
    await runtime.refreshWatchedMembers()
    return result
  }

  /**
   * Publish a revision that already exists in the project's repository.
   *
   * `submit` publishes the working tree: it settles the edit cluster, commits
   * what is there, and pushes the commit it just made. That is the right thing
   * when someone has edited files, and the wrong thing when the revision to
   * publish is one git already holds -- because reaching it through `submit`
   * would first have to put it in the working tree, which means touching a
   * checkout that belongs to somebody else.
   *
   * This reads the commit out of the object database instead, so the working
   * tree, the branch, the index and the binding are all untouched, and a dirty
   * checkout is not an obstacle. `pushRevision` is the same call `submit` ends
   * at; the difference is only which revision it is handed.
   */
  async function publishRevision(project, revision) {
    if (!revision) throw new Error('publishRevision requires a revision')
    const item = record(project)
    if (!item) throw new Error(`project ${project} is not bound on this daemon`)
    const runtime = await start(item)
    // Fail on a revision this repository does not hold, rather than pushing a
    // ref that resolves to something else. `^{commit}` is the load-bearing
    // part: without it a tag or a tree of the same name would satisfy the
    // check and then publish as something other than a commit.
    try {
      await execFile('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: item.sourceDir })
    } catch {
      throw new Error(`revision ${revision} is not present in the repository bound to ${project}`)
    }
    // `exact`: publish this commit or nothing. Without it the server's
    // ancestry rule turns a republication into a merge -- the accepted head
    // combined with the named revision, published as a commit nobody asked
    // for and authored as the checkout's owner. Measured on a real project
    // before this option existed.
    const result = await runtime.sync.pushRevision(revision, { forceRebuild: true, exact: true })
    if (result?.status === 'WrongHead') {
      throw new Error(
        `refusing to publish ${revision.slice(0, 12)} for ${project}: the server's accepted head is ` +
        `${String(result.head).slice(0, 12)} and this revision does not descend from it. Nothing was published.`,
      )
    }
    return result
  }

  async function remoteOperation(project, operation, params = {}) {
    const item = record(project)
    if (!item) throw new Error(`project ${project} is not bound on this daemon`)
    const remotes = createGitRemotes({ sourceDir: item.sourceDir })
    if (operation === 'list') {
      const listed = (await remotes.list({ fetch: params.fetch === true })).filter(remote => remote.name !== 'tlda')
      const projectPart = safeRefPart(project)
      // The branch first, then the old ref. Not a fallback between two live
      // names: `ensureProjectBranch` promotes one to the other on the first
      // settle or recover of the process, and this listing runs without starting
      // a runtime, so it can be asked before that has happened -- and it stays
      // on the old name forever in a checkout whose promotion is blocked by a
      // branch called `tlda`. Reading only the new name would report no local
      // tip in both cases.
      const localTip = await remotes.resolveRef(`refs/heads/tlda/${projectPart}`)
        || await remotes.resolveRef(`refs/tlda/project/${projectPart}`)
        || await remotes.resolveRef(`refs/tlda/fetched/${projectPart}`)
      if (localTip) {
        const transport = (await remotes.list({ names: ['tlda'] }))[0]
        listed.push({
          name: 'tlda',
          url: transport?.url || null,
          kind: 'tlda',
          writable: false,
          branches: [{ name: project, commit: localTip, selected: false, writable: false }],
        })
      }
      return listed
    }
    if (operation === 'read-file') return remotes.readFile(params.revision, params.file)
    // Not a remote operation, and neither is `read-file` beside it. Both are
    // questions only the machine holding the checkout can answer, and this is
    // the route that reaches it. See docs/naming-errata.md.
    if (operation === 'repo-path') return remotes.repoPathFor(params.path)
    // Same class as `repo-path` beside it: only the machine holding the checkout
    // can stage a file, so the request comes here. Skip's ruling on the untracked
    // click — `git add` it, then open it live.
    if (operation === 'track-path') return remotes.trackPath(params.path)
    if (params.name === 'tlda') throw new Error('The tlda transport remote is not a project remote')
    if (operation === 'add') return remotes.add(params.name, params.url)
    if (operation === 'delete') return remotes.delete(params.name)
    const branch = params.branch || await remotes.currentBranch()
    if (operation === 'pull') return remotes.pull(params.name, branch)
    if (operation === 'push') return remotes.push(params.name, branch, params.revision)
    if (operation === 'checkout') {
      const checkedOut = await remotes.checkout(params.name, branch, params.revision)
      const submission = await submit(project)
      return { ...checkedOut, submission }
    }
    throw new Error(`unsupported Git remote operation: ${operation || '(missing)'}`)
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
    // The remote a push would use for a project. Readable because it is the
    // thing `--server` is meant to govern, so it is what a check about that
    // contract has to look at.
    projectRemoteUrl,
    bindSource,
    unbindSource,
    sync,
    headChanged,
    pollRemote,
    standOnWorkBranch,
    remoteOperation,
    submit,
    publishRevision,
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
