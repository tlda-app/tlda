import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  getBuildReporter,
  runBuild,
  setBuildReporter,
} from '../server/lib/build-runner.mjs'
import { createProject, initProjectStore } from '../server/lib/project-store.mjs'

function captureReporter(patches) {
  return {
    broadcastSignal() {},
    emitGlobalEvent() {},
    mirrorShadow() {},
    patchShape() {},
    putShape() {},
    updateProject(name, patch) {
      patches.push({ name, patch })
    },
    writeSentinel() {},
  }
}

test('an error before active-build setup cannot leave persisted building state', async () => {
  const originalReporter = getBuildReporter()
  const patches = []
  initProjectStore(mkdtempSync(join(tmpdir(), 'tlda-orphan-state-')))
  setBuildReporter(captureReporter(patches))

  try {
    await assert.rejects(runBuild('missing-project-for-orphan-state-test'))
  } finally {
    setBuildReporter(originalReporter)
  }

  assert.deepEqual(patches.map(({ patch }) => patch.buildStatus), ['building', 'failed'])
})

test('an ordinary post-setup failure publishes failed exactly once and rethrows', async () => {
  const originalReporter = getBuildReporter()
  const patches = []
  const root = mkdtempSync(join(tmpdir(), 'tlda-ordinary-failure-'))
  initProjectStore(root)
  createProject({ name: 'ordinary-failure', mainFile: 'main.tex' })
  const source = join(root, 'ordinary-failure', 'source')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'main.tex'), '\\documentclass{article}\\begin{document}broken')
  setBuildReporter(captureReporter(patches))

  let error
  try {
    await runBuild('ordinary-failure')
  } catch (e) {
    error = e
  } finally {
    setBuildReporter(originalReporter)
  }

  assert.ok(error, 'the original build error must still rethrow')
  assert.equal(patches.filter(({ patch }) => patch.buildStatus === 'failed').length, 1)
})

test('a prior failed attempt cannot suppress early-failure recovery on the next attempt', async () => {
  const originalReporter = getBuildReporter()
  const patches = []
  const root = mkdtempSync(join(tmpdir(), 'tlda-stale-attempt-'))
  initProjectStore(root)
  createProject({ name: 'stale-attempt', mainFile: 'main.tex' })
  const mainPath = join(root, 'stale-attempt', 'source', 'main.tex')
  writeFileSync(mainPath, '\\documentclass{article}\\begin{document}broken')
  setBuildReporter(captureReporter(patches))

  try {
    await assert.rejects(runBuild('stale-attempt'))
    assert.deepEqual(patches.map(({ patch }) => patch.buildStatus), ['building', 'failed'])

    patches.length = 0
    unlinkSync(mainPath)
    await assert.rejects(runBuild('stale-attempt'))
  } finally {
    setBuildReporter(originalReporter)
  }

  assert.deepEqual(patches.map(({ patch }) => patch.buildStatus), ['building', 'failed'])
})
