import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import express from 'express'

import { createGitHttpHandler } from './git-http.mjs'
import { encodeRefComponent } from './source-git-store.mjs'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore } from './project-store.mjs'

const execFileAsync = promisify(execFile)

function git(cwd, args) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

test('authenticated Git HTTP admits one immutable proposal without moving shared head', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-http-'))
  const checkout = join(root, 'checkout')
  const project = 'paper'
  const daemonId = 'mini-test'
  const admitted = []
  let server
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    const lifecycle = await sourceLifecycleStore(project)
    const sourceGit = await lifecycle.gitRepository()
    const sharedHead = await sourceGit.acceptRevision({
      project,
      files: [{ path: 'main.tex', content: 'base\n' }],
      message: 'shared base',
    })
    await sourceGit.advanceHead(project, sharedHead, null)
    const app = express()
    app.use(createGitHttpHandler({
      validateToken: token => token === 'secret' ? 'rw' : null,
      repositoryForProject: async name => (await sourceLifecycleStore(name)).gitRepository(),
      admitProposal: async proposal => { admitted.push(proposal) },
    }))
    server = createServer(app)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const remote = `http://${daemonId}:secret@127.0.0.1:${server.address().port}/git/${project}`

    const repository = await lifecycle.gitRepository()
    await git(root, ['clone', '--quiet', '--no-checkout', repository.gitDir, checkout])
    await git(checkout, ['checkout', '--quiet', '-b', 'work', sharedHead])
    writeFileSync(join(checkout, 'main.tex'), 'proposal\n')
    await git(checkout, ['add', 'main.tex'])
    await git(checkout, ['commit', '--quiet', '-m', 'proposal'])
    const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
    const ref = `refs/tlda/proposals/${encodeRefComponent(daemonId)}/work/${revision}`
    const pushed = await git(checkout, ['push', remote, `HEAD:${ref}`])
    assert.match(`${pushed.stdout}\n${pushed.stderr}`, /SubmittedToBuildQueue/)

    assert.equal(await repository.head(project), sharedHead)
    assert.deepEqual(admitted.map(item => ({
      project: item.project, daemonId: item.daemonId, branch: item.branch, revision: item.revision,
    })), [{ project, daemonId, branch: 'work', revision }])
  } finally {
    if (server) {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
    }
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
