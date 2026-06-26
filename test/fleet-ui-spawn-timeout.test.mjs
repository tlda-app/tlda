import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/fleet/fleet-data.mjs', import.meta.url), 'utf8')

test('browser UI spawn requests use a longer WS timeout than ordinary RPCs', () => {
  assert.match(source, /function wsSend\(msg,\s*\{\s*timeoutMs\s*=\s*5000\s*\}\s*=\s*\{\}\)/)
  assert.match(source, /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?reject\(new Error\('timeout'\)\)[\s\S]*?\},\s*timeoutMs\)/)
  assert.match(source, /clearTimeout\(cb\.timer\)/)

  const spawnAgent = source.match(/export function spawnAgent\(model, doc, name, effort\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(spawnAgent, /type:\s*'spawn'/)
  assert.match(spawnAgent, /fresh:\s*true/)
  assert.match(spawnAgent, /timeoutMs:\s*30_000/)
})
