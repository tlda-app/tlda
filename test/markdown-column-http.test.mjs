#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const SERVER_SCRIPT = join(ROOT, 'server', 'unified-server.mjs')
const PORT = 15191
const hasLocalTls = existsSync(join(homedir(), '.config', 'tlda', 'localhost+2.pem')) &&
  existsSync(join(homedir(), '.config', 'tlda', 'localhost+2-key.pem'))
if (hasLocalTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = `${hasLocalTls ? 'https' : 'http'}://localhost:${PORT}`

function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tlda-md-column-data-'))
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-md-column-projects-'))
  const fleetDb = join(dataDir, 'fleet.db')

  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['--import', 'tsx', SERVER_SCRIPT, '--i-am-tlda-cli'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        PROJECTS_DIR: projectsDir,
        TLDA_FLEET_DB: fleetDb,
        PUBLIC_DIR: join(ROOT, 'server', 'public'),
        TLDA_DEV_SERVER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Server did not start within 10s'))
    }, 10000)

    let started = false
    proc.stdout.on('data', chunk => {
      if (!started && chunk.toString().includes('running on')) {
        started = true
        clearTimeout(timeout)
        resolve({
          proc,
          async cleanup() {
            proc.kill('SIGTERM')
            await new Promise(r => { proc.on('exit', r); setTimeout(r, 3000) })
            rmSync(dataDir, { recursive: true, force: true })
            rmSync(projectsDir, { recursive: true, force: true })
          },
        })
      }
    })
    proc.on('exit', code => {
      if (!started) {
        clearTimeout(timeout)
        reject(new Error(`Server exited with code ${code}`))
      }
    })
  })
}

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, ok: res.ok, headers: res.headers, data }
}

async function waitForMarkdownBuild(name) {
  for (let i = 0; i < 50; i++) {
    const { data } = await request('GET', `/api/projects/${name}`)
    if (data?.buildStatus === 'success' && data?.pages > 0) return data
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${name} markdown build`)
}

test('markdown project columns are indexed and lazily served over /docs', { timeout: 30000 }, async () => {
  const server = await startServer()
  try {
    const id = '77777777-7777-4777-8777-777777777777'
    let response = await request('POST', '/api/projects', {
      name: 'world-md-http',
      title: 'World MD HTTP',
      mainFile: 'README.md',
      format: 'markdown',
    })
    assert.equal(response.status, 201)

    response = await request('POST', '/api/projects/world-md-http/push', {
      files: [
        {
          path: 'README.md',
          content: '# Main document\n\nOpen the [agent report](parts/report.md#agent-report).\n',
        },
        {
          path: 'parts/report.md',
          content: `---\ntlda-id: ${id}\ntlda-kind: artifact\n---\n\n# Agent report {#agent-report}\n\nArtifact body.\n`,
        },
        {
          path: '.tlda/parts.json',
          content: JSON.stringify({
            version: 1,
            parts: [{
              id,
              kind: 'artifact',
              title: 'Agent report',
              path: 'parts/report.md',
              storage: { type: 'project', path: 'parts/report.md' },
            }],
            externalAuthorities: [],
          }),
        },
      ],
    })
    assert.equal(response.status, 200)

    const project = await waitForMarkdownBuild('world-md-http')
    assert.equal(project.pages, 2)

    response = await request('GET', '/docs/world-md-http/page-info.json')
    assert.equal(response.status, 200)
    assert.deepEqual(response.data.map(page => page.file), ['index.html', 'parts/report.html'])
    assert.deepEqual(response.data.map(page => page.source.file), ['README.md', 'parts/report.md'])
    assert.equal(response.data[0].group, 'world-md-http-world')
    assert.equal(response.data[1].group, 'world-md-http-world')

    response = await request('GET', '/docs/world-md-http/parts/report.html')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /html/)
    assert.match(response.data, /Agent report/)
    assert.match(response.data, /Artifact body/)
    assert.doesNotMatch(response.data, /tlda-id/)

    response = await request('PUT', `/api/projects/world-md-http/parts/${id}/markdown`, {
      markdown: '# Agent report\n\nUpdated artifact body.\n',
      title: 'Agent report',
      actor: 'test',
      provenance: { source: 'markdown-column-http.test' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.ok, true)

    response = await request('GET', '/api/projects/world-md-http/build/status')
    assert.equal(response.status, 200)
    assert.equal(response.data.status, 'success')
    assert.doesNotMatch(response.data.log || '', /pdflatex|latexmk|BUILD FAILED/)

    response = await request('GET', '/docs/world-md-http/parts/report.html')
    assert.equal(response.status, 200)
    assert.match(response.data, /Updated artifact body/)
    assert.doesNotMatch(response.data, /Artifact body\./)
  } finally {
    await server.cleanup()
  }
})
