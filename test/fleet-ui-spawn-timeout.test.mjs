import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/fleet/fleet-data.mjs', import.meta.url), 'utf8')

test('browser UI spawn requests use a longer WS timeout than ordinary RPCs', () => {
  assert.match(source, /const WS_REQUEST_IDLE_MS = 45_000/)
  assert.match(source, /const SPAWN_WS_DEADLINE_MS = 30_000/)
  assert.match(source, /function wsSend\(msg,\s*\{\s*idleTimeoutMs\s*=\s*WS_REQUEST_IDLE_MS,\s*deadlineMs\s*\}\s*=\s*\{\}\)/)
  assert.match(source, /startWsRequest\(\{[\s\S]*?idleTimeoutMs,[\s\S]*?deadlineMs,[\s\S]*?\}\)/)

  const spawnAgent = source.match(/export function spawnAgent\(model, doc, name, effort\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(spawnAgent, /type:\s*'spawn'/)
  assert.match(spawnAgent, /fresh:\s*true/)
  assert.match(spawnAgent, /deadlineMs:\s*SPAWN_WS_DEADLINE_MS/)
})
