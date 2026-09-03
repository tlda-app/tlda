import test from 'node:test'
import assert from 'node:assert/strict'

import { deleteProjectAndLocalBinding } from './tlda.mjs'

test('project delete removes the local source binding after the server project', async () => {
  const calls = []
  const result = await deleteProjectAndLocalBinding('example', {
    apiImpl: async (...args) => { calls.push(['api', ...args]) },
    lifecycleImpl: async (...args) => {
      calls.push(['daemon', ...args])
      return { unlinked: true }
    },
  })

  assert.deepEqual(result, { deleted: true, binding: { unlinked: true } })
  assert.deepEqual(calls, [
    ['api', 'DELETE', '/api/projects/example'],
    ['daemon', 'project-source-unlink', { project: 'example' }],
  ])
})

test('project delete clears a stale binding when the server project is already absent', async () => {
  const calls = []
  const result = await deleteProjectAndLocalBinding('example', {
    apiImpl: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    lifecycleImpl: async (...args) => {
      calls.push(args)
      return { unlinked: true }
    },
  })

  assert.deepEqual(result, { deleted: false, binding: { unlinked: true } })
  assert.deepEqual(calls, [['project-source-unlink', { project: 'example' }]])
})

test('project delete does not unlink when server deletion fails', async () => {
  let daemonCalled = false
  await assert.rejects(
    deleteProjectAndLocalBinding('example', {
      apiImpl: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }) },
      lifecycleImpl: async () => { daemonCalled = true },
    }),
    /unavailable/,
  )
  assert.equal(daemonCalled, false)
})

test('project delete explains how to finish when local unlink fails', async () => {
  await assert.rejects(
    deleteProjectAndLocalBinding('example', {
      apiImpl: async () => {},
      lifecycleImpl: async () => { throw new Error('connection refused') },
    }),
    /Project "example" was deleted on the server, but the local source binding could not be removed \(connection refused\)\. Re-run the same command once the daemon is up\./,
  )
})
