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

test('managed daemon and bot help expose non-bootstrap restart commands', () => {
  const daemon = help('daemon')
  assert.equal(daemon.status, 0, daemon.stderr)
  assert.match(daemon.stdout, /tlda daemon \[start\|restart\|stop/)
  assert.match(daemon.stdout, /already-loaded launchd service/)
  assert.match(daemon.stdout, /Stop refuses because unloading the job/)

  const bot = help('bot')
  assert.equal(bot.status, 0, bot.stderr)
  assert.match(bot.stdout, /tlda bot \[list\|install\|enlist\|uninstall\|start\|restart\|stop/)
  assert.match(bot.stdout, /refreshes its launch recipe/)
  assert.match(bot.stdout, /Stop refuses because unloading a supervised job/)
})

test('stop refuses before unloading a loaded service', { skip: process.platform !== 'darwin' }, () => {
  const daemon = command('daemon', 'stop')
  assert.equal(daemon.status, 1)
  assert.match(daemon.stderr, /Refusing to unload the supervised fleet daemon/)

  const bot = command('bot', 'stop', 'dev')
  assert.equal(bot.status, 1)
  assert.match(bot.stderr, /Refusing to unload supervised bot services/)
})
