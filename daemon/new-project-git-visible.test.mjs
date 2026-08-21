import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

import { startServer, stopServer, unusedPort } from '../server/lib/unified-server-test-harness.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'

function sourceWatcher() {
  const watcher = new EventEmitter()
  watcher.add = () => {}
  watcher.unwatch = async () => {}
  watcher.close = async () => {}
  return watcher
}

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

test('new project linked from an existing Git checkout becomes a visible built document', { timeout: 360_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-new-project-git-visible-'))
  const checkout = join(root, 'checkout')
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const peerCheckout = join(root, 'peer-checkout')
  const project = 'git-visible-paper'
  const port = await unusedPort()
  const base = `https://127.0.0.1:${port}`
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const previousGitTls = process.env.GIT_SSL_NO_VERIFY
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  process.env.GIT_SSL_NO_VERIFY = '1'
  let server
  let manager
  let peerManager
  let remoteManager
  let phase = 'fixture setup'
  try {
    mkdirSync(checkout)
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'README.md'), '# Git-visible paper\n\nRendered through the daemon Git remote.\n')
    await git(checkout, ['add', 'README.md'])
    await git(checkout, ['commit', '-m', 'author working copy'])
    const authorRevision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()

    phase = 'server startup'
    server = await startServer({ port, projectsDir, fleetDb })
    phase = 'project creation'
    const createdResponse = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, name: project, title: 'Git-visible paper', mainFile: 'README.md', format: 'markdown' }),
    })
    assert.equal(createdResponse.status, 201, await createdResponse.text())

    phase = 'daemon Git manager setup'
    const watcher = sourceWatcher()
    manager = createGitSyncManager({
      bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-git-visible', server: base,
      token: 'fixture-token',
      watch: () => watcher, quietMs: 10, log: { info() {}, warn() {}, error() {} },
    })
    manager.bindSource(project, checkout)
    await manager.sync([{ name: project, mainFile: 'README.md' }])
    phase = 'ordinary Git submission'
    const submission = await manager.submit(project)
    assert.equal(submission.status, 'SubmittedToBuildQueue')

    phase = 'build fixed point'
    let projectView
    let buildView
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      projectView = await fetch(`${base}/api/projects/${project}`).then(response => response.json())
      buildView = await fetch(`${base}/api/projects/${project}/build/status`).then(response => response.json())
      if (projectView.buildStatus === 'success' && projectView.sourceRevision === submission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(projectView.buildStatus, 'success', JSON.stringify({ projectView, buildView, server: server.output() }))
    assert.equal(projectView.sourceRevision, submission.revision)
    assert.equal(projectView.pages, 1)

    phase = 'document manifest'
    const manifest = await fetch(`${base}/docs/manifest.json`).then(response => response.json())
    assert.deepEqual(manifest.documents[project], {
      name: 'Git-visible paper', pages: 1, format: 'markdown',
      createdAt: projectView.createdAt, lastBuild: projectView.lastBuild, autoSync: true,
    })
    phase = 'page info'
    const pageInfo = await fetch(`${base}/docs/${project}/page-info.json`).then(response => response.json())
    assert.equal(pageInfo.length, 1)
    assert.equal(pageInfo[0].file, 'index.html')
    assert.equal(pageInfo[0].source.file, 'README.md')
    phase = 'rendered page'
    const pageResponse = await fetch(`${base}/docs/${project}/index.html`)
    assert.equal(pageResponse.status, 200)
    assert.match(await pageResponse.text(), /Rendered through the daemon Git remote/)

    assert.equal((await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim(), authorRevision)
    assert.notEqual(authorRevision, submission.revision, 'daemon proposal commit must not move the author working copy')
    const appliedRef = `refs/tlda/applied/${manager.bindingRecords()[0].bindingId.replace(/[^A-Za-z0-9._-]+/g, '-')}`
    await manager.headChanged(project, submission.revision)
    assert.equal((await git(checkout, ['rev-parse', appliedRef])).stdout.trim(), submission.revision)

    phase = 'local edit convergence'
    writeFileSync(join(checkout, 'README.md'), '# Git-visible paper\n\nVisible after a later local edit.\n')
    watcher.emit('change', join(checkout, 'README.md'))
    let editedProject
    let editedBuild
    const editDeadline = Date.now() + 120_000
    while (Date.now() < editDeadline) {
      editedProject = await fetch(`${base}/api/projects/${project}`).then(response => response.json())
      editedBuild = await fetch(`${base}/api/projects/${project}/build/status`).then(response => response.json())
      if (editedProject.buildStatus === 'success' && editedProject.sourceRevision !== submission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(editedProject.buildStatus, 'success', JSON.stringify({ editedProject, editedBuild, server: server.output() }))
    assert.notEqual(editedProject.sourceRevision, submission.revision)
    assert.equal(editedProject.acceptSeq, 2)
    assert.equal(editedBuild.sourceRevision, editedProject.sourceRevision)
    const editedPageResponse = await fetch(`${base}/docs/${project}/index.html`)
    assert.equal(editedPageResponse.status, 200)
    assert.match(await editedPageResponse.text(), /Visible after a later local edit/)
    await manager.headChanged(project, editedProject.sourceRevision)
    assert.equal((await git(checkout, ['rev-parse', appliedRef])).stdout.trim(), editedProject.sourceRevision)
    assert.match(readFileSync(join(checkout, 'README.md'), 'utf8'), /Visible after a later local edit/)

    phase = 'local edit burst convergence'
    for (const content of ['burst one', 'burst two', 'burst settled']) {
      writeFileSync(join(checkout, 'README.md'), `# Git-visible paper\n\n${content}.\n`)
      watcher.emit('change', join(checkout, 'README.md'))
    }
    let burstProject
    const burstDeadline = Date.now() + 120_000
    while (Date.now() < burstDeadline) {
      burstProject = await fetch(`${base}/api/projects/${project}`).then(response => response.json())
      if (burstProject.buildStatus === 'success' && burstProject.acceptSeq === 3) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(burstProject.buildStatus, 'success', JSON.stringify({ burstProject, server: server.output() }))
    assert.equal(burstProject.acceptSeq, 3, 'one settled burst must publish one new accepted revision')
    const burstPageResponse = await fetch(`${base}/docs/${project}/index.html`)
    assert.equal(burstPageResponse.status, 200)
    assert.match(await burstPageResponse.text(), /burst settled/)
    await manager.headChanged(project, burstProject.sourceRevision)
    assert.equal((await git(checkout, ['rev-parse', appliedRef])).stdout.trim(), burstProject.sourceRevision)

    phase = 'cross-daemon accepted head convergence'
    mkdirSync(peerCheckout)
    await git(peerCheckout, ['init', '-b', 'main'])
    await git(peerCheckout, ['config', 'user.name', 'peer fixture'])
    await git(peerCheckout, ['config', 'user.email', 'peer@example.test'])
    const peerRemote = new URL(`/git/${project}`, base)
    peerRemote.username = 'daemon-peer'
    peerRemote.password = 'fixture-token'
    await git(peerCheckout, ['remote', 'add', 'tlda', peerRemote.toString()])
    await git(peerCheckout, ['fetch', '--no-tags', 'tlda', `+refs/tlda/source/${project}:refs/tlda/fetched/${project}`])
    await git(peerCheckout, ['checkout', '-B', 'main', `refs/tlda/fetched/${project}`])
    const peerWatcher = sourceWatcher()
    peerManager = createGitSyncManager({
      bindingsFile: join(root, 'peer-bindings.json'), daemonId: 'daemon-peer', server: base,
      token: 'fixture-token', watch: () => peerWatcher, quietMs: 10,
      log: { info() {}, warn() {}, error() {} },
    })
    peerManager.bindSource(project, peerCheckout)
    await peerManager.sync([{ name: project, mainFile: 'README.md' }])
    writeFileSync(join(peerCheckout, 'README.md'), '# Git-visible paper\n\nAccepted from the peer daemon.\n')
    const peerSubmission = await peerManager.submit(project)
    assert.equal(peerSubmission.status, 'SubmittedToBuildQueue')
    let peerProject
    const peerDeadline = Date.now() + 120_000
    while (Date.now() < peerDeadline) {
      peerProject = await fetch(`${base}/api/projects/${project}`).then(response => response.json())
      if (peerProject.buildStatus === 'success' && peerProject.sourceRevision === peerSubmission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(peerProject.acceptSeq, 4, JSON.stringify({ peerProject, server: server.output() }))
    const proposalsBefore = (await git(checkout, ['ls-remote', 'tlda', 'refs/tlda/proposals/daemon-git-visible/*'])).stdout
    await manager.headChanged(project, peerProject.sourceRevision)
    assert.equal((await git(checkout, ['rev-parse', appliedRef])).stdout.trim(), peerProject.sourceRevision)
    assert.match(readFileSync(join(checkout, 'README.md'), 'utf8'), /Accepted from the peer daemon/)
    await new Promise(resolve => setTimeout(resolve, 50))
    const proposalsAfter = (await git(checkout, ['ls-remote', 'tlda', 'refs/tlda/proposals/daemon-git-visible/*'])).stdout
    assert.equal(proposalsAfter, proposalsBefore, 'applying an accepted peer head must not submit feedback work')
    const peerPageResponse = await fetch(`${base}/docs/${project}/index.html`)
    assert.equal(peerPageResponse.status, 200)
    assert.match(await peerPageResponse.text(), /Accepted from the peer daemon/)

    phase = 'remote-backed edit convergence'
    const remoteProject = 'remote-visible-paper'
    const externalRemote = join(root, 'external.git')
    const externalSeed = join(root, 'external-seed')
    const externalPeer = join(root, 'external-peer')
    await git(root, ['init', '--bare', externalRemote])
    await git(externalRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(root, ['init', '-b', 'main', externalSeed])
    await git(externalSeed, ['config', 'user.name', 'remote fixture'])
    await git(externalSeed, ['config', 'user.email', 'remote@example.test'])
    writeFileSync(join(externalSeed, 'README.md'), '# Remote-visible paper\n\nInitial remote bytes.\n')
    await git(externalSeed, ['add', 'README.md'])
    await git(externalSeed, ['commit', '-m', 'initial remote'])
    await git(externalSeed, ['remote', 'add', 'origin', externalRemote])
    await git(externalSeed, ['push', 'origin', 'main'])
    const remoteCreated = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: remoteProject, title: 'Remote-visible paper', mainFile: 'README.md', format: 'markdown' }),
    })
    assert.equal(remoteCreated.status, 201, await remoteCreated.text())
    const remoteWatcher = sourceWatcher()
    remoteManager = createGitSyncManager({
      bindingsFile: join(root, 'remote-bindings.json'), daemonId: 'daemon-remote', server: base,
      token: 'fixture-token', remoteCheckoutsRoot: join(root, 'remote-checkouts'),
      watch: () => remoteWatcher, quietMs: 10, log: { info() {}, warn() {}, error() {} },
    })
    const preparedRemote = await remoteManager.prepareRemote({ project: remoteProject, remote: externalRemote, pollSeconds: 15 })
    remoteManager.bindSource(remoteProject, preparedRemote.sourceDir, preparedRemote)
    await remoteManager.sync([{ name: remoteProject, mainFile: 'README.md' }])
    const remoteInitialSubmission = await remoteManager.submit(remoteProject)
    assert.equal(remoteInitialSubmission.status, 'SubmittedToBuildQueue')
    let remoteInitialProject
    const remoteInitialDeadline = Date.now() + 120_000
    while (Date.now() < remoteInitialDeadline) {
      remoteInitialProject = await fetch(`${base}/api/projects/${remoteProject}`).then(response => response.json())
      if (remoteInitialProject.buildStatus === 'success' && remoteInitialProject.sourceRevision === remoteInitialSubmission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(remoteInitialProject.acceptSeq, peerProject.acceptSeq + 1, JSON.stringify({ remoteInitialProject, server: server.output() }))
    await remoteManager.headChanged(remoteProject, remoteInitialProject.sourceRevision)
    assert.equal((await git(externalRemote, ['rev-parse', 'refs/heads/main'])).stdout.trim(), remoteInitialProject.sourceRevision)

    await git(root, ['clone', '-b', 'main', externalRemote, externalPeer])
    await git(externalPeer, ['config', 'user.name', 'remote human'])
    await git(externalPeer, ['config', 'user.email', 'remote-human@example.test'])
    writeFileSync(join(externalPeer, 'README.md'), '# Remote-visible paper\n\nEdit arriving from the external remote.\n')
    await git(externalPeer, ['add', 'README.md'])
    await git(externalPeer, ['commit', '-m', 'external remote edit'])
    await git(externalPeer, ['push', 'origin', 'main'])
    await remoteManager.pollRemote(remoteProject)
    let remoteEditedProject
    const remoteEditDeadline = Date.now() + 120_000
    while (Date.now() < remoteEditDeadline) {
      remoteEditedProject = await fetch(`${base}/api/projects/${remoteProject}`).then(response => response.json())
      if (remoteEditedProject.buildStatus === 'success' && remoteEditedProject.acceptSeq === remoteInitialProject.acceptSeq + 1) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(remoteEditedProject.buildStatus, 'success', JSON.stringify({ remoteEditedProject, server: server.output() }))
    await remoteManager.headChanged(remoteProject, remoteEditedProject.sourceRevision)
    assert.equal((await git(externalRemote, ['rev-parse', 'refs/heads/main'])).stdout.trim(), remoteEditedProject.sourceRevision)
    assert.match(readFileSync(join(preparedRemote.sourceDir, 'README.md'), 'utf8'), /Edit arriving from the external remote/)
    const remotePageResponse = await fetch(`${base}/docs/${remoteProject}/index.html`)
    assert.equal(remotePageResponse.status, 200)
    assert.match(await remotePageResponse.text(), /Edit arriving from the external remote/)

    phase = 'divergent edit withholding and resolution'
    const remoteSourceDir = preparedRemote.sourceDir
    const remoteAppliedRef = `refs/tlda/applied/${remoteManager.bindingRecords()[0].bindingId.replace(/[^A-Za-z0-9._-]+/g, '-')}`
    const remoteProposalPattern = 'refs/tlda/proposals/daemon-remote/*'
    const remoteProposalsBeforeConflict = (await git(remoteSourceDir, ['ls-remote', 'tlda', remoteProposalPattern])).stdout
    writeFileSync(join(remoteSourceDir, 'README.md'), '# Remote-visible paper\n\nLocal conflicting side.\n')
    await git(remoteSourceDir, ['add', 'README.md'])
    await git(remoteSourceDir, ['commit', '-m', 'local conflicting edit'])

    await git(externalPeer, ['fetch', 'origin'])
    await git(externalPeer, ['checkout', '-B', 'main', 'origin/main'])
    writeFileSync(join(externalPeer, 'README.md'), '# Remote-visible paper\n\nRemote conflicting side.\n')
    await git(externalPeer, ['add', 'README.md'])
    await git(externalPeer, ['commit', '-m', 'remote conflicting edit'])
    const conflictingRemoteRevision = (await git(externalPeer, ['rev-parse', 'HEAD'])).stdout.trim()
    await git(externalPeer, ['push', 'origin', 'main'])
    const withheld = await remoteManager.pollRemote(remoteProject)
    assert.deepEqual(withheld.conflicted, ['README.md'])
    assert.equal(withheld.status, 'conflicted')
    const heldProject = await fetch(`${base}/api/projects/${remoteProject}`).then(response => response.json())
    assert.equal(heldProject.sourceRevision, remoteEditedProject.sourceRevision)
    assert.equal(heldProject.acceptSeq, remoteEditedProject.acceptSeq)
    assert.equal((await git(externalRemote, ['rev-parse', 'refs/heads/main'])).stdout.trim(), conflictingRemoteRevision)
    assert.match((await git(remoteSourceDir, ['status', '--porcelain'])).stdout, /^UU README\.md$/m)
    const remoteProposalsWhileHeld = (await git(remoteSourceDir, ['ls-remote', 'tlda', remoteProposalPattern])).stdout
    assert.equal(remoteProposalsWhileHeld, remoteProposalsBeforeConflict, 'a conflict must not choose a side or submit work')
    const heldPageResponse = await fetch(`${base}/docs/${remoteProject}/index.html`)
    assert.equal(heldPageResponse.status, 200)
    assert.match(await heldPageResponse.text(), /Edit arriving from the external remote/)

    writeFileSync(join(remoteSourceDir, 'README.md'), '# Remote-visible paper\n\nHuman resolved both sides.\n')
    await git(remoteSourceDir, ['add', 'README.md'])
    const resolvedSubmission = await remoteManager.submit(remoteProject)
    assert.equal(resolvedSubmission.status, 'SubmittedToBuildQueue')
    let resolvedProject
    const resolutionDeadline = Date.now() + 120_000
    while (Date.now() < resolutionDeadline) {
      resolvedProject = await fetch(`${base}/api/projects/${remoteProject}`).then(response => response.json())
      if (resolvedProject.buildStatus === 'success' && resolvedProject.sourceRevision === resolvedSubmission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(resolvedProject.acceptSeq, remoteEditedProject.acceptSeq + 1, JSON.stringify({ resolvedProject, server: server.output() }))
    await remoteManager.headChanged(remoteProject, resolvedProject.sourceRevision)
    assert.equal((await git(remoteSourceDir, ['rev-parse', remoteAppliedRef])).stdout.trim(), resolvedProject.sourceRevision)
    assert.equal((await git(externalRemote, ['rev-parse', 'refs/heads/main'])).stdout.trim(), resolvedProject.sourceRevision)
    assert.match(readFileSync(join(remoteSourceDir, 'README.md'), 'utf8'), /Human resolved both sides/)
    const resolvedPageResponse = await fetch(`${base}/docs/${remoteProject}/index.html`)
    assert.equal(resolvedPageResponse.status, 200)
    assert.match(await resolvedPageResponse.text(), /Human resolved both sides/)

    phase = 'daemon and server restart convergence'
    const queuePath = join(projectsDir, '.build-queue.sqlite')
    const readQueueRow = revision => {
      const db = new Database(queuePath, { readonly: true })
      try {
        return db.prepare('SELECT id, revision, priority, fractional_priority, started_once, state FROM build_submissions WHERE revision = ?').get(revision)
      } finally {
        db.close()
      }
    }
    const durableResolutionRow = readQueueRow(resolvedProject.sourceRevision)
    assert.equal(durableResolutionRow.state, 'complete')
    await remoteManager.closeAll()
    remoteManager = null
    await peerManager.closeAll()
    peerManager = null
    await manager.closeAll()
    manager = null
    await stopServer(server)
    server = null
    server = await startServer({ port, projectsDir, fleetDb })
    assert.deepEqual(readQueueRow(resolvedProject.sourceRevision), durableResolutionRow, 'restart must not rotate or duplicate completed work')

    const restartedWatcher = sourceWatcher()
    remoteManager = createGitSyncManager({
      bindingsFile: join(root, 'remote-bindings.json'), daemonId: 'daemon-remote', server: base,
      token: 'fixture-token', remoteCheckoutsRoot: join(root, 'remote-checkouts'),
      watch: () => restartedWatcher, quietMs: 10, log: { info() {}, warn() {}, error() {} },
    })
    await remoteManager.sync([{ name: remoteProject, mainFile: 'README.md' }])
    await git(externalPeer, ['fetch', 'origin'])
    await git(externalPeer, ['checkout', '-B', 'main', 'origin/main'])
    writeFileSync(join(externalPeer, 'README.md'), '# Remote-visible paper\n\nVisible after daemon and server restart.\n')
    await git(externalPeer, ['add', 'README.md'])
    await git(externalPeer, ['commit', '-m', 'post-restart external edit'])
    await git(externalPeer, ['push', 'origin', 'main'])
    await remoteManager.pollRemote(remoteProject)
    let restartedProject
    const restartDeadline = Date.now() + 120_000
    while (Date.now() < restartDeadline) {
      restartedProject = await fetch(`${base}/api/projects/${remoteProject}`).then(response => response.json())
      if (restartedProject.buildStatus === 'success' && restartedProject.acceptSeq === resolvedProject.acceptSeq + 1) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(restartedProject.buildStatus, 'success', JSON.stringify({ restartedProject, server: server.output() }))
    await remoteManager.headChanged(remoteProject, restartedProject.sourceRevision)
    const restartedAppliedRef = `refs/tlda/applied/${remoteManager.bindingRecords()[0].bindingId.replace(/[^A-Za-z0-9._-]+/g, '-')}`
    assert.equal((await git(preparedRemote.sourceDir, ['rev-parse', restartedAppliedRef])).stdout.trim(), restartedProject.sourceRevision)
    assert.match(readFileSync(join(preparedRemote.sourceDir, 'README.md'), 'utf8'), /Visible after daemon and server restart/)
    assert.equal((await git(externalRemote, ['rev-parse', 'refs/heads/main'])).stdout.trim(), restartedProject.sourceRevision)
    const restartedRowsDb = new Database(queuePath, { readonly: true })
    const restartedRows = restartedRowsDb.prepare('SELECT revision, COUNT(*) AS count FROM build_submissions WHERE revision IN (?, ?) GROUP BY revision ORDER BY revision')
      .all(resolvedProject.sourceRevision, restartedProject.sourceRevision)
    restartedRowsDb.close()
    assert.deepEqual(restartedRows.map(row => row.count), [1, 1])
    const restartedPageResponse = await fetch(`${base}/docs/${remoteProject}/index.html`)
    assert.equal(restartedPageResponse.status, 200)
    assert.match(await restartedPageResponse.text(), /Visible after daemon and server restart/)
    console.log(JSON.stringify({
      project: projectView,
      build: buildView,
      document: manifest.documents[project],
      page: pageInfo[0],
      renderedPage: { status: pageResponse.status, containsMarker: true },
      authorRevision,
      submittedRevision: submission.revision,
      editedProject,
      editedBuild,
      editedPage: { status: editedPageResponse.status, containsMarker: true },
      burstProject,
      burstPage: { status: burstPageResponse.status, containsLatestMarker: true },
      peerProject,
      peerPage: { status: peerPageResponse.status, containsPeerMarker: true },
      remoteInitialProject,
      remoteEditedProject,
      remotePage: { status: remotePageResponse.status, containsRemoteMarker: true },
      heldConflict: { status: withheld.status, remoteRevision: conflictingRemoteRevision, serverRevision: heldProject.sourceRevision },
      resolvedProject,
      resolvedPage: { status: resolvedPageResponse.status, containsResolvedMarker: true },
      restartedProject,
      restartedPage: { status: restartedPageResponse.status, containsRestartMarker: true },
      durableResolutionRow,
    }))
  } catch (error) {
    error.message = `${phase}: ${error.message}\n${server?.output?.() || ''}`
    throw error
  } finally {
    await remoteManager?.closeAll()
    await peerManager?.closeAll()
    await manager?.closeAll()
    await stopServer(server)
    rmSync(root, { recursive: true, force: true })
    if (previousTls == null) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    if (previousGitTls == null) delete process.env.GIT_SSL_NO_VERIFY
    else process.env.GIT_SSL_NO_VERIFY = previousGitTls
  }
})
