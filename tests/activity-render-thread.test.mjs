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

test('activity cards carry latency timestamp attributes for visible telemetry', () => {
  const html = renderActivityGroup([{
    from: 'fleet:latency',
    timestamp: '2026-07-13T12:00:00.000Z',
    _dbId: 42,
    _toolName: 'Bash',
    _toolArg: 'npm test',
    _activityLatency: {
      jsonlTs: '2026-07-13T12:00:00.000Z',
      daemonReceivedAtMs: 1783944000050,
      daemonSentAtMs: 1783944000100,
      serverReceivedAtMs: 1783944000200,
      serverBroadcastQueuedAtMs: 1783944000210,
      browserReceivedAtMs: 1783944000300,
      browserRenderQueuedAtMs: 1783944000315,
    },
  }], ctx)

  assert.match(html, /data-msg-id="42"/)
  assert.match(html, /data-jsonl-ts="2026-07-13T12:00:00.000Z"/)
  assert.match(html, /data-daemon-received-at-ms="1783944000050"/)
  assert.match(html, /data-daemon-sent-at-ms="1783944000100"/)
  assert.match(html, /data-server-received-at-ms="1783944000200"/)
  assert.match(html, /data-server-broadcast-queued-at-ms="1783944000210"/)
  assert.match(html, /data-browser-received-at-ms="1783944000300"/)
  assert.match(html, /data-browser-render-queued-at-ms="1783944000315"/)
})
