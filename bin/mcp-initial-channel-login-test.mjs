#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const configDir = mkdtempSync(path.join(os.tmpdir(), 'tlda-initial-channel-login-'))
mkdirSync(path.join(configDir, '.claude'), { recursive: true })
const fleetId = 'fleet:initial-channel-login'
const seen = []

const server = http.createServer((_req, res) => {
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
    ws.send(JSON.stringify({
      id: message.id,
      result: message.type === 'login'
        ? { ok: true, agent: { id: fleetId, friendly_name: 'initial-channel-login' } }
        : { ok: true },
    }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${address.port}`
writeFileSync(path.join(configDir, 'daemon.yaml'), `machineId: initial-channel-login-test\nenvironments:\n  default: test\n  values:\n    test:\n      database: ${base}\n      store: ${base}\n      licenseKey: ""\n`)

Object.assign(process.env, {
  FLEET_ID: fleetId,
  FLEET_LOCAL_ID: 'mint-initial-channel-login',
  FLEET_MINT_ID: 'mint-initial-channel-login',
  FLEET_TMUX_SESSION: 'fleet-initial-channel-login',
  HOME: configDir,
  TLDA_CONFIG_DIR: configDir,
  TLDA_DAEMON_CONFIG_DIR: configDir,
  TLDA_ENV: 'test',
  TLDA_MACHINE_ID: 'initial-channel-login-test',
})
delete process.env.CODEX_THREAD_ID

try {
  const { initFleet } = await import('../mcp-server/fleet-tools.mjs')
  initFleet({})
  const deadline = Date.now() + 2_000
  while (!seen.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(seen.length, 1, 'first channel open should authenticate without a tool call')
  assert.equal(seen[0].type, 'login')
  assert.equal(seen[0].agent_id, fleetId)
  assert.equal(seen[0].env_name, 'test')
  assert.equal(seen[0].machine_id, 'initial-channel-login-test')
  console.log('PASS: first MCP channel open claims its fleet identity through login')
} finally {
  for (const client of wss.clients) client.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(configDir, { recursive: true, force: true })
}
process.exit(0)
