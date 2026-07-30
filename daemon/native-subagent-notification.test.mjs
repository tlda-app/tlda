import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativeSubagentRouteForToolUseFromWatchers,
  nativeSubagentRoutesFromWatchers,
} from './jsonl-ingestor.mjs'

test('native child routes stay daemon-local and are scoped to the requesting parent', () => {
  const watchers = [{
    nativeSubagent: {
      agentId: 'fleet:child-a',
      parentAgentId: 'fleet:parent-a',
      harnessChildId: 'native-a',
      childName: 'worker-a',
      harnessKind: 'codex',
    },
  }, {
    nativeSubagent: {
      agentId: 'fleet:child-b',
      parentAgentId: 'fleet:parent-b',
      harnessChildId: 'native-b',
      harnessKind: 'claude',
    },
  }]

  assert.deepEqual(
    nativeSubagentRoutesFromWatchers(watchers, 'fleet:parent-a', ['fleet:child-a', 'fleet:child-b']),
    [{
      child_agent_id: 'fleet:child-a',
      native_agent_id: 'native-a',
      harness: 'codex',
    }],
  )
})

test('Claude MCP tool-use metadata resolves to the native child watcher', () => {
  const watchers = [{
    nativeSubagent: {
      agentId: 'fleet:child-a',
      parentAgentId: 'fleet:parent-a',
      harnessChildId: 'native-a',
      harnessKind: 'claude',
    },
    nativeToolUseIds: new Set(['toolu_login_a']),
  }, {
    nativeSubagent: {
      agentId: 'fleet:child-b',
      parentAgentId: 'fleet:parent-b',
      harnessChildId: 'native-b',
      harnessKind: 'claude',
    },
    nativeToolUseIds: new Set(['toolu_login_b']),
  }]

  assert.deepEqual(
    nativeSubagentRouteForToolUseFromWatchers(watchers, 'fleet:parent-a', 'toolu_login_a'),
    {
      child_agent_id: 'fleet:child-a',
      native_agent_id: 'native-a',
      harness: 'claude',
    },
  )
  assert.equal(
    nativeSubagentRouteForToolUseFromWatchers(watchers, 'fleet:parent-a', 'toolu_login_b'),
    null,
  )
})
