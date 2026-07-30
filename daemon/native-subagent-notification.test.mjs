import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

test('tool-use lookup falls back to the native transcript tail before ingestion catches up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tool-route-'))
  const jsonlPath = path.join(dir, 'agent-child.jsonl')
  try {
    fs.writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'mcp__tlda__login',
          id: 'toolu_login_tail',
          input: {},
        }],
      },
    }))
    const watchers = [{
      jsonlPath,
      nativeSubagent: {
        agentId: 'fleet:child-tail',
        parentAgentId: 'fleet:parent-tail',
        harnessChildId: 'native-tail',
        harnessKind: 'claude',
      },
    }]

    assert.deepEqual(
      nativeSubagentRouteForToolUseFromWatchers(watchers, 'fleet:parent-tail', 'toolu_login_tail'),
      {
        child_agent_id: 'fleet:child-tail',
        native_agent_id: 'native-tail',
        harness: 'claude',
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
