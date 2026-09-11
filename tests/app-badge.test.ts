import assert from 'node:assert/strict'
import test from 'node:test'
import { appBadgeSupported, applyAppBadge, badgeCountFor } from '../src/appBadge'

function badgingNavigator() {
  const calls: Array<['set', number | undefined] | ['clear']> = []
  return {
    calls,
    nav: {
      setAppBadge: async (count?: number) => { calls.push(['set', count]) },
      clearAppBadge: async () => { calls.push(['clear']) },
    },
  }
}

test('a positive unread count reaches the platform badge', async () => {
  const { nav, calls } = badgingNavigator()
  assert.equal(await applyAppBadge(3, nav), 'set')
  assert.deepEqual(calls, [['set', 3]])
})

test('zero unread clears the badge', async () => {
  const { nav, calls } = badgingNavigator()
  assert.equal(await applyAppBadge(0, nav), 'cleared')
  assert.deepEqual(calls, [['clear']])
})

test('unsupported and rejecting platforms do not break the app', async () => {
  assert.equal(appBadgeSupported({}), false)
  assert.equal(await applyAppBadge(5, {}), 'unsupported')
  const nav = {
    setAppBadge: async () => { throw new Error('denied') },
    clearAppBadge: async () => { throw new Error('denied') },
  }
  assert.equal(await applyAppBadge(2, nav), 'failed')
})

test('invalid counts clear rather than reaching the platform', () => {
  assert.equal(badgeCountFor(Number.NaN), 0)
  assert.equal(badgeCountFor(-4), 0)
  assert.equal(badgeCountFor(2.7), 2)
})
