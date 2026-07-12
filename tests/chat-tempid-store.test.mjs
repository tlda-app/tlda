import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `chat-tempid-store-${process.pid}-${Date.now()}.db`)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
  return { store: new FleetStore(dbPath), dbPath }
}

test('chat temp id result is recoverable from persisted event metadata', async () => {
  const { store, dbPath } = tempStore()
  try {
    await store.share({
      type: 'chat',
      from: 'fleet:sender',
      to: 'fleet:recipient-a',
      text: 'hello',
      metadata: { client_temp_id: 'fleet:sender:mcp-chat:test-1' },
    })
    await store.share({
      type: 'chat',
      from: 'fleet:sender',
      to: 'fleet:recipient-b',
      text: 'hello',
      metadata: { client_temp_id: 'fleet:sender:mcp-chat:test-1' },
    })

    const result = store.getChatTempIdResult('fleet:sender:mcp-chat:test-1')
    assert.deepEqual(result.eventIds, [1, 2])
    assert.deepEqual(result.recipients, ['fleet:recipient-a', 'fleet:recipient-b'])
    assert.deepEqual(result.receipts, [])
    assert.equal(store.getChatTempIdResult('missing'), null)
  } finally {
    store.close()
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
    }
  }
})
