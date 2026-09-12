import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:https'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { removeTempDir } from './test-support/remove-temp-dir.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

async function rawStatus(port, path) {
  return await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, rejectUnauthorized: false }, res => {
      res.resume()
      res.once('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
    req.end()
  })
}

test('a nested HTML book serves its directory index and referenced relative assets', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-html-book-assets-'))
  const projects = join(root, 'projects')
  const project = join(projects, 'qtm285-course')
  const chapterDir = join(project, 'output', '_book', 'homework')
  const assetsDir = join(project, 'output', '_book', 'site_libs', 'runtime')
  mkdirSync(chapterDir, { recursive: true })
  mkdirSync(assetsDir, { recursive: true })
  mkdirSync(join(project, 'source'), { recursive: true })
  writeFileSync(join(project, 'project.json'), JSON.stringify({ name: 'qtm285-course', title: 'Book', format: 'html' }))
  writeFileSync(join(project, 'output', 'page-info.json'), JSON.stringify([
    { file: '_book/homework/setup.html', width: 800, height: 1000, title: 'Setup' },
  ]))
  writeFileSync(join(chapterDir, 'setup.html'), `<!doctype html><html><head>
    <link href="../site_libs/runtime/app.css" rel="stylesheet">
    <script src="../site_libs/runtime/app.js"></script>
    </head><body>Setup</body></html>`)
  writeFileSync(join(assetsDir, 'app.css'), 'body { color: black; }')
  writeFileSync(join(assetsDir, 'app.js'), 'window.bookRuntime = true')
  writeFileSync(join(project, 'output', '_book', 'index.html'), '<!doctype html><title>Directory index</title>')

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: projects,
      TLDA_FLEET_DB: join(root, 'fleet.db'),
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    const bookUrl = `https://127.0.0.1:${port}/docs/qtm285-course/_book/`
    const book = await fetch(bookUrl)
    assert.equal(book.status, 200)
    assert.match(await book.text(), /Directory index/)

    const pageUrl = `https://127.0.0.1:${port}/docs/qtm285-course/_book/homework/setup.html`
    const page = await fetch(pageUrl, { dispatcher: undefined })
    assert.equal(page.status, 200)
    const html = await page.text()
    const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
      .map(match => match[1])
      .filter(ref => ref.includes('site_libs/'))
    assert.equal(references.length, 2)
    for (const reference of references) {
      const response = await fetch(new URL(reference, pageUrl))
      assert.equal(response.status, 200, `${reference} must resolve from its nested chapter`)
    }

    const missing = await fetch(`https://127.0.0.1:${port}/docs/qtm285-course/missing/`)
    assert.equal(missing.status, 404)

    assert.equal(
      await rawStatus(port, '/docs/qtm285-course/_book/../../project.json'),
      404,
    )
  } finally {
    await stopServer(child)
    removeTempDir(root)
  }
})
