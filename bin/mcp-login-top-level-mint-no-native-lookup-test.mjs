#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const configDir = mkdtempSync(path.join(os.tmpdir(), 'tlda-login-top-level-'))
mkdirSync(path.join(configDir, '.claude'), { recursive: true })
const fleetId = 'fleet:top-level-login'
const localMintId = 'mint-top-level-login'
let nativeBindingHits = 0
const seen = []

const server = http.createServer((req, res) => {
  if (req.url?.startsWith(`/api/fleet/native-subagent-binding/${encodeURIComponent(fleetId)}/`)) {
    nativeBindingHits++
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'agent has no daemon route' }))
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
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    seen.push(message)
    if (message.type === 'login') {
      ws.send(JSON.stringify({
        id: message.id,
        result: { ok: true, agent: { id: fleetId, friendly_name: 'top-level-login' } },
      }))
      return
    }
    ws.send(JSON.stringify({ id: message.id, result: { ok: true } }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${address.port}`
writeFileSync(path.join(configDir, 'daemon.yaml'), `machineId: login-top-level-test\nenvironments:\n  default: test\n  values:\n    test:\n      database: ${base}\n      store: ${base}\n      licenseKey: ""\n`)

Object.assign(process.env, {
  FLEET_ID: fleetId,
  FLEET_LOCAL_ID: localMintId,
  FLEET_MINT_ID: localMintId,
  FLEET_TMUX_SESSION: 'fleet-top-level-login',
  HOME: configDir,
  TLDA_CONFIG_DIR: configDir,
  TLDA_DAEMON_CONFIG_DIR: configDir,
  TLDA_ENV: 'test',
})
delete process.env.CODEX_THREAD_ID

try {
  const { handleFleetTool, initFleet } = await import('../mcp-server/fleet-tools.mjs')
  initFleet({})

  const login = await handleFleetTool('login', {}, { threadId: 'claude-session-not-yet-routable' })
  assert.equal(login.isError, undefined, login.content?.[0]?.text)
  assert.match(login.content[0].text, new RegExp(`Logged in ${fleetId.replace(':', '\\:')}`))
  assert.equal(nativeBindingHits, 0, 'top-level login should not run native-child lookup')
  const loginMessage = seen.find(message => message.type === 'login')
  assert.ok(loginMessage, 'expected a login websocket message')
  assert.equal(loginMessage.agent_id, fleetId)
  console.log('PASS: pre-login top-level fleet mint logs in through explicit identity without native-child lookup')
} finally {
  for (const client of wss.clients) client.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(configDir, { recursive: true, force: true })
}
process.exit(0)
