// Joining takes an observation, never an emission: recording a launch result
// carrying only the pre-minted id stores it provisional and leaves the mint
// unjoined, and only an observed session completes the join.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MintStore } from './mint-store.mjs'
import { createDaemonMintCore } from './mint-core.mjs'

function freshCore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-provisional-join-'))
  const store = new MintStore(join(dir, 'daemon-mints.sqlite'), { defaultEnvName: 'testing' })
  const bound = []
  const core = createDaemonMintCore({
    store,
    launchProcess: async () => { throw new Error('no launch in this test') },
    bindSeat: async facts => { bound.push(facts.mintId) },
  })
  return { store, core, bound, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const PROCESS = {
  tmux_session: 'fleet-test',
  harness: 'claude',
  model: 'opus',
  cwd: '/Users/x/work/tlda',
  provisional_session_id: 'emitted-1',
}

test('a launch emission records provisional and does not join', async () => {
  const { store, core, cleanup } = freshCore()
  try {
    store.ensure('mint-1')
    store.setFact('mint-1', 'fleet_id', 'fleet:test')
    const facts = await core.recordProcess('mint-1', PROCESS)
    assert.equal(facts.provisionalSessionId, 'emitted-1')
    assert.equal(facts.sessionId, null)
    assert.equal(facts.joinedAt, null)
  } finally { cleanup() }
})

test('an observed session promotes past the provisional and joins', async () => {
  const { store, core, bound, cleanup } = freshCore()
  try {
    store.ensure('mint-1')
    store.setFact('mint-1', 'fleet_id', 'fleet:test')
    await core.recordProcess('mint-1', PROCESS)
    const facts = await core.recordSession('mint-1', { session_id: 'observed-1', session_path: '/s/observed-1.jsonl' })
    assert.equal(facts.sessionId, 'observed-1')
    assert.equal(facts.provisionalSessionId, null)
    assert.ok(facts.joinedAt)
    assert.deepEqual(bound, ['mint-1', 'mint-1'])
  } finally { cleanup() }
})

test('a stale provisional key beside an observed id is not resurrected', async () => {
  const { store, core, cleanup } = freshCore()
  try {
    store.ensure('mint-1')
    store.setFact('mint-1', 'fleet_id', 'fleet:test')
    await core.recordProcess('mint-1', PROCESS)
    await core.recordSession('mint-1', { session_id: 'observed-1', session_path: '/s/observed-1.jsonl' })
    // The reconcile merge spreads the stored process JSON, whose provisional
    // key went stale at promotion; re-recording it must not revive the column.
    const facts = await core.recordProcess('mint-1', {
      ...PROCESS, session_id: 'observed-1', session_path: '/s/observed-1.jsonl',
    })
    assert.equal(facts.sessionId, 'observed-1')
    assert.equal(facts.provisionalSessionId, null)
  } finally { cleanup() }
})
