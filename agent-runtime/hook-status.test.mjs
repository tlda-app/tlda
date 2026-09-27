import assert from 'node:assert/strict'
import test from 'node:test'

import { hookActivityFor, hookStatusTransition } from './hook-status.mjs'

test('PreToolUse maps to thinking with the hook tool name', () => {
  assert.equal(hookActivityFor('PreToolUse'), 'thinking')
  assert.deepEqual(
    hookStatusTransition({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    { activity: 'thinking', tool: 'Bash' },
  )
})

test('Stop and failure edges map to idle', () => {
  for (const name of ['Stop', 'StopFailure']) {
    assert.equal(hookActivityFor(name), 'idle')
  }
  assert.deepEqual(
    hookStatusTransition({ hook_event_name: 'Stop' }),
    { activity: 'idle', tool: null },
  )
})

test('non-activity and unknown hook events stay silent', () => {
  for (const name of [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
    'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PermissionRequest',
    'PermissionDenied',
    'Notification', 'PreCompact', 'TaskCompleted', 'TeammateIdle', 'Whatever',
    null, undefined, 42,
  ]) {
    assert.equal(hookActivityFor(name), null, name)
    assert.equal(hookStatusTransition({ hook_event_name: name }), null, name)
  }
})

test('blank tool names carry no tool', () => {
  assert.deepEqual(
    hookStatusTransition({ hook_event_name: 'PreToolUse', tool_name: '  ' }),
    { activity: 'thinking', tool: null },
  )
})
