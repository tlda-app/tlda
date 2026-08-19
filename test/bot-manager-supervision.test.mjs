// The bot manager's whole job is the question the per-bot supervisor got wrong:
// is this bot running? It got a healthy bot's answer wrong every time, restarted
// it, and burned 5.9 MB of log doing so, so a healthy bot that is left alone is
// the thing worth holding still.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'cli', 'tlda.mjs')

function configure() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tlda-bot-manager-'))
  const home = path.join(dir, 'home')
  const configDir = path.join(dir, 'config')
  mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'server.yaml'), '')
  writeFileSync(path.join(configDir, 'daemon.yaml'), [
    'machineId: test-machine',
    'environments:',
    '  default: test',
    '  values:',
    '    test:',
    '      database: https://example.invalid',
    '      store: https://example.invalid',
    '      licenseKey: test-license',
    'regions: {}',
    'profiles: {}',
    'grants: {}',
    'models: {}',
    '',
  ].join('\n'))
  writeFileSync(path.join(configDir, 'bots.yaml'), [
    'bots:',
    '  probe:',
    `    script: ${path.join(dir, 'probe-bot.mjs')}`,
    'environments:',
    '  test:',
    '    - probe',
    '',
  ].join('\n'))
  return { dir, home, configDir }
}

function startManager({ home, configDir }) {
  const child = spawn(process.execPath, [cli, 'bot', 'manager'], {
    cwd: root,
    env: { ...process.env, HOME: home, TLDA_CONFIG_DIR: configDir, TLDA_BOT_SUPERVISION_POLL_MS: '100' },
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, read: () => output }
}

function waitFor(read, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = setInterval(() => {
      if (pattern.test(read())) {
        clearInterval(tick)
        resolve(read())
      } else if (Date.now() > deadline) {
        clearInterval(tick)
        reject(new Error(`timed out waiting for ${pattern}\n--- manager output ---\n${read()}`))
      }
    }, 25)
  })
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

test('a bot whose pidfile holds a live pid is left alone', async () => {
  const { dir, home, configDir } = configure()
  const bot = spawn('/bin/sh', ['-c', 'sleep 30'])
  writeFileSync(path.join(configDir, 'probe.test.pid'), `${bot.pid}\n`)
  const manager = startManager({ home, configDir })
  try {
    await waitFor(manager.read, /supervising 1 bot\(s\): probe:test/, 10_000)
    // Twenty passes at 100ms. The old supervisor relaunched every few seconds
    // under exactly this condition.
    await settle(2000)
    assert.doesNotMatch(manager.read(), /no live process/)
    assert.equal(existsSync(path.join(configDir, 'probe.test.log')), false,
      'a live bot must not have a launch appended to its log')
  } finally {
    manager.child.kill('SIGKILL')
    bot.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bot with no live process is started', async () => {
  const { dir, home, configDir } = configure()
  const manager = startManager({ home, configDir })
  try {
    await waitFor(manager.read, /probe:test: no live process — starting/, 10_000)
  } finally {
    manager.child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

// One bot of a model, for its whole life. The row seeded here holds a DIFFERENT
// name from the one bots.yaml declares, which is the whole point: a rename is how
// a bot is stopped, and a launcher that reads a rename as a vacancy refills it
// within one poll — so stopping a bot would cause its replacement. The check is
// on the model, and `bot:<env>:<model>` is the ledger's key for one.
test('a bot already in the ledger under another name is woken, not minted', async () => {
  const { dir, home, configDir } = configure()
  const { MintStore } = await import('../daemon/mint-store.mjs')
  const store = new MintStore(path.join(configDir, 'daemon-mints.sqlite'), { defaultEnvName: 'test' })
  store.ensure('bot:test:probe')
  store.setFact('bot:test:probe', 'fleet_id', 'fleet:probe-already-exists')
  store.setFact('bot:test:probe', 'env_name', 'test')
  store.updateFriendlyName('bot:test:probe', 'quiet-probe')
  store.close()
  const manager = startManager({ home, configDir })
  try {
    await waitFor(manager.read, /probe:test: already in the ledger — waking bot:test:probe/, 10_000)
    assert.doesNotMatch(manager.read(), /mint did not get the name/,
      'the mint must not be attempted at all when the ledger already has this model')
  } finally {
    manager.child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

// Skip, 2026-08-19 03:01 EDT: "the fucking bot manager should restart on fucking
// code change too." The bot here is healthy and its pidfile is live — the ONLY
// reason it is stopped is that its tree changed, which is the whole behaviour.
test('a code change stops a healthy bot so the ordinary start path brings it back', async () => {
  const { dir, home, configDir } = configure()
  const bot = spawn('/bin/sh', ['-c', 'sleep 60'])
  writeFileSync(path.join(configDir, 'probe.test.pid'), `${bot.pid}\n`)
  writeFileSync(path.join(dir, 'probe-bot.mjs'), '// v1\n')
  const manager = startManager({ home, configDir })
  try {
    await waitFor(manager.read, /supervising 1 bot\(s\): probe:test/, 10_000)
    // First sight seeds the fingerprint and must NOT restart, or every manager
    // start would bounce every healthy bot on the box.
    await settle(1000)
    assert.doesNotMatch(manager.read(), /code changed/,
      'a bot seen for the first time must be recorded, not restarted')

    writeFileSync(path.join(dir, 'probe-bot.mjs'), '// v2 — changed\n')
    await waitFor(manager.read, /probe:test: code changed — stopping pid \d+/, 10_000)
    // Stopped, and then started again through the ordinary path — that second
    // line is the one that proves the restart is not a bypass.
    await waitFor(manager.read, /probe:test: no live process — starting/, 10_000)
  } finally {
    manager.child.kill('SIGKILL')
    bot.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

// The settle. A tree being written to must not produce a restart per pass — that
// is the relaunch storm this supervision model exists to end, arriving through a
// new door. Working copies here are edited in place (`npm install` in a bot's
// directory rewrites many files over several seconds), so this is a real case.
test('a tree still being written is not restarted until it holds still', async () => {
  const { dir, home, configDir } = configure()
  const bot = spawn('/bin/sh', ['-c', 'sleep 60'])
  writeFileSync(path.join(configDir, 'probe.test.pid'), `${bot.pid}\n`)
  writeFileSync(path.join(dir, 'probe-bot.mjs'), '// v1\n')
  const manager = startManager({ home, configDir })
  let writer = null
  try {
    await waitFor(manager.read, /supervising 1 bot\(s\): probe:test/, 10_000)
    await settle(500)
    // Keep changing the tree faster than the poll interval for two seconds —
    // twenty passes at 100ms, every one of which sees a different fingerprint.
    let n = 0
    writer = setInterval(() => {
      writeFileSync(path.join(dir, `part-${n}.mjs`), `// ${n}\n`)
      n++
    }, 50)
    await settle(2000)
    assert.doesNotMatch(manager.read(), /code changed/,
      'a tree that never holds still must not be restarted while it is being written')
    clearInterval(writer)
    writer = null
    // Now it settles, and the restart follows.
    await waitFor(manager.read, /probe:test: code changed — stopping pid \d+/, 10_000)
  } finally {
    if (writer) clearInterval(writer)
    manager.child.kill('SIGKILL')
    bot.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale pidfile does not count as a live bot', async () => {
  const { dir, home, configDir } = configure()
  const dead = spawn('/bin/sh', ['-c', 'exit 0'])
  const deadPid = dead.pid
  await new Promise(resolve => dead.on('exit', resolve))
  writeFileSync(path.join(configDir, 'probe.test.pid'), `${deadPid}\n`)
  const manager = startManager({ home, configDir })
  try {
    await waitFor(manager.read, /probe:test: no live process — starting/, 10_000)
  } finally {
    manager.child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
