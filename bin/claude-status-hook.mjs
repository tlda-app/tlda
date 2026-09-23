#!/usr/bin/env node

// Claude status hook: reports PreToolUse / Stop / StopFailure /
// PermissionDenied as additional triggers into the existing agent-status
// state machine (agent-runtime/hook-status.mjs maps the event; the server's
// /api/fleet/hook-status route applies the same agent-status path the pane
// scrape uses). Events with no activity edge exit silently. This script never
// fails: a hook that errors would surface hook noise in the agent's turn, so
// every failure mode below exits 0 with no stdout.
//
// Zero project imports: the mapping is inlined and the server URL is read by
// scanning daemon.yaml text directly (no yaml package, no shared/config.mjs).
// A hook runs on every tool call inside the agent's turn, so it must work
// from the pane's environment — which has no node_modules on its path.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'

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

// Mirrors hookStatusTransition in agent-runtime/hook-status.mjs (inlined so
// this script has no project imports). The .mjs module is the tested contract;
// this copy is the hot-path deployment of it.
function hookStatusTransition(event) {
  const name = event?.hook_event_name
  const activity = name === 'PreToolUse' ? 'thinking'
    : name === 'Stop' || name === 'StopFailure' || name === 'PermissionDenied' ? 'idle'
    : null
  if (!activity) return null
  const rawTool = event?.tool_name
  const tool = typeof rawTool === 'string' && rawTool.trim() ? rawTool.trim() : null
  return { activity, tool }
}

const transition = hookStatusTransition(event)
if (!transition) process.exit(0)

function envFromDaemonKey(value) {
  return String(value || '').match(/^[^:]+:(.+)$/)?.[1] || null
}

// Scan daemon.yaml text for the database URL of the environment named by
// FLEET_DAEMON_KEY (or the default: line). No yaml parser: environments
// blocks are `    "<name>":` at 4-space indent with `      database: "<url>"`
// beneath, and `  default: "<name>"` / `  default: <name>` at 2-space indent.
function fleetServerUrl(configDir, envName) {
  const text = readFileSync(join(configDir, 'daemon.yaml'), 'utf8')
  const lines = text.split('\n')
  let name = envName
  if (!name) {
    const def = lines.find(line => /^  default:\s/.test(line))
    name = def?.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '') || null
  }
  if (!name) return null
  const header = lines.findIndex(line => line.trim() === `"${name}":` || line.trim() === `'${name}':` || line.trim() === `${name}:`)
  if (header < 0) return null
  for (const line of lines.slice(header + 1)) {
    if (/^    "\S[^"]*":\s*$/.test(line) || /^    '\S[^']*':\s*$/.test(line) || /^    \S[^:]*:\s*$/.test(line)) break
    const match = line.match(/^      database:\s*["']?([^"'\s]+)["']?\s*$/)
    if (match) return match[1]
  }
  return null
}

let server = null
try {
  const configDir = process.env.TLDA_CONFIG_DIR || join(homedir(), '.config', 'tlda')
  server = fleetServerUrl(configDir, envFromDaemonKey(process.env.FLEET_DAEMON_KEY))
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
