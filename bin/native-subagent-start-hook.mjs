#!/usr/bin/env node

import http from 'node:http'
import https from 'node:https'
import { getFleetServerUrl } from '../shared/config.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk

let event
try {
  event = JSON.parse(input)
} catch {
  process.exit(0)
}

if (event?.hook_event_name !== 'SubagentStart') process.exit(0)

const parentAgentId = process.env.FLEET_ID
const nativeAgentId = event.agent_id
if (parentAgentId && nativeAgentId) {
  const envName = String(process.env.FLEET_DAEMON_KEY || '').match(/^[^:]+:(.+)$/)?.[1]
  let server = null
  try {
    server = getFleetServerUrl(envName)
  } catch (error) {
    process.stderr.write(`native child identity hook could not resolve the fleet server: ${error.message}\n`)
  }
  if (server) {
    const url = `${server}/api/fleet/native-subagent-binding/${encodeURIComponent(parentAgentId)}/${encodeURIComponent(nativeAgentId)}`
    const client = url.startsWith('https:') ? https : http
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const ready = await new Promise(resolve => {
        const request = client.get(url, { timeout: 1000 }, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode === 200))
        })
        request.on('error', () => resolve(false))
        request.on('timeout', () => { request.destroy(); resolve(false) })
      })
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext: 'Before task work, call tlda login() and then inbox(). This binds the native child thread to its own tlda identity.',
  },
}))
