import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { reportBuildFailure, setBuildReporter } from './build-runner.mjs'
import { closeProjectStore, createProject, initProjectStore, projectDir } from './project-store.mjs'

test('failed-build reporting reaches the reader signal and conversation event', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-failure-report-'))
  await initProjectStore(root)
  createProject({ name: 'failed-project', mainFile: 'main.tex' })
  mkdirSync(projectDir('failed-project'), { recursive: true })
  writeFileSync(join(projectDir('failed-project'), 'latex.log'), '! Undefined control sequence.\nl.4 \\pr\n')
  writeFileSync(join(projectDir('failed-project'), 'build.log'), '[build] LaTeX produced 1 error(s)\n')

  const calls = []
  setBuildReporter({
    broadcastSignal: (...args) => { calls.push(['broadcastSignal', ...args]) },
    writeSentinel: (...args) => { calls.push(['writeSentinel', ...args]); return { skipped: false } },
    emitGlobalEvent: (...args) => { calls.push(['emitGlobalEvent', ...args]) },
  })
  t.after(async () => {
    setBuildReporter(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })

  await reportBuildFailure('failed-project', 'LaTeX produced 1 error(s)', 'bad-revision', 2)
  await new Promise(resolve => setImmediate(resolve))

  const status = calls.find(call => call[0] === 'broadcastSignal' && call[2] === 'signal:build-status')
  assert.equal(status?.[1], 'doc-failed-project')
  assert.match(status?.[3]?.errors?.[0]?.message || '', /Undefined control sequence/)

  const progress = calls.find(call => call[0] === 'broadcastSignal' && call[2] === 'signal:build-progress')
  assert.equal(progress?.[3]?.phase, 'failed')

  const card = calls.find(call => call[0] === 'emitGlobalEvent' && call[1] === 'build-card')
  assert.equal(card?.[2]?.buildFailed, 'LaTeX produced 1 error(s)')
  assert.match(card?.[2]?.errors?.[0]?.message || '', /Undefined control sequence/)

  const sentinel = calls.find(call => call[0] === 'writeSentinel')
  assert.equal(sentinel?.[2]?.sourceRevision, 'bad-revision')
  assert.match(sentinel?.[2]?.errorsJson || '', /Undefined control sequence/)
})
