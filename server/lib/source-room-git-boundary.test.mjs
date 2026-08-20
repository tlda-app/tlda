import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceRoomDaemon, sourceRoomDaemonKey } from './source-room-daemon.mjs'

test('source-room edits and published heads use its canonical Git manager', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-room-git-'))
  const calls = []
  const manager = {
    bindSource: (...args) => calls.push(['bind', ...args]),
    sync: async (...args) => calls.push(['sync', ...args]),
    queuePaths: (...args) => calls.push(['queue', ...args]),
    headChanged: async (...args) => { calls.push(['head', ...args]); return { ok: true } },
  }
  const lifecycle = {
    gitRepository: async () => ({ head: async () => null }),
    readCurrentFile: async () => ({ content: Buffer.from('start') }),
  }
  const daemon = createSourceRoomDaemon({
    projectDir: project => join(root, project),
    readProject: async name => ({ name, mainFile: 'main.md' }),
    sourceLifecycleStore: async () => lifecycle,
    readClientSourceManifest: async () => ['main.md'],
    gitSyncManagerForProject: project => {
      assert.equal(project, 'paper')
      return manager
    },
    pushDelayMs: 5,
  })
  try {
    const room = await daemon.getRoom('paper', 'main.md')
    room.ytext.insert(room.ytext.length, ' edit')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(calls.find(call => call[0] === 'queue'), ['queue', 'paper', ['main.md']])
    assert.equal(calls.find(call => call[0] === 'bind')[3].mainFile, 'main.md')
    await daemon.headChanged('paper', 'revision-published')
    assert.deepEqual(calls.at(-1), ['head', 'paper', 'revision-published'])
    assert.equal(room.heldRevision, 'revision-published')
    assert.equal(sourceRoomDaemonKey('paper'), 'source-room:paper')
  } finally {
    daemon.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})
