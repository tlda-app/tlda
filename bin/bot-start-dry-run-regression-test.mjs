#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'tlda-bot-dry-run-'))

try {
  const home = join(dir, 'home')
  const configDir = join(dir, 'config')
  const fakeBin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })

  writeFileSync(join(configDir, 'server.yaml'), '')
  writeFileSync(join(configDir, 'daemon.yaml'), `machineId: test-machine\nenvironments:\n  default: test\n  values:\n    test:\n      database: https://example.invalid\n      store: https://example.invalid\n      licenseKey: test-license\nregions: {}\nprofiles: {}\ngrants: {}\nmodels: {}\n`)
  writeFileSync(join(configDir, 'bots.yaml'), `bots:\n  - name: todd\n    script: bin/bots/todd.mjs\n`)

  for (const command of ['launchctl', 'tmux']) {
    const path = join(fakeBin, command)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${command} '$* >> '${calls}'\nexit 0\n`, { mode: 0o755 })
  }

  const result = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'bot', 'start', 'todd', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TLDA_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const plist = join(home, 'Library', 'LaunchAgents', 'com.tlda.bot.todd.plist')
  assert.equal(existsSync(plist), false, 'dry-run must not write a launchd plist')
  assert.equal(existsSync(calls) ? readFileSync(calls, 'utf8') : '', '', 'dry-run must not call launchctl or tmux')
  for (const artifact of ['todd.pid', 'todd.fleet-id', 'todd.heartbeat']) {
    assert.equal(existsSync(join(configDir, artifact)), false, `dry-run must not create ${artifact}`)
  }
  assert.match(result.stdout, /Would start bot service:/)
  assert.match(result.stdout, /todd: com\.tlda\.bot\.todd/)

  const blockedStart = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'bot', 'start', 'todd'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TLDA_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  })
  assert.notEqual(blockedStart.status, 0, 'normal start must refuse without an existing bot fleet id')
  assert.match(blockedStart.stderr, /needs an existing fleet id/)
  writeFileSync(join(configDir, 'todd.fleet-id'), 'fleet:todd-existing\n')

  const liveResult = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'bot', 'start', 'todd'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TLDA_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  })
  assert.equal(liveResult.status, 0, liveResult.stderr || liveResult.stdout)
  assert.match(liveResult.stdout, /Started com\.tlda\.bot\.todd\./)
  assert.equal(existsSync(plist), true, 'normal start must retain its existing plist write')
  const plistText = readFileSync(plist, 'utf8')
  assert.match(plistText, /tlda agent wake (?:&quot;|")\$fleet_id(?:&quot;|")/, 'bot launchd job must wake the existing bot identity')
  assert.doesNotMatch(plistText, /node['" ][^<]*bin\/bots\/todd\.mjs/, 'bot launchd job must not run the bot script directly')
  assert.doesNotMatch(plistText, /tmux new-session/, 'launchd must not pre-create the bot tmux before wake')
  assert.match(readFileSync(calls, 'utf8'), /launchctl bootstrap/)
  assert.match(readFileSync(calls, 'utf8'), /launchctl kickstart/)

  console.log('bot start dry-run regression: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
