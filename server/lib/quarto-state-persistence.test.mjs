// Quarto's project state (`.quarto/xref`, `idx`, `cites`) has to survive a
// build, or the crossref index it holds is rebuilt from nothing every time and
// nothing outside the build can ever read it.
//
// Two properties are worth a test and neither is covered elsewhere:
//
//   1. A seeded item may now be a PATH, and its parent does not exist in a
//      fresh instance. If the parent is not created the copy throws and no
//      build runs at all.
//   2. The `.quarto/*` items must be OPTIONALLY absent. Only a Quarto project
//      produces them; for every markdown, tex and html project the instance
//      has none, and publishing throws on any missing item outside that set.
//      Getting this wrong refuses the publication of every non-Quarto build in
//      the system — a total outage dressed as a cache change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeBuildInstance } from './build-instance.mjs'
import { PUBLISH_REPLACED_ITEMS } from './build-dispatch.mjs'

const QUARTO_STATE = ['.quarto/xref', '.quarto/idx', '.quarto/cites']

// Enough of a lifecycle for the non-link branch: one revision, one file.
const stubLifecycle = () => ({
  readRevision: async () => ({ files: [{ path: 'index.qmd', mode: '100644' }] }),
  readRevisionFiles: async () => new Map([['index.qmd', Buffer.from('# hi\n')]]),
})

const seedLiveProject = (root, { withQuartoState }) => {
  const live = join(root, 'live')
  mkdirSync(join(live, 'build-cache'), { recursive: true })
  writeFileSync(join(live, 'build-cache', 'cached.txt'), 'cache')
  if (withQuartoState) {
    mkdirSync(join(live, '.quarto', 'xref'), { recursive: true })
    writeFileSync(join(live, '.quarto', 'xref', 'INDEX'),
      JSON.stringify({ 'lectures/ch.qmd': { 'ch.html': 'abc123' } }))
    writeFileSync(join(live, '.quarto', 'xref', 'abc123'),
      JSON.stringify({ entries: [{ key: 'thm-a', caption: '', order: { number: 1, section: [7] } }] }))
    mkdirSync(join(live, '.quarto', 'idx'), { recursive: true })
    writeFileSync(join(live, '.quarto', 'idx', 'index.qmd.json'), '{}')
    mkdirSync(join(live, '.quarto', 'cites'), { recursive: true })
    writeFileSync(join(live, '.quarto', 'cites', 'index.json'), '{}')
  }
  return live
}

test('the crossref index survives into a build instance, parent directory and all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quarto-state-'))
  try {
    const live = seedLiveProject(root, { withQuartoState: true })
    const instance = await materializeBuildInstance({
      name: 'course', sourceRevision: 'rev1', lifecycle: stubLifecycle(),
      seedProject: live, temporaryRoot: root,
    })

    // The whole point: `.quarto` does not exist in a fresh instance, so a
    // pathed seed only lands if its parent is created first.
    const index = join(instance.project, '.quarto', 'xref', 'INDEX')
    assert.ok(existsSync(index), '.quarto/xref/INDEX was not carried into the instance')
    assert.deepEqual(JSON.parse(readFileSync(index, 'utf8')),
      { 'lectures/ch.qmd': { 'ch.html': 'abc123' } })

    // The per-document index file the linker actually reads.
    const entry = JSON.parse(
      readFileSync(join(instance.project, '.quarto', 'xref', 'abc123'), 'utf8'))
    assert.equal(entry.entries[0].order.section[0], 7, 'chapter number lost in transit')

    assert.ok(existsSync(join(instance.project, '.quarto', 'idx', 'index.qmd.json')))
    assert.ok(existsSync(join(instance.project, '.quarto', 'cites', 'index.json')))
    // unchanged behaviour, still carried
    assert.ok(existsSync(join(instance.project, 'build-cache', 'cached.txt')))
    rmSync(instance.root, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project with no Quarto state still builds — the seed skips what is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quarto-state-none-'))
  try {
    const live = seedLiveProject(root, { withQuartoState: false })
    const instance = await materializeBuildInstance({
      name: 'notes', sourceRevision: 'rev1', lifecycle: stubLifecycle(),
      seedProject: live, temporaryRoot: root,
    })
    assert.ok(!existsSync(join(instance.project, '.quarto')),
      'nothing should be invented when the live project has no Quarto state')
    assert.ok(existsSync(join(instance.project, 'source', 'index.qmd')))
    rmSync(instance.root, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every Quarto-state item publishing replaces is allowed to be absent', async () => {
  // Guards the outage described at the top of this file. If someone adds a
  // `.quarto/*` entry to PUBLISH_REPLACED_ITEMS and forgets the optional set,
  // publishing throws for every non-Quarto project. Read out of the module so
  // this cannot drift from a second copy of the list.
  const source = readFileSync(new URL('./build-dispatch.mjs', import.meta.url), 'utf8')
  const optional = source.slice(source.indexOf('OPTIONALLY_ABSENT_PUBLISHED_ITEMS = new Set('))
  for (const item of PUBLISH_REPLACED_ITEMS.filter(i => i.startsWith('.quarto/'))) {
    assert.ok(optional.includes(`'${item}'`),
      `${item} is replaced on publish but is not in OPTIONALLY_ABSENT_PUBLISHED_ITEMS; `
      + 'every non-Quarto build would refuse to publish')
  }
  assert.deepEqual(
    PUBLISH_REPLACED_ITEMS.filter(i => i.startsWith('.quarto/')), QUARTO_STATE,
    'the persisted Quarto state changed; the 4.0MB scope was a deliberate decision')
})

test('DELIBERATE RED: the rig can fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quarto-state-red-'))
  try {
    const live = seedLiveProject(root, { withQuartoState: true })
    const instance = await materializeBuildInstance({
      name: 'course', sourceRevision: 'rev1', lifecycle: stubLifecycle(),
      seedProject: live, temporaryRoot: root,
    })
    assert.ok(existsSync(join(instance.project, '.quarto', 'xref', 'NOT-THERE')),
      'expected to fail: this file was never written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
