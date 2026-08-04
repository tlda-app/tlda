#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const configDir = mkdtempSync(path.join(os.tmpdir(), 'tlda-session-contract-'))
const childId = 'fleet:session-contract-child'
const childName = 'session-contract-child'
const parentId = 'fleet:session-contract-parent'
const seen = []

const server = http.createServer((req, res) => {
  if (req.url?.startsWith(`/api/fleet/native-subagent-binding/${encodeURIComponent(parentId)}/`)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ child_agent_id: childId, child_name: childName }))
    return
  }
  res.writeHead(404)
  res.end()
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
wss.on('connection', ws => {
  let authenticatedId = null
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    seen.push({ type: message.type, authenticatedId })
    const reply = result => ws.send(JSON.stringify({ id: message.id, result }))
    const reject = error => ws.send(JSON.stringify({ id: message.id, error }))
    if (message.type === 'login') {
      authenticatedId = message.agent_id
      reply({ ok: true, agent: { id: childId, friendly_name: childName } })
      return
    }
    if (!authenticatedId) {
      reject('spawn requires an authenticated fleet WS identity; call login() first')
      return
    }
    if (message.type === 'spawn') {
      reply({ ok: true, agent_id: 'fleet:session-contract-minted', mailbox_id: 'mailbox:test' })
      return
    }
    if (message.type === 'delegate') {
      reply({ ok: true, task_id: 'task:session-contract' })
      return
    }
    if (message.type === 'resolve-agent') {
      reply({ agent: { id: message.agent, friendly_name: 'session-contract-minted' } })
      return
    }
    reply({ ok: true })
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${address.port}`
writeFileSync(path.join(configDir, 'daemon.yaml'), `machineId: session-contract-test\nenvironments:\n  default: test\n  values:\n    test:\n      database: ${base}\n      store: ${base}\n      licenseKey: ""\n`)

Object.assign(process.env, {
  FLEET_ID: parentId,
  TLDA_CONFIG_DIR: configDir,
  TLDA_DAEMON_CONFIG_DIR: configDir,
  TLDA_ENV: 'test',
})

try {
  const { handleFleetTool, initFleet } = await import('../mcp-server/fleet-tools.mjs')
  initFleet({})
  const context = { threadId: 'native-session-contract-thread' }
  const login = await handleFleetTool('login', {}, context)
  assert.equal(login.isError, undefined, login.content?.[0]?.text)
  assert.match(login.content[0].text, new RegExp(`Logged in ${childId.replace(':', '\\:')}`))

  const delegated = await handleFleetTool('delegate', {
    mint: { name: 'session-contract-minted' },
    message: 'Prove login authenticates the immediately following mint.',
  }, context)
  assert.equal(delegated.isError, undefined, delegated.content?.[0]?.text)
  assert.match(delegated.content[0].text, /delegated \[task:session-contract\]/)

  assert.equal(seen[0]?.type, 'login')
  assert.equal(seen.find(entry => entry.type === 'spawn')?.authenticatedId, childId)
  assert.equal(seen.find(entry => entry.type === 'delegate')?.authenticatedId, childId)
  console.log('PASS: successful native MCP login authenticates the immediately following mint and delegate calls')
} finally {
  for (const client of wss.clients) client.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(configDir, { recursive: true, force: true })
}
process.exit(0)
