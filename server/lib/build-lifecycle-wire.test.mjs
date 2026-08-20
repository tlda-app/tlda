import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore, updateProject } from './project-store.mjs'
import { listProjectsWithLifecycleStatus } from '../routes/projects.mjs'

test('production project listing ignores corrupt legacy build status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-status-projection-'))
  const name = 'projected-paper'
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    await updateProject(name, { buildStatus: 'success' })
    const lifecycle = await sourceLifecycleStore(name)
    lifecycle.recordAcceptedRevision(name, 'projected-revision', 8)
    lifecycle.recordRevisionPhase(name, 'projected-revision', 'build', 'build_failed', { error: 'real failure' })
    lifecycle.recordRevisionPhase(name, 'projected-revision', 'version', 'not_reached', null)
    lifecycle.recordRevisionPhase(name, 'projected-revision', 'mirror', 'not_reached', null)

    const [project] = await listProjectsWithLifecycleStatus()
    assert.equal(project.buildStatus, 'error')
    assert.equal(project.buildPhase, 'build')
    assert.equal(project.sourceRevision, 'projected-revision')
    assert.equal(project.acceptSeq, 8)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
