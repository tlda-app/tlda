// Regression: a name is an opaque atom. The app must NOT parse/strip a `:suffix`
// ("phase") off a name anywhere in routing/resolution. A friendly_name like
// `base:day` is one whole name, delivered and resolved exact-match. Phase is a
// Todd-owned naming convention the server never interprets. The `~N` positional
// search syntax stays (it's a real operator, not phase).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter } from '../shared/fleet-labels.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-opaque-name-'))
const dbPath = path.join(dir, 'fleet.db')
let store = null, failed = false

const now = () => new Date().toISOString()
try {
  store = new FleetStore(dbPath, { taskDoc: false })
  store.upsertAgent({ id: 'fleet:coord', friendly_name: 'repro-coord:day', labels: ['tlda'],
    registered_at: new Date(0).toISOString(), last_seen: now(), dead: false, human: false, is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' } })
  store.upsertAgent({ id: 'fleet:plain', friendly_name: 'repro-plain', labels: ['tlda'],
    registered_at: new Date(0).toISOString(), last_seen: now(), dead: false, human: false, is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' } })

  const recips = (to) => store.resolveChatRecipients(parseFilter(to), { from: null, filter: to })

  // THE FIX: a phase-suffixed name delivers to its exact holder — no stripping.
  assert.deepEqual(recips('repro-coord:day'), ['fleet:coord'],
    'a `:day` name must deliver whole, exact-match (no phase strip → 0 recipients)')
  // Colon-free name still delivers.
  assert.deepEqual(recips('repro-plain'), ['fleet:plain'])
  // Immutable id still delivers.
  assert.deepEqual(recips('fleet:coord'), ['fleet:coord'])

  // findAgent resolves the whole name exact — never a lineage:phase lookup.
  assert.equal(store.findAgent('repro-coord:day')?.id, 'fleet:coord',
    'findAgent must resolve the whole name exact')
  // The bare base is NOT the `:day` agent (no bare→day phase magic).
  assert.equal(store.findAgent('repro-coord')?.id ?? null, null,
    'bare base must not resolve to the :day holder (no phase magic)')

  // The `~N` positional search operator is preserved (it is not phase).
  const p = parseFilter('repro-coord~1')
  assert.equal(p?.selector?.position, 1, '~N must still parse as a position operator')

  console.log('PASS opaque-name-routing-regression-test')
} catch (e) {
  failed = true
  console.error('FAIL', e.message); console.error(e.stack)
} finally {
  try { store?.close() } catch { /* best-effort teardown */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort teardown */ }
}
process.exit(failed ? 1 : 0)
