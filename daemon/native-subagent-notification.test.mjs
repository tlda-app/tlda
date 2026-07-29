import assert from 'node:assert/strict'
import test from 'node:test'

import { nativeSubagentRoutesFromWatchers } from './jsonl-ingestor.mjs'

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
