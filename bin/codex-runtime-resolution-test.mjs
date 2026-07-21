#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexRuntimeCandidates, resolveOwnedCodexTranscript } from '../agent-launch/harness/codex.mjs'
import { codexRolloutBelongsToAgent, codexRolloutIsTopLevel, resolveTranscript } from '../agent-runtime/resolve-transcript.mjs'

const children = new Map([
  ['pane', ['shell']],
  ['shell', ['node-wrapper']],
  ['node-wrapper', ['native-codex', 'mcp-server']],
])
const runtimes = new Set(['node-wrapper', 'native-codex'])

assert.deepEqual(
  codexRuntimeCandidates({ panePids: ['pane'], children, runtimes }),
  ['native-codex', 'node-wrapper'],
  'the native child that owns the writable rollout must be checked before the Node wrapper',
)

assert.deepEqual(
  codexRuntimeCandidates({ panePids: ['pane', 'pane'], children, runtimes }),
  ['native-codex', 'node-wrapper'],
  'duplicate pane roots must not duplicate candidates',
)

const chosen = await resolveTranscript({
  pid: 'native-codex',
  kind: 'codex',
  agent: { id: 'fleet:expected' },
  launchTs: Date.now(),
  processOwnedOnly: true,
  acceptTranscript: path => path.includes('expected'),
  findOpenTranscript: async (_pid, _matches, accept) => {
    for (const path of [
      '/tmp/.codex/sessions/rollout-stale.jsonl',
      '/tmp/.codex/sessions/rollout-expected.jsonl',
    ]) {
      if (accept(path)) return path
    }
    return null
  },
})
assert.equal(chosen, '/tmp/.codex/sessions/rollout-expected.jsonl')

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-resolution-'))
try {
  const topLevel = path.join(fixtureDir, 'rollout-top.jsonl')
  const subagent = path.join(fixtureDir, 'rollout-subagent.jsonl')
  const wrongTopLevel = path.join(fixtureDir, 'rollout-wrong-top.jsonl')
  fs.writeFileSync(topLevel, [
    JSON.stringify({ type: 'session_meta', payload: { thread_source: 'user', source: 'cli' } }),
    JSON.stringify({ result: 'Logged in fleet:expected. Your name: "expected"' }),
  ].join('\n'))
  fs.writeFileSync(subagent, [
    JSON.stringify({ type: 'session_meta', payload: { thread_source: 'subagent', source: { subagent: {} } } }),
    JSON.stringify({ result: 'Logged in fleet:expected. Your name: "expected"' }),
  ].join('\n'))
  fs.writeFileSync(wrongTopLevel, [
    JSON.stringify({ type: 'session_meta', payload: { thread_source: 'user', source: 'cli' } }),
    JSON.stringify({ result: 'Logged in fleet:wrong. Your name: "wrong"' }),
  ].join('\n'))
  assert.equal(codexRolloutIsTopLevel(topLevel), true)
  assert.equal(codexRolloutBelongsToAgent(topLevel, { id: 'fleet:expected' }), true)
  assert.equal(codexRolloutIsTopLevel(subagent), false)
  assert.equal(codexRolloutBelongsToAgent(subagent, { id: 'fleet:expected' }), false)

  const fallbackResolved = await resolveTranscript({
    pid: 'native-codex',
    kind: 'codex',
    agent: { id: 'fleet:expected' },
    launchTs: Date.now(),
    acceptTranscript: candidate => codexRolloutBelongsToAgent(candidate, { id: 'fleet:expected' }),
    findOpenTranscript: async () => null,
    findFallbackTranscript: async () => topLevel,
  })
  assert.equal(fallbackResolved, topLevel, 'the real resolver fallback accepts the correct owner rollout')

  const wrongOwnerFallback = await resolveTranscript({
    pid: 'native-codex',
    kind: 'codex',
    agent: { id: 'fleet:expected' },
    launchTs: Date.now(),
    acceptTranscript: candidate => codexRolloutBelongsToAgent(candidate, { id: 'fleet:expected' }),
    findOpenTranscript: async () => null,
    findFallbackTranscript: async () => wrongTopLevel,
  })
  assert.equal(wrongOwnerFallback, null, 'the real resolver fallback rejects a nearby wrong-owner rollout')

  const noCorrectOwnerFallback = await resolveTranscript({
    pid: 'node-wrapper',
    kind: 'codex',
    agent: { id: 'fleet:expected' },
    launchTs: Date.now(),
    acceptTranscript: candidate => codexRolloutBelongsToAgent(candidate, { id: 'fleet:expected' }),
    findOpenTranscript: async () => null,
    findFallbackTranscript: async () => null,
  })
  assert.equal(noCorrectOwnerFallback, null, 'the real resolver fallback returns null when no correct owner exists')

  const resolverCalls = []
  const resolved = await resolveOwnedCodexTranscript({
    runtimePids: ['native-codex', 'node-wrapper'],
    agent: { id: 'fleet:expected' },
    launchTs: Date.now(),
    processOwnedOnly: false,
    resolveTranscriptImpl: async options => {
      resolverCalls.push(options)
      if (options.processOwnedOnly) return null
      const nearby = options.pid === 'node-wrapper'
        ? [wrongTopLevel]
        : [wrongTopLevel, topLevel]
      return nearby.find(candidate => options.acceptTranscript(candidate)) || null
    },
  })
  assert.equal(resolved, topLevel, 'a nearby top-level rollout owned by another seat must not bind')
  assert.equal(resolverCalls.length, 3, 'all descendant runtimes are checked before the owner-filtered fallback')
  assert.ok(resolverCalls.every(call => typeof call.acceptTranscript === 'function'))
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true })
}

console.log('ok: Codex runtime resolution checks descendants before wrappers')
