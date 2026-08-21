import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { startServer, stopServer, unusedPort } from '../server/lib/unified-server-test-harness.mjs'
import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

function sourceWatcher() {
  const watcher = new EventEmitter()
  watcher.add = () => {}
  watcher.unwatch = async () => {}
  watcher.close = async () => {}
  return watcher
}

function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

test('a native PDF root reaches a visible searchable document through the daemon Git path', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-native-pdf-git-visible-'))
  const checkout = join(root, 'checkout')
  const projectsDir = join(root, 'projects')
  const project = 'native-pdf-document'
  const port = await unusedPort()
  const base = `https://127.0.0.1:${port}`
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const previousGitTls = process.env.GIT_SSL_NO_VERIFY
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  process.env.GIT_SSL_NO_VERIFY = '1'
  let server
  let manager
  let phase = 'fixture setup'
  try {
    mkdirSync(checkout)
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'book.pdf'), minimalPdf('Native PDF Git path'))
    await git(checkout, ['add', 'book.pdf'])
    await git(checkout, ['commit', '-m', 'native PDF root'])

    phase = 'server startup'
    server = await startServer({ port, projectsDir, fleetDb: join(root, 'fleet.db') })
    phase = 'project creation'
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: project, title: 'Native PDF document', mainFile: 'book.pdf',
        sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged',
      }),
    })
    assert.equal(created.status, 201, await created.text())

    phase = 'ordinary daemon Git submission'
    manager = createGitSyncManager({
      bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-native-pdf', server: base,
      token: 'fixture-token', watch: () => sourceWatcher(), quietMs: 10,
      log: { info() {}, warn() {}, error() {} },
    })
    manager.bindSource(project, checkout)
    await manager.sync([{ name: project, mainFile: 'book.pdf', format: 'pdf', sourceFormat: 'pdf' }])
    const submission = await manager.submit(project)
    assert.equal(submission.status, 'SubmittedToBuildQueue')

    phase = 'build fixed point'
    let projectView
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      projectView = await fetch(`${base}/api/projects/${project}`).then(response => response.json())
      if (projectView.buildStatus === 'success' && projectView.sourceRevision === submission.revision) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(projectView.buildStatus, 'success', JSON.stringify({ phase, projectView, output: server.output() }))
    assert.equal(projectView.sourceRevision, submission.revision)
    assert.equal(Object.hasOwn(projectView, 'format'), false, 'PDF must not create a project type')
    assert.deepEqual(
      { sourceFormat: projectView.sourceFormat, renderer: projectView.renderer, documentFormat: projectView.documentFormat },
      { sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' },
    )

    phase = 'published artifacts'
    const manifest = await fetch(`${base}/docs/${project}/document-manifest.json`).then(response => response.json())
    assert.equal(manifest.pages.length, 1)
    assert.equal(manifest.sourceMapping, 'none')
    assert.equal(existsSync(join(projectsDir, project, 'output', 'book.pdf')), true)
    assert.equal(existsSync(join(projectsDir, project, 'output', manifest.pages[0].file)), true)
    const geometry = JSON.parse(readFileSync(join(projectsDir, project, 'output', manifest.pages[0].textGeometry), 'utf8'))
    assert.match(geometry.text, /Native PDF Git path/)

    phase = 'canonical Git root'
    const sourceRepo = join(projectsDir, project, '.source-lifecycle', 'git')
    const stored = await git(sourceRepo, ['show', `${submission.revision}:book.pdf`])
    assert.equal(stored.stdout.startsWith('%PDF-1.4'), true)
  } catch (error) {
    error.message = `${phase}: ${error.message}`
    throw error
  } finally {
    await manager?.stop?.()
    if (server) await stopServer(server)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    if (previousGitTls === undefined) delete process.env.GIT_SSL_NO_VERIFY
    else process.env.GIT_SSL_NO_VERIFY = previousGitTls
    rmSync(root, { recursive: true, force: true })
  }
})
