import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { removeTempDir } from './lib/test-support/remove-temp-dir.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}

test('existing App routes mount the packaged shell without capturing pages or missing paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-preview-site-'))
  const appPage = join(dir, 'app', 'book', 'chapters', 'sampling.html')
  const staticPage = join(dir, 'static', 'book', 'chapters', 'sampling.html')
  mkdirSync(join(appPage, '..'), { recursive: true })
  mkdirSync(join(staticPage, '..'), { recursive: true })
  writeFileSync(join(dir, 'app.html'), '<html><body><div id="root"></div></body></html>')
  writeFileSync(appPage, '<html><body>canvas page</body></html>')
  writeFileSync(staticPage, '<html><body>static page</body></html>')

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/serve-static-dir.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, TLDA_STATIC_DIR: dir, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  try {
    const deadline = Date.now() + 10_000
    while (!output.includes('[static] serving')) {
      if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
      if (Date.now() > deadline) throw new Error(`server did not start: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const app = await request(port, '/app/book/chapters/sampling.html')
    assert.equal(app.status, 200)
    assert.match(app.body, /<div id="root"><\/div>/)
    assert.doesNotMatch(app.body, /canvas page/)

    const iframe = await request(port, '/app/book/chapters/sampling.html?_tldaShape=shape%3Apage')
    assert.equal(iframe.status, 200)
    assert.match(iframe.body, /canvas page/)

    const direct = await request(port, '/static/book/chapters/sampling.html')
    assert.equal(direct.status, 200)
    assert.match(direct.body, /static page/)
    assert.doesNotMatch(direct.body, /<div id="root"><\/div>/)

    const missing = await request(port, '/app/book/chapters/missing.html')
    assert.equal(missing.status, 404)
    assert.doesNotMatch(missing.body, /<div id="root"><\/div>/)

    const directoryWithoutIndex = await request(port, '/app/book')
    assert.equal(directoryWithoutIndex.status, 404)
    assert.doesNotMatch(directoryWithoutIndex.body, /<div id="root"><\/div>/)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
})
