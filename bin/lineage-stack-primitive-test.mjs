// CP3 store stack primitive: push/pop/swap keep one active holder per position,
// contiguous top-first indices, correct membership, and apply Todd-computed exact
// names through renameAgentFriendlyName (the server never derives a name).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-stack-'))
let store = null, failed = false
const now = () => new Date().toISOString()
const mk = (id, name) => store.upsertAgent({ id, friendly_name: name, labels: [],
  registered_at: new Date(0).toISOString(), last_seen: now(), dead: false, human: false, is_manager: false,
  metadata: { kind: 'codex', model: 'gpt-test' } })
const idsAt = (linId) => store._activeStack(linId).map(r => `${r.stack_index}:${r.fleet_id}`)
const name = (id) => store.getAgent(id)?.friendly_name ?? null

function assertContiguousOneActive(linId) {
  const rows = store._activeStack(linId)
  const seen = new Set()
  rows.forEach((r, i) => {
    assert.equal(r.stack_index, i, `stack indices must be contiguous top-first (got ${idsAt(linId)})`)
    assert.ok(!seen.has(r.stack_index), 'exactly one active holder per index')
    seen.add(r.stack_index)
  })
}

try {
  store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  const lin = store.getOrCreateLineage('crew')
  const L = lin.id
  mk('fleet:w1', 'w1'); mk('fleet:w2', 'w2'); mk('fleet:w3', 'w3'); mk('fleet:w4', 'w4')

  // push w1 (top). Todd names it the bare base.
  await store.pushExisting(L, 'fleet:w1', [{ fleetId: 'fleet:w1', friendlyName: 'crew' }])
  assert.deepEqual(idsAt(L), ['0:fleet:w1'])
  assert.equal(name('fleet:w1'), 'crew')

  // push w2 → new top; w1 drops to :day. Todd supplies both names.
  await store.pushExisting(L, 'fleet:w2', [
    { fleetId: 'fleet:w2', friendlyName: 'crew' },
    { fleetId: 'fleet:w1', friendlyName: 'crew:day' },
  ])
  assert.deepEqual(idsAt(L), ['0:fleet:w2', '1:fleet:w1'])
  assert.equal(name('fleet:w2'), 'crew'); assert.equal(name('fleet:w1'), 'crew:day')
  assertContiguousOneActive(L)

  // push w3 → top; shift down. Names: w3=crew, w2=:day, w1=:dusk.
  await store.pushExisting(L, 'fleet:w3', [
    { fleetId: 'fleet:w3', friendlyName: 'crew' },
    { fleetId: 'fleet:w2', friendlyName: 'crew:day' },
    { fleetId: 'fleet:w1', friendlyName: 'crew:dusk' },
  ])
  assert.deepEqual(idsAt(L), ['0:fleet:w3', '1:fleet:w2', '2:fleet:w1'])
  assert.equal(name('fleet:w1'), 'crew:dusk')
  assertContiguousOneActive(L)

  // pop → top (w3) leaves and is un-named by Todd; w2 rises to top, w1 to :day.
  // The vacating top MUST be in the assignments (→ null) so its name frees.
  const popped = await store.pop(L, [
    { fleetId: 'fleet:w3', friendlyName: null },
    { fleetId: 'fleet:w2', friendlyName: 'crew' },
    { fleetId: 'fleet:w1', friendlyName: 'crew:day' },
  ])
  assert.equal(popped.popped, 'fleet:w3')
  assert.deepEqual(idsAt(L), ['0:fleet:w2', '1:fleet:w1'])
  assert.equal(store.getAgent('fleet:w3')?.lineage_id ?? null, null, 'popped agent leaves current membership')
  assertContiguousOneActive(L)

  // swap: replace the :day holder (w1, index 1) with w4. No shift of the top.
  // w1 is swapped out and un-named (frees 'crew:day' for w4).
  const sw = await store.swap('fleet:w1', 'fleet:w4', [
    { fleetId: 'fleet:w1', friendlyName: null },
    { fleetId: 'fleet:w4', friendlyName: 'crew:day' },
  ])
  assert.equal(sw.stackIndex, 1)
  assert.deepEqual(idsAt(L), ['0:fleet:w2', '1:fleet:w4'])
  assert.equal(name('fleet:w4'), 'crew:day')
  assert.equal(store.getAgent('fleet:w1')?.lineage_id ?? null, null, 'swapped-out agent leaves current membership')
  assertContiguousOneActive(L)

  // history preserved: w1 has both an index-2 (pushed) and index-1 (post-pop) closed tenure.
  const w1hist = store.db.prepare('SELECT stack_index, active FROM lineage_stack_entries WHERE fleet_id = ? ORDER BY entered_at').all('fleet:w1')
  assert.ok(w1hist.length >= 2 && w1hist.every(r => r.active === 0), 'w1 history rows retained + all inactive after swap-out')

  // search-family: every id ever on the stack is discoverable from the entries table.
  const family = new Set(store.db.prepare('SELECT DISTINCT fleet_id FROM lineage_stack_entries WHERE lineage_id = ?').all(L).map(r => r.fleet_id))
  assert.deepEqual([...family].sort(), ['fleet:w1', 'fleet:w2', 'fleet:w3', 'fleet:w4'])

  console.log('PASS lineage-stack-primitive-test — push/pop/swap: contiguous one-per-index, names via rename, history + swap-family retained')
} catch (e) {
  failed = true
  console.error('FAIL', e.message); console.error(e.stack)
} finally {
  try { await store?.close?.() } catch { /* best-effort teardown */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort teardown */ }
}
process.exit(failed ? 1 : 0)
