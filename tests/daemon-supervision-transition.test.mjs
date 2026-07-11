import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DaemonTransitionFailed,
  assertTargetEnvironmentDaemon,
  daemonReadyLogEvidence,
  isCompleteTargetDaemonReady,
  parseFleetDaemonPids,
  parseLaunchdPid,
  pollTargetDaemonReadiness,
  runDaemonStartWithSupervisedNoop,
  runBoundedDaemonStartTransition,
} from '../cli/lib/daemon-supervision-transition.mjs'

test('parseLaunchdPid reads launchctl pid lines', () => {
  assert.equal(parseLaunchdPid('state = running\npid = 22470\n'), 22470)
  assert.equal(parseLaunchdPid('state = waiting\n'), null)
})

test('parseFleetDaemonPids finds daemon node processes', () => {
  const output = `
    101 /bin/zsh
    22470 node --import tsx bin/fleet-daemon.mjs
    22471 grep fleet-daemon
    70280 node --import tsx /Users/skip/work/tlda/.worktrees/dev/bin/fleet-daemon.mjs
  `
  assert.deepEqual(parseFleetDaemonPids(output), [22470, 70280])
})

test('target environment verification tolerates other environment daemons', () => {
  assert.equal(assertTargetEnvironmentDaemon({
    expectedPid: 22470,
    lockInspection: { held: true, holder: { pid: 22470, origin: 'https://tlda.example#default' } },
    pidFilePid: 22470,
    launchdPid: 22470,
    observedDaemonPids: [70280, 22470, 91312],
  }), true)
})

test('target environment verification rejects wrong lock holder', () => {
  assert.throws(() => assertTargetEnvironmentDaemon({
    expectedPid: 22470,
    lockInspection: { held: true, holder: { pid: 70280, origin: 'http://mini:5293#dev-preview' } },
    pidFilePid: 22470,
    observedDaemonPids: [70280, 22470],
  }), /lock held by pid 70280/)
})

test('target environment verification accepts launchd wrapper owning daemon pid', () => {
  assert.equal(assertTargetEnvironmentDaemon({
    expectedPid: 85682,
    lockInspection: { held: true, holder: { pid: 85682, origin: 'https://tlda.example#default' } },
    pidFilePid: 85682,
    launchdPid: 85607,
    launchdOwnsDaemon: true,
    observedDaemonPids: [85682],
  }), true)
})

test('complete target readiness requires Fly WS and watcher evidence', () => {
  assert.deepEqual(isCompleteTargetDaemonReady({
    expectedPid: 22470,
    lockInspection: { held: true, holder: { pid: 22470 } },
    pidFilePid: 22470,
    launchdPid: 22470,
    observedDaemonPids: [22470],
    flyWsConnected: true,
    watcherReady: true,
  }), { ready: true, reason: 'ready' })

  assert.equal(isCompleteTargetDaemonReady({
    expectedPid: 22470,
    lockInspection: { held: true, holder: { pid: 22470 } },
    pidFilePid: 22470,
    launchdPid: 22470,
    observedDaemonPids: [22470],
    flyWsConnected: true,
    watcherReady: false,
  }).ready, false)
})

test('daemon ready log evidence binds readiness to pid, target server, machine, and env', () => {
  const log = `
[daemon] fleet-daemon 0.1.1 starting pid=22470
[daemon]   server      = https://tlda-fly.cormorant-matrix.ts.net
[daemon] daemon-ready pid=22470 server=https://tlda-fly.cormorant-matrix.ts.net machine_id=mini env_name=default agents=10 projects=4 watchers=started
`
  assert.equal(daemonReadyLogEvidence(log, {
    pid: 22470,
    server: 'https://tlda-fly.cormorant-matrix.ts.net',
    machineId: 'mini',
    envName: 'default',
  }), true)
  assert.equal(daemonReadyLogEvidence(log, {
    pid: 70280,
    server: 'https://tlda-fly.cormorant-matrix.ts.net',
    machineId: 'mini',
    envName: 'default',
  }), false)
})

test('readiness polling waits through launchd pid before readiness and then succeeds', async () => {
  let poll = 0
  const result = await pollTargetDaemonReadiness({
    previousPid: 22470,
    timeoutMs: 1000,
    pollMs: 1,
    getCandidatePid: async () => 22500,
    inspectReadiness: async (pid) => {
      poll += 1
      return poll >= 3 ? { ready: true, pid } : { ready: false, reason: 'watchers not ready' }
    },
  })
  assert.deepEqual(result, { pid: 22500, ready: true })
  assert.equal(poll, 3)
})

test('readiness timeout routes to fallback when launchd pid appears but readiness never arrives', async () => {
  const calls = []
  const result = await runBoundedDaemonStartTransition({
    existingPid: 22470,
    supervisedTimeoutMs: 5,
    fallbackTimeoutMs: 5,
    writePlist: async () => calls.push('write-plist'),
    bootstrap: async () => calls.push('bootstrap'),
    stopExisting: async (pid) => calls.push(`stop:${pid}`),
    waitSupervised: async ({ previousPid, timeoutMs }) => {
      calls.push(`wait-supervised:${previousPid}:${timeoutMs}`)
      const readiness = await pollTargetDaemonReadiness({
        previousPid,
        timeoutMs,
        pollMs: 1,
        getCandidatePid: async () => 22500,
        inspectReadiness: async () => ({ ready: false, reason: 'no watcher marker' }),
      })
      return readiness.ready ? readiness.pid : null
    },
    startDirectFallback: async ({ previousPid }) => {
      calls.push(`fallback:${previousPid}`)
      return 22501
    },
    verifyTargetDaemon: async (pid, opts) => calls.push(`verify:${pid}:${opts.supervised}`),
    stageRecoveryAction: async () => calls.push('stage-recovery'),
  })

  assert.deepEqual(result, { mode: 'direct-fallback', pid: 22501, fallbackUsed: true })
  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised:22470:5',
    'fallback:22470',
    'verify:22501:false',
  ])
})

test('bounded transition preflights before stopping and verifies supervised daemon readiness', async () => {
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
    verifyTargetDaemon: async (pid, opts) => calls.push(`verify:${pid}:${opts.supervised}`),
    stageRecoveryAction: async () => {
      calls.push('stage-recovery')
      return null
    },
  })

  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised:22470',
    'verify:22500:true',
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
    verifyTargetDaemon: async (pid, opts) => calls.push(`verify:${pid}:${opts.supervised}`),
    stageRecoveryAction: async () => {
      calls.push('stage-recovery')
      return null
    },
  })

  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised',
    'fallback:22470',
    'verify:22501:false',
  ])
  assert.deepEqual(result, { mode: 'direct-fallback', pid: 22501, fallbackUsed: true })
})

test('bounded transition stages explicit recovery when supervised and fallback both fail', async () => {
  const calls = []
  await assert.rejects(
    runBoundedDaemonStartTransition({
      existingPid: 22470,
      writePlist: async () => calls.push('write-plist'),
      bootstrap: async () => calls.push('bootstrap'),
      stopExisting: async (pid) => calls.push(`stop:${pid}`),
      waitSupervised: async () => {
        calls.push('wait-supervised')
        return null
      },
      startDirectFallback: async () => {
        calls.push('fallback')
        return null
      },
      verifyTargetDaemon: async () => calls.push('verify'),
      stageRecoveryAction: async ({ stoppedPid }) => {
        calls.push(`stage-recovery:${stoppedPid}`)
        return { file: '/tmp/recover.sh', command: 'sh /tmp/recover.sh' }
      },
    }),
    (e) => {
      assert.equal(e instanceof DaemonTransitionFailed, true)
      assert.equal(e.daemonless, true)
      assert.deepEqual(e.recovery, { file: '/tmp/recover.sh', command: 'sh /tmp/recover.sh' })
      return true
    },
  )
  assert.deepEqual(calls, [
    'write-plist',
    'bootstrap',
    'stop:22470',
    'wait-supervised',
    'fallback',
    'stage-recovery:22470',
  ])
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
      verifyTargetDaemon: async () => {},
      stageRecoveryAction: async () => calls.push('stage-recovery'),
    }),
    /launchd preflight failed/,
  )
  assert.deepEqual(calls, ['write-plist', 'bootstrap'])
})

test('bounded transition does not stop outside daemon when launchd capability probe fails in preflight', async () => {
  const calls = []
  await assert.rejects(
    runBoundedDaemonStartTransition({
      existingPid: 22470,
      writePlist: async () => {
        calls.push('capcheck')
        throw new Error('launchd capability probe failed')
      },
      bootstrap: async () => calls.push('bootstrap-real'),
      stopExisting: async () => calls.push('stop-22470'),
      waitSupervised: async () => null,
      startDirectFallback: async () => null,
      verifyTargetDaemon: async () => {},
      stageRecoveryAction: async () => calls.push('stage-recovery'),
    }),
    /capability probe failed/,
  )
  assert.deepEqual(calls, ['capcheck'])
})

test('daemon start no-ops when pidfile daemon is already supervised and ready', async () => {
  const calls = []
  const result = await runDaemonStartWithSupervisedNoop({
    existingPid: 22470,
    getLaunchdPid: async () => {
      calls.push('launchd-pid')
      return 22470
    },
    verifyTargetDaemon: async (pid, opts) => calls.push(`verify:${pid}:${opts.supervised}`),
    runBoundedTransition: async () => {
      calls.push('bounded-transition')
      return { mode: 'bounded' }
    },
  })
  assert.deepEqual(result, { mode: 'already-supervised', pid: 22470 })
  assert.deepEqual(calls, ['launchd-pid', 'verify:22470:true'])
})

test('daemon start no-ops when launchd wrapper owns pidfile daemon', async () => {
  const calls = []
  const result = await runDaemonStartWithSupervisedNoop({
    existingPid: 85682,
    getLaunchdPid: async () => {
      calls.push('launchd-pid')
      return 85607
    },
    launchdOwnsExisting: async (launchdPid, daemonPid) => {
      calls.push(`owns:${launchdPid}:${daemonPid}`)
      return true
    },
    verifyTargetDaemon: async (pid, opts) => calls.push(`verify:${pid}:${opts.supervised}`),
    runBoundedTransition: async () => {
      calls.push('bounded-transition')
      return { mode: 'bounded' }
    },
  })
  assert.deepEqual(result, { mode: 'already-supervised', pid: 85682 })
  assert.deepEqual(calls, ['launchd-pid', 'owns:85607:85682', 'verify:85682:true'])
})

test('daemon start runs bounded transition when launchd pid differs or is absent', async () => {
  const calls = []
  const result = await runDaemonStartWithSupervisedNoop({
    existingPid: 22470,
    getLaunchdPid: async () => {
      calls.push('launchd-pid')
      return null
    },
    verifyTargetDaemon: async () => calls.push('verify'),
    runBoundedTransition: async () => {
      calls.push('bounded-transition')
      return { mode: 'supervised', pid: 22500, fallbackUsed: false }
    },
  })
  assert.deepEqual(result, { mode: 'supervised', pid: 22500, fallbackUsed: false })
  assert.deepEqual(calls, ['launchd-pid', 'bounded-transition'])
})
