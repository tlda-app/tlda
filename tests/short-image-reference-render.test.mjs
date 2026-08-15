import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveInlineAttachments } from '../src/fleet/chat-render.mjs'

const renderMarkdown = text => text.replace(
  /!\[([^\]]*)\]\(([^)]+)\)/g,
  '<img alt="$1" src="$2">',
)

const attachments = [{
  type: 'file',
  id: 0,
  path: '/sender/private/plot.png',
  name: 'plot.png',
  url: '/api/file?path=%2Fserver%2Fuploads%2Fplot.png',
}]

test('short message-local image reference resolves through attachment metadata', () => {
  const html = resolveInlineAttachments(
    'See ![plot](image#0).',
    attachments,
    renderMarkdown,
  )

  assert.match(html, /<img alt="plot" src="\/api\/file\?path=%2Fserver%2Fuploads%2Fplot\.png">/)
  assert.doesNotMatch(html, /image#0|\/sender\/private\/plot\.png/)
})

test('legacy image attachment tokens still resolve', () => {
  const html = resolveInlineAttachments(
    'See ![plot]({{att:0}}).',
    attachments,
    renderMarkdown,
  )

  assert.match(html, /<img alt="plot" src="\/api\/file\?path=%2Fserver%2Fuploads%2Fplot\.png">/)
})
