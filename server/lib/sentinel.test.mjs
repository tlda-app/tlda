import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { closeAllRooms, getRecord, initSyncRooms } from './sync-rooms.mjs'
import { DOC_VERSION_SENTINEL_ID, writeSentinel } from './sentinel.mjs'

test('first publication creates the sentinel and later publication updates it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-sentinel-first-publication-'))
  initSyncRooms(root, { evictIdleRooms: false })
  const transactionErrors = []
  const originalError = console.error
  console.error = (...args) => {
    transactionErrors.push(args.map(String).join(' '))
    originalError(...args)
  }
  try {
    await writeSentinel('doc-new-paper', {
      commitHash: 'first', sourceRevision: 'revision-1', acceptSeq: 1,
      errorsJson: '', warningsJson: 'first warnings',
    })
    const first = await getRecord('doc-new-paper', DOC_VERSION_SENTINEL_ID)
    assert.deepEqual(transactionErrors, [], 'first publication must not execute a failing update transaction')
    assert.equal(first.props.sourceRevision, 'revision-1')
    assert.equal(first.props.warningsJson, 'first warnings')

    await writeSentinel('doc-new-paper', {
      commitHash: 'second', sourceRevision: 'revision-2', acceptSeq: 2,
      errorsJson: 'second errors',
    })
    const second = await getRecord('doc-new-paper', DOC_VERSION_SENTINEL_ID)
    assert.equal(second.props.commitHash, 'second')
    assert.equal(second.props.sourceRevision, 'revision-2')
    assert.equal(second.props.errorsJson, 'second errors')
    assert.equal(second.props.warningsJson, 'first warnings')
  } finally {
    console.error = originalError
    closeAllRooms()
    rmSync(root, { recursive: true, force: true })
  }
})
