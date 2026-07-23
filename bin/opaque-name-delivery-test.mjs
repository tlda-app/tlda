// Delivery proof (not just resolution). Replicates the REAL server chat delivery
// loop (unified-server.mjs: resolveChatRecipients → per-recipient _insertEventRecord
// with unread:true) and asserts a `:day` (phase-suffixed, opaque) name actually
// lands the message in its EXACT holder's inbox — and only there. This is the
// end-to-end check that was missing: `d303f6a8` must not just resolve the name,
// it must DELIVER to the resolved agent with no cross-delivery and no 0-recipient
// silent drop (the original bug: phase-strip → base miss → 0 recipients).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter } from '../shared/fleet-labels.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-opaque-delivery-'))
const dbPath = path.join(dir, 'fleet.db')
let store = null, failed = false
const now = () => new Date().toISOString()

// Mirror of the server's chat delivery loop, using the SAME store functions the
// live WS handler uses (no re-implementation of resolution or insert).
async function deliver(to, from, text) {
  const recipients = store.resolveChatRecipients(parseFilter(to), { from, filter: to })
  const ids = []
  for (const r of recipients) {
    const inserted = await store._insertEventRecord(
      { type: 'chat', timestamp: now(), from, to: r, text, unread: true },
      { notify: false },
    )
    ids.push(Number(inserted.id))
  }
  return { recipients, ids }
}

try {
  store = new FleetStore(dbPath, { taskDoc: false })
  store.upsertAgent({ id: 'fleet:coord', friendly_name: 'deliver-coord:day', labels: ['tlda'],
    registered_at: new Date(0).toISOString(), last_seen: now(), dead: false, human: false, is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' } })
  store.upsertAgent({ id: 'fleet:plain', friendly_name: 'deliver-plain', labels: ['tlda'],
    registered_at: new Date(0).toISOString(), last_seen: now(), dead: false, human: false, is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' } })

  // 1) THE BUG CASE: a chat addressed to the whole `:day` name must DELIVER to its
  //    exact holder — non-empty recipients + a real inbox row on fleet:coord.
  const d1 = await deliver('deliver-coord:day', 'fleet:plain', 'hello coord [day]')
  assert.deepEqual(d1.recipients, ['fleet:coord'],
    'phase-suffixed name must resolve to exactly its holder (not 0 recipients)')
  assert.equal(store.getUnreadCount('fleet:coord'), 1,
    'message must land in fleet:coord inbox (delivery, not just resolution)')
  const coordInbox = store.getUnread('fleet:coord')
  assert.ok(coordInbox.some(e => e.text === 'hello coord [day]'),
    'the exact message text must be in the coord inbox')
  // No cross-delivery: the plain agent got nothing.
  assert.equal(store.getUnreadCount('fleet:plain'), 0,
    'the message to `:day` must NOT leak to any other agent')

  // 2) A colon-free name delivers to its holder, and only there.
  const d2 = await deliver('deliver-plain', 'fleet:coord', 'hello plain')
  assert.deepEqual(d2.recipients, ['fleet:plain'])
  assert.equal(store.getUnreadCount('fleet:plain'), 1, 'plain name must deliver to fleet:plain')
  assert.equal(store.getUnreadCount('fleet:coord'), 1,
    'coord unread unchanged by the message addressed to plain')

  // 3) The immutable id delivers too (control).
  const d3 = await deliver('fleet:coord', 'fleet:plain', 'by id')
  assert.deepEqual(d3.recipients, ['fleet:coord'])
  assert.equal(store.getUnreadCount('fleet:coord'), 2, 'id-addressed message delivered to coord')

  console.log('PASS opaque-name-delivery-test — `:day` name DELIVERED to its exact holder, no cross-delivery, no 0-recipient drop')
} catch (e) {
  failed = true
  console.error('FAIL', e.message); console.error(e.stack)
} finally {
  try { await store?.close?.() } catch { /* best-effort teardown */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort teardown */ }
}
process.exit(failed ? 1 : 0)
