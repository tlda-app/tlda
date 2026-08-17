#!/usr/bin/env node
// readJsonl must TAIL an append-only log, not re-read it.
//
// The property is not "the records come out right" -- the old full re-read got
// those right too, at 250ms of readFileSync plus 220ms of JSON.parse per call on
// the server's main thread. The property is that bytes already consumed are
// never read again.
//
// So the load-bearing assertion is a counterfactual, not a stopwatch: after a
// read, the ALREADY-CONSUMED prefix is overwritten in place with bytes that are
// not valid JSON, keeping the file's size and inode identical. A tailing reader
// never looks at them and succeeds. A re-reading reader parses them and throws.
// A timing test would be flaky and could pass for the wrong reason; this cannot.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, openSync, writeSync, closeSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { initProjectStore, closeProjectStore, createProject, projectDir } from '../server/lib/project-store.mjs'
import { __test } from '../server/lib/edit-events.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-edit-events-tail-'))
await initProjectStore(root)
let failures = 0

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

const event = i => JSON.stringify({
  schema_version: 1,
  record_type: 'edit_event',
  id: `e${i}`,
  timestamp: new Date(1786900000000 + i * 1000).toISOString(),
  actor_kind: 'agent',
  actor_id: `agent-${i}`,
  attribution_status: 'direct',
})

try {
  createProject({ name: 'paper', title: 'paper' })
  const dir = `${projectDir('paper')}/edit-events`
  const path = `${dir}/edit-events.jsonl`
  mkdirSync(dir, { recursive: true })

  for (let i = 0; i < 50; i++) appendFileSync(path, `${event(i)}\n`)

  await check('reads every appended record', async () => {
    const records = __test.readJsonl('paper', 'edit-events')
    assert.equal(records.length, 50)
    assert.equal(records[0].id, 'e0')
  })

  // The counterfactual: same length, same inode, invalid JSON, entirely inside
  // the region already consumed by the read above.
  const sizeBefore = statSync(path).size
  const firstLineLength = readFileSync(path, 'utf8').indexOf('\n')
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.from('X'.repeat(firstLineLength)), 0, firstLineLength, 0)
  } finally {
    closeSync(fd)
  }
  assert.equal(statSync(path).size, sizeBefore, 'test bug: poisoning changed the file size')

  appendFileSync(path, `${event(50)}\n`)
  await check('does not re-read consumed bytes (a re-reader throws on the poisoned prefix)', async () => {
    const records = __test.readJsonl('paper', 'edit-events')
    assert.equal(records.length, 51)
  })

  // A record still being written -- no trailing newline yet -- must not be
  // parsed, and must not advance the offset past itself.
  appendFileSync(path, event(51))
  await check('ignores a partial trailing line', async () => {
    const records = __test.readJsonl('paper', 'edit-events')
    assert.equal(records.length, 51)
  })

  appendFileSync(path, '\n')
  await check('picks the completed line up exactly once', async () => {
    const records = __test.readJsonl('paper', 'edit-events')
    assert.equal(records.length, 52)
    assert.equal(new Set(records.map(r => r.id)).size, 52, 'a record was counted twice')
  })

  await check('a missing log is empty, not an error', async () => {
    createProject({ name: 'empty', title: 'empty' })
    assert.deepEqual(__test.readJsonl('empty', 'edit-events'), [])
  })
} finally {
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS edit-events tail' : `FAIL edit-events tail (${failures})`)
process.exit(failures === 0 ? 0 : 1)
