import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { JSDOM } from 'jsdom'

import { detectAttachments, processMessageText } from '../shared/message-processing.mjs'
import { renderChatLine, resolveInlineAttachments } from '../src/fleet/chat-render.mjs'

function withTempDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-artifacts-'))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function startUploadStub() {
  const uploads = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/upload') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const name = decodeURIComponent(req.headers['x-filename'] || 'artifact.bin')
      uploads.push({ name, body: Buffer.concat(chunks) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: `/api/file?path=${encodeURIComponent(`/tmp/fleet-uploads/${name}`)}` }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        uploads,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

function renderMarkdownStub(text) {
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="chat-image" src="$2" alt="$1">')
}

function renderMarkdownWithOrdinaryLinks(text) {
  return renderMarkdownStub(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => `<a href="${href}" target="_blank">${label}</a>`)
    .replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank">${url}</a>`)
}

function renderCtx(renderMarkdown = renderMarkdownStub) {
  return {
    agentLabel: id => id,
    getNickClass: () => '',
    isHumanId: () => false,
    getAgents: () => [],
    getTasks: () => [],
    tldaToken: null,
    renderMarkdown,
  }
}

test('bare local image path uploads and rewrites to an attachment token', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`Artifact: ${img}`, dir, stub.baseUrl)
    assert.equal(result.resolvedMessage, 'Artifact: {{att:0}}')
    assert.deepEqual(result.brokenPaths, [])
    assert.equal(result.inlineAttachments.length, 1)
    assert.equal(result.inlineAttachments[0].path, img)
    assert.equal(result.inlineAttachments[0].name, 'activity-card.png')
    assert.match(result.inlineAttachments[0].url, /^\/api\/file\?path=/)
    assert.equal(stub.uploads.length, 1)
    assert.equal(stub.uploads[0].name, 'activity-card.png')
  } finally {
    await stub.close()
  }
}))

test('uploaded local image token renders as a visible chat image', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`Artifact: ${img}`, dir, stub.baseUrl)
    const html = renderChatLine({
      type: 'chat',
      from: 'fleet:agent',
      to: 'fleet:skip',
      text: result.resolvedMessage,
      _inlineAttachments: result.inlineAttachments,
      timestamp: '2026-06-18T00:00:00.000Z',
    }, renderCtx())
    const dom = new JSDOM(`<div id="root">${html}</div>`)
    const rendered = dom.window.document.querySelector('img.chat-image')
    assert.ok(rendered)
    assert.match(rendered.getAttribute('src'), /^\/api\/file\?path=/)
    assert.equal(rendered.getAttribute('alt'), 'activity-card.png')
    assert.equal(dom.window.document.getElementById('root').textContent.includes(img), false)
  } finally {
    await stub.close()
  }
}))

test('uploaded local image token in markdown image syntax renders with server URL', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`![proof](${img})`, dir, stub.baseUrl)
    const html = resolveInlineAttachments(result.resolvedMessage, result.inlineAttachments, renderMarkdownStub)
    const dom = new JSDOM(`<div id="root">${html}</div>`)
    const rendered = dom.window.document.querySelector('img.chat-image')
    assert.ok(rendered)
    assert.match(rendered.getAttribute('src'), /^\/api\/file\?path=/)
    assert.equal(rendered.getAttribute('alt'), 'proof')
  } finally {
    await stub.close()
  }
}))

test('missing bare local path is reported as broken', withTempDir(async (dir) => {
  const missing = path.join(dir, 'missing-shot.png')
  const result = detectAttachments(`Artifact: ${missing}`, dir)
  assert.equal(result.resolvedMessage, 'Artifact: {{att:0}}')
  assert.equal(result.inlineAttachments.length, 1)
  assert.equal(result.inlineAttachments[0].broken, true)
  assert.equal(result.inlineAttachments[0].path, missing)
}))

test('backticked local path remains literal and does not upload', withTempDir(async (dir) => {
  const img = path.join(dir, 'activity-card.png')
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const stub = await startUploadStub()
  try {
    const result = await processMessageText(`Artifact: \`${img}\``, dir, stub.baseUrl)
    assert.equal(result.resolvedMessage, `Artifact: \`${img}\``)
    assert.deepEqual(result.inlineAttachments, [])
    assert.deepEqual(result.brokenPaths, [])
    assert.equal(stub.uploads.length, 0)
  } finally {
    await stub.close()
  }
}))

test('shared-doc metadata with path renders as an artifact chip, not a navigation link', () => {
  const html = renderChatLine({
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: 'Report attached.',
    timestamp: '2026-06-18T00:00:00.000Z',
    attachments: [{
      type: 'shared-doc',
      source: 'doc:fleet:agent:agent-report',
      path: '/tmp/agent-report.md',
      text: [
        '# Agent report',
        '',
        'This report explains the failed share chip and includes enough detail to identify the content without guessing.',
      ].join('\n'),
    }],
  }, renderCtx())
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const root = dom.window.document.getElementById('root')
  const chip = dom.window.document.querySelector('.ref-chip-doc')
  const link = dom.window.document.querySelector('a')

  assert.ok(chip)
  assert.equal(link, null)
  assert.equal(chip.getAttribute('data-path'), '/tmp/agent-report.md')
  assert.equal(chip.getAttribute('data-url'), '/api/file?path=%2Ftmp%2Fagent-report.md')
  assert.equal(chip.getAttribute('data-title'), 'agent-report.md')
  assert.equal(chip.getAttribute('draggable'), 'true')
  assert.match(root.textContent, /agent-report\.md/)
  assert.doesNotMatch(root.innerHTML, /ref-chip-shared-doc|shared-doc|doc-chip|data-share-id|tool-ref-preview|<a\b/)
})

test('literal doc token with URL uses ordinary markdown link handling, not shared-doc output', () => {
  const html = renderChatLine({
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: '[doc:psc-report] PSC report https://example.test/psc-report.md',
    timestamp: '2026-06-18T00:00:00.000Z',
  }, renderCtx(renderMarkdownWithOrdinaryLinks))
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const root = dom.window.document.getElementById('root')
  const link = dom.window.document.querySelector('a')

  assert.ok(link)
  assert.equal(link.getAttribute('href'), 'https://example.test/psc-report.md')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(dom.window.document.querySelector('.shared-doc.doc-chip'), null)
  assert.equal(dom.window.document.querySelector('.ref-chip-shared-doc'), null)
  assert.equal(dom.window.document.querySelector('[data-share-id]'), null)
  assert.match(root.textContent, /\[doc:psc-report\] PSC report/)
  assert.doesNotMatch(root.innerHTML, /ref-chip-shared-doc|class="shared-doc|doc-chip|data-share-id|Shared doc:/)
})

test('/api/file markdown links render as links, not file chips', () => {
  const html = renderChatLine({
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: '[scratch/e2-argument-outline.md](/api/file?path=%2FUsers%2Fskip%2Fwork%2Fbalancing-act%2Fscratch%2Fe2-argument-outline.md)',
    timestamp: '2026-06-23T22:19:32.000Z',
  }, renderCtx(renderMarkdownWithOrdinaryLinks))
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const link = dom.window.document.querySelector('a')

  assert.ok(link)
  assert.equal(link.getAttribute('href'), '/api/file?path=%2FUsers%2Fskip%2Fwork%2Fbalancing-act%2Fscratch%2Fe2-argument-outline.md')
  assert.equal(dom.window.document.querySelector('.ref-chip-doc, .md-file-card'), null)
})

test('resolved local file attachment tokens still render as artifact chips', () => {
  const html = renderChatLine({
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: 'Report: {{att:0}}',
    _inlineAttachments: [{
      type: 'file',
      path: '/Users/skip/work/balancing-act/scratch/e2-argument-outline.md',
      name: 'e2-argument-outline.md',
      url: '/api/file?path=%2Ftmp%2Ffleet-uploads%2Fe2-argument-outline.md',
    }],
    timestamp: '2026-06-23T22:19:32.000Z',
  }, renderCtx(renderMarkdownWithOrdinaryLinks))
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const chip = dom.window.document.querySelector('.ref-chip-doc')

  assert.ok(chip)
  assert.equal(chip.getAttribute('data-path'), '/Users/skip/work/balancing-act/scratch/e2-argument-outline.md')
  assert.equal(chip.getAttribute('data-url'), '/api/file?path=%2Ftmp%2Ffleet-uploads%2Fe2-argument-outline.md')
  assert.equal(dom.window.document.querySelector('a'), null)
})

test('literal doc token without link target stays ordinary readable text', () => {
  const html = renderChatLine({
    type: 'chat',
    from: 'fleet:agent',
    to: 'fleet:skip',
    text: '[doc:psc-report] PSC report',
    timestamp: '2026-06-18T00:00:00.000Z',
  }, renderCtx(renderMarkdownWithOrdinaryLinks))
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const root = dom.window.document.getElementById('root')

  assert.equal(dom.window.document.querySelector('a'), null)
  assert.equal(dom.window.document.querySelector('.shared-doc.doc-chip'), null)
  assert.equal(dom.window.document.querySelector('[data-share-id]'), null)
  assert.match(root.textContent, /\[doc:psc-report\] PSC report/)
  assert.doesNotMatch(root.innerHTML, /ref-chip-shared-doc|class="shared-doc|doc-chip|data-share-id|Shared doc:/)
})

test('shared report chip css uses readable title and summary classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'shapes', 'fleet-chat.css'), 'utf8')

  assert.match(css, /\.fleet-chat-shape \.ref-chip-doc \{[\s\S]*color: var\(--text-bright/)
  assert.match(css, /\.fleet-chat-shape \.ref-chip-doc-title \{[\s\S]*text-overflow: ellipsis/)
  assert.match(css, /\.fleet-chat-shape \.ref-chip-doc-summary \{[\s\S]*color: var\(--text/)
})
