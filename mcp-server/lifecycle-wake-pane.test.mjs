import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Stub fleet server for /api/capture-pane. Mode flips per test: 'ok' returns a
// fixed pane, 'fail' returns a 500 so capturePaneText reports { ok: false }.
let captureMode = 'ok'
const PANE_TEXT = 'agent-x-harness$ tlda status\nawake, 1 task open'
const stub = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/capture-pane') {
    req.resume()
    req.on('end', () => {
      if (captureMode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ pane: PANE_TEXT }))
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tmux session gone' }))
      }
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not stubbed' }))
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubUrl = `http://127.0.0.1:${stub.address().port}`
test.after(() => { stub.close() })

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'lifecycle-wake-pane-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'lifecycle-wake-pane-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: lifecycle-wake-pane-test',
  '  values:',
  '    lifecycle-wake-pane-test:',
  `      database: ${stubUrl}`,
  `      store: ${stubUrl}`,
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

__setFleetTransportForTest({
  // The wake RPC itself succeeds — the pane read is what fails.
  durable: async (operation, payload) => {
    assert.equal(operation, 'spawn')
    assert.equal(payload.agent, 'agent-x')
    return { agent: 'agent-x' }
  },
  ephemeral: async (operation) => { throw new Error(`unexpected ephemeral operation ${operation}`) },
})

test('a wake whose terminal cannot be read is unverified, not confirmed', async () => {
  captureMode = 'fail'
  const result = await handleFleetTool('lifecycle', { action: 'wake', agent: 'agent-x' })
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /^Lifecycle wake unverified:/)
  assert.match(text, /Do not treat agent-x as reachable/)
  assert.match(text, /tmux session gone/)
  assert.doesNotMatch(text, /^wake agent-x\./m)
})

test('a wake with a readable terminal keeps its exact success shape', async () => {
  captureMode = 'ok'
  const result = await handleFleetTool('lifecycle', { action: 'wake', agent: 'agent-x' })
  assert.equal(result.isError, undefined)
  const text = result.content[0].text
  const m = text.match(/^wake agent-x\.\n\nI, tlda, looked at agent-x's terminal at (\S+) and it looked like this:\n\n```\n([\s\S]*)\n```\n\nThat is what the terminal held at (\S+)\. It could have changed since\.\nTo look again, say: terminal\(agent: "agent-x"\)$/)
  assert.ok(m, `success shape changed:\n${text}`)
  assert.equal(m[1], m[3])
  assert.equal(m[2], PANE_TEXT)
})
