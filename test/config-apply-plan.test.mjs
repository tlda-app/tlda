import test from 'node:test'
import assert from 'node:assert/strict'
import { planLaunchdApply } from '../cli/lib/config-apply-plan.mjs'

test('planLaunchdApply adds missing jobs', () => {
  const plan = planLaunchdApply({
    desiredJobs: [{ label: 'com.tlda.fleet-daemon.testing', plist: '/a/testing.plist', content: 'new' }],
    existingJobs: [],
  })
  assert.deepEqual(plan.add.map(j => j.label), ['com.tlda.fleet-daemon.testing'])
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.unchanged, [])
  assert.deepEqual(plan.remove, [])
})

test('planLaunchdApply updates changed jobs and leaves identical jobs alone', () => {
  const plan = planLaunchdApply({
    desiredJobs: [
      { label: 'com.tlda.fleet-daemon', plist: '/a/default.plist', content: 'same' },
      { label: 'com.tlda.bot.dev', plist: '/a/dev.plist', content: 'new' },
    ],
    existingJobs: [
      { label: 'com.tlda.fleet-daemon', plist: '/a/default.plist', content: 'same' },
      { label: 'com.tlda.bot.dev', plist: '/a/dev.plist', content: 'old' },
    ],
  })
  assert.deepEqual(plan.add, [])
  assert.deepEqual(plan.update.map(j => j.label), ['com.tlda.bot.dev'])
  assert.deepEqual(plan.unchanged.map(j => j.label), ['com.tlda.fleet-daemon'])
  assert.deepEqual(plan.remove, [])
})

test('planLaunchdApply removes stale managed jobs', () => {
  const plan = planLaunchdApply({
    desiredJobs: [{ label: 'com.tlda.fleet-daemon.testing', plist: '/a/testing.plist', content: 'new' }],
    existingJobs: [
      { label: 'com.tlda.fleet-daemon', plist: '/a/default.plist', content: 'old' },
      { label: 'com.tlda.fleet-daemon.testing', plist: '/a/testing.plist', content: 'new' },
      { label: 'com.tlda.bot.teacher', plist: '/a/teacher.plist', content: 'old' },
    ],
  })
  assert.deepEqual(plan.add, [])
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.unchanged.map(j => j.label), ['com.tlda.fleet-daemon.testing'])
  assert.deepEqual(plan.remove.map(j => j.label), ['com.tlda.fleet-daemon', 'com.tlda.bot.teacher'])
})

test('planLaunchdApply rejects malformed desired jobs', () => {
  assert.throws(
    () => planLaunchdApply({ desiredJobs: [{ label: 'com.tlda.bad', plist: '/a/bad.plist' }], existingJobs: [] }),
    /missing content/,
  )
})

