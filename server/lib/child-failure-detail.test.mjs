// A build that dies has to say why.
//
// These run REAL child processes into the same `execFileAsync` the renderers
// use, because the thing under test is what Node puts on the error object in
// each failure mode — not what we believe it puts there. The belief was wrong
// once already: the old code read `e.stderr || e.stdout || e.message`, and on a
// killed process `stderr` is empty, so it reported the program's ordinary
// progress output as the cause and dropped `signal` entirely.
//
// The controls are the assertions that the reported cause is NOT the last line
// of normal output. Without them every one of these passes against the old
// code, because the old code did produce a non-empty message — just the wrong one.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

import { childFailureDetail, describeChildFailure } from './build-runner.mjs'

const execFileAsync = promisify(execFile)

async function failureOf(argv, options = {}) {
  try {
    await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 8 * 1024 * 1024, ...options })
  } catch (e) {
    return e
  }
  throw new Error('expected the command to fail, and it did not')
}

test('a killed process says it was killed, not what it last printed', async () => {
  // The shape of a render the OS stops: it never reaches its own error path.
  const error = await failureOf(['sh', '-c', 'echo "12/84 [make-plots]"; kill -9 $$'])
  assert.equal(error.signal, 'SIGKILL', 'precondition: this is the killed shape')
  assert.equal(String(error.stderr || ''), '', 'precondition: a killed process writes no error')

  const detail = childFailureDetail(error)
  assert.match(detail, /killed by SIGKILL/, `must name the signal. Got: ${detail}`)
  assert.match(detail, /memory/, 'SIGKILL should point at the usual cause')

  // THE CONTROL. The old code returned exactly "12/84 [make-plots]" here — a
  // progress line presented as the reason the build failed.
  assert.notEqual(detail.trim(), '12/84 [make-plots]',
    'the cause must not BE the last progress line')
  assert.ok(detail.indexOf('killed by SIGKILL') < detail.indexOf('12/84'),
    'how it ended must come before what it printed, so the output reads as context')
})

test('a process stopped for flooding its output buffer says so', async () => {
  const error = await failureOf(
    ['sh', '-c', 'i=0; while [ $i -lt 20000 ]; do echo "chunk $i of padding padding padding"; i=$((i+1)); done'],
    { maxBuffer: 1024 },
  )
  assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'precondition')

  const detail = childFailureDetail(error)
  assert.match(detail, /more output than the build was willing to buffer/,
    `must name the real reason. Got: ${detail.slice(0, 160)}`)
  // THE CONTROL. The old code returned the FIRST 1KB of progress output, which
  // reads as though the build failed at chunk 0.
  assert.doesNotMatch(detail.slice(0, 60), /^chunk 0 of padding/,
    'must not open with the first line of ordinary output')
})

test('a process that reported its own error keeps that error', async () => {
  // The case that already worked must keep working: when a renderer DOES say
  // what went wrong, that text is the valuable part and has to survive.
  const error = await failureOf(['sh', '-c', 'echo "ERROR: object \'theta\' not found" 1>&2; exit 1'])
  const detail = childFailureDetail(error)
  assert.match(detail, /object 'theta' not found/, `the real error must survive. Got: ${detail}`)
  assert.match(detail, /exited with status 1/, 'and it should still say how it ended')
})

test('a process that dies silently says that it printed nothing', async () => {
  const error = await failureOf(['sh', '-c', 'exit 3'])
  const detail = childFailureDetail(error)
  assert.match(detail, /exited with status 3/)
  assert.match(detail, /printed nothing/,
    'silence is a finding and must be stated, not left as an empty string')
})

test('the description is never empty, even for an error we do not recognise', async () => {
  // The old failure mode produced an empty detail, which is what a message
  // ending in a bare colon looks like on the build surface.
  for (const value of [null, undefined, {}, new Error('')]) {
    const described = describeChildFailure(value)
    assert.ok(described && described.trim().length > 0,
      `describeChildFailure(${JSON.stringify(value)}) must say something`)
  }
})
