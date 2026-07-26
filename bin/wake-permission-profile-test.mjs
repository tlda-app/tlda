#!/usr/bin/env node
import assert from 'node:assert/strict'

import { compileWakePermissionProfile } from '../daemon/wake-permission-profile.mjs'

const staleStoredSet = {
  name: 'stale-app-dev',
  operations: {
    read: { allow: ['stale-read'], deny: [] },
    write: { allow: ['stale-write'], deny: [] },
  },
}

const currentCompiledSet = {
  name: 'app-dev',
  operations: {
    read: { allow: ['current-read'], deny: [] },
    write: { allow: ['current-write'], deny: [] },
  },
}

const calls = []
const result = compileWakePermissionProfile({
  facts: {
    launchRecipe: {
      cwd: '/tmp/wake-profile',
      permissionGrant: 'app-dev',
      permissionSet: staleStoredSet,
    },
    processState: {
      permission_grant: 'wd',
      permission_set: staleStoredSet,
    },
  },
  wakeParams: {},
  loadDaemonLaunchConfig: () => ({ permissionProfiles: { 'app-dev': currentCompiledSet } }),
  readDaemonConfigForCwd: cwd => {
    calls.push(['readDaemonConfigForCwd', cwd])
    return { default: 'wd' }
  },
  withDaemonModelAliases: (base, daemonConfig) => {
    calls.push(['withDaemonModelAliases', daemonConfig.default])
    return base
  },
  compilePermissionGrant: (config, grant, { cwd }) => {
    calls.push(['compilePermissionGrant', grant, cwd])
    assert.equal(config.permissionProfiles['app-dev'], currentCompiledSet)
    return currentCompiledSet
  },
})

assert.equal(result.cwd, '/tmp/wake-profile')
assert.equal(result.permissionGrant, 'app-dev')
assert.equal(result.permissionSet, currentCompiledSet)
assert.deepEqual(calls, [
  ['readDaemonConfigForCwd', '/tmp/wake-profile'],
  ['withDaemonModelAliases', 'wd'],
  ['compilePermissionGrant', 'app-dev', '/tmp/wake-profile'],
])
assert.notEqual(result.permissionSet, staleStoredSet)

const override = compileWakePermissionProfile({
  facts: {
    launchRecipe: { cwd: '/tmp/wake-profile', permissionGrant: 'app-dev' },
  },
  wakeParams: { permission_grant: 'wd' },
  loadDaemonLaunchConfig: () => ({}),
  readDaemonConfigForCwd: () => ({}),
  withDaemonModelAliases: base => base,
  compilePermissionGrant: (_config, grant) => ({ name: grant }),
})

assert.equal(override.permissionGrant, 'wd')
assert.equal(override.permissionSet.name, 'wd')

console.log('wake-permission-profile-test: ok')
