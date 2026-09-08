#!/usr/bin/env node
// The sandbox daemon can die before it writes a log line. Polling pid/socket
// only ever reports "gone"; the spawned child's own `error` and `exit` facts
// say which death it was. Each case below is a death the old poll could not
// tell apart, plus the two controls that prove the classifier can also say
// "started fine" and "still starting".
import { spawn } from 'child_process'
import { createServer } from 'net'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { watchSpawnedChild, waitForSandboxDaemon } from '../cli/lib/dev-worktree.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-sandbox-daemon-death-'))
// Node itself takes ~1s to start on a loaded box, so a real death needs a
// patient window; the timeout control needs a short one.
const patient = { attempts: 100, intervalMs: 100 }
const impatient = { attempts: 8, intervalMs: 50 }
const checks = []
const check = (name, ok) => checks.push([name, ok])
const cleanup = []

function start(script, logPath, { command = process.execPath } = {}) {
  const child = spawn(command, ['-e', script], { stdio: 'ignore' })
  const facts = watchSpawnedChild(child)
  cleanup.push(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  return { child, facts, logPath }
}

async function settle(run, socketPath, options = patient) {
  try {
    return { ok: await waitForSandboxDaemon(run.facts, socketPath, run.logPath, options) }
  } catch (error) {
    return { error }
  }
}

try {
  // 1. Started, then exited non-zero, having logged.
  const logOne = join(root, 'exit-code.log')
  const logOneText = 'daemon boot\nconfig resolved\nfatal: no authority\n'
  writeFileSync(logOne, logOneText)
  const one = await settle(start('process.exit(7)', logOne), join(root, 'never-one.sock'))
  const d1 = one.error?.diagnosis
  check('a daemon that exits is classified exit-before-lifecycle', d1?.outcome === 'exit-before-lifecycle')
  check('its exit code is reported', d1?.code === 7)
  check('a clean exit reports no signal', d1?.signal === null)
  check('the log path, size and tail are reported', d1?.log.path === logOne && d1?.log.size === logOneText.length && d1?.log.tail.endsWith('fatal: no authority'))

  // 2. Started, then killed by a signal — indistinguishable from case 1 under a pid poll.
  const logTwo = join(root, 'signal.log')
  const two = start('setInterval(() => {}, 1000)', logTwo)
  two.child.kill('SIGKILL')
  const twoResult = await settle(two, join(root, 'never-two.sock'))
  const d2 = twoResult.error?.diagnosis
  check('a killed daemon is classified exit-before-lifecycle', d2?.outcome === 'exit-before-lifecycle')
  check('its signal is reported', d2?.signal === 'SIGKILL')
  check('a signalled death carries no exit code', d2?.code === null)
  check('a missing log is named as missing, not as an empty tail', d2?.log.exists === false && d2?.log.path === logTwo)
  check('signal death is distinguishable from code death', d1?.code !== d2?.code && d1?.signal !== d2?.signal)

  // 3. Never started at all.
  const logThree = join(root, 'spawn-error.log')
  const three = await settle(
    start('process.exit(0)', logThree, { command: join(root, 'no-such-binary') }),
    join(root, 'never-three.sock'),
  )
  const d3 = three.error?.diagnosis
  check('a daemon that never starts is classified spawn-error', d3?.outcome === 'spawn-error')
  check('the spawn errno is reported', d3?.code === 'ENOENT')
  check('spawn failure is not reported as an exit', d3?.outcome !== 'exit-before-lifecycle')

  // 4. Positive control: a live daemon that creates its lifecycle socket is reported ready.
  const logFour = join(root, 'ready.log')
  writeFileSync(logFour, 'daemon boot\nlifecycle socket listening\n')
  const socketPath = join(root, 'lifecycle.sock')
  const server = createServer()
  await new Promise(resolve => server.listen(socketPath, resolve))
  cleanup.push(() => server.close())
  const four = await settle(start('setInterval(() => {}, 1000)', logFour), socketPath)
  check('a daemon that reaches its socket is reported socket-ready', four.ok?.outcome === 'socket-ready')
  check('socket readiness is not reported as a failure', four.error === undefined)

  // 5. Control: alive, no socket, no death — the wait must time out, not misclassify.
  const logFive = join(root, 'slow.log')
  const five = await settle(start('setInterval(() => {}, 1000)', logFive), join(root, 'never-five.sock'), impatient)
  const d5 = five.error?.diagnosis
  check('a live daemon with no socket times out as no-lifecycle-socket', d5?.outcome === 'no-lifecycle-socket')
  check('a timeout is not attributed to an exit or a spawn error', d5?.code === null && d5?.signal === null)

  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : '  FAIL '}${name}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
} finally {
  for (const undo of cleanup) undo()
  rmSync(root, { recursive: true, force: true })
}
