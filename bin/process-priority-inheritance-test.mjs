import assert from 'assert/strict'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { availableParallelism, tmpdir } from 'os'
import { join } from 'path'
import { nicedAgentCommand, spawnTmux } from '../agent-launch/tmux.mjs'
import { playwrightCliInvocation } from '../cli/lib/pw.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tlda-priority-test-'))
const socket = `tlda-priority-${process.pid}`
const session = `priority-${process.pid}`
const resultPath = join(dir, 'result.json')
const workerPath = join(dir, 'worker.mjs')
const remotePath = join(dir, 'remote.git')
const repoPath = join(dir, 'checkout')
const load = []

function nice(pid) {
  return Number(execFileSync('ps', ['-o', 'ni=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}

function waitForResult(timeoutMs = 18_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(resultPath, 'utf8')) } catch {
      // The worker has not written its atomic-sized result yet.
    }
    execFileSync('sleep', ['0.1'])
  }
  throw new Error('niced agent job did not complete under concurrent load')
}

writeFileSync(workerPath, `
  import { execFileSync, spawnSync } from 'child_process'
  import { writeFileSync } from 'fs'
  const nice = pid => Number(execFileSync('ps', ['-o', 'ni=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  const descendant = spawnSync(process.execPath, ['-e', "process.stdout.write(require('child_process').execFileSync('ps', ['-o', 'ni=', '-p', String(process.pid)], {encoding:'utf8'}).trim())"], { encoding: 'utf8' })
  if (descendant.status !== 0) throw descendant.error || new Error(descendant.stderr)
  const nested = spawnSync('/usr/bin/nice', ['-n', '5', process.execPath, '-e', "process.stdout.write(require('child_process').execFileSync('ps', ['-o', 'ni=', '-p', String(process.pid)], {encoding:'utf8'}).trim())"], { encoding: 'utf8' })
  if (nested.status !== 0) throw nested.error || new Error(nested.stderr)
  const descendantNice = Number(descendant.stdout)
  const browserNice = Number(nested.stdout)
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  let total = 0
  for (let i = 0; i < 10_000_000; i++) total = (total + i) % 1_000_003
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ agentPid: process.pid, agentNice: nice(process.pid), descendantNice, browserNice, remoteUrl, total }))
`)

try {
  assert.match(nicedAgentCommand('printf ok'), /^exec \/usr\/bin\/nice -n 5 /)
  assert.deepEqual(playwrightCliInvocation('/tmp/playwright-cli', ['status']), {
    command: '/usr/bin/nice',
    args: ['-n', '5', '/tmp/playwright-cli', 'status'],
  })
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' })
  execFileSync('git', ['init', repoPath], { stdio: 'ignore' })
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remotePath])

  const controllerNice = nice(process.pid)
  const loadLaneCount = availableParallelism()
  for (let i = 0; i < loadLaneCount; i++) {
    load.push(spawn('/usr/bin/nice', ['-n', '5', process.execPath, '-e', 'const end=Date.now()+20000; while(Date.now()<end){}'], { stdio: 'ignore' }))
  }
  execFileSync('sleep', ['0.2'])
  assert.deepEqual(load.map(child => nice(child.pid)), Array(loadLaneCount).fill(controllerNice + 5))
  await spawnTmux(session, repoPath, `${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)}`, {
    autoDismiss: false,
    tmuxSocket: socket,
    crashLogPath: join(dir, 'agent.log'),
  })
  const result = waitForResult()
  assert.equal(result.agentNice, controllerNice + 5)
  assert.equal(result.descendantNice, result.agentNice)
  assert.equal(result.browserNice, result.agentNice + 5)
  assert.equal(result.remoteUrl, remotePath)
  assert.equal(typeof result.total, 'number')
  assert.equal(load.every(child => child.exitCode === null), true)
  console.log(JSON.stringify({ controllerNice, loadLaneCount, loadNice: controllerNice + 5, agentNice: result.agentNice, descendantNice: result.descendantNice, browserNice: result.browserNice, remoteCount: 1, longJobCompletedWhileAllLoadLanesBusy: true }))
} finally {
  for (const child of load) child.kill('SIGKILL')
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch {
    // The disposable tmux server may already have exited with its only session.
  }
  rmSync(dir, { recursive: true, force: true })
}
