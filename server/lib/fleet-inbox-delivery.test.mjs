import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import {
  formatInboxContent,
  formatInboxText,
  resolveInboxMessage,
  resolveMarkdownImagesForMcp,
} from '../../mcp-server/fleet-tools.mjs'
import { FleetStore } from './fleet-store.mjs'

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

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

test('the inbox delivery projection returns and acknowledges direct chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-inbox-delivery-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const delivered = await store.insertEventRecord({
      type: 'chat',
      from: 'fleet:skip',
      to: 'fleet:recipient',
      text: 'delivery proof',
      metadata: { priority: 'urgent' },
      unread: true,
    }, { notify: false })
    await store.insertEventRecord({
      type: 'chat',
      from: 'fleet:skip',
      to: 'fleet:recipient',
      text: 'already handled',
      unread: false,
    }, { notify: false })

    assert.equal(store.getInboxDeliveryCount('fleet:recipient'), 1)
    const rows = store.getInboxDeliveriesLimited('fleet:recipient', 50)
    assert.deepEqual(rows.map(row => row.id), [Number(delivered.id)])
    assert.equal(rows[0].text, 'delivery proof')

    assert.deepEqual(store.markEventsRead('fleet:recipient', [delivered.id]), [Number(delivered.id)])
    assert.equal(store.getInboxDeliveryCount('fleet:recipient'), 0)
    assert.deepEqual(store.getInboxDeliveriesLimited('fleet:recipient', 50), [])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all inbox formatting includes a delivered user message', async () => {
  const message = await resolveInboxMessage({
    id: 42,
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:recipient',
    text: 'visible in all',
    metadata: {},
  }, {
    resolveChipTokens: async text => ({ text, images: [] }),
    resolveTheoremRefs: text => text,
    resolveImages: async text => ({ text, images: [] }),
  })

  const rendered = formatInboxText({
    mode: 'all',
    task: null,
    tasks: [],
    messages: [message],
    counts: { messages: 1 },
  })
  assert.match(rendered, /ALL ACTIVE INBOX/)
  assert.match(rendered, /visible in all/)
  assert.match(rendered, /fleet:skip/)
})

test('MCP inbox injects markdown image content instead of a not-pre-materialized URL placeholder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-inbox-image-'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  const resolveImages = text => resolveMarkdownImagesForMcp(text, {
    tmpDir: dir,
    now: () => 1234,
    fetcher: async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    }),
  })

  try {
    const message = await resolveInboxMessage({
      id: 44,
      type: 'chat',
      from: 'fleet:skip',
      to: 'fleet:recipient',
      text: 'see this ![screenshot](https://example.test/screenshot.png)',
      metadata: {},
    }, {
      resolveChipTokens: async text => ({ text, images: [] }),
      resolveTheoremRefs: text => text,
      resolveImages,
    })

    const rendered = formatInboxText({
      mode: 'all',
      task: null,
      tasks: [],
      messages: [message],
      counts: { messages: 1 },
    })
    const content = formatInboxContent({ text: rendered, messages: [message] })

    assert.doesNotMatch(content[0].text, /not pre-materialized/)
    assert.match(content[0].text, /image attached: screenshot/)
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].mimeType, 'image/png')
    assert.equal(content[1].data, png.toString('base64'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP inbox reports the exact markdown image pre-materialization failure', async () => {
  const message = await resolveInboxMessage({
    id: 45,
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:recipient',
    text: 'broken ![screenshot](https://example.test/screenshot.png)',
    metadata: {},
  }, {
    resolveChipTokens: async text => ({ text, images: [] }),
    resolveTheoremRefs: text => text,
    resolveImages: text => resolveMarkdownImagesForMcp(text, {
      fetcher: async () => new Response('nope', { status: 503 }),
    }),
  })

  assert.match(message.line, /image: screenshot not pre-materialized: HTTP 503/)
  const content = formatInboxContent({ text: message.line, messages: [message] })
  assert.equal(content.length, 1)
})

test('my-task delivers unread messages and ack-inbox clears only returned ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-inbox-ws-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const delivered = await store.insertEventRecord({
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:recipient',
    text: 'websocket delivery proof',
    unread: true,
  }, { notify: false })
  store.close()

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const before = await request(ws, 1, 'my-task', { agent: 'fleet:recipient', peek: true })
    assert.deepEqual(before.messages.map(message => message.id), [Number(delivered.id)])
    assert.equal(before.counts.messages, 1)

    const ack = await request(ws, 2, 'ack-inbox', {
      agent: 'fleet:recipient',
      event_ids: [delivered.id],
    })
    assert.deepEqual(ack.event_ids, [Number(delivered.id)])

    const after = await request(ws, 3, 'my-task', { agent: 'fleet:recipient', peek: true })
    assert.deepEqual(after.messages, [])
    assert.equal(after.counts.messages, 0)
    ws.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chat reply names a resolved recipient with no direct subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-inbox-no-direct-subscription-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', labels: [], registered_at: now, last_seen: now })
  store.close()

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const sent = await request(ws, 1, 'chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'delivery without a direct subscription',
      _tempId: 'no-direct-subscription-proof',
    })

    assert.equal(sent.ok, true)
    assert.deepEqual(sent.recipients, ['fleet:recipient'])
    assert.deepEqual(sent.receipts, [{
      recipient: 'fleet:recipient',
      status: 'available',
      tag: null,
      priority: 'normal',
      delivery: 'no_direct_subscription',
      deliveryChannel: 'channel',
      wokeRecipient: 'no',
      notifyBy: null,
      reason: 'no matching direct subscription',
    }])

    const inbox = await request(ws, 2, 'my-task', { agent: 'fleet:recipient', peek: true })
    assert.deepEqual(inbox.messages.map(message => message.id), sent.event_ids)
    assert.equal(inbox.messages[0].metadata.recipient_delivery[0].delivery, 'no_direct_subscription')
    assert.equal(inbox.messages[0].metadata.recipient_delivery[0].reason, 'no matching direct subscription')
    ws.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
