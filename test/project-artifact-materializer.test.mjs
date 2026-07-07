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

test('realizeProjectMarkdownArtifact preserves existing non-artifact manifest parts', () => {
  const { root } = setupProject()
  writeProjectPartsManifest(root, createProjectPartsManifest([{
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'task-doc',
    path: 'TASKS.md',
    title: 'Tasks for paper',
    metadata: { managed: true },
  }]))

  const result = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# New artifact\n',
    idFactory: () => '22222222-2222-4222-8222-222222222222',
  })

  assert.equal(result.status, 'ready')
  const manifest = readProjectPartsManifest(root)
  assert.deepEqual(new Set(manifest.parts.map(part => part.id)), new Set([
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]))
  assert.equal(manifest.parts.find(part => part.kind === 'task-doc').title, 'Tasks for paper')
  assert.equal(manifest.parts.find(part => part.kind === 'artifact').title, 'New artifact')
})

test('writeProjectMarkdownArtifact updates a project-owned artifact without clobbering other parts', () => {
  const { root } = setupProject()
  writeProjectPartsManifest(root, createProjectPartsManifest([{
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'task-doc',
    path: 'TASKS.md',
    title: 'Tasks for paper',
    metadata: { managed: true },
  }]))

  const created = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# Original artifact\n\nOld body.\n',
    idFactory: () => '33333333-3333-4333-8333-333333333333',
  })

  const updated = writeProjectMarkdownArtifact({
    project: 'paper',
    projectArtifactId: created.projectArtifactId,
    markdown: '# Revised artifact\n\nNew body.\n',
    actor: { friendlyName: 'editor', fleetId: 'fleet:editor' },
    provenance: { thread: '961000' },
    now: () => '2026-07-07T12:00:00.000Z',
  })

  assert.equal(updated.status, 'ready')
  assert.equal(updated.projectArtifactId, created.projectArtifactId)
  assert.equal(updated.projectPath, created.projectPath)
  assert.equal(updated.title, 'Revised artifact')

  const content = readFileSync(created.localPath, 'utf8')
  assert.match(content, /tlda-id: 33333333-3333-4333-8333-333333333333/)
  assert.match(content, /title: "Revised artifact"/)
  assert.match(content, /# Revised artifact/)
  assert.match(content, /New body\./)
  assert.doesNotMatch(content, /Old body/)

  const manifest = readProjectPartsManifest(root)
  assert.deepEqual(new Set(manifest.parts.map(part => part.id)), new Set([
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  ]))
  const artifact = manifest.parts.find(part => part.id === created.projectArtifactId)
  assert.equal(artifact.title, 'Revised artifact')
  assert.equal(artifact.metadata.provenance.thread, '961000')
  assert.equal(artifact.metadata.updatedAt, '2026-07-07T12:00:00.000Z')
  assert.equal(manifest.parts.find(part => part.kind === 'task-doc').title, 'Tasks for paper')
  assert.equal(git(['log', '-1', '--format=%s'], root), 'Update markdown artifact: Revised artifact')
})

test('writeProjectMarkdownArtifact refuses content with another artifact id', () => {
  setupProject()
  const created = realizeProjectMarkdownArtifact({
    project: 'paper',
    markdown: '# Original artifact\n',
    idFactory: () => '44444444-4444-4444-8444-444444444444',
  })

  assert.throws(() => writeProjectMarkdownArtifact({
    project: 'paper',
    projectArtifactId: created.projectArtifactId,
    markdown: '---\ntlda-id: 55555555-5555-4555-8555-555555555555\ntlda-kind: artifact\n---\n\n# Wrong identity\n',
  }), /id mismatch/)
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
  assert.equal(result.targetPath, missing)
  assert.match(result.error, /not readable/)
})
