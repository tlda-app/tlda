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
  writeFileSync(join(configDir, 'bots.yaml'), `bots:\n  todd:\n    script: /opt/tlda-bots/todd/todd.mjs\nenvironments:\n  test:\n    - todd\n`)

  for (const command of ['launchctl', 'tmux']) {
    const path = join(fakeBin, command)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${command} '$* >> '${calls}'\nif [ '${command}' = launchctl ] && [ "$1" = print ]; then\n  echo 'Could not find service' >&2\n  exit 1\nfi\nexit 0\n`, { mode: 0o755 })
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

  writeFileSync(join(configDir, 'todd.test.pid'), `${process.pid}\n`)
  const statusResult = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), '--env', 'test', 'bot', 'status', 'todd'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: taskHome,
      TLDA_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  })
  assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout)
  // Liveness is the pidfile the bot wrote, not a launchd job of its own and not a
  // tmux session name. A running bot with no per-bot job is the new normal state,
  // so it must not read as a fault.
  assert.match(statusResult.stdout, new RegExp(`todd:test: running \\(pid ${process.pid}\\)`))
  assert.doesNotMatch(statusResult.stdout, /Configuration fault:/)
  assert.match(statusResult.stdout, /bot manager: not running/)

  // The declaration says one bot in one environment, so an apply installs one bot
  // manager and takes away the per-bot job that used to supervise it.
  const staleBotPlist = join(taskHome, 'Library', 'LaunchAgents', 'com.tlda.bot.todd.test.plist')
  writeFileSync(staleBotPlist, '<plist>stale per-bot supervisor</plist>')
  const planResult = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'config', 'apply', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: taskHome,
      TLDA_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
  })
  assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout)
  const group = (title, text) => text.split(/^(?=Add:|Update:|Remove:|Unchanged:)/m).find(part => part.startsWith(`${title}:`)) || ''
  assert.match(group('Add', planResult.stdout), /com\.tlda\.bot-manager/)
  assert.match(group('Remove', planResult.stdout), /com\.tlda\.bot\.todd\.test/)
  assert.doesNotMatch(group('Add', planResult.stdout), /com\.tlda\.bot\.todd/)
  assert.equal(existsSync(staleBotPlist), true, 'a dry run must not touch any plist')

  console.log('bot command supervision boundary: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
