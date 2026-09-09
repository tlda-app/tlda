import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fenceLaunchEnv, wrapSandboxCmd } from './fence.mjs'

const execFile = promisify(execFileCb)
const darwinUserTemp = () => fs.realpathSync(
  execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(),
)
const xcrunDatabases = userTemp => new Set(
  fs.readdirSync(userTemp, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith('xcrun_db-'))
    .map(entry => `${userTemp}/${entry.name}`),
)

async function observeNewXcrunDatabases(userTemp, run, { settleMs = 2000, timeoutMs = 15000 } = {}) {
  const before = xcrunDatabases(userTemp)
  const created = new Set()
  let lastChange = Date.now()
  const sample = () => {
    for (const file of xcrunDatabases(userTemp)) {
      if (!before.has(file) && !created.has(file)) {
        created.add(file)
        lastChange = Date.now()
      }
    }
  }
  const timer = setInterval(sample, 1)
  try {
    await run()
    const deadline = Date.now() + timeoutMs
    while (Date.now() - lastChange < settleMs && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      sample()
    }
  } finally {
    sample()
    clearInterval(timer)
  }
  return [...created]
}

test('fence launch environment prefers Homebrew Git without enabling the xcrun cache leak', () => {
  const env = fenceLaunchEnv({
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
    existsSync: file => file === '/opt/homebrew/bin/git',
  })
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin:/opt/homebrew/bin')
  assert.equal(Object.hasOwn(env, 'xcrun_nocache'), false)
  assert.equal(Object.hasOwn(env, 'DEVELOPER_DIR'), false)
})

test('fence launch environment preserves the inherited PATH when Homebrew Git is absent', () => {
  const env = fenceLaunchEnv({
    env: { PATH: '/usr/bin:/bin' },
    existsSync: () => false,
  })
  assert.equal(Object.hasOwn(env, 'PATH'), false)
  assert.equal(Object.hasOwn(env, 'xcrun_nocache'), false)
})

test('repeated fleet-context Git probes use Homebrew Git and create no xcrun database', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/opt/homebrew/bin/git'),
}, async () => {
  const userTemp = darwinUserTemp()
  let redResults = []
  let redCreated = []
  try {
    redCreated = await observeNewXcrunDatabases(userTemp, async () => {
      redResults = await Promise.allSettled(Array.from({ length: 20 }, () => execFile('/usr/bin/git', ['status', '--short'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/opt/homebrew/bin:/bin', xcrun_nocache: '1' },
      })))
    })
    assert.ok(redResults.every(result => result.status === 'fulfilled'), 'controlled red Git probes did not all settle successfully')
    assert.ok(redCreated.length > 0, 'old fleet environment did not reproduce the xcrun database leak')
  } finally {
    for (const file of redCreated) if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  const policy = {
    harness: 'codex',
    permission_grant: {},
    git: 'write',
    read_roots: [],
    write_roots: [],
    runner: { command: '/bin/zsh', args: ['-lc', '{cmd}'] },
  }
  const probe = wrapSandboxCmd(
    "command -v git; print -r -- ${xcrun_nocache-unset}; for i in {1..10}; do git status --short >/dev/null; done",
    policy,
    { enforce: true },
  )
  let stdout = ''
  const created = await observeNewXcrunDatabases(userTemp, async () => {
    ({ stdout } = await execFile('/bin/zsh', ['-c', probe], { cwd: process.cwd(), encoding: 'utf8' }))
  })
  assert.deepEqual(stdout.trim().split('\n'), ['/opt/homebrew/bin/git', 'unset'])
  assert.deepEqual(created, [])
})
