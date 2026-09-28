// Codex identity resolves the rollout the live runtime owns, and attests it
// only on an observed record: existence proves a launch attempt while a
// record proves a worker. An unreadable or recordless rollout stays missing.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveLiveSessionIdentity } from './codex.mjs'

const CODEX_ARGS = 'codex --model gpt-5 --cwd /Users/x/work/book'

function stubExec({ panePids = '4242', ps = null } = {}) {
  return async (command) => {
    if (command === 'tmux') return { stdout: `${panePids}\n` }
    if (command === 'ps') return { stdout: ps ?? `  4242     1 ${CODEX_ARGS}\n` }
    throw new Error(`unexpected command ${command}`)
  }
}

function writeRollout(dir, name, lines) {
  const file = path.join(dir, name)
  writeFileSync(file, lines.join('\n'))
  return file
}

function resolveWith({ file, agent = {}, extraDeps = {} }) {
  return resolveLiveSessionIdentity({
    agent: { id: 'fleet:test', cwd: '/Users/x/work/book', registered_at: new Date().toISOString(), ...agent },
    tmuxSession: 'fleet-test',
    _deps: {
      execFile: stubExec(),
      resolveTranscriptImpl: async () => file,
      ...extraDeps,
    },
  })
}

const ROLLOUT_UUID = 'c6063ad2-07f1-4d4f-bd19-5bb44b63f074'

test('an owned rollout with a record resolves with model', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = writeRollout(root, `rollout-${ROLLOUT_UUID}.jsonl`, [
    JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5' } }),
    '',
  ])
  const identity = await resolveWith({ file })
  assert.equal(identity.jsonlPath, file)
  assert.ok(identity.sessionId)
  assert.equal(identity.model, 'gpt-5')
})

test('an existing but recordless rollout stays missing', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-rollout-empty-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, lines] of [[`rollout-${ROLLOUT_UUID}.jsonl`, ['\n']], [`rollout-${ROLLOUT_UUID}-b.jsonl`, ['not json', '{{{oops']]]) {
    const file = writeRollout(root, name, lines)
    const identity = await resolveWith({ file })
    assert.equal(identity, null, name)
  }
})

test('a recordless rollout reports the transcript stage in diagnose mode', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-rollout-diag-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = writeRollout(root, `rollout-${ROLLOUT_UUID}.jsonl`, ['\n'])
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:test', cwd: '/Users/x/work/book', registered_at: new Date().toISOString() },
    tmuxSession: 'fleet-test',
    diagnose: true,
    _deps: { execFile: stubExec(), resolveTranscriptImpl: async () => file },
  })
  assert.equal(identity.sessionId, null)
  assert.equal(identity.failureStage, 'transcript')
})
