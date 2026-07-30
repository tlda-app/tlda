import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { buildCmd as buildClaudeCmd } from '../agent-launch/harness/claude.mjs'
import { buildCmd as buildCodexCmd } from '../agent-launch/harness/codex.mjs'

test('Codex launch installs the native child identity bootstrap hook', () => {
  const cmd = buildCodexCmd({
    fleetId: 'fleet:parent',
    localAgentId: 'mint-parent',
    tmuxSession: 'fleet-parent',
    cwd: process.cwd(),
  })
  assert.match(cmd, /hooks\.SubagentStart=/)
  assert.match(cmd, /native-subagent-start-hook\.mjs/)
})

test('Claude launch installs native child bootstrap and pending-delivery hooks', () => {
  const cmd = buildClaudeCmd({
    fleetId: 'fleet:parent',
    localAgentId: 'mint-parent',
    tmuxSession: 'fleet-parent',
    model: 'claude-opus-5',
    config: {},
  })
  assert.match(cmd, /SubagentStart/)
  assert.match(cmd, /native-subagent-start-hook\.mjs/)
  assert.match(cmd, /UserPromptSubmit/)
  assert.match(cmd, /native-subagent-notification-hook\.mjs/)
})

test('SubagentStart tells the child to bind and read its own inbox', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('./native-subagent-start-hook.mjs', import.meta.url).pathname],
    {
      input: JSON.stringify({
        hook_event_name: 'SubagentStart',
        agent_id: 'native-child-id',
        agent_type: 'worker',
      }),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !['FLEET_ID', 'FLEET_DAEMON_KEY'].includes(key)),
      ),
    },
  )
  assert.equal(result.status, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.match(output.hookSpecificOutput.additionalContext, /call tlda login\(\) and then inbox\(\)/)
})
