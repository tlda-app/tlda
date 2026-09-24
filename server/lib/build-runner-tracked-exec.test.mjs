import assert from 'node:assert/strict'
import test from 'node:test'

import { trackedExec, setBuildOutputSink, streamChildOutput } from './build-runner.mjs'

// `trackedExec` streams every child through `streamChildOutput`, which
// build-runner.mjs only re-exports from the incremental engine. A re-export
// creates no local binding, so calling the bare name threw
// `ReferenceError: streamChildOutput is not defined` inside the promise
// executor — rejecting every `run()` before the command started. pdflatex
// never ran, no DVI and no log appeared, and the build died with the bare
// `DVI file not created`. Observed on the executor 2026-09-24 across every
// LaTeX project; the Quarto engine was unaffected (it never calls this path).
test('trackedExec runs a command and resolves its output', async () => {
  const { stdout } = await trackedExec('tracked-exec-test', 'printf hello')
  assert.equal(stdout, 'hello')
})

test('trackedExec rejects a failing command with its output attached', async () => {
  await assert.rejects(
    trackedExec('tracked-exec-test', 'printf oops; exit 3'),
    /Command failed/,
  )
})

test('trackedExec streams child output to the build sink', async () => {
  const seen = []
  setBuildOutputSink((name, line, skipped) => seen.push([name, line, skipped]))
  try {
    await trackedExec('tracked-exec-stream', 'printf hello')
  } finally {
    setBuildOutputSink(null)
  }
  assert.deepEqual(seen, [['tracked-exec-stream', 'hello', 0]])
})

test('the worker import path still re-exports the streaming helper', () => {
  assert.equal(typeof streamChildOutput, 'function')
})
