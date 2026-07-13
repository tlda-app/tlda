import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootstrapLaunchdJob,
  launchdDomain,
  launchctlCommand,
  probeLaunchdBootstrapCapability,
} from '../cli/lib/launchd-supervision.mjs'

function launchctlError(stderr) {
  const e = new Error('launchctl failed')
  e.stderr = Buffer.from(stderr)
  return e
}

test('launchdDomain defaults to gui uid and preserves override', () => {
  assert.equal(launchdDomain({ uid: 501, override: undefined }), 'gui/501')
  assert.equal(launchdDomain({ uid: 501, override: 'user/501' }), 'user/501')
})

test('launchctlCommand runs same-user gui-domain launchctl directly', () => {
  assert.deepEqual(
    launchctlCommand(['bootstrap', 'gui/501', '/tmp/fleet.plist'], { uid: 501, currentUid: 501 }),
    { command: 'launchctl', args: ['bootstrap', 'gui/501', '/tmp/fleet.plist'] },
  )
  assert.deepEqual(
    launchctlCommand(['kickstart', 'gui/501/com.tlda.fleet-daemon'], { uid: 501, currentUid: 501 }),
    { command: 'launchctl', args: ['kickstart', 'gui/501/com.tlda.fleet-daemon'] },
  )
})

test('launchctlCommand runs different-user gui-domain launchctl through asuser', () => {
  assert.deepEqual(
    launchctlCommand(['bootstrap', 'gui/501', '/tmp/fleet.plist'], { uid: 501, currentUid: 502 }),
    { command: 'launchctl', args: ['asuser', '501', 'launchctl', 'bootstrap', 'gui/501', '/tmp/fleet.plist'] },
  )
  assert.deepEqual(
    launchctlCommand(['kickstart', 'gui/501/com.tlda.fleet-daemon'], { uid: 501, currentUid: 502 }),
    { command: 'launchctl', args: ['asuser', '501', 'launchctl', 'kickstart', 'gui/501/com.tlda.fleet-daemon'] },
  )
})

test('launchctlCommand prints gui-domain launchd state directly', () => {
  assert.deepEqual(
    launchctlCommand(['print', 'gui/501/com.tlda.fleet-daemon'], { uid: 501, currentUid: 502 }),
    { command: 'launchctl', args: ['print', 'gui/501/com.tlda.fleet-daemon'] },
  )
})

test('launchctlCommand leaves non-gui override domains direct', () => {
  assert.deepEqual(
    launchctlCommand(['bootstrap', 'user/501', '/tmp/fleet.plist'], { uid: 501 }),
    { command: 'launchctl', args: ['bootstrap', 'user/501', '/tmp/fleet.plist'] },
  )
})

test('bootstrap failure aborts loudly and does not kickstart', async () => {
  const calls = []
  await assert.rejects(
    bootstrapLaunchdJob({
      plist: '/tmp/fleet.plist',
      label: 'com.tlda.fleet-daemon',
      domain: 'gui/501',
      runLaunchctl: async (args) => {
        calls.push(args)
        if (args[0] === 'bootstrap') throw launchctlError('Bootstrap failed: 5: Input/output error')
      },
    }),
    /Input\/output error/,
  )
  assert.deepEqual(calls, [['bootstrap', 'gui/501', '/tmp/fleet.plist']])
})

test('bootstrap errno 37 is idempotent and still kickstarts', async () => {
  const calls = []
  await bootstrapLaunchdJob({
    plist: '/tmp/fleet.plist',
    label: 'com.tlda.fleet-daemon',
    domain: 'gui/501',
    runLaunchctl: async (args) => {
      calls.push(args)
      if (args[0] === 'bootstrap') throw launchctlError('Bootstrap failed: 5: Input/output error; errno = 37')
    },
  })
  assert.deepEqual(calls, [
    ['bootstrap', 'gui/501', '/tmp/fleet.plist'],
    ['kickstart', 'gui/501/com.tlda.fleet-daemon'],
  ])
})

test('bootstrap real errno 37 format is idempotent and still kickstarts', async () => {
  const calls = []
  await bootstrapLaunchdJob({
    plist: '/tmp/fleet.plist',
    label: 'com.tlda.fleet-daemon',
    domain: 'gui/501',
    runLaunchctl: async (args) => {
      calls.push(args)
      if (args[0] === 'bootstrap') throw launchctlError('Bootstrap failed: 37: Operation already in progress')
    },
  })
  assert.deepEqual(calls, [
    ['bootstrap', 'gui/501', '/tmp/fleet.plist'],
    ['kickstart', 'gui/501/com.tlda.fleet-daemon'],
  ])
})

test('capability probe cleans up plist and bootouts in finally after failure', async () => {
  const calls = []
  await assert.rejects(
    probeLaunchdBootstrapCapability({
      label: 'com.tlda.fleet-daemon.capcheck.123',
      plist: '/tmp/capcheck.plist',
      domain: 'gui/501',
      runLaunchctl: async (args) => {
        calls.push(['launchctl', ...args])
        if (args[0] === 'bootstrap') throw launchctlError('Not privileged to bootstrap')
      },
      writeFile: (file) => calls.push(['write', file]),
      unlinkFile: (file) => calls.push(['unlink', file]),
    }),
    /Not privileged/,
  )
  assert.deepEqual(calls, [
    ['write', '/tmp/capcheck.plist'],
    ['launchctl', 'bootstrap', 'gui/501', '/tmp/capcheck.plist'],
    ['launchctl', 'bootout', 'gui/501/com.tlda.fleet-daemon.capcheck.123'],
    ['unlink', '/tmp/capcheck.plist'],
  ])
})

test('capability probe treats errno 37 as pass and still cleans up', async () => {
  const calls = []
  await probeLaunchdBootstrapCapability({
    label: 'com.tlda.fleet-daemon.capcheck.456',
    plist: '/tmp/capcheck.plist',
    domain: 'gui/501',
    runLaunchctl: async (args) => {
      calls.push(args)
      if (args[0] === 'bootstrap') throw launchctlError('service already loaded: errno = 37')
    },
    writeFile: (file) => calls.push(['write', file]),
    unlinkFile: (file) => calls.push(['unlink', file]),
  })
  assert.deepEqual(calls, [
    ['write', '/tmp/capcheck.plist'],
    ['bootstrap', 'gui/501', '/tmp/capcheck.plist'],
    ['bootout', 'gui/501/com.tlda.fleet-daemon.capcheck.456'],
    ['unlink', '/tmp/capcheck.plist'],
  ])
})
