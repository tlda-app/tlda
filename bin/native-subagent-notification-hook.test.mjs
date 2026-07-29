import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const hookPath = new URL('./native-subagent-notification-hook.mjs', import.meta.url)

test('UserPromptSubmit hook injects route metadata without copying the message body', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'tlda-native-hook-'))
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/fleet/native-subagent-notifications/fleet%3Aparent')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      ok: true,
      notifications: [{
        event_id: 42,
        child_agent_id: 'fleet:child',
        child_name: 'parent:worker',
        sender_name: 'skip',
        native_agent_id: 'worker',
        harness: 'codex',
      }],
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  writeFileSync(join(configDir, 'daemon.yaml'), `
environments:
  default: testing
  values:
    testing:
      database: http://127.0.0.1:${port}
      store: http://127.0.0.1:${port}
      licenseKey: ""
`)

  try {
    const child = spawn(process.execPath, [hookPath.pathname], {
      env: {
        ...process.env,
        FLEET_ID: 'fleet:parent',
        FLEET_DAEMON_KEY: 'test:testing',
        TLDA_CONFIG_DIR: configDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end('{}')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise(resolve => child.on('close', resolve))

    assert.equal(exitCode, 0)
    assert.equal(stderr, '')
    assert.match(stdout, /Pending native-subagent delivery obligations/)
    assert.match(stdout, /event 42/)
    assert.match(stdout, /thread\(agent: "fleet:child"\)/)
    assert.match(stdout, /agent id worker/)
    assert.doesNotMatch(stdout, /message body/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(configDir, { recursive: true, force: true })
  }
})
