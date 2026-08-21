import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { closeProjectStore, createProject, initProjectStore } from '../lib/project-store.mjs'
import { listProjectsWithLifecycleStatus } from './projects.mjs'

test('project listing projects indexed lifecycle fields without a per-project journal sweep', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-list-index-'))
  try {
    await initProjectStore(root)
    for (let index = 0; index < 1_000; index++) {
      createProject({ name: `project-${String(index).padStart(4, '0')}`, mainFile: 'main.md', format: 'markdown' })
    }

    const started = performance.now()
    const projects = await listProjectsWithLifecycleStatus()
    const elapsedMs = performance.now() - started

    assert.equal(projects.length, 1_000)
    assert.deepEqual({
      buildStatus: projects[0].buildStatus,
      buildPhase: projects[0].buildPhase,
      sourceRevision: projects[0].sourceRevision,
      acceptSeq: projects[0].acceptSeq,
    }, { buildStatus: 'unknown', buildPhase: null, sourceRevision: null, acceptSeq: null })
    assert.ok(elapsedMs < 2_000, `indexed 1,000-project listing took ${elapsedMs.toFixed(1)}ms`)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
