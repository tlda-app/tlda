import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'

import { initProjectStore } from '../server/lib/project-store.mjs'
import { realizeProjectMarkdownArtifact, writeProjectMarkdownArtifact } from '../server/lib/project-artifact-materializer.mjs'
import { formatRecipientAttachmentRef } from '../shared/inbox-reference-materialization.mjs'
import { renderChatLine } from '../src/fleet/chat-render.mjs'
import { convertChatEvent } from '../src/fleet/convert-chat-event.mjs'
import projectRoutes from '../server/routes/projects.mjs'

function setupProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-project-world-'))
  initProjectStore(root)
  const dir = path.join(root, name)
  const source = path.join(dir, 'source')
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name,
    title: name,
    format: 'markdown',
    mainFile: 'main.md',
  }))
  git(['init'], source)
  return { root, dir, source }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitShow(cwd, ref, file) {
  return git(['show', `${ref}:${file}`], cwd)
}

test('shared markdown artifacts expose exact git versions and preserve overwritten bytes', () => {
  const { source } = setupProject('world')

  const first = realizeProjectMarkdownArtifact({
    project: 'world',
    markdown: '# AGENTS.md\n\nfirst bytes\n',
    title: 'AGENTS.md',
    actor: { friendlyName: 'sender', fleetId: 'fleet:sender' },
    provenance: { sourceAgent: 'fleet:sender', recipient: 'fleet:recipient', eventId: 1323467, attachmentId: '0' },
  })
  assert.equal(first.state, 'available')
  assert.equal(first.git.committed, true)
  assert.match(first.git.hash, /^[0-9a-f]{40}$/)
  assert.equal(gitShow(source, first.git.hash, first.projectPath).includes('first bytes'), true)

  const second = writeProjectMarkdownArtifact({
    project: 'world',
    projectArtifactId: first.projectArtifactId,
    markdown: '# AGENTS.md\n\nsecond bytes\n',
    title: 'AGENTS.md',
    actor: { friendlyName: 'sender', fleetId: 'fleet:sender' },
    provenance: { sourceAgent: 'fleet:sender', recipient: 'fleet:recipient', eventId: 1323468, attachmentId: '0' },
  })
  assert.equal(second.state, 'available')
  assert.equal(second.git.committed, true)
  assert.match(second.git.hash, /^[0-9a-f]{40}$/)
  assert.notEqual(second.git.hash, first.git.hash)

  assert.equal(gitShow(source, first.git.hash, first.projectPath).includes('first bytes'), true)
  assert.equal(gitShow(source, first.git.hash, first.projectPath).includes('second bytes'), false)
  assert.equal(gitShow(source, second.git.hash, second.projectPath).includes('second bytes'), true)
})

test('recipient attachment refs can surface project artifact paths without daemon-local paths', () => {
  assert.equal(formatRecipientAttachmentRef({
    kind: 'attachment',
    state: 'available',
    status: 'ready',
    localPath: null,
    projectPath: 'parts/agents.md',
    projectArtifactId: 'artifact-1',
  }), 'parts/agents.md')
})

test('normal fleet chat file chip identifies the exact project artifact version', () => {
  const version = 'abcdef1234567890abcdef1234567890abcdef12'
  const msg = convertChatEvent({
    id: 1323467,
    type: 'chat',
    from_id: 'fleet:skip',
    to_id: 'fleet:recipient',
    timestamp: '2026-07-16T03:41:00.000Z',
    text: '{{att:0}}',
    metadata: {
      inline_attachments: [{
        id: 0,
        type: 'file',
        name: 'AGENTS.md',
        path: '/uploads/AGENTS.md',
        url: '/api/file?path=%2Fuploads%2FAGENTS.md',
        mimeType: 'text/markdown',
      }],
      recipient_refs: {
        'fleet:recipient': {
          attachments: {
            '0': {
              kind: 'attachment',
              state: 'available',
              status: 'ready',
              project: 'world',
              projectPath: 'parts/agents.md',
              projectArtifactId: 'artifact-1',
              projectArtifactVersion: version,
              projectArtifactHash: 'hash-of-rendered-artifact',
            },
          },
        },
      },
    },
  })
  assert.equal(msg.metadata.recipient_refs['fleet:recipient'].attachments['0'].projectArtifactVersion, version)

  const html = renderChatLine(msg, {
    agentLabel: id => id,
    getNickClass: () => '',
    isHumanId: id => id === 'fleet:skip',
    getAgents: () => [],
    getTasks: () => [],
    renderMarkdown: s => s,
  })

  assert.match(html, /data-msg-id="1323467"/)
  assert.match(html, /AGENTS\.md/)
  assert.match(html, /@abcdef1/)
  assert.match(html, /data-project="world"/)
  assert.match(html, /data-project-artifact-id="artifact-1"/)
  assert.match(html, new RegExp(`data-project-version="${version}"`))
  assert.match(html, /data-url="\/api\/projects\/world\/parts\/artifact-1\/markdown\?version=abcdef1234567890abcdef1234567890abcdef12"/)
})

test('project artifact markdown route recovers earlier bytes by message version after overwrite', async () => {
  const { source } = setupProject('route-world')
  const first = realizeProjectMarkdownArtifact({
    project: 'route-world',
    markdown: '# AGENTS.md\n\noriginal message bytes\n',
    title: 'AGENTS.md',
    actor: { friendlyName: 'sender', fleetId: 'fleet:sender' },
    provenance: { sourceAgent: 'fleet:sender', recipient: 'fleet:recipient', eventId: 1323467, attachmentId: '0' },
  })
  const second = writeProjectMarkdownArtifact({
    project: 'route-world',
    projectArtifactId: first.projectArtifactId,
    markdown: '# AGENTS.md\n\noverwritten bytes\n',
    title: 'AGENTS.md',
    actor: { friendlyName: 'sender', fleetId: 'fleet:sender' },
    provenance: { sourceAgent: 'fleet:sender', recipient: 'fleet:recipient', eventId: 1323468, attachmentId: '0' },
  })

  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectRoutes)
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const oldRes = await fetch(`http://127.0.0.1:${port}/api/projects/route-world/parts/${first.projectArtifactId}/markdown?version=${first.git.hash}`)
    assert.equal(oldRes.status, 200)
    assert.equal((await oldRes.text()).includes('original message bytes'), true)

    const currentRes = await fetch(`http://127.0.0.1:${port}/api/projects/route-world/parts/${first.projectArtifactId}/markdown`)
    assert.equal(currentRes.status, 200)
    const currentText = await currentRes.text()
    assert.equal(currentText.includes('overwritten bytes'), true)
    assert.equal(currentText.includes('original message bytes'), false)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  assert.equal(gitShow(source, second.git.hash, second.projectPath).includes('overwritten bytes'), true)
})

test('server materializes project markdown before daemon-local attachment routing', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const fnStart = source.indexOf('async function materializeRecipientAttachment')
  assert.notEqual(fnStart, -1)
  const fnEnd = source.indexOf('\nfunction queueRecipientMaterialization', fnStart)
  assert.notEqual(fnEnd, -1)
  const block = source.slice(fnStart, fnEnd)

  const projectAt = block.indexOf('materializeProjectMarkdownAttachment')
  const routeAt = block.indexOf("resolveRpc('materialize-attachment', recipient)")
  assert.notEqual(projectAt, -1)
  assert.notEqual(routeAt, -1)
  assert.ok(projectAt < routeAt, 'project artifact realization must not depend on daemon-local materialization')
  assert.match(block, /state: projectArtifact\?\.state === 'available' \? 'available' : 'failed'/)
  assert.match(block, /daemonMaterializationError: error/)
  assert.match(source, /projectArtifactVersion: projectArtifact\.git\?\.hash/)
})
