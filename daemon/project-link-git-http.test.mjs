import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import projectRoutes from '../server/routes/projects.mjs'
import { createGitHttpHandler } from '../server/lib/git-http.mjs'
import { closeProjectStore, initProjectStore, sourceLifecycleStore } from '../server/lib/project-store.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'

test('new local project initializes its remote, then materializes only by daemon Git proposal', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-link-git-http-'))
  const projectsDir = join(root, 'projects')
  const checkout = join(root, 'checkout')
  const admitted = []
  const forbiddenRequests = []
  let server
  let manager
  try {
    await initProjectStore(projectsDir)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (/source-room\/files|source-snapshot/.test(req.url)) forbiddenRequests.push(req.url)
      next()
    })
    app.use('/api/projects', projectRoutes)
    app.use(createGitHttpHandler({
      validateToken: value => value === 'secret' ? 'rw' : null,
      repositoryForProject: async project => (await sourceLifecycleStore(project)).gitRepository(),
      admitProposal: async proposal => { admitted.push(proposal) },
    }))
    server = createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'paper', mainFile: 'main.tex', format: 'svg' }),
    })
    assert.equal(created.status, 201)
    assert.equal(existsSync(join(projectsDir, 'paper', '.source-lifecycle', 'git', 'HEAD')), true, '201 must follow remote initialization')

    mkdirSync(checkout)
    writeFileSync(join(checkout, 'main.tex'), '\\documentclass{article}\\begin{document}linked\\end{document}\n')
    const watcher = new EventEmitter()
    watcher.close = async () => {}
    manager = createGitSyncManager({
      bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-link', server: base, token: 'secret',
      watch: () => watcher, quietMs: 10, log: { info() {}, warn() {}, error() {} },
    })
    manager.bindSource('paper', checkout)
    await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
    const submission = await manager.submit('paper')
    assert.equal(submission.status, 'SubmittedToBuildQueue')
    assert.equal(admitted.length, 1)
    assert.equal(admitted[0].revision, submission.revision)
    assert.deepEqual(forbiddenRequests, [])
  } finally {
    await manager?.closeAll()
    if (server?.listening) {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
    }
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
