import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function help(noun) {
  return spawnSync(process.execPath, ['cli/tlda.mjs', noun, '--help'], {
    cwd: root,
    encoding: 'utf8',
  })
}

function command(...args) {
  return spawnSync(process.execPath, ['cli/tlda.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TLDA_ENV: 'testing' },
  })
}

// The bot half of this file asserted `tlda bot install|start|restart|stop` and the
// refusal each of them printed. Those commands are gone — bot supervision is
// reconciled by config apply and nothing else — and bin/bot-start-dry-run-regression-test.mjs
// asserts their absence, so the two files contradicted each other and this one had
// been failing on main since the commands were deleted.
test('managed daemon help exposes non-bootstrap restart commands', () => {
  const daemon = help('daemon')
  assert.equal(daemon.status, 0, daemon.stderr)
  assert.match(daemon.stdout, /tlda daemon \[start\|restart\|stop/)
  assert.match(daemon.stdout, /already-loaded launchd service/)
  assert.match(daemon.stdout, /Stop refuses because unloading the job/)
})

test('stop refuses before unloading a loaded service', { skip: process.platform !== 'darwin' }, () => {
  const daemon = command('daemon', 'stop')
  assert.equal(daemon.status, 1)
  assert.match(daemon.stderr, /Refusing to unload the supervised fleet daemon/)
})
