import assert from 'node:assert/strict'
import test from 'node:test'
import { appBadgeSupported, applyAppBadge, badgeCountFor, coalesceAsyncRefresh } from '../src/appBadge'
// @ts-ignore — vanilla JS module
import { createFilterSubscriptions } from '../server/lib/filter-subscriptions.mjs'

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

test('a label-routed recipient reaches the existing live filter subscription', async () => {
  const connection = {}
  const subscriptions = createFilterSubscriptions({
    getAgentsByIds: async () => [{
      id: 'fleet:human',
      friendly_name: 'human-name',
      labels: ['reviewers'],
    }],
    loadMembershipSpans: async () => [],
  })
  subscriptions.subscribe(
    connection,
    'badge-refresh',
    [[['to', 'human-name']]],
    { humanId: 'fleet:human', humanName: 'human-name' },
  )
  const routedEvent = {
    from_id: 'fleet:sender',
    recipients: ['fleet:human'],
    metadata: { original_route: 'reviewers' },
  }
  const matches = await subscriptions.match(routedEvent)
  assert.deepEqual(matches.map(({ conn, subId }: any) => ({ conn, subId })), [
    { conn: connection, subId: 'badge-refresh' },
  ])
})

test('an arrival during a count read queues a second refresh', async () => {
  let releaseFirst: (() => void) | null = null
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
  let reads = 0
  const refresh = coalesceAsyncRefresh(async () => {
    reads++
    if (reads === 1) await firstBlocked
  })

  const first = refresh()
  const duringFirst = refresh()
  assert.equal(reads, 1)
  releaseFirst!()
  await Promise.all([first, duringFirst])
  assert.equal(reads, 2)
})
