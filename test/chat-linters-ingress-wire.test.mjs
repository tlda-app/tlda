import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from '../server/lib/fleet-store.mjs'

const SENDER = 'fleet:lint-sender'
const DEAD_RECIPIENT = 'fleet:lint-dead-end'
const HUMAN_SENDER = 'fleet:lint-human'

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
    if (Date.now() > deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function openSocket(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function sendChat(ws, payload, timeoutMs = 20_000) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no chat reply within ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'chat', id, _tempId: randomUUID(), ...payload }))
  })
}

function waitForHistoryBurst(ws, subId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no ${subId} history burst within ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.data?.subId !== subId) return
      if (message.event !== 'filter-events') return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message.data.events || [])
    }
    ws.on('message', onMessage)
  })
}

const SERVER_YAML_ON = [
  'chatLinters:',
  '  outlineFileBacked:',
  '    enabled: true',
  '',
].join('\n')

test('chat ingress enforces the explicit outline contract and nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-chat-linters-ingress-'))
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'daemon.yaml'), [
    'environments:',
    '  default: chat-linters-test',
    '  values:',
    '    chat-linters-test:',
    '      database: http://127.0.0.1:1',
    '      store: http://127.0.0.1:1',
    '      licenseKey: ""',
    '',
  ].join('\n'))
  const serverYamlPath = join(configDir, 'server.yaml')
  writeFileSync(serverYamlPath, SERVER_YAML_ON)

  const dbPath = join(root, 'fleet.sqlite')
  const seed = new FleetStore(dbPath, { taskDoc: false })
  const stamp = '2026-09-28T06:00:00.000Z'
  await seed.upsertAgent({
    id: SENDER, friendly_name: 'lint-sender', labels: [],
    registered_at: stamp, last_seen: stamp, dead: false, human: false,
  })
  // The non-delivering recipient: death stops delivery, not addressing, so an
  // accepted send is stored with a not-delivered receipt and wakes nobody.
  await seed.upsertAgent({
    id: DEAD_RECIPIENT, friendly_name: 'lint-dead-end', labels: [],
    registered_at: stamp, last_seen: stamp, dead: true, human: false,
  })
  await seed.upsertAgent({
    id: HUMAN_SENDER, friendly_name: 'lint-human', labels: [],
    registered_at: stamp, last_seen: stamp, dead: false, human: true,
  })
  seed.close()

  // Test-only boot shim, copied from activity-operation-idempotency-wire: some
  // shells deny os.setPriority (EACCES), which fleet-search-client treats as
  // fatal at server boot.
  const shimPath = join(root, 'setpriority-eacces-shim.cjs')
  writeFileSync(shimPath, `
const os = require('node:os')
const originalSetPriority = os.setPriority
os.setPriority = (...args) => {
  try {
    return originalSetPriority.apply(os, args)
  } catch (error) {
    if (error?.info?.code === 'EACCES' || /EACCES/.test(error?.message || '')) return
    throw error
  }
}
`)

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      PROJECTS_DIR: join(root, 'projects'), TLDA_FLEET_DB: dbPath,
      TLDA_CONFIG_DIR: configDir, TLDA_ENV: 'chat-linters-test', TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      NODE_OPTIONS: [`--require=${shimPath}`, process.env.NODE_OPTIONS].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let ws
  try {
    await waitForServer(child)
    ws = await openSocket(`ws://127.0.0.1:${port}/ws/fleet`)

    // 1. A marked outline with no source file is refused by name.
    const refusedMarked = await sendChat(ws, {
      message: '## plan\n\n- one\n- two\n', outline: true, to: DEAD_RECIPIENT, from: SENDER,
    })
    assert.ok(refusedMarked.error, `expected a refusal, got ${JSON.stringify(refusedMarked)}`)
    assert.match(String(refusedMarked.error), /outline-file-backed/)
    assert.match(String(refusedMarked.error), /no source file/)

    // 2. The same marked outline with a source file is accepted.
    const filedText = '## plan\n\n- one\n- two\n'
    const acceptedFiled = await sendChat(ws, {
      message: filedText, outline: true, to: DEAD_RECIPIENT, from: SENDER,
      source: { file: join(root, 'plan.md'), selector: '#plan' },
    })
    assert.ok(acceptedFiled.result?.ok, `expected acceptance, got ${JSON.stringify(acceptedFiled)}`)

    // 3. An ordinary long message is accepted: length gates nothing.
    const longText = `status ${'x'.repeat(2000)}`
    const acceptedLong = await sendChat(ws, { message: longText, to: DEAD_RECIPIENT, from: SENDER })
    assert.ok(acceptedLong.result?.ok, `expected long acceptance, got ${JSON.stringify(acceptedLong)}`)

    // 4. An ordinary flat list is accepted: shape gates nothing.
    const flatList = '- alpha\n- beta\n- gamma\n'
    const acceptedList = await sendChat(ws, { message: flatList, to: DEAD_RECIPIENT, from: SENDER })
    assert.ok(acceptedList.result?.ok, `expected list acceptance, got ${JSON.stringify(acceptedList)}`)

    // 5. Humans are never gated, even marked and fileless.
    const acceptedHuman = await sendChat(ws, {
      message: 'human outline', outline: true, to: DEAD_RECIPIENT, from: HUMAN_SENDER,
    })
    assert.ok(acceptedHuman.result?.ok, `expected human acceptance, got ${JSON.stringify(acceptedHuman)}`)

    // 6. Without the key, a marked fileless outline passes unchanged (config
    // is read per send, so no restart is needed to prove the unconfigured path).
    writeFileSync(serverYamlPath, '# no chatLinters key\n')
    const unconfiguredText = 'unconfigured marked outline'
    const acceptedUnconfigured = await sendChat(ws, {
      message: unconfiguredText, outline: true, to: DEAD_RECIPIENT, from: SENDER,
    })
    assert.ok(acceptedUnconfigured.result?.ok, `expected unconfigured acceptance, got ${JSON.stringify(acceptedUnconfigured)}`)

    // 7. The refused send stored nothing: the sender's history holds exactly
    // the accepted sends.
    const burstPromise = waitForHistoryBurst(ws, 'lint-history')
    ws.send(JSON.stringify({
      type: 'subscribe-filter', subId: 'lint-history', filter: [[['from', SENDER]]], window: 50,
    }))
    const history = await burstPromise
    const chats = history.filter(event => event.type === 'chat')
    assert.deepEqual(chats.map(event => event.text).sort(), [filedText, longText, flatList, unconfiguredText].sort())
  } finally {
    ws?.close()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
