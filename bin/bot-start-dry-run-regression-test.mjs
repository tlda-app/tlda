#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'tlda-bot-command-boundary-'))

try {
  const taskHome = join(dir, 'home')
  const configDir = join(dir, 'config')
  const fakeBin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  mkdirSync(join(taskHome, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })

  writeFileSync(join(configDir, 'server.yaml'), '')
  writeFileSync(join(configDir, 'daemon.yaml'), `machineId: test-machine\nenvironments:\n  default: test\n  values:\n    test:\n      database: https://example.invalid\n      store: https://example.invalid\n      licenseKey: test-license\nregions: {}\nprofiles: {}\ngrants: {}\nmodels: {}\n`)
  writeFileSync(join(configDir, 'bots.yaml'), `bots:\n  todd:\n    script: /opt/tlda-bots/todd/todd.mjs\n`)

  for (const command of ['launchctl', 'tmux']) {
    const path = join(fakeBin, command)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${command} '$* >> '${calls}'\nexit 0\n`, { mode: 0o755 })
  }

  for (const command of ['install', 'uninstall', 'start', 'restart', 'stop']) {
    const result = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'bot', command, 'todd'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: taskHome,
        TLDA_CONFIG_DIR: configDir,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
      },
    })
    assert.notEqual(result.status, 0, `${command} must not remain a bot service-management path`)
    assert.match(result.stderr, new RegExp(`Unknown subcommand: tlda bot ${command}`))
  }

  assert.equal(existsSync(calls) ? readFileSync(calls, 'utf8') : '', '', 'removed bot commands must not call launchctl or tmux')
  assert.equal(existsSync(join(taskHome, 'Library', 'LaunchAgents', 'com.tlda.bot.todd.plist')), false)

  console.log('bot command supervision boundary: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
