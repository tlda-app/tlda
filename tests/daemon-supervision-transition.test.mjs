import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFleetDaemonPids,
  parseLaunchdPid,
  runBoundedDaemonStartTransition,
} from '../cli/lib/daemon-supervision-transition.mjs'

test('parseLaunchdPid reads launchctl pid lines', () => {
  assert.equal(parseLaunchdPid('state = running\npid = 22470\n'), 22470)
  assert.equal(parseLaunchdPid('state = waiting\n'), null)
})

test('parseFleetDaemonPids finds daemon node processes only', () => {
  const output = `
    101 /bin/zsh
    22470 node --import tsx bin/fleet-daemon.mjs
    22471 grep fleet-daemon
    22472 node --import tsx /Users/skip/work/tlda/bin/fleet-daemon.mjs
  `
  assert.deepEqual(parseFleetDaemonPids(output), [22470, 22472])
})

test('bounded transition preflights before stopping and verifies supervised daemon', async () => {
  const calls = []
  const result = await runBoundedDaemonStartTransition({
    existingPid: 22470,
    writePlist: async () => calls.push('write-plist'),
    bootstrap: async () => calls.push('bootstrap'),
    stopExisting: async (pid) => calls.push(`stop:${pid}`),
    waitSupervised: async ({ previousPid }) => {
      calls.push(`wait-supervised:${previousPid}`)
      return 22500
    },
    startDirectFallback: async () => {
      calls.push('fallback')
      return null
    },
    verifyExactlyOne: async (pid) => calls.push(`verify-one:${pid}`),
  })

  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised:22470',
    'verify-one:22500',
  ])
  assert.deepEqual(result, { mode: 'supervised', pid: 22500, fallbackUsed: false })
})

test('bounded transition uses direct fallback when supervised daemon does not come up', async () => {
  const calls = []
  const result = await runBoundedDaemonStartTransition({
    existingPid: 22470,
    writePlist: async () => calls.push('write-plist'),
    bootstrap: async () => calls.push('bootstrap'),
    stopExisting: async (pid) => calls.push(`stop:${pid}`),
    waitSupervised: async () => {
      calls.push('wait-supervised')
      return null
    },
    startDirectFallback: async ({ previousPid }) => {
      calls.push(`fallback:${previousPid}`)
      return 22501
    },
    verifyExactlyOne: async (pid) => calls.push(`verify-one:${pid}`),
  })

  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised',
    'fallback:22470',
    'verify-one:22501',
  ])
  assert.deepEqual(result, { mode: 'direct-fallback', pid: 22501, fallbackUsed: true })
})

test('bounded transition does not stop outside daemon when preflight fails', async () => {
  const calls = []
  await assert.rejects(
    runBoundedDaemonStartTransition({
      existingPid: 22470,
      writePlist: async () => calls.push('write-plist'),
      bootstrap: async () => {
        calls.push('bootstrap')
        throw new Error('launchd preflight failed')
      },
      stopExisting: async () => calls.push('stop'),
      waitSupervised: async () => null,
      startDirectFallback: async () => null,
      verifyExactlyOne: async () => {},
    }),
    /launchd preflight failed/,
  )
  assert.deepEqual(calls, ['write-plist', 'bootstrap'])
})
