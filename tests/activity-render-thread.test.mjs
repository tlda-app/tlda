import assert from 'node:assert/strict'
import test from 'node:test'

import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

const ctx = {
  agentLabel: id => id.replace(/^fleet:/, ''),
  getNickClass: () => 'nick-test',
  getAgents: () => [],
  renderMarkdown: text => `<p>${text}</p>`,
  highlightSyntax: code => code,
  langFromFilePath: () => '',
  foldHeights: { bash: 10 },
}

test('get_thread pretty result renders activity rows with existing activity styling', () => {
  const longCommand = 'node cli/tlda-dev.mjs pw eval "async () => { const ed = window.__tldraw_editor__; return Object.keys(window).filter(k => k.toLowerCase().includes(\'fleet\')).sort() }"'
  const thread = [
    '2 messages (6/25/2026, 3:55:46 AM -> 6/25/2026, 3:55:48 AM)',
    '',
    '[6/25/2026, 3:55:46 AM] move-machines fleet:3dcc6335 → move-machines fleet:3dcc6335',
    'Normal chat message',
    '',
    '---',
    '',
    '[6/25/2026, 3:55:48 AM] move-machines fleet:3dcc6335 → move-machines fleet:3dcc6335',
    '[activity #633181] Bash',
    `  ${longCommand}`,
  ].join('\n')

  const html = renderActivityGroup([{
    from: 'fleet:pretty',
    timestamp: '2026-06-25T07:55:49.000Z',
    _toolName: 'tlda/get_thread',
    _toolArg: 'fleet:3dcc6335',
    _toolInput: { agent: 'fleet:3dcc6335' },
    _prettyResult: thread,
  }], ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /pretty-thread-activity/)
  assert.match(html, /chat-activity-card/)
  assert.match(html, /tool-name">Bash</)
  assert.match(html, /code-block-lang">bash</)
  assert.doesNotMatch(html, /pretty-msg-body">\s*<p>\[activity #633181\]/)
})
