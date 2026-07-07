import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function connectWs(url, wsOpts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOpts)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function fleetRpc(ws) {
  let seq = 0
  const pending = new Map()
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg.id || !pending.has(msg.id)) return
    pending.get(msg.id)(msg.result ?? msg)
    pending.delete(msg.id)
  })
  return (type, params = {}) => new Promise(resolve => {
    const id = `ref-${++seq}`
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, type, ...params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve(null)
      }
    }, 5000)
  })
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(intervalMs)
  }
}

function cleanup(label, fn) {
  try {
    fn()
  } catch (e) {
    // Best-effort cleanup: preserve the primary assertion failure.
    console.warn(`[inbox-reference-materialization-ws] cleanup failed for ${label}: ${e.message}`)
  }
}

test('chat attachment recipient refs fail visibly when recipient has no daemon route', async () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const port = 5500 + (process.pid % 1000)
  const db = path.join(os.tmpdir(), `inbox-ref-ws-${process.pid}.db`)
  const projects = path.join(os.tmpdir(), `inbox-ref-projects-${process.pid}`)
  const useTls = fs.existsSync(path.join(os.homedir(), '.config/tlda/localhost+2.pem'))
  const proto = useTls ? 'https' : 'http'
  const wsProto = useTls ? 'wss' : 'ws'
  const wsOpts = useTls ? { rejectUnauthorized: false } : {}
  const server = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      TLDA_FLEET_DB: db,
      PROJECTS_DIR: projects,
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout.on('data', d => { serverLog += d })
  server.stderr.on('data', d => { serverLog += d })
  let fleet
  let daemon
  const materializedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-ref-materialized-'))
  const materializedPath = path.join(materializedDir, 'repro.txt')
  const materializedMarkdownPath = path.join(materializedDir, 'report.md')
  const sourceProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-ref-source-project-'))
  const sourceMarkdownPath = path.join(sourceProjectRoot, 'shared-report.md')
  fs.writeFileSync(materializedPath, 'hello materialized')
  fs.writeFileSync(materializedMarkdownPath, '# Local markdown copy\n')
  fs.writeFileSync(sourceMarkdownPath, '# Shared markdown report\n\nBody from chat attachment.\n')
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`${proto}://127.0.0.1:${port}/api/health`)
        return res.ok
      } catch {
        return false
      }
    })

    fleet = await connectWs(`${wsProto}://127.0.0.1:${port}/ws/fleet`, wsOpts)
    daemon = await connectWs(`${wsProto}://127.0.0.1:${port}/ws/fleet-daemon`, wsOpts)
    daemon.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type !== 'rpc' || msg.op !== 'materialize-attachment') return
      daemon.send(JSON.stringify({
        type: 'rpc-reply',
        id: msg.id,
        result: {
          path: msg.name?.endsWith('.md') ? materializedMarkdownPath : materializedPath,
          size: fs.statSync(msg.name?.endsWith('.md') ? materializedMarkdownPath : materializedPath).size,
          sha256: msg.name?.endsWith('.md')
            ? '47d596a1c4e14c189b843978cd0c9306d999ad8ba13fa6d1dab3f3ae50601141'
            : '0e054778f190c28c18ccdb52a2fdaffd42c81ddaabda5302361ea6a6f3d288cc',
        },
      }))
    })
    daemon.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: 'test-machine',
      env_name: 'test',
      user: 'test',
      hostname: 'test-host',
      version: 'test',
      boot_id: Date.now(),
      install_path: root,
    }))
    const sendFleet = fleetRpc(fleet)
    const projectRes = await fetch(`${proto}://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'paper',
        title: 'Paper',
        mainFile: 'main.md',
        format: 'markdown',
        sourceDir: sourceProjectRoot,
      }),
    })
    assert.equal(projectRes.status, 201)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:sender', name: 'sender' }))?.ok, true)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:recipient', name: 'recipient' }))?.ok, true)
    assert.equal((await sendFleet('register', {
      agent_id: 'fleet:routed-recipient',
      name: 'routed-recipient',
      machine_id: 'test-machine',
      env_name: 'test',
      cwd: sourceProjectRoot,
    }))?.ok, true)

    const sent = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'Please inspect {{att:0}}',
      inline_attachments: [{
        type: 'file',
        id: 0,
        name: 'repro.txt',
        url: 'https://example.test/repro.txt',
        size: 5,
      }],
    })
    assert.equal(sent?.ok, true)

    const message = await waitFor(async () => {
      const inbox = await sendFleet('my-task', { agent: 'fleet:recipient', peek: true })
      const msg = inbox?.messages?.find(m => m.id === sent.event_ids[0])
      const ref = msg?.metadata?.recipient_refs?.['fleet:recipient']?.attachments?.['0']
      return ref?.state === 'failed' ? msg : null
    })
    const ref = message.metadata.recipient_refs['fleet:recipient'].attachments['0']
    assert.equal(ref.state, 'failed')
    assert.equal(ref.status, 'failed')
    assert.equal(ref.kind, 'attachment')
    assert.equal(ref.sourceAgent, 'fleet:sender')
    assert.match(ref.error, /daemon address|no fleet-daemon connected|op=materialize-attachment/)
    assert.equal(ref.localPath, null)

    const routed = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'routed-recipient',
      message: 'Please inspect {{att:0}}',
      inline_attachments: [{
        type: 'file',
        id: 0,
        name: 'repro.txt',
        url: 'https://example.test/repro.txt',
        size: 5,
      }],
    })
    assert.equal(routed?.ok, true)
    const routedMessage = await waitFor(async () => {
      const inbox = await sendFleet('my-task', { agent: 'fleet:routed-recipient', peek: true })
      const msg = inbox?.messages?.find(m => m.id === routed.event_ids[0])
      const routedRef = msg?.metadata?.recipient_refs?.['fleet:routed-recipient']?.attachments?.['0']
      return routedRef?.state === 'available' ? msg : null
    })
    const routedRef = routedMessage.metadata.recipient_refs['fleet:routed-recipient'].attachments['0']
    assert.equal(routedRef.localPath, materializedPath)
    assert.equal(routedRef.status, 'ready')
    assert.equal(routedRef.kind, 'attachment')
    assert.equal(routedRef.sourceAgent, 'fleet:sender')
    assert.equal(routedRef.projectArtifactId, null)
    assert.equal(routedRef.projectPath, null)
    assert.equal(fs.readFileSync(routedRef.localPath, 'utf8'), 'hello materialized')

    const markdownRouted = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'routed-recipient',
      message: 'Please inspect markdown {{att:0}}',
      inline_attachments: [{
        type: 'file',
        id: 0,
        name: 'shared-report.md',
        url: `${proto}://127.0.0.1:${port}/api/file?path=${encodeURIComponent(sourceMarkdownPath)}`,
        mimeType: 'text/markdown',
        size: fs.statSync(sourceMarkdownPath).size,
      }],
    })
    assert.equal(markdownRouted?.ok, true)
    const markdownMessage = await waitFor(async () => {
      const inbox = await sendFleet('my-task', { agent: 'fleet:routed-recipient', peek: true })
      const msg = inbox?.messages?.find(m => m.id === markdownRouted.event_ids[0])
      const markdownRef = msg?.metadata?.recipient_refs?.['fleet:routed-recipient']?.attachments?.['0']
      return markdownRef?.state === 'available' && markdownRef?.projectArtifactId ? msg : null
    })
    const markdownRef = markdownMessage.metadata.recipient_refs['fleet:routed-recipient'].attachments['0']
    assert.equal(markdownRef.localPath, materializedMarkdownPath)
    assert.equal(markdownRef.projectArtifactStatus, 'ready')
    assert.equal(markdownRef.project, 'paper')
    assert.equal(markdownRef.projectPath, `parts/${markdownRef.projectArtifactId.replace(/-/g, '').slice(0, 8)}.md`)
    const projectArtifactPath = path.join(projects, 'paper', 'source', markdownRef.projectPath)
    assert.equal(fs.existsSync(projectArtifactPath), true)
    const projectArtifact = fs.readFileSync(projectArtifactPath, 'utf8')
    assert.match(projectArtifact, new RegExp(`tlda-id: ${markdownRef.projectArtifactId}`))
    assert.match(projectArtifact, /tlda-kind: artifact/)
    assert.match(projectArtifact, /# Shared markdown report/)
    const manifest = JSON.parse(fs.readFileSync(path.join(projects, 'paper', 'source', '.tlda', 'parts.json'), 'utf8'))
    const manifestPart = manifest.parts.find(part => part.id === markdownRef.projectArtifactId)
    assert.equal(manifestPart.kind, 'artifact')
    assert.equal(manifestPart.path, markdownRef.projectPath)
  } catch (e) {
    e.message = `${e.message}\nserver log:\n${serverLog.slice(-2000)}`
    throw e
  } finally {
    cleanup('fleet ws', () => fleet?.close())
    cleanup('daemon ws', () => daemon?.close())
    cleanup('server process', () => server.kill('SIGKILL'))
    cleanup('materialized dir', () => fs.rmSync(materializedDir, { recursive: true, force: true }))
    cleanup('source project dir', () => fs.rmSync(sourceProjectRoot, { recursive: true, force: true }))
    cleanup('projects dir', () => fs.rmSync(projects, { recursive: true, force: true }))
    cleanup('db', () => fs.rmSync(db, { force: true }))
    cleanup('db wal', () => fs.rmSync(`${db}-wal`, { force: true }))
    cleanup('db shm', () => fs.rmSync(`${db}-shm`, { force: true }))
  }
})
