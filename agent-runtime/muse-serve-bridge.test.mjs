import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseBridgeArgs, summarizeViewNotification } from './muse-serve-bridge.mjs'

test('bridge args parse state dir, bin, and serve args', () => {
  const parsed = parseBridgeArgs(['--state-dir', '/tmp/x', '--bin', 'muse', '--', '--disable-sandbox'])
  assert.equal(parsed.stateDir, '/tmp/x')
  assert.equal(parsed.bin, 'muse')
  assert.deepEqual(parsed.serveArgs, ['--disable-sandbox'])
})

test('bridge args refuse to run without a state dir', () => {
  assert.throws(() => parseBridgeArgs(['--', '--disable-sandbox']), /state-dir/)
})

test('bridge command builder emits no fifo paths and no secrets', async () => {
  const { servePaneCommand, serveStateDir } = await import('./muse-serve-host.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-bridge-cmd-'))
  try {
    const stateDir = serveStateDir('fleet-x', { tmpdir: dir })
    const cmd = servePaneCommand({ stateDir, serveArgs: ['--disable-sandbox'], envAssignments: { XDG_CONFIG_HOME: '/tmp/cfg' } })
    assert.ok(cmd.includes('muse-serve-bridge.mjs'))
    assert.ok(!cmd.includes('serve.stdin') && !cmd.includes('serve.stdout'))
    assert.ok(!cmd.includes('META_API_KEY'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status summaries name turns, tools, and permission waits', () => {
  assert.equal(summarizeViewNotification({ method: 'turn/completed', params: { turnId: 't', terminal: 'completed' } }), 'turn t completed')
  assert.equal(summarizeViewNotification({ method: 'item/completed', params: { item: { kind: 'toolCall', tool: 'read_file', status: 'completed' } } }), 'tool read_file completed')
  assert.equal(summarizeViewNotification({ method: 'approval/request', params: {} }), 'approval requested (see daemon)')
  assert.equal(summarizeViewNotification({ method: 'tokenUsage', params: {} }), null)
})
