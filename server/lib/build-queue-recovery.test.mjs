import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'

test('a process restart replays the same keyed job without resampling or rotating twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-build-queue-recovery-'))
  const path = join(dir, 'queue.sqlite')
  try {
    const firstStarts = []
    const firstStore = new BuildQueueStore(path)
    const first = createBuildQueue({
      store: firstStore,
      getProjectsDir: () => dir,
      random: () => 0.375,
      transport: {
        start(job) {
          firstStarts.push(job)
          return { cancel() {} }
        },
      },
    }, { maxConcurrency: 1 })
    await first.admitBuild('paper', { revision: 'revision-a', daemonId: 'daemon-a', branch: 'main' })
    assert.equal(firstStarts.length, 1)
    const before = first.inspect()
    assert.equal(before.running[0].fractionalPriority, 0.375)
    assert.equal(before.running[0].startedOnce, true)
    const ringBefore = [...before.ring]
    firstStore.close()

    const recoveredStarts = []
    const recoveredStore = new BuildQueueStore(path)
    const recovered = createBuildQueue({
      store: recoveredStore,
      getProjectsDir: () => dir,
      random: () => { throw new Error('recovery must not resample') },
      transport: {
        start(job) {
          recoveredStarts.push(job)
          return { cancel() {} }
        },
      },
    }, { maxConcurrency: 1 })
    await recovered.recover()
    assert.equal(recoveredStarts.length, 1)
    assert.equal(recoveredStarts[0].sourceRevision, 'revision-a')
    assert.equal(recoveredStarts[0].fractionalPriority, 0.375)
    assert.deepEqual([...recovered.inspect().ring], ringBefore)
    recoveredStore.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
