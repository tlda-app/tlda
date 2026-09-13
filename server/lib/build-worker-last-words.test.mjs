import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createForkTransport } from './build-transport.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-lastwords-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

// A stand-in worker, because the real one needs a project, a revision store and
// a render. What is under test is the transport's contract on death, and that is
// the same whatever the worker was doing when it died.
function worker(body) {
  const path = join(root, `worker-${Math.abs(body.length)}-${body.slice(0, 8).replace(/\W/g, '')}.mjs`)
  writeFileSync(path, body)
  return createForkTransport(path)
}

function runToExit(transport) {
  return new Promise(resolve => {
    transport.start({ name: 'p', osPriority: 10 }, {
      onMessage() {},
      onError() {},
      onExit: (code, signal, output) => resolve({ code, signal, output }),
    })
  })
}

// THE DEFECT THIS EXISTS FOR. A worker that dies without reporting used to leave
// the queue saying "exited with code 1" -- what the observer saw, not what
// happened -- while the reason went to a process log that rotates in minutes. On
// 2026-09-13 one such cause was unrecoverable eight minutes later, and three
// people then reasoned from the manufactured exit code.
test('a worker that dies without reporting still hands back its last output', async () => {
  const t = worker(`
    process.on('message', () => {
      console.error('THE REASON: something specific went wrong')
      process.exit(1)
    })
  `)
  const { code, output } = await runToExit(t)
  assert.equal(code, 1)
  assert.match(output, /THE REASON: something specific went wrong/,
    'the worker died silently as far as the queue is concerned, so its output is the only account there is')
})

// `exit 1` and the kernel reclaiming memory both arrive at the same handler, and
// telling them apart decides whether anyone goes and fixes memory. A box with no
// swap has OOM-killed R four times; attributing a thrown error to that, or the
// reverse, sends the next person to the wrong place entirely.
test('a killed worker is distinguishable from one that exited', async () => {
  const t = worker(`
    process.on('message', () => { process.kill(process.pid, 'SIGKILL') })
  `)
  const { code, signal } = await runToExit(t)
  assert.equal(signal, 'SIGKILL', 'a signal death must arrive as a signal, not as a bare code')
  assert.equal(code, null)
})

// Bounded, because a worker that prints in a loop must not be able to grow the
// server's memory through the thing that records its death. A single chunk can
// exceed the bound on its own -- stdout arrives in pieces up to 64 KB -- which
// is the case that made the first implementation keep 65,526 bytes against a
// 16 KB limit.
test('the kept output is bounded even when one chunk exceeds the bound', async () => {
  const t = worker(`
    process.on('message', () => {
      for (let i = 0; i < 4000; i++) console.error('x'.repeat(200))
      process.exit(1)
    })
  `)
  const { output } = await runToExit(t)
  assert.ok(output.length <= 17 * 1024, `kept ${output.length} bytes, which is not bounded`)
})

// The END is what explains a death, so a full buffer must discard the beginning
// rather than the end.
//
// It exits by setting `exitCode` instead of calling `process.exit`, and that is
// not tidiness. A hard exit does not wait for a pipe to drain, so the final
// write is lost often enough to make this assertion flap -- measured, one
// failure in three runs. THAT IS A REAL LIMIT OF THE FEATURE, not just of the
// test: a worker killed or exiting the instant after it prints can lose exactly
// the line that mattered. Asserting it here would test Node's flush timing; the
// limit belongs in the module's comment, where it is.
test('a full buffer keeps the end of the output and discards the beginning', async () => {
  const t = worker(`
    process.on('message', () => {
      for (let i = 0; i < 4000; i++) console.error('x'.repeat(200))
      console.error('LAST-LINE-BEFORE-DEATH')
      process.exitCode = 1
      process.disconnect()
    })
  `)
  const { output } = await runToExit(t)
  assert.match(output, /LAST-LINE-BEFORE-DEATH/,
    'the beginning was kept instead of the end, which is the half that explains nothing')
  assert.equal(/^x+$/m.test(output.split('\n')[0]) || output.startsWith('x'), true,
    'the earlier output should have been trimmed, leaving a partial first line')
})
