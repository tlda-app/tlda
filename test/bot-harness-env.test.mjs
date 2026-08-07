import assert from 'node:assert/strict'
import test from 'node:test'

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
