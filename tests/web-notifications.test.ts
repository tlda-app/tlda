import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectNewItems,
  notificationContentFor,
  shouldNotifyForItem,
  showWebNotification,
} from '../src/webNotifications'

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    kind: 'info',
    title: 'Delegated: answer two questions',
    body: 'real-noncore-pm needs answers',
    present: { chat: true },
    ts: Date.now(),
    ...overrides,
  }
}

test('hud and list items notify; chat-only and suggest items do not', () => {
  assert.equal(shouldNotifyForItem(item({ present: { chat: true, hud: true } })), true)
  assert.equal(shouldNotifyForItem(item({ present: { chat: true, list: true } })), true)
  assert.equal(shouldNotifyForItem(item({ present: { chat: true } })), false)
  assert.equal(shouldNotifyForItem(item({ kind: 'suggest', present: { chat: true } })), false)
  // A suggest chip forced into the hud still notifies: placement wins over kind.
  assert.equal(shouldNotifyForItem(item({ kind: 'suggest', present: { chat: true, hud: true } })), true)
})

test('content falls back to a titled notification rather than an empty one', () => {
  assert.deepEqual(notificationContentFor(item({ title: 'T', body: 'B' })), { title: 'T', body: 'B' })
  assert.deepEqual(notificationContentFor(item({ title: '', body: undefined })), { title: 'tlda', body: '' })
  assert.deepEqual(notificationContentFor(item({ title: '  ', body: 'B' })), { title: 'tlda', body: 'B' })
})

test('only unseen ids notify, and the seen set stays bounded', () => {
  const seen = new Set<string>()
  const first = [item({ id: 'a' }), item({ id: 'b' })]
  assert.deepEqual(collectNewItems(seen, first).map(i => (i as { id: string }).id), ['a', 'b'])
  assert.deepEqual(collectNewItems(seen, [...first, item({ id: 'c' })]).map(i => (i as { id: string }).id), ['c'])
  assert.deepEqual(collectNewItems(seen, first), [])
})

test('a granted permission reaches the platform Notification', () => {
  const shown: Array<{ title: string; options: unknown }> = []
  const FakeNotification = function (this: unknown, title: string, options: unknown) {
    shown.push({ title, options })
  } as unknown as typeof Notification
  const result = showWebNotification(
    item({ id: 'n-1', title: 'T', body: 'B' }),
    { permission: 'granted', ctor: FakeNotification },
  )
  assert.equal(result, 'shown')
  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, 'T')
  assert.deepEqual((shown[0].options as { tag: string }).tag, 'n-1')
})

test('denied, default, and missing platforms never construct', () => {
  let constructed = 0
  const CountingNotification = function (this: unknown) {
    constructed++
  } as unknown as typeof Notification
  assert.equal(showWebNotification(item(), { permission: 'denied', ctor: CountingNotification }), 'skipped')
  assert.equal(showWebNotification(item(), { permission: 'default', ctor: CountingNotification }), 'skipped')
  assert.equal(showWebNotification(item(), { permission: 'granted', ctor: undefined }), 'unsupported')
  assert.equal(constructed, 0)
  const ThrowingNotification = function (this: unknown) {
    throw new Error('gone')
  } as unknown as typeof Notification
  assert.equal(showWebNotification(item(), { permission: 'granted', ctor: ThrowingNotification }), 'failed')
})
