import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  nativeSubagentDescriptor,
  nativeSubagentOperationId,
} from './jsonl-ingestor.mjs'

test('describes Codex native subagent ownership from session metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-codex-subagent-'))
  const transcript = join(dir, 'rollout-child.jsonl')
  try {
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child-thread',
        parent_thread_id: 'parent-thread',
        thread_source: 'subagent',
        agent_nickname: 'worker',
      },
    })}\n`)
    assert.deepEqual(nativeSubagentDescriptor(transcript), {
      harnessKind: 'codex',
      harnessChildId: 'child-thread',
      parentSessionId: 'parent-thread',
      childName: 'worker',
      agentPath: null,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('describes Claude native subagent ownership from sidechain metadata and path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-claude-subagent-'))
  const transcriptDir = join(dir, 'parent-session', 'subagents')
  const transcript = join(transcriptDir, 'agent-child-id.jsonl')
  try {
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(transcript, `${JSON.stringify({
      isSidechain: true,
      agentId: 'child-id',
      type: 'user',
    })}\n`)
    assert.deepEqual(nativeSubagentDescriptor(transcript), {
      harnessKind: 'claude',
      harnessChildId: 'child-id',
      parentSessionId: 'parent-session',
      childName: null,
      agentPath: null,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native subagent observation operation id is stable and ownership-scoped', () => {
  const input = {
    daemonKey: 'mini:testing',
    parentAgentId: 'fleet:parent',
    harnessKind: 'codex',
    harnessChildId: 'child-thread',
  }
  assert.equal(nativeSubagentOperationId(input), nativeSubagentOperationId(input))
  assert.notEqual(
    nativeSubagentOperationId(input),
    nativeSubagentOperationId({ ...input, parentAgentId: 'fleet:other' }),
  )
})
