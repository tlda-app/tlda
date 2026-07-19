import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = process.env.TLDA_STARTUP_SMOKE_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('unified server completes module initialization and serves health', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-startup-smoke-'))
  const configDir = path.join(root, 'config')
  const projectsDir = path.join(root, 'projects')
  const dataDir = path.join(root, 'data')
  const port = await reservePort()
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    defaultConfig: 'smoke',
    configs: {
      smoke: {
        database: `http://127.0.0.1:${port}`,
        store: `http://127.0.0.1:${port}`,
        licenseKey: '',
      },
    },
  }))

  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: projectsDir,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DEV_SERVER: '1',
      TLDA_FLEET_DB: path.join(root, 'fleet.db'),
      TLDA_TLS_CERT: path.join(root, 'no-cert.pem'),
      TLDA_TLS_KEY: path.join(root, 'no-key.pem'),
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      TLDA_SESSION_BACKFILL_STARTUP_DELAY_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not reach listen:\n${output}`)), 12_000)
      const inspect = () => {
        if (output.includes('Unified server running on')) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`server exited before listen (${code ?? signal}):\n${output}`))
      })
    })
    let health = null
    let lastError = null
    for (let attempt = 0; attempt < 20 && !health; attempt++) {
      if (child.exitCode != null) throw new Error(`server exited after listen (${child.exitCode}):\n${output}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        if (response.status === 200) health = await response.json()
      } catch (error) {
        lastError = error
      }
      if (!health) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(health, `health did not become ready (${lastError?.message || 'no response'}):\n${output}`)
    assert.equal(health.ok, true)
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
