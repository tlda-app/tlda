import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCmd } from '../agent-launch/harness/bot.mjs'

test('managed bot environment reaches the bot process', () => {
  const command = buildCmd({
    fleetId: 'fleet:dev',
    tmuxSession: 'fleet-bot-dev_testing',
    name: 'dev',
    botName: 'dev',
    botScript: '/tmp/dev-bot.mjs',
    botEnv: {
      TLDA_DEV_BOT_LINKED_REMOTE_ENABLED: 'true',
      TLDA_DEV_BOT_LINKED_REMOTE_URL: 'https://example.invalid/remote.git',
    },
  })

  assert.match(command, /TLDA_DEV_BOT_LINKED_REMOTE_ENABLED=/)
  assert.match(command, /TLDA_DEV_BOT_LINKED_REMOTE_URL=/)
  assert.match(command, /https:\/\/example\.invalid\/remote\.git/)
})

test('managed bot process prefers Homebrew Git and does not inherit xcrun_nocache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-bot-launch-env-'))
  const script = join(dir, 'capture-env.mjs')
  writeFileSync(script, `console.log(JSON.stringify({ PATH: process.env.PATH, xcrun_nocache: process.env.xcrun_nocache ?? null }))\n`)
  try {
    const env = {
      ...process.env,
      PATH: '/usr/bin:/bin:/opt/homebrew/bin',
      xcrun_nocache: '1',
    }
    const command = buildCmd({
      fleetId: 'fleet:dev',
      tmuxSession: 'fleet-bot-dev_testing',
      name: 'dev',
      botName: 'dev',
      botScript: script,
      env,
    })
    const captured = JSON.parse(execFileSync('/bin/zsh', ['-lc', command], {
      encoding: 'utf8',
      env,
    }).trim())
    assert.equal(captured.PATH, '/opt/homebrew/bin:/usr/bin:/bin:/opt/homebrew/bin')
    assert.equal(captured.xcrun_nocache, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
