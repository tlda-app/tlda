import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertOwnerCapableLaunchdManager,
  isOwnerCapableLaunchdManager,
  transitionLaunchdJob,
} from '../cli/lib/config-apply-transition.mjs'

test('only the owner Aqua launchd manager may apply configuration', () => {
  assert.equal(isOwnerCapableLaunchdManager('Aqua\n'), true)
  assert.equal(isOwnerCapableLaunchdManager('Background\n'), false)
  assert.throws(
    () => assertOwnerCapableLaunchdManager('Background'),
    /^Error: configuration is not applied$/,
  )
})

test('failed update restores and reboots the prior loaded job', async () => {
  const calls = []
  const previous = { label: 'com.tlda.bot.todd.testing', content: 'old', loaded: true }
  const job = { label: previous.label, content: 'new', previous }
  let firstBootstrap = true

  await assert.rejects(
    transitionLaunchdJob(job, 'update', {
      install: async value => calls.push(['install', value.content]),
      remove: async value => calls.push(['remove', value.content]),
      bootout: async value => calls.push(['bootout', value.content]),
      bootstrap: async value => {
        calls.push(['bootstrap', value.content])
        if (firstBootstrap) {
          firstBootstrap = false
          throw new Error('new bootstrap failed')
        }
      },
    }),
    /new bootstrap failed/,
  )

  assert.deepEqual(calls, [
    ['install', 'new'],
    ['bootout', 'new'],
    ['bootstrap', 'new'],
    ['bootout', 'new'],
    ['install', 'old'],
    ['bootstrap', 'old'],
  ])
})

test('failed add restores the prior unloaded plist without starting it', async () => {
  const calls = []
  const previous = { label: 'com.tlda.bot.todd.testing', content: 'old', loaded: false }
  const job = { label: previous.label, content: 'new', previous }

  await assert.rejects(
    transitionLaunchdJob(job, 'add', {
      install: async value => calls.push(['install', value.content]),
      remove: async value => calls.push(['remove', value.content]),
      bootout: async value => calls.push(['bootout', value.content]),
      bootstrap: async value => {
        calls.push(['bootstrap', value.content])
        throw new Error('bootstrap failed')
      },
    }),
    /bootstrap failed/,
  )

  assert.deepEqual(calls, [
    ['install', 'new'],
    ['bootstrap', 'new'],
    ['bootout', 'new'],
    ['install', 'old'],
  ])
})

test('failed new add removes the unregistered plist', async () => {
  const calls = []
  const job = { label: 'com.tlda.bot.nobody.testing', content: 'new' }

  await assert.rejects(
    transitionLaunchdJob(job, 'add', {
      install: async value => calls.push(['install', value.content]),
      remove: async value => calls.push(['remove', value.content]),
      bootout: async value => calls.push(['bootout', value.content]),
      bootstrap: async value => {
        calls.push(['bootstrap', value.content])
        throw new Error('bootstrap failed')
      },
    }),
    /bootstrap failed/,
  )

  assert.deepEqual(calls, [
    ['install', 'new'],
    ['bootstrap', 'new'],
    ['bootout', 'new'],
    ['remove', 'new'],
  ])
})
