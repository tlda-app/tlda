import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function daemonSource() {
  return readFileSync(path.join(ROOT, 'bin', 'fleet-daemon.mjs'), 'utf8')
}

test('project source watching is chokidar-backed, not active-viewer fs.watch backed', () => {
  const source = daemonSource()

  assert.equal(source.includes('function startSourceWatcher'), true)
  assert.equal(source.includes('function sourceWatcherPaths'), true)
  assert.equal(source.includes('chokidar.watch(watchPaths'), true)
  assert.equal(source.includes('chokidar.watch(state.sourceDir'), false)
  assert.equal(source.includes('function syncFsWatchers'), false)
  assert.equal(source.includes('_activeViewerSet'), false)
  assert.equal(source.includes('fs.watch(state.sourceDir'), false)
  assert.equal(source.includes('watchSeen'), false)
})

test('source watcher has no fs.watchFile polling fallbacks', () => {
  const source = daemonSource()

  assert.equal(source.includes('function startPolling'), false)
  assert.equal(source.includes('function stopPolling'), false)
  assert.equal(source.includes('_symlinkPolls'), false)
  assert.equal(source.includes('fs.unwatchFile'), false)

  const watchFileUses = source.match(/fs\.watchFile\(/g) || []
  assert.equal(watchFileUses.length, 1)
  assert.match(source, /config drift watcher armed/)
})

test('backing files and scratch symlink targets use chokidar watchers', () => {
  const source = daemonSource()

  assert.equal(source.includes('chokidar backing watcher started'), true)
  assert.equal(source.includes('chokidar symlink target watcher failed'), true)
  assert.equal(source.includes('fs.watch(fp'), false)
  assert.equal(source.includes('fs.watchFile(target'), false)
})

test('daemon liveness observation emits present, not awake activity status', () => {
  const source = daemonSource()

  assert.equal(source.includes("emitAgentStatus(agent.id, 'present')"), true)
  assert.equal(source.includes("emitAgentStatus(agent.id, 'awake')"), false)
})
