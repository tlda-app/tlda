#!/usr/bin/env node

// Claude status hook: reports PreToolUse / Stop / StopFailure as additional
// triggers into the existing agent-status state machine (agent-runtime/
// hook-status.mjs maps the event; the server's /api/fleet/hook-status route
// applies the same agent-status path the pane scrape uses). Events with no
// activity edge exit silently. This script never fails: a hook that errors
// would surface hook noise in the agent's turn, so every failure mode below
// exits 0 with no stdout.
//
// Project imports are fine here: module resolution walks up from this file,
// and the sibling native-subagent-notification-hook.mjs already imports
// shared/config.mjs from the same pane environment through the same trigger.
// The mapping lives in exactly one place (hook-status.mjs, the tested
// contract) and the server URL in exactly one place (getFleetServerUrl).

import http from 'node:http'
import https from 'node:https'
import { getFleetServerUrl } from '../shared/config.mjs'
import { hookStatusTransition } from '../agent-runtime/hook-status.mjs'

const agentId = process.env.FLEET_ID
if (!agentId) process.exit(0)

let input = ''
for await (const chunk of process.stdin) input += chunk

let event
try {
  event = JSON.parse(input)
} catch {
  process.exit(0)
}

const transition = hookStatusTransition(event)
if (!transition) process.exit(0)

function envFromDaemonKey(value) {
  return String(value || '').match(/^[^:]+:(.+)$/)?.[1] || null
}

let server = null
try {
  server = getFleetServerUrl(envFromDaemonKey(process.env.FLEET_DAEMON_KEY))
} catch {
  process.exit(0)
}
if (!server) process.exit(0)

const body = JSON.stringify({
  agent_id: agentId,
  hook_event_name: event.hook_event_name,
  activity: transition.activity,
  tool: transition.tool,
})

const client = server.startsWith('https:') ? https : http
await new Promise(resolve => {
  const request = client.request(
    `${server}/api/fleet/hook-status`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 2000 },
    response => {
      response.resume()
      response.on('end', () => resolve())
    },
  )
  request.on('error', () => resolve())
  request.on('timeout', () => { request.destroy(); resolve() })
  request.end(body)
})
process.exit(0)
