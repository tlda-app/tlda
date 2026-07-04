import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MailboxLibrarian, type MailboxEntry } from './mailbox-librarian.ts'

describe('mailbox librarian', () => {
  it('returns a pending handle and settles it once', () => {
    const mailbox = new MailboxLibrarian({ idGenerator: () => 'mailbox:test-1' })
    const entry = mailbox.start({ kind: 'spawn', ownerId: 'fleet:caller', meta: { name: 'worker' } })

    assert.equal(entry.id, 'mailbox:test-1')
    assert.equal(entry.status, 'pending')
    assert.equal(mailbox.get(entry.id)?.meta.name, 'worker')

    const settled = mailbox.complete(entry.id, { agentId: 'fleet:worker' })
    assert.equal(settled?.status, 'completed')
    assert.equal(settled?.result?.agentId, 'fleet:worker')
    assert.equal(mailbox.fail(entry.id, 'too late'), null)
  })

  it('expires pending handles through the supplied timer', () => {
    const timers: Array<() => void> = []
    const expired: MailboxEntry[] = []
    const mailbox = new MailboxLibrarian({
      idGenerator: () => 'mailbox:test-2',
      setTimeoutFn: ((fn: () => void) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
      onExpire: (entry) => expired.push(entry),
    })

    mailbox.start({ kind: 'spawn', ownerId: 'fleet:caller', timeoutMs: 10 })
    timers[0]()

    assert.equal(mailbox.get('mailbox:test-2')?.status, 'failed')
    assert.equal(mailbox.get('mailbox:test-2')?.error, 'deadline exceeded')
    assert.equal(expired.length, 1)
    assert.equal(expired[0].id, 'mailbox:test-2')
  })
})
