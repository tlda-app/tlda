import assert from 'node:assert/strict'
import test from 'node:test'
import { DOC_VERSION_SENTINEL_ID, writeSentinel } from '../server/lib/sentinel.mjs'

function makeMemoryIo(initialShape) {
  let shape = initialShape
  return {
    get shape() { return shape },
    async updateShape(_docName, shapeId, updater) {
      assert.equal(shapeId, DOC_VERSION_SENTINEL_ID)
      if (!shape) throw new Error(`Shape not found: ${shapeId}`)
      shape = updater(shape)
    },
    async putShape(_docName, nextShape) {
      shape = nextShape
    },
  }
}

test('writeSentinel preserves status fields when syncing shadow build state', async () => {
  const io = makeMemoryIo({
    id: DOC_VERSION_SENTINEL_ID,
    typeName: 'shape',
    type: 'doc-version',
    props: {
      w: 1,
      h: 1,
      commitHash: 'old-hash',
      timestamp: 1000,
      buildReadyAt: 1000,
      sourceVersion: 42,
      errorsJson: '[{"message":"broken"}]',
      warningsJson: '[{"message":"warn"}]',
      syncErrorJson: '{"message":"sync failed"}',
    },
  })

  const result = await writeSentinel('doc-paper', {
    commitHash: 'new-hash',
    timestamp: 2000,
    buildReadyAt: 2000,
  }, io)

  assert.equal(result.skipped, false)
  assert.equal(io.shape.props.commitHash, 'new-hash')
  assert.equal(io.shape.props.buildReadyAt, 2000)
  assert.equal(io.shape.props.sourceVersion, 42)
  assert.equal(io.shape.props.errorsJson, '[{"message":"broken"}]')
  assert.equal(io.shape.props.warningsJson, '[{"message":"warn"}]')
  assert.equal(io.shape.props.syncErrorJson, '{"message":"sync failed"}')
})

test('writeSentinel refuses an out-of-order build write', async () => {
  const existing = {
    id: DOC_VERSION_SENTINEL_ID,
    typeName: 'shape',
    type: 'doc-version',
    props: {
      w: 1,
      h: 1,
      commitHash: 'newer-hash',
      timestamp: 3000,
      buildReadyAt: 3000,
      sourceVersion: 50,
      errorsJson: '[{"message":"still broken"}]',
      warningsJson: '',
      syncErrorJson: '{"message":"sync failed"}',
    },
  }
  const io = makeMemoryIo(existing)

  const result = await writeSentinel('doc-paper', {
    commitHash: 'older-hash',
    timestamp: 4000,
    buildReadyAt: 4000,
    sourceVersion: 49,
    errorsJson: '',
    warningsJson: '',
  }, io)

  assert.equal(result.skipped, true)
  assert.deepEqual(io.shape, existing)
})
