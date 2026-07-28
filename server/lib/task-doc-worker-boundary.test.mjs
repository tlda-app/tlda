import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStoreClient } from './fleet-store-client.mjs'

test('task-doc materialization reads project metadata inside the fleet worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-task-doc-worker-'))
  const projectsDir = join(root, 'projects')
  const sourceDir = join(root, 'source')
  mkdirSync(join(projectsDir, 'paper'), { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(
    join(projectsDir, 'paper', 'project.json'),
    JSON.stringify({ name: 'paper', sourceDir }),
  )

  const store = new FleetStoreClient(join(root, 'fleet.db'), {
    taskDoc: true,
    taskDocOptions: {
      projectsDir,
      globalDir: join(root, 'global'),
    },
  })
  try {
    await store.ready()
    await store.flushTaskDocs()
    assert.deepEqual(await store.getActiveTasks(), [])
  } finally {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
