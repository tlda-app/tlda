import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import projectRoutes from './projects.mjs'
import { closeProjectStore, initProjectStore } from '../lib/project-store.mjs'
import { createGitRemotes } from '../../shared/git-remotes.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8' })

test('remote routes expose token writeability and keep revision reads inside the Git tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-remotes-route-'))
  const projectsDir = join(root, 'projects')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.md'), '# inside\n')
  writeFileSync(join(root, 'outside.md'), '# outside\n')
  await git(checkout, ['add', 'main.md'])
  await git(checkout, ['commit', '-m', 'fixture'])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const remotes = createGitRemotes({ sourceDir: checkout })

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.authLevel = req.headers.authorization === 'Bearer read-token' ? 'read' : 'rw'
    next()
  })
  app.locals.sendProjectSourceDaemon = async (_project, _operation, params) => {
    if (params.operation === 'list') return []
    if (params.operation === 'read-file') return remotes.readFile(params.revision, params.file)
    throw new Error('unexpected operation')
  }
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  try {
    await initProjectStore(projectsDir)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api/projects`
    const created = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fixture', mainFile: 'main.md', format: 'markdown' }),
    })
    assert.equal(created.status, 201)

    const readList = await fetch(`${base}/fixture/remotes`, { headers: { authorization: 'Bearer read-token' } }).then(response => response.json())
    assert.equal(readList.writable, false)
    const rwList = await fetch(`${base}/fixture/remotes`, { headers: { authorization: 'Bearer rw-token' } }).then(response => response.json())
    assert.equal(rwList.writable, true)

    const inside = await fetch(`${base}/fixture/source/main.md?revision=${revision}`)
    assert.equal(inside.status, 200)
    assert.equal(await inside.text(), '# inside\n')
    const escaped = await fetch(`${base}/fixture/source/${encodeURIComponent('../outside.md')}?revision=${revision}`)
    assert.equal(escaped.status, 400)
    assert.doesNotMatch(await escaped.text(), /# outside/)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
