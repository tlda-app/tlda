// A chat message addressed to an agent renders, even when its text opens with 📬.
//
// 💻 and 📬 are TERMINAL system markers: everything tlda types into an agent's
// terminal marks its lines, and the mailbox says "this line is not something the
// agent entered, it is a notification the app injected". That is a fact about a
// terminal transcript row and only about one.
//
// The two marker tests used to run ahead of the terminal branch in renderChatLine,
// so they applied to every row. A bot's task check-in is a real chat event with a
// real address -- stored, delivered, and visible to `thread()` -- and it was
// rendered as nothing purely because its text opens with the marker. Measured
// 2026-09-03: 100% suppressed every day back to at least 08-09, 515 of 515 on
// 09-02, while the agent's reply rendered normally. So the panel showed answers to
// messages it never drew, which is what Skip reported.
//
// A chat shape is "messages to this address". A row addressed to the agent belongs
// in it.
//
// The terminal cases are the controls. Without them a change that simply deletes
// the suppression passes the first two assertions and silently fills every chat
// with transcript noise.
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderChatLine } from '../src/fleet/chat-render.mjs'

const ctx = {
  agentLabel: id => id,
  getNickClass: () => '',
  isHumanId: id => id === 'fleet:skip',
  getAgents: () => [],
  getTasks: () => [],
  tldaToken: null,
  renderMarkdown: html => html,
}

const KICK = '📬 Task check-in: you still have pending task **Ship the thing** (12m old).'

const chatRow = (text) => ({
  _evType: 'chat',
  from: 'fleet:todd',
  to: 'fleet:worker',
  recipients: ['fleet:worker'],
  text,
  timestamp: '2026-09-03T06:24:36.000Z',
  _dbId: 1,
})

const terminalRow = (text) => ({
  _evType: 'terminal_assistant',
  from: 'fleet:worker',
  to: 'fleet:worker',
  recipients: ['fleet:other'],
  text,
  timestamp: '2026-09-03T06:24:36.000Z',
  _dbId: 2,
})

test('a chat message opening with the mailbox marker renders', () => {
  const html = renderChatLine(chatRow(KICK), ctx)
  assert.notEqual(html, '', 'a chat event addressed to an agent must not render as nothing')
  assert.match(html, /Task check-in/)
})

test('the pre-marker wake wording is also chat and also renders', () => {
  // This phrasing prepends a line ahead of the 📬, which is why the original
  // suppression grew a regex rather than a startsWith. It is still chat.
  const html = renderChatLine(chatRow('You were away as hibernating for 12 minutes.\n\n' + KICK), ctx)
  assert.notEqual(html, '')
  assert.match(html, /Task check-in/)
})

test('CONTROL: the same text on a terminal row is still suppressed', () => {
  assert.equal(renderChatLine(terminalRow(KICK), ctx), '')
})

test('CONTROL: the pre-marker wake wording on a terminal row is still suppressed', () => {
  assert.equal(
    renderChatLine(terminalRow('You were away as hibernating for 12 minutes.\n\n' + KICK), ctx),
    '',
  )
})

test('CONTROL: a channel notification block is suppressed wherever it appears', () => {
  // Not marker-scoped -- a <channel> block is never something a person typed, so
  // this one legitimately applies to any row and must keep doing so.
  assert.equal(renderChatLine(chatRow('<channel source="tlda">...</channel>'), ctx), '')
})

test('CONTROL: an ordinary chat message with no marker still renders', () => {
  // Guards the other direction: if this ever returns '' the harness is broken and
  // the assertions above would pass for the wrong reason.
  const html = renderChatLine(chatRow('the build finished, nothing to do'), ctx)
  assert.notEqual(html, '')
  assert.match(html, /nothing to do/)
})
