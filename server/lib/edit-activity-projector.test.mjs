import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEditActivityProjector, mathBlocks } from './edit-activity-projector.mjs'
import { FleetStore } from './fleet-store.mjs'

test('math block resolver includes environments and display delimiters', () => {
  const source = ['text', '\\[', 'x+y', '\\]', '$$ z $$', '\\begin{align}', 'a&=b', '\\end{align}'].join('\n')
  assert.deepEqual(mathBlocks(source).map(block => [block.kind, block.environment || block.delimiter, block.start_line, block.end_line]), [
    ['delimiter', '\\[', 2, 4],
    ['delimiter', '$$', 5, 5],
    ['environment', 'align', 6, 8],
  ])
})

test('persisted Edit activity reopens and projects immutable enclosing equation source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-edit-projector-'))
  const dbPath = join(root, 'fleet.sqlite')
  const operation = { operation_id: 'O1', kind: 'edit', files: [{ path: 'main.tex' }] }
  const before = ['intro', '\\begin{equation}', 'x + y', '\\end{equation}', 'outro'].join('\n')
  const after = ['intro', '\\begin{equation}', 'x - y', '\\end{equation}', 'outro'].join('\n')
  let store = new FleetStore(dbPath, { taskDoc: false })
  let storeOpen = true
  try {
    const activity = await store.share({ type: 'activity', from: 'fleet:agent', text: 'Edit', metadata: { project: 'paper', input: { edit_operation: operation } } })
    store.close()
    storeOpen = false
    store = new FleetStore(dbPath, { taskDoc: false })
    storeOpen = true
    const projector = createEditActivityProjector({
      fleetStore: store,
      readEvents: async () => ({ events: [{
        previous_source_revision: 'before', after_source_revision: 'after', ambiguous: false,
        attribution_basis: { operation_id: 'O1' },
        changed_files: [{ path: 'main.tex', hunks: [{ old_start: 3, old_lines: 1, new_start: 3, new_lines: 1 }] }],
      }] }),
      lifecycleFor: async () => ({ readRevisionFile: (revision, file) => file === 'main.tex' ? Buffer.from(revision === 'before' ? before : after) : null }),
    })
    await projector.project('paper')
    const row = store.db.prepare('SELECT metadata FROM events WHERE id=?').get(activity.id)
    const canonical = JSON.parse(row.metadata).input.canonical_source
    assert.equal(canonical.before_revision, 'before')
    assert.equal(canonical.after_revision, 'after')
    assert.equal(canonical.scope.environment, 'equation')
    assert.equal(canonical.scope.old_source, ['\\begin{equation}', 'x + y', '\\end{equation}'].join('\n'))
    assert.equal(canonical.scope.new_source, ['\\begin{equation}', 'x - y', '\\end{equation}'].join('\n'))
  } finally {
    if (storeOpen) store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
