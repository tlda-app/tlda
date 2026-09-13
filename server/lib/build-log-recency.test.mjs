import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'tlda-buildlog-'))
const projectsDir = join(root, 'projects')

const { buildLogModifiedAsync, initProjectStore, closeProjectStore } = await import('./project-store.mjs')
await initProjectStore(projectsDir)

function project(name) {
  const dir = join(projectsDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('a project with no build log has no log time, rather than a wrong one', async () => {
  project('never-built')
  assert.equal(await buildLogModifiedAsync('never-built'), null)
})

// The whole point. `lastBuild` records the last COMPLETED build, so while a build
// is running it names an earlier one -- and on a project whose builds keep
// failing it names the last time things WORKED, which reads exactly like current
// state. Three people misread a stale failure as current on 2026-09-13, one of
// them twice. The log's own mtime is what separates the two, because a running
// build appends to it.
test('the log time distinguishes a log being written now from one that is finished', async () => {
  const dir = project('in-flight')
  const lastBuild = new Date(Date.now() - 60_000).toISOString()

  writeFileSync(join(dir, 'build.log'), 'rendering...\n')
  const modified = await buildLogModifiedAsync('in-flight')

  assert.ok(modified, 'a log that exists must report when it was written')
  assert.ok(modified > lastBuild,
    'a log written after the last completed build must read as newer, or nothing distinguishes the two')
})

test('an unreadable log reports nothing rather than throwing into the status response', async () => {
  assert.equal(await buildLogModifiedAsync('no-such-project'), null)
})

test.after(async () => {
  // The store opens a database client; without closing it `node --test` never
  // exits and the suite reads as a hang rather than a failure.
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true })
})
