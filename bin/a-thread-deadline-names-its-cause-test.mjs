#!/usr/bin/env node
// Skip, 2026-09-01 23:14:01: "add an error message for that" -- after a thread()
// call died with `WS request deadline exceeded after 45000ms (type=fleet-search)`.
// That sentence names the transport and no remedy, so the one thing the caller
// can act on -- the query was bigger than the deadline, ask for less of it --
// is the thing it does not say.
//
// `startWsRequest` has taken a `makeDeadlineError` hook since it was written and
// three callers supply one. The fleet-search read supplied none and fell through
// to the generic string. This is that argument arriving.
//
// It is a WIRE test, not a call-site one, because the argument crosses four hops
// to reach the timer -- thread -> mcpFleetTransport.ephemeral -> sendEphemeral ->
// sendFleetRequestAttempt -> _sendWSOnce -> startWsRequest -- and every one of
// them builds a fresh options object. A test that stopped at the transport seam
// would prove the sender and say nothing about whether the hook is still in the
// bag when the deadline fires. So: a real WebSocket server that accepts the
// login, accepts the fleet-search, and then says nothing at all.
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const configDir = mkdtempSync(path.join(os.tmpdir(), 'tlda-thread-deadline-'))
mkdirSync(path.join(configDir, '.claude'), { recursive: true })
const fleetId = 'fleet:thread-deadline'

const searchesReceived = []
let loginSeen = false

const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
wss.on('connection', ws => {
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type === 'fleet-search') {
      // The shape of the fault: the server took the query and is still working
      // on it when the deadline arrives. Never reply.
      searchesReceived.push(message)
      return
    }
    if (message.type === 'login') loginSeen = true
    ws.send(JSON.stringify({
      id: message.id,
      result: message.type === 'login'
        ? { ok: true, agent: { id: fleetId, friendly_name: 'thread-deadline' } }
        : { ok: true },
    }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
writeFileSync(
  path.join(configDir, 'daemon.yaml'),
  `machineId: thread-deadline-test\nenvironments:\n  default: test\n  values:\n    test:\n      database: ${base}\n      store: ${base}\n      licenseKey: ""\n`,
)

Object.assign(process.env, {
  FLEET_ID: fleetId,
  FLEET_LOCAL_ID: 'mint-thread-deadline',
  FLEET_MINT_ID: 'mint-thread-deadline',
  FLEET_TMUX_SESSION: 'fleet-thread-deadline',
  HOME: configDir,
  TLDA_CONFIG_DIR: configDir,
  TLDA_DAEMON_CONFIG_DIR: configDir,
  TLDA_ENV: 'test',
  TLDA_MACHINE_ID: 'thread-deadline-test',
  // The production deadline is 45s. The message under test is the same one at
  // any deadline, so the test buys its evidence at 400ms instead.
  TLDA_FLEET_READ_DEADLINE_MS: '400',
})
delete process.env.CODEX_THREAD_ID

let failure = null
try {
  const { initFleet, handleFleetTool } = await import('../mcp-server/fleet-tools.mjs')
  initFleet({})

  // Only ask once the channel is actually up. A thread() call made before the
  // socket opens returns without reaching the wire, and a message read off THAT
  // is a message about a disconnected client, not about a deadline.
  const upBy = Date.now() + 10_000
  while (!loginSeen && Date.now() < upBy) await new Promise(r => setTimeout(r, 50))
  assert.ok(loginSeen, 'the MCP channel never logged in; the test could not reach the wire')

  {
    const result = await handleFleetTool('thread', { filter: 'me <> skip', page_size: 5000 })
    const text = result?.content?.[0]?.text || ''
    assert.ok(searchesReceived.length, `the fleet-search read never reached the wire; the test proved nothing (got: ${text})`)

    assert.equal(result.isError, true, `a deadline must be an error, got: ${text}`)

    // 1. The generic sentence is gone. This is the string Skip was handed.
    assert.doesNotMatch(
      text,
      /WS request deadline exceeded/,
      `the generic transport message still reaches the caller: ${text}`,
    )

    // 2. It names the cause -- which read timed out, and after how long. A
    //    message that says only "timed out" sends the caller looking at the
    //    network when the query is what was too big.
    assert.match(text, /fleet-search/, `the message must name the read that expired: ${text}`)
    assert.match(text, /400\s*ms/, `the message must name the deadline it hit: ${text}`)

    // 3. It names the remedy. thread() pages on `page_size`, and the bounded
    //    form (since AND until) raises the row limit to 10,000 -- which is the
    //    query that actually outruns the deadline. Naming the knob is the whole
    //    point of the argument; without it this is the generic message with
    //    better nouns.
    assert.match(text, /page_size/, `the message must name the remedy: ${text}`)

    console.log(`ok — thread() deadline reported as: ${text}`)
  }

  // The same read over the OTHER socket. Naming `env` sends the call down
  // sendOneShotWS instead of the pooled channel -- a separate connection with
  // its own timer and its own message. A caller must not have to know which one
  // carried the query to get a sentence it can act on.
  {
    const before = searchesReceived.length
    const result = await handleFleetTool('thread', { filter: 'me <> skip', page_size: 5000, env: 'test' })
    const text = result?.content?.[0]?.text || ''
    assert.ok(
      searchesReceived.length > before,
      `the env-named read never reached the wire; this case proved nothing (got: ${text})`,
    )
    // `Environment: test` is only prepended on the env-scoped branch, so its
    // presence is what proves this case took the other socket rather than
    // quietly repeating the first one.
    assert.match(text, /^Environment: test/, `this case did not take the env-scoped path: ${text}`)
    assert.equal(result.isError, true, `a deadline must be an error, got: ${text}`)
    assert.doesNotMatch(text, /fleet WS request timed out/, `the env-named socket still reports generically: ${text}`)
    assert.match(text, /page_size/, `the env-named socket must name the remedy too: ${text}`)
    console.log(`ok — thread(env:) deadline reported as: ${text.replace(/\n/g, ' | ')}`)
  }
} catch (e) {
  failure = e
} finally {
  wss.close()
  server.close()
}

if (failure) {
  console.error(`FAIL: ${failure.message}`)
  process.exit(1)
}
process.exit(0)
