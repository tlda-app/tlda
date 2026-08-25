/**
 * What a Bash card and a run of polls actually draw.
 *
 * Both of these are things Skip could see were wrong by looking at his chat —
 * a command running off the side, and thirty rows saying nothing — so the check
 * is on the rendered output rather than on the functions underneath it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

const CTX = {
  agentLabel: () => 'codex',
  getNickClass: () => '',
  getAgents: () => [],
  renderMarkdown: value => value,
  highlightSyntax: value => value,
  langFromFilePath: () => '',
}

const render = group => new JSDOM(renderActivityGroup(group, CTX)).window.document

const ONE_LINER = 'cd ~/worktrees/x && npx eslint a.mjs 2>&1 | tail -6; git commit -q -m msg'

test('a long one-liner is laid out at the joins, and copy keeps the original', () => {
  const doc = render([{
    from: 'fleet:codex',
    timestamp: '2026-08-25T06:00:00.000Z',
    _toolName: 'Bash',
    _toolArg: ONE_LINER,
    _toolInput: { command: ONE_LINER },
  }])

  const code = doc.querySelector('pre.code-bash code')
  assert.ok(code, 'the command renders as a bash card')
  const rendered = code.textContent
  assert.ok(rendered.includes('cd ~/worktrees/x &&\n'), 'breaks after &&')
  assert.ok(rendered.includes('tail -6 ;\n'), 'breaks after ;')
  assert.ok(rendered.includes('2>&1 |\n'), 'a redirection stays with its command')
  assert.equal(rendered.split('\n').length, 4)

  // What you paste is what ran, not our layout of it. A <template>'s text is in
  // its content fragment, not its textContent.
  const copySource = doc.querySelector('template.code-block-copy-source')
  assert.ok(copySource, 'the card carries a copy source')
  assert.equal(copySource.content.textContent, ONE_LINER, 'copy hands over the original command')
})

test('a run of polls is one waiting row, with what it waits on and for how long', () => {
  const poll = (ts, id) => ({
    from: 'fleet:codex',
    timestamp: ts,
    _toolName: 'CodeOutput',
    _toolArg: '',
    _toolStatus: 'started',
    _toolInput: {
      waitingOn: 'Bash: npm run build',
      action: 'wait for output',
      _semanticOutputHandle: 'cell:41',
      _semanticWaitingOnId: id,
    },
  })

  const doc = render([
    poll('2026-08-25T06:00:00.000Z', 'call_parent'),
    poll('2026-08-25T06:00:30.000Z', 'call_parent'),
    poll('2026-08-25T06:01:00.000Z', 'call_parent'),
    poll('2026-08-25T06:01:30.000Z', 'call_parent'),
  ])

  const rows = doc.querySelectorAll('.tool-waiting-line')
  assert.equal(rows.length, 1, 'four polls, one row')

  const row = rows[0]
  assert.equal(row.querySelector('.waiting-label').textContent, 'Waiting for output')
  assert.equal(row.querySelector('.waiting-subject').textContent, 'Bash: npm run build')
  assert.equal(
    row.querySelector('.waiting-subject').getAttribute('data-waiting-on-id'),
    'call_parent',
    'the row points at the call that started the command',
  )
  assert.ok(row.getAttribute('data-waiting-since'), 'the ticker has an epoch to count from')
  assert.ok(row.querySelector('.waiting-elapsed'), 'elapsed is shown')

  // The number on it is time, never a count of polls.
  assert.equal(doc.querySelectorAll('.tool-count').length, 0)
})

test('interleaved polls of two different things stay two rows', () => {
  const wait = (ts, handle, subject) => ({
    from: 'fleet:codex',
    timestamp: ts,
    _toolName: 'CodeOutput',
    _toolArg: '',
    _toolStatus: 'started',
    _toolInput: { waitingOn: subject, action: 'wait for output', _semanticOutputHandle: handle },
  })
  const doc = render([
    wait('2026-08-25T06:00:00.000Z', 'cell:41', 'Bash: npm run build'),
    wait('2026-08-25T06:00:01.000Z', 'cell:42', 'Bash: npm test'),
    wait('2026-08-25T06:00:30.000Z', 'cell:41', 'Bash: npm run build'),
    wait('2026-08-25T06:00:31.000Z', 'cell:42', 'Bash: npm test'),
  ])
  const subjects = [...doc.querySelectorAll('.waiting-subject')].map(n => n.textContent)
  assert.deepEqual(subjects, ['Bash: npm run build', 'Bash: npm test'])
})

test('once the output lands the row is the result, not a wait', () => {
  const base = {
    from: 'fleet:codex',
    timestamp: '2026-08-25T06:00:00.000Z',
    _toolName: 'CodeOutput',
    _toolArg: '',
    _toolInput: { waitingOn: 'Bash: npm run build', action: 'wait for output', _semanticOutputHandle: 'cell:41' },
  }
  const doc = render([
    { ...base, _toolStatus: 'started' },
    { ...base, timestamp: '2026-08-25T06:00:30.000Z', _toolStatus: 'completed', _prettyResult: 'build succeeded' },
  ])
  assert.equal(doc.querySelectorAll('.tool-waiting-line').length, 0, 'the wait is over, so the waiting row is gone')
  assert.ok(doc.body.textContent.includes('build succeeded'))
})
