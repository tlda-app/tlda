import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { processMessageText } from '../../shared/message-processing.mjs'
import { convertChatEvent } from '../../src/fleet/convert-chat-event.mjs'
import { renderChatLine } from '../../src/fleet/chat-render.mjs'
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

async function openSocket(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function waitForStoredChat(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no stored image chat within 20s')), 20_000)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      const events = message.event === 'filter-event'
        ? [message.data?.event]
        : message.event === 'filter-events' ? (message.data?.events || []) : []
      const event = events.find(candidate => candidate?.type === 'chat' && candidate.text === 'See ![plot](image#0).')
      if (!event) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(event)
    }
    ws.on('message', onMessage)
  })
}

test('short image reference crosses sender, chat socket, persistence, and renderer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-image-ref-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const uploadDir = join(dir, 'uploads')
  const imagePath = join(dir, 'plot.png')
  writeFileSync(imagePath, 'png')

  const store = new FleetStore(dbPath, { taskDoc: false })
  for (const [id, name] of [['fleet:image-sender', 'image-sender'], ['fleet:image-reader', 'image-reader']]) {
    await store.upsertAgent({
      id,
      friendly_name: name,
      labels: [],
      registered_at: '2026-08-15T00:00:00.000Z',
      last_seen: '2026-08-15T00:00:00.000Z',
      dead: false,
      human: true,
    })
  }
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
      TLDA_UPLOAD_DIR: uploadDir,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let ws
  try {
    await waitForServer(child)
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    let outgoing
    try {
      outgoing = await processMessageText(`See ![plot](${imagePath}).`, dir, `https://127.0.0.1:${port}`)
    } finally {
      if (previousTls == null) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    }
    assert.equal(outgoing.resolvedMessage, 'See ![plot](image#0).')
    assert.equal(outgoing.brokenPaths.length, 0)

    ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'subscribe-filter',
      subId: 'image-ref-wire',
      filter: [[['from', 'fleet:image-sender']]],
      window: 20,
    }))
    const storedPromise = waitForStoredChat(ws)
    ws.send(JSON.stringify({
      type: 'chat',
      from: 'fleet:image-sender',
      to: 'fleet:image-reader',
      message: outgoing.resolvedMessage,
      inline_attachments: outgoing.inlineAttachments,
    }))
    const stored = await storedPromise
    assert.equal(stored.text, 'See ![plot](image#0).')
    assert.doesNotMatch(stored.text, /\/Users\/|\/tmp\/|api\/file/)

    const message = convertChatEvent(stored)
    const html = renderChatLine(message, {
      agentLabel: id => id,
      getNickClass: () => '',
      isHumanId: () => true,
      getAgents: () => [],
      getTasks: () => [],
      tldaToken: null,
      renderMarkdown: text => text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">'),
    })
    assert.match(html, /<img alt="plot" src="https:\/\/127\.0\.0\.1:/)
    assert.doesNotMatch(html, /image#0|\/sender\/|tlda-image-ref-wire-[^/]+\/plot\.png/)
  } finally {
    ws?.close()
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
