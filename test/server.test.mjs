#!/usr/bin/env node
/**
 * Server integration tests.
 *
 * Tests project CRUD, push/hashes, file deletion, build status.
 * Spins up a real server on a test port — no LaTeX, no browser.
 *
 * Usage:
 *   node --test test/server.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const SERVER_SCRIPT = join(ROOT, 'server', 'unified-server.mjs')

const PORT = 15177

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ctd-test-data-'))
  const projectsDir = mkdtempSync(join(tmpdir(), 'ctd-test-projects-'))

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        PROJECTS_DIR: projectsDir,
        PUBLIC_DIR: join(ROOT, 'server', 'public'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Server did not start within 10s'))
    }, 10000)

    let started = false
    proc.stdout.on('data', (chunk) => {
      if (!started && chunk.toString().includes('running on')) {
        started = true
        clearTimeout(timeout)
        resolve({
          proc, dataDir, projectsDir,
          async cleanup() {
            proc.kill('SIGTERM')
            await new Promise(r => { proc.on('exit', r); setTimeout(r, 3000) })
            rmSync(dataDir, { recursive: true, force: true })
            rmSync(projectsDir, { recursive: true, force: true })
          },
        })
      }
    })

    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout)
        reject(new Error(`Server exited with code ${code}`))
      }
    })
  })
}

const BASE = `http://localhost:${PORT}`

async function api(method, path, body = null) {
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
  return { status: res.status, ok: res.ok, data }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server', { timeout: 30000 }, () => {
  let server

  before(async () => {
    server = await startServer()
  })

  after(async () => {
    if (server) await server.cleanup()
  })

  // --- Health ---

  it('health endpoint returns ok + pid', async () => {
    const { data } = await api('GET', '/health')
    assert.ok(data.ok)
    assert.equal(typeof data.pid, 'number')
    assert.equal(typeof data.uptime, 'number')
  })

  // --- Project CRUD ---

  describe('project CRUD', () => {
    it('creates a project', async () => {
      const { status, data } = await api('POST', '/api/projects', {
        name: 'test-crud', title: 'Test', mainFile: 'main.tex',
      })
      assert.equal(status, 201)
      assert.equal(data.name, 'test-crud')
    })

    it('rejects duplicate create', async () => {
      const { status } = await api('POST', '/api/projects', {
        name: 'test-crud', title: 'Test', mainFile: 'main.tex',
      })
      assert.equal(status, 409)
    })

    it('rejects invalid names', async () => {
      const { status } = await api('POST', '/api/projects', {
        name: 'Bad Name!', title: 'Test', mainFile: 'main.tex',
      })
      assert.equal(status, 400)
    })

    it('lists projects', async () => {
      const { data } = await api('GET', '/api/projects')
      assert.ok(Array.isArray(data.projects))
      assert.ok(data.projects.some(p => p.name === 'test-crud'))
    })

    it('gets a project', async () => {
      const { data } = await api('GET', '/api/projects/test-crud')
      assert.equal(data.name, 'test-crud')
      assert.equal(data.mainFile, 'main.tex')
    })

    it('returns 404 for nonexistent project', async () => {
      const { status } = await api('GET', '/api/projects/nonexistent')
      assert.equal(status, 404)
    })

    it('deletes a project', async () => {
      // Create a throwaway
      await api('POST', '/api/projects', { name: 'test-delete', mainFile: 'x.tex' })
      const { status } = await api('DELETE', '/api/projects/test-delete')
      assert.equal(status, 200)

      const { status: s2 } = await api('GET', '/api/projects/test-delete')
      assert.equal(s2, 404)
    })
  })

  // --- Push + Hashes ---

  describe('push and hashes', () => {
    before(async () => {
      await api('POST', '/api/projects', { name: 'test-push', mainFile: 'main.tex' })
    })

    it('pushes files', async () => {
      const { data } = await api('POST', '/api/projects/test-push/push', {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}' },
          { path: 'refs.bib', content: '@article{foo}' },
        ],
      })
      assert.ok(data.ok)
      assert.equal(data.filesWritten, 2)
    })

    it('detects unchanged files when last build succeeded', async () => {
      // Create a fresh project and push files without triggering a build failure
      await api('POST', '/api/projects', { name: 'test-unchanged', mainFile: 'main.tex' })
      await api('POST', '/api/projects/test-unchanged/push', {
        files: [{ path: 'main.tex', content: 'hello' }],
      })
      // Wait for the build to settle (it will fail since no LaTeX, but that's fine)
      await new Promise(r => setTimeout(r, 1000))

      // Manually set buildStatus to success so we can test the unchanged path
      // (In real use, a successful LaTeX build sets this)
      const projectJsonPath = join(server.projectsDir, 'test-unchanged', 'project.json')
      const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'))
      project.buildStatus = 'success'
      const { writeFileSync: wf } = await import('node:fs')
      wf(projectJsonPath, JSON.stringify(project, null, 2))

      // Now push identical files — should be marked unchanged
      const { data } = await api('POST', '/api/projects/test-unchanged/push', {
        files: [{ path: 'main.tex', content: 'hello' }],
      })
      assert.ok(data.unchanged, 'identical push after success should be marked unchanged')
    })

    it('returns hashes', async () => {
      const { data } = await api('GET', '/api/projects/test-push/hashes')
      assert.ok(data.hashes)
      assert.ok(data.hashes['main.tex'])
      assert.ok(data.hashes['refs.bib'])
      assert.match(data.hashes['main.tex'], /^[0-9a-f]{32}$/)
    })

    it('hashes change when content changes', async () => {
      const { data: before } = await api('GET', '/api/projects/test-push/hashes')

      await api('POST', '/api/projects/test-push/push', {
        files: [{ path: 'main.tex', content: '\\documentclass{book}' }],
      })

      const { data: after } = await api('GET', '/api/projects/test-push/hashes')
      assert.notEqual(before.hashes['main.tex'], after.hashes['main.tex'])
      // refs.bib shouldn't change
      assert.equal(before.hashes['refs.bib'], after.hashes['refs.bib'])
    })

    it('lists source files', async () => {
      const { data } = await api('GET', '/api/projects/test-push/files')
      assert.ok(data.files.includes('main.tex'))
      assert.ok(data.files.includes('refs.bib'))
    })

    it('deletes files via push', async () => {
      // Add a file
      await api('POST', '/api/projects/test-push/push', {
        files: [{ path: 'extra.tex', content: 'extra' }],
      })

      // Verify it exists
      let { data } = await api('GET', '/api/projects/test-push/hashes')
      assert.ok(data.hashes['extra.tex'])

      // Delete it
      await api('POST', '/api/projects/test-push/push', {
        deletedFiles: ['extra.tex'],
      })

      // Verify it's gone
      ;({ data } = await api('GET', '/api/projects/test-push/hashes'))
      assert.equal(data.hashes['extra.tex'], undefined)
    })

    it('handles binary files (base64)', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const { data } = await api('POST', '/api/projects/test-push/push', {
        files: [{ path: 'fig.png', content: pngBytes.toString('base64'), encoding: 'base64' }],
      })
      assert.ok(data.ok)

      // Verify it's stored correctly
      const filePath = join(server.projectsDir, 'test-push', 'source', 'fig.png')
      assert.ok(existsSync(filePath))
      const stored = readFileSync(filePath)
      assert.deepEqual(stored, pngBytes)
    })
  })

  // --- Build status ---

  describe('build status', () => {
    it('returns status for project with no builds', async () => {
      await api('POST', '/api/projects', { name: 'test-status', mainFile: 'main.tex' })
      const { data } = await api('GET', '/api/projects/test-status/build/status')
      assert.ok(data.status) // 'none' or similar
    })

    it('returns errors endpoint', async () => {
      await api('POST', '/api/projects', { name: 'test-errors', mainFile: 'main.tex' })
      const { data } = await api('GET', '/api/projects/test-errors/build/errors')
      assert.ok(Array.isArray(data.errors))
      assert.ok(Array.isArray(data.warnings))
    })
  })

  // --- Edge cases ---

  describe('edge cases', () => {
    it('push to nonexistent project returns 404', async () => {
      const { status } = await api('POST', '/api/projects/nope/push', { files: [] })
      assert.equal(status, 404)
    })

    it('hashes for nonexistent project returns 404', async () => {
      const { status } = await api('GET', '/api/projects/nope/hashes')
      assert.equal(status, 404)
    })

    it('push with no files and no changes is ok', async () => {
      await api('POST', '/api/projects', { name: 'test-empty', mainFile: 'main.tex' })
      const { data } = await api('POST', '/api/projects/test-empty/push', { files: [] })
      assert.ok(data.ok || data.unchanged)
    })

    it('manifest includes all projects', async () => {
      const { data } = await api('GET', '/docs/manifest.json')
      assert.ok(data.documents)
      // Should include projects we created
      assert.ok(data.documents['test-push'] || data.documents['test-crud'])
    })

    it('server survives path traversal attempt', async () => {
      const { status } = await api('POST', '/api/projects/test-push/push', {
        files: [{ path: '../../../etc/passwd', content: 'hacked' }],
      })
      // Should fail (400 or 500), not write outside project dir
      assert.ok(status >= 400, 'path traversal should be rejected')

      // Server should still be alive
      const health = await api('GET', '/health')
      assert.ok(health.data.ok)
    })
  })
})
