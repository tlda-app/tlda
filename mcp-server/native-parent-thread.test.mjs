import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { matchesLocalParentThread, parentTranscriptContainsToolUse } from './lib/native-parent-thread.mjs'

test('matches the MCP parent thread from either local identity source', () => {
  assert.equal(matchesLocalParentThread('claude-session', 'claude-session', null), true)
  assert.equal(matchesLocalParentThread('codex-thread', null, 'codex-thread'), true)
})

test('does not claim a native child thread as the parent', () => {
  assert.equal(matchesLocalParentThread('child-thread', 'parent-thread', 'parent-thread'), false)
  assert.equal(matchesLocalParentThread(null, 'parent-thread', 'parent-thread'), false)
})

test('recognizes a Claude parent tool use from its transcript tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-parent-tool-use-'))
  const transcript = path.join(dir, 'parent.jsonl')
  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_parent' }] } })}\n`)
    assert.equal(parentTranscriptContainsToolUse(transcript, 'toolu_parent'), true)
    assert.equal(parentTranscriptContainsToolUse(transcript, 'toolu_child'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
