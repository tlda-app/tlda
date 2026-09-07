import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntimeSourceWatcher } from './git-sync-manager.mjs'
import { createEditClusterDebouncer } from './edit-cluster.mjs'

function injectedWatcher() {
  let callback
  const watcher = new EventEmitter()
  watcher.closed = false
  watcher.close = async () => { watcher.closed = true }
  return {
    watch(root, onChange) {
      watcher.root = root
      callback = onChange
      return watcher
    },
    watcher,
    change(filename) { callback('change', filename) },
  }
}

test('a runtime routes only current members and conservatively handles an absent filename', async () => {
  const sourceDir = '/fixture/project'
  const first = path.join(sourceDir, 'first.tex')
  const second = path.join(sourceDir, 'second.tex')
  const watchedMembers = new Set([first])
  const notes = []
  const injected = injectedWatcher()
  const watcher = createRuntimeSourceWatcher({
    sourceDir,
    watchedMembers,
    note: file => notes.push(file),
    watch: injected.watch,
  })

  assert.equal(injected.watcher.root, sourceDir)
  injected.change('first.tex')
  injected.change('not-a-member.tex')
  assert.deepEqual(notes, [first])

  watchedMembers.clear()
  watchedMembers.add(second)
  injected.change('first.tex')
  injected.change('second.tex')
  injected.change(null)
  assert.deepEqual(notes, [first, second, second])

  watchedMembers.clear()
  injected.change(null)
  assert.equal(notes.at(-1), path.join(sourceDir, '__tlda_ambiguous_source_event__'))

  await watcher.close()
  assert.equal(injected.watcher.closed, true)
})

test('an absent filename with no members arms the real edit debouncer', async () => {
  const sourceDir = '/fixture/project'
  const injected = injectedWatcher()
  let settle
  const settled = new Promise(resolve => { settle = resolve })
  const cluster = createEditClusterDebouncer({ sourceDir, quietMs: 1, onSettled: settle })
  createRuntimeSourceWatcher({
    sourceDir,
    watchedMembers: new Set(),
    note: file => cluster.note(file),
    watch: injected.watch,
  })

  injected.change(null)
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ambiguous event did not settle')), 100)),
  ])
  assert.equal(cluster.state().open, false)
  cluster.close()
})

test('overlapping runtimes independently route the same member', () => {
  const sourceDir = '/fixture/project'
  const member = path.join(sourceDir, 'shared.tex')
  const notes = [[], []]
  const injected = [injectedWatcher(), injectedWatcher()]

  for (let index = 0; index < 2; index++) {
    createRuntimeSourceWatcher({
      sourceDir,
      watchedMembers: new Set([member]),
      note: file => notes[index].push(file),
      watch: injected[index].watch,
    })
    injected[index].change('shared.tex')
  }

  assert.deepEqual(notes, [[member], [member]])
})

test('a recursive native watcher observes a nested member through a symlink root', async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'tlda-runtime-source-watcher-'))
  const realRoot = path.join(fixture, 'real')
  const sourceDir = path.join(fixture, 'linked')
  const nested = path.join(realRoot, 'nested')
  mkdirSync(nested, { recursive: true })
  symlinkSync(realRoot, sourceDir)
  const member = path.join(sourceDir, 'nested', 'member.tex')
  writeFileSync(path.join(nested, 'member.tex'), 'before\n')
  let watcher
  try {
    const observed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('nested symlink-root edit was not observed')), 5_000)
      watcher = createRuntimeSourceWatcher({
        sourceDir,
        watchedMembers: new Set([member]),
        note(file) {
          if (file !== member) return
          clearTimeout(timeout)
          resolve(file)
        },
      })
    })
    writeFileSync(path.join(nested, 'member.tex'), 'after\n')
    assert.equal(await observed, member)
  } finally {
    await watcher?.close()
    rmSync(fixture, { recursive: true, force: true })
  }
})
