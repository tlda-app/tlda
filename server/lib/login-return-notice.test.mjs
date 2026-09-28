// The return notice is agent mail: the parked notice if one is parked, else
// the away notice. The MCP channel's own login must neither receive nor
// consume it — the channel ignores its reply, so handing over there drops
// the agent's mail into a transport log nobody reads.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loginReturnNoticeHandover } from './login-return-notice.mjs'

test('agent login takes delivery of a parked notice and consumes it', () => {
  const out = loginReturnNoticeHandover({ pendingNotice: 'wake note', awayNotice: 'away note', isChannelLogin: false })
  assert.equal(out.notice, 'wake note')
  assert.equal(out.consume, true)
})

test('agent login with nothing parked gets the away notice without consuming', () => {
  const out = loginReturnNoticeHandover({ pendingNotice: null, awayNotice: 'away note', isChannelLogin: false })
  assert.equal(out.notice, 'away note')
  assert.equal(out.consume, false)
})

test('channel login neither receives nor consumes a parked notice', () => {
  const out = loginReturnNoticeHandover({ pendingNotice: 'wake note', awayNotice: 'away note', isChannelLogin: true })
  assert.equal(out.notice, null)
  assert.equal(out.consume, false)
})

test('unflagged login keeps the old behavior', () => {
  const out = loginReturnNoticeHandover({ pendingNotice: 'wake note' })
  assert.equal(out.notice, 'wake note')
  assert.equal(out.consume, true)
})
