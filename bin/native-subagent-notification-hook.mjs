#!/usr/bin/env node

import http from 'node:http'
import https from 'node:https'
import { getFleetServerUrl } from '../shared/config.mjs'

const parentAgentId = process.env.FLEET_ID
if (!parentAgentId) process.exit(0)

function envFromDaemonKey(value) {
  return String(value || '').match(/^[^:]+:(.+)$/)?.[1] || null
}

let server
try {
  server = getFleetServerUrl(envFromDaemonKey(process.env.FLEET_DAEMON_KEY))
} catch {
  process.exit(0)
}

async function drainStdin() {
  for await (const _chunk of process.stdin) { /* hook payload is not needed */ }
}

function getJson(url, timeoutMs = 3000) {
  const client = url.startsWith('https:') ? https : http
  return new Promise(resolve => {
    const request = client.get(url, { timeout: timeoutMs }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    request.on('error', () => resolve(null))
    request.on('timeout', () => { request.destroy(); resolve(null) })
  })
}

await drainStdin()
const payload = await getJson(
  `${server}/api/fleet/native-subagent-notifications/${encodeURIComponent(parentAgentId)}`,
)
if (!payload) {
  process.stderr.write('native-subagent notification hook could not reach the fleet server\n')
  process.exit(0)
}
const notifications = payload?.ok ? payload.notifications || [] : []
if (!notifications.length) process.exit(0)

const lines = notifications.map(item => {
  const sender = item.sender_name || item.sender_agent_id || 'unknown sender'
  return `- Native child ${item.child_name} (${item.child_agent_id}) has a pending tlda inbox message from ${sender} (event ${item.event_id}). Read the original with tlda thread(agent: "${item.child_agent_id}"), then forward it with the native SendMessage tool to agent id ${item.native_agent_id}.`
})
process.stdout.write(`Pending native-subagent delivery obligations:\n${lines.join('\n')}\n`)
