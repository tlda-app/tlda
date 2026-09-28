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

const BEATS_BODY = [
  '## the-beats',
  '',
  '**The pitch.** A statistical claim only means something with a coherent account of randomness.',
  '**Why it matters.** Policy evidence comes from panel data.',
  '**The problem.** Intervals refer to a mechanism nobody can think about.',
  '**The answer.** Put the randomness in the adoption instead.',
  '**Why it is right.** Beliefs become claims about the setting.',
  '**It subsumes.** Experiments are the special case.',
  '**It is a program.** Which imaginations are defensible is open.',
  '**What this adds.** Staggered adoption is the work proposed.',
  '**The measure.** The warm-up case took everything I had.',
].join('\n')

const SERVER_YAML_ON = [
  'chatLinters:',
  '  fileBackedComposition:',
  '    enabled: true',
  '    minChars: 100',
  '  outlineDepth:',
  '    enabled: true',
  '',
].join('\n')

test('chat ingress enforces configured linters, stores the rest, and ignores absent config', async () => {
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

    // 1. Long inline chat with no source file is refused by name.
    const longInline = `background ${'x'.repeat(500)}`
    const refusedLong = await sendChat(ws, { message: longInline, to: DEAD_RECIPIENT, from: SENDER })
    assert.ok(refusedLong.error, `expected a refusal, got ${JSON.stringify(refusedLong)}`)
    assert.match(String(refusedLong.error), /file-backed-composition/)
    assert.match(String(refusedLong.error), /file.*selector/)

    // 2. A filed flat outline is refused as a list, not an outline.
    const refusedBeats = await sendChat(ws, {
      message: BEATS_BODY, to: DEAD_RECIPIENT, from: SENDER,
      source: { file: join(root, 'beats.md'), selector: '#the-beats' },
    })
    assert.ok(refusedBeats.error, `expected a refusal, got ${JSON.stringify(refusedBeats)}`)
    assert.match(String(refusedBeats.error), /outline-depth/)
    assert.match(String(refusedBeats.error), /single structural depth/)

    // 3. Short chat passes and is stored (to the dead end: accepted, never delivered).
    const shortText = 'short status: still working'
    const acceptedShort = await sendChat(ws, { message: shortText, to: DEAD_RECIPIENT, from: SENDER })
    assert.ok(acceptedShort.result?.ok, `expected acceptance, got ${JSON.stringify(acceptedShort)}`)
    assert.equal(acceptedShort.result.event_ids?.length, 1)

    // 4. Humans are never gated.
    const humanLong = `human background ${'y'.repeat(500)}`
    const acceptedHuman = await sendChat(ws, { message: humanLong, to: DEAD_RECIPIENT, from: HUMAN_SENDER })
    assert.ok(acceptedHuman.result?.ok, `expected human acceptance, got ${JSON.stringify(acceptedHuman)}`)

    // 5. Without the key, long inline chat passes unchanged (config is read per
    // send, so no restart is needed to prove the unconfigured path).
    writeFileSync(serverYamlPath, '# no chatLinters key\n')
    const unconfiguredLong = `unconfigured ${'z'.repeat(500)}`
    const acceptedUnconfigured = await sendChat(ws, { message: unconfiguredLong, to: DEAD_RECIPIENT, from: SENDER })
    assert.ok(acceptedUnconfigured.result?.ok, `expected unconfigured acceptance, got ${JSON.stringify(acceptedUnconfigured)}`)

    // 6. The refused sends stored nothing: the sender's history holds exactly
    // the two accepted sends, and neither refused body appears.
    const burstPromise = waitForHistoryBurst(ws, 'lint-history')
    ws.send(JSON.stringify({
      type: 'subscribe-filter', subId: 'lint-history', filter: [[['from', SENDER]]], window: 50,
    }))
    const history = await burstPromise
    const chats = history.filter(event => event.type === 'chat')
    assert.deepEqual(chats.map(event => event.text).sort(), [shortText, unconfiguredLong].sort())
  } finally {
    ws?.close()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
