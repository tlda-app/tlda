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
    // The room stands on its project branch like any other checkout.
    standOnWorkBranch: async (...args) => { calls.push(['stand', ...args]); return { ok: true, status: 'moved' } },
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

test('whole-file source-room submissions wait for the Git proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-room-submit-'))
  const calls = []
  const manager = {
    bindSource: (...args) => calls.push(['bind', ...args]),
    sync: async (...args) => calls.push(['sync', ...args]),
    standOnWorkBranch: async () => ({ ok: true }),
    remoteOperation: async (_project, operation, params) => {
      calls.push(['remote', operation, params.path])
      return { tracked: true }
    },
    queuePaths: (...args) => calls.push(['queue', ...args]),
    submit: async (...args) => {
      calls.push(['submit', ...args])
      return { ok: true, revision: 'abc123' }
    },
  }
  const daemon = createSourceRoomDaemon({
    projectDir: project => join(root, project),
    readProject: async name => ({
      name,
      mainFile: 'deck.html',
      documentRoots: [{ path: 'deck.html', format: 'slides' }],
    }),
    sourceLifecycleStore: async () => ({ gitRepository: async () => ({ head: async () => null }) }),
    readClientSourceManifest: async () => ['deck.html'],
    gitSyncManagerForProject: () => manager,
  })
  try {
    const result = await daemon.submitFiles('slides', {
      files: [{ path: 'deck.html', content: '<h1>Deck</h1>' }],
    })
    assert.deepEqual(result, {
      status: 202,
      body: { ok: true, status: 'submitted', revision: 'abc123' },
    })
    assert.deepEqual(calls.find(call => call[0] === 'bind')[3].documentRoots, [
      { path: 'deck.html', format: 'slides' },
    ])
    assert.deepEqual(calls.find(call => call[0] === 'submit'), ['submit', 'slides'])
  } finally {
    daemon.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})
