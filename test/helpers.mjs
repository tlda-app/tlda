/**
 * Shared test helpers for e2e tests.
 *
 * Provides: startServer, createProject, pushFile, waitForBuild.
 * Used by pipeline.test.mjs and annotations.test.mjs.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
export const ROOT = join(__dirname, '..')
export const SERVER_SCRIPT = join(ROOT, 'server', 'unified-server.mjs')
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Start a server on a test port with temp dirs. Returns control object. */
export function startServer(port = 15176) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tlda-test-data-'))
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-test-projects-'))

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        PROJECTS_DIR: projectsDir,
        PUBLIC_DIR: join(ROOT, 'server', 'public'),
        TLDA_NO_AUTH: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const logs = []

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Server did not start within 10s'))
    }, 10000)

    let started = false
    proc.stdout.on('data', (chunk) => {
      const line = chunk.toString()
      logs.push(line.trimEnd())
      if (!started && line.includes('running on')) {
        started = true
        clearTimeout(timeout)
        resolve({
          port,
          proc,
          dataDir,
          projectsDir,
          logs,
          base: `http://localhost:${port}`,
          dumpLogs(label = 'server') {
            const recent = logs.slice(-40).join('\n')
            console.log(`\n--- ${label} logs (last 40 lines) ---\n${recent}\n---\n`)
          },
          async cleanup() {
            proc.kill('SIGTERM')
            await new Promise(r => proc.on('exit', r))
            rmSync(dataDir, { recursive: true, force: true })
            rmSync(projectsDir, { recursive: true, force: true })
          },
        })
      }
    })

    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim()
      logs.push(`[stderr] ${msg}`)
      if (msg) console.log(`  [server stderr] ${msg}`)
    })

    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout)
        reject(new Error(`Server exited with code ${code} before binding`))
      }
    })
  })
}

/** Create a project on the test server. */
export async function createProject(base, name, mainFile = 'test.tex') {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title: name, mainFile }),
  })
  const data = await res.json()
  assert.equal(res.status, 201, `Create project failed: ${JSON.stringify(data)}`)
  return data
}

/** Push files to a project. files: [{ path, content, encoding? }] */
export async function pushFiles(base, name, files) {
  const res = await fetch(`${base}/api/projects/${name}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  const data = await res.json()
  assert.ok(res.ok, `Push failed: ${JSON.stringify(data)}`)
  return data
}

/** Push a single text file. */
export async function pushFile(base, name, filename, content) {
  return pushFiles(base, name, [{ path: filename, content }])
}

/** Poll build status until done. Returns final status. */
export async function waitForBuild(base, name, timeoutMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/projects/${name}/build/status`)
    const data = await res.json()
    if (data.status !== 'building') return data
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Build did not complete within ${timeoutMs / 1000}s`)
}
