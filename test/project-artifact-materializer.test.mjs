import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  PROJECT_ARTIFACT_KIND,
  realizeProjectMarkdownArtifact,
  resolveArtifactProject,
  resolveProjectCwd,
  writeProjectMarkdownArtifact,
} from '../server/lib/project-artifact-materializer.mjs'
import {
  createProject,
  initProjectStore,
  projectPartsRoot,
} from '../server/lib/project-store.mjs'
import {
  readProjectPartsManifest,
  writeProjectPartsManifest,
} from '../server/lib/project-parts-scanner.mjs'
import { createProjectPartsManifest } from '../shared/project-parts.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(dir) {
  git(['init'], dir)
  git(['config', 'user.name', 'tester'], dir)
  git(['config', 'user.email', 'tester@example.test'], dir)
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', 'README.md'], dir)
  git(['commit', '-m', 'initial'], dir)
}

function setupProject() {
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-artifact-projects-'))
  initProjectStore(projectsDir)
  createProject({ name: 'paper', mainFile: 'main.tex', format: 'markdown' })
  const root = projectPartsRoot('paper')
  initRepo(root)
  return { projectsDir, root }
}

test('realizeProjectMarkdownArtifact creates a project-owned markdown part and attributed commit', () => {
  const { root } = setupProject()
  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# Artifact report\n\nBody text.\n',
    actor: { friendlyName: 'code-review', fleetId: 'fleet:27def15c' },
    provenance: { sourceAgent: 'code-review', thread: '936726' },
    idFactory: () => '7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870',
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.state, 'available')
  assert.equal(result.kind, PROJECT_ARTIFACT_KIND)
  assert.equal(result.title, 'Artifact report')
  assert.equal(result.sourceAgent, 'code-review')
  assert.equal(result.projectArtifactId, '7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870')
  assert.equal(result.projectPath, 'parts/7d8c0f2e.md')
  assert.equal(result.localPath, join(root, 'parts', '7d8c0f2e.md'))
  assert.equal(result.localPathVerified, true)
  assert.equal(result.recipientRef.projectArtifactId, result.projectArtifactId)
  assert.equal(result.recipientRef.localPath, result.localPath)
  assert.equal(result.recipientRef.projectPath, result.projectPath)
  assert.equal(result.recipientRef.state, 'available')
  assert.equal(existsSync(result.localPath), true)

  const content = readFileSync(result.localPath, 'utf8')
  assert.match(content, /tlda-id: 7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870/)
  assert.match(content, /tlda-kind: artifact/)
  assert.match(content, /# Artifact report/)

  const manifest = readProjectPartsManifest(root)
  assert.equal(manifest.parts.length, 1)
  assert.equal(manifest.parts[0].id, '7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870')
  assert.equal(manifest.parts[0].kind, 'artifact')
  assert.equal(manifest.parts[0].path, 'parts/7d8c0f2e.md')
  assert.equal(manifest.parts[0].metadata.provenance.sourceAgent, 'code-review')

  assert.equal(result.git.committed, true)
  assert.equal(git(['log', '-1', '--format=%an <%ae>'], root), 'code-review <fleet:27def15c>')
  assert.equal(git(['log', '-1', '--format=%s'], root), 'Realize markdown artifact: Artifact report')
})

test('realizeProjectMarkdownArtifact materializes a readable same-machine source path', () => {
  const { root } = setupProject()
  const source = join(root, 'input.md')
  writeFileSync(source, '---\ntitle: old\n---\n\n# Source file report\n\nFrom disk.\n')

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    sourcePath: source,
    actor: { friendlyName: 'agent', fleetId: 'fleet:agent' },
    idFactory: () => '11111111-2222-4333-8444-555555555555',
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.title, 'Source file report')
  assert.equal(result.provenance.sourcePath, source)
  const content = readFileSync(result.localPath, 'utf8')
  assert.doesNotMatch(content, /title: old/)
  assert.match(content, /# Source file report/)
})

test('project resolution maps .worktrees cwd back to the underlying project', () => {
  const { root } = setupProject()
  const worktreeCwd = join(root, '.worktrees', 'slice', 'src')
  mkdirSync(worktreeCwd, { recursive: true })

  assert.equal(resolveProjectCwd(worktreeCwd), root)
  assert.deepEqual(
    resolveArtifactProject({
      cwd: worktreeCwd,
      projectsProvider: () => [{ name: 'paper', partsRoot: root, sourceDir: root }],
    }),
    { name: 'paper', root },
  )
})

test('unreadable source returns non-ready payload without a fake localPath', () => {
  const { root } = setupProject()
  const missing = join(root, 'missing.md')

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    sourcePath: missing,
    title: 'Missing source',
  })

  assert.equal(result.status, 'source unreadable')
  assert.equal(result.state, 'failed')
  assert.equal(result.ready, false)
  assert.equal(result.localPath, null)
  assert.equal(result.localPathVerified, false)
  assert.equal(result.recipientRef, null)
  assert.equal(result.targetPath, missing)
  assert.match(result.error, /not readable/)
})

test('sourcePath outside the project fails closed instead of reading server-local files', () => {
  setupProject()
  const outsideRoot = mkdtempSync(join(tmpdir(), 'tlda-artifact-outside-'))
  const outside = join(outsideRoot, 'outside.md')
  writeFileSync(outside, '# Outside\n')

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    sourcePath: outside,
    title: 'Outside source',
  })

  assert.equal(result.status, 'owner-missing')
  assert.equal(result.state, 'failed')
  assert.equal(result.ready, false)
  assert.equal(result.localPath, null)
  assert.equal(result.targetPath, outside)
  assert.match(result.error, /not routed through the project owner/)
})

test('unresolved project returns non-ready payload without materializing', () => {
  const result = realizeProjectMarkdownArtifact({
    project: 'missing-project',
    markdown: '# Orphan artifact\n',
    title: 'Orphan artifact',
    projectsProvider: () => [],
  })

  assert.equal(result.status, 'not materialized')
  assert.equal(result.state, 'failed')
  assert.equal(result.ready, false)
  assert.equal(result.localPath, null)
  assert.equal(result.localPathVerified, false)
  assert.equal(result.recipientRef, null)
  assert.match(result.error, /No project resolved/)
})

test('sourcePath sibling-prefix traversal fails closed under the shared containment helper', () => {
  const { projectsDir } = setupProject()
  const siblingDir = join(projectsDir, 'paper', 'source2')
  mkdirSync(siblingDir, { recursive: true })
  const sibling = join(siblingDir, 'evil.md')
  writeFileSync(sibling, '# Evil\n')
  const traversal = join(projectsDir, 'paper', 'source', '..', 'source2', 'evil.md')

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    sourcePath: traversal,
    title: 'Traversal source',
  })

  assert.equal(result.status, 'owner-missing')
  assert.equal(result.state, 'failed')
  assert.equal(result.localPath, null)
  assert.match(result.error, /not routed through the project owner/)
})

test('realizeProjectMarkdownArtifact preserves existing manifest metadata and authorities', () => {
  const { root } = setupProject()
  mkdirSync(join(root, 'parts'), { recursive: true })
  writeFileSync(join(root, 'parts', 'existing.md'), `---
tlda-id: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
tlda-kind: artifact
---

# Existing
`)
  writeProjectPartsManifest(root, createProjectPartsManifest([{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    kind: 'artifact',
    path: 'parts/existing.md',
    title: 'Existing',
    metadata: { anchor: 'keep-me' },
    authority: { originMachine: 'mini', writable: true },
  }], {
    externalAuthorities: [{ originMachine: 'mini', transport: 'daemon-rpc' }],
  }))

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# New artifact\n\nBody.\n',
    idFactory: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  })

  assert.equal(result.status, 'ready')
  const manifest = readProjectPartsManifest(root)
  const existing = manifest.parts.find(part => part.id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const created = manifest.parts.find(part => part.id === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  assert.equal(existing.path, 'parts/existing.md')
  assert.equal(existing.metadata.anchor, 'keep-me')
  assert.equal(existing.authority.originMachine, 'mini')
  assert.equal(created.path, 'parts/cccccccc.md')
  assert.deepEqual(manifest.externalAuthorities, [{ originMachine: 'mini', transport: 'daemon-rpc' }])
})

test('realizeProjectMarkdownArtifact surfaces unlanded writeback as non-ready payload', () => {
  const { root } = setupProject()

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# Racing artifact\n\nBody.\n',
    idFactory: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    writebackOptions: {
      beforeInstall: () => writeFileSync(join(root, 'parts', 'dddddddd.md'), '# competing artifact\n'),
    },
  })

  assert.equal(result.ready, false)
  assert.equal(result.state, 'failed')
  assert.equal(result.status, 'conflict')
  assert.equal(result.localPath, null)
  assert.equal(result.localPathVerified, false)
  assert.equal(result.recipientRef, null)
  assert.equal(result.targetPath, join(root, 'parts', 'dddddddd.md'))
  assert.equal(result.writeback.status, 'conflict')
  assert.equal(result.git.skipped, true)
  assert.equal(readFileSync(join(root, 'parts', 'dddddddd.md'), 'utf8'), '# competing artifact\n')

  const manifest = readProjectPartsManifest(root)
  const created = manifest.parts.find(part => part.id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  assert.equal(created.metadata.writeback.status, 'conflict')
})

test('writeProjectMarkdownArtifact updates an existing artifact through writeback checkpoint', () => {
  const { root } = setupProject()
  const created = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# Original artifact\n\nOld body.\n',
    idFactory: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  })

  const updated = writeProjectMarkdownArtifact({
    project: 'paper',
    projectArtifactId: created.projectArtifactId,
    markdown: '# Updated artifact\n\nNew body.\n',
    actor: { friendlyName: 'editor', fleetId: 'fleet:editor' },
  })

  assert.equal(updated.status, 'ready')
  assert.equal(updated.title, 'Updated artifact')
  assert.equal(updated.localPath, created.localPath)
  assert.equal(updated.localPathVerified, true)
  assert.match(readFileSync(created.localPath, 'utf8'), /# Updated artifact/)
  assert.match(readFileSync(created.localPath, 'utf8'), /New body/)

  const manifest = readProjectPartsManifest(root)
  const part = manifest.parts.find(part => part.id === created.projectArtifactId)
  assert.equal(part.title, 'Updated artifact')
  assert.equal(part.metadata.writeback.status, 'synced')
  assert.equal(part.metadata.hash, updated.hash)
})
