import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'
import { resolveCodexResumeHandle } from '../agent-runtime/codex-resume-resolver.mjs'

function makeAgent(id = 'fleet:test-resume') {
  return {
    id,
    friendly_name: id.replace(/^fleet:/, ''),
    cwd: '/tmp/tlda-resume-test',
    registered_at: '2026-07-10T12:00:00.000Z',
  }
}

test('codex resume resolver reads daemon ledger session identity', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-codex-resume-'))
  const ledger = createPermissionLedger(path.join(tmp, 'ledger.db'))
  try {
    const rolloutId = '11111111-2222-4333-8444-555555555555'
    const rolloutPath = path.join(tmp, `rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`)
    fs.writeFileSync(rolloutPath, '{}\n')

    ledger.setSync('fleet:test-resume', { spawnPolicy: { name: 'unsandboxed', policy: 'unsandboxed' } })
    ledger.setSessionSync('fleet:test-resume', {
      sessionId: rolloutId,
      sessionKind: 'codex',
      sessionPath: rolloutPath,
      cwd: '/tmp/tlda-resume-test',
      friendlyName: 'test-resume',
    })

    const resolved = await resolveCodexResumeHandle(makeAgent(), { permissionLedger: ledger })

    assert.equal(resolved.ok, true)
    assert.equal(resolved.resumeId, rolloutId)
    assert.equal(resolved.jsonlPath, rolloutPath)
    assert.equal(resolved.cwd, '/tmp/tlda-resume-test')
    assert.equal(resolved.source, 'daemon-ledger')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('codex resume resolver rejects non-bare ledger resume ids', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-codex-resume-'))
  const ledger = createPermissionLedger(path.join(tmp, 'ledger.db'))
  try {
    const rolloutId = '11111111-2222-4333-8444-555555555555'
    const rolloutPath = path.join(tmp, `rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`)
    fs.writeFileSync(rolloutPath, '{}\n')

    ledger.setSync('fleet:test-bad-resume', { spawnPolicy: { name: 'unsandboxed', policy: 'unsandboxed' } })
    ledger.setSessionSync('fleet:test-bad-resume', {
      sessionId: path.basename(rolloutPath, '.jsonl'),
      sessionKind: 'codex',
      sessionPath: rolloutPath,
      cwd: '/tmp/tlda-resume-test',
      friendlyName: 'test-bad-resume',
    })

    const resolved = await resolveCodexResumeHandle(makeAgent('fleet:test-bad-resume'), { permissionLedger: ledger })

    assert.equal(resolved.ok, false)
    assert.equal(resolved.code, 'missing-resume-handle')
    assert.equal(resolved.detail.reason, 'invalid-uuid')
    assert.equal(resolved.detail.session_id, path.basename(rolloutPath, '.jsonl'))
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('codex resume resolver backfills a missing daemon-ledger session identity from rollout files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-codex-resume-backfill-'))
  const ledger = createPermissionLedger(path.join(tmp, 'ledger.db'))
  try {
    const rolloutId = '33333333-2222-4333-8444-555555555555'
    const sessionsBase = path.join(tmp, 'sessions')
    const rolloutDir = path.join(sessionsBase, '2026', '07', '12')
    fs.mkdirSync(rolloutDir, { recursive: true })
    const rolloutPath = path.join(rolloutDir, `rollout-2026-07-12T18-26-43-${rolloutId}.jsonl`)
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: rolloutId,
          cwd: '/tmp/tlda-resume-test',
          timestamp: '2026-07-12T22:26:43.000Z',
        },
      }),
      JSON.stringify({
        payload: {
          type: 'mcp_tool_call_end',
          invocation: { server: 'tlda', tool: 'login' },
          result: [{ type: 'text', text: 'Logged in fleet:test-resume.\nYour name: "test-resume"' }],
        },
      }),
      '',
    ].join('\n'))

    ledger.setSync('fleet:test-resume', { spawnPolicy: { name: 'unsandboxed', policy: 'unsandboxed' } })

    const resolved = await resolveCodexResumeHandle(makeAgent(), { permissionLedger: ledger, sessionsBase })

    assert.equal(resolved.ok, true)
    assert.equal(resolved.resumeId, rolloutId)
    assert.equal(resolved.jsonlPath, rolloutPath)
    assert.equal(resolved.source, 'daemon-ledger-backfill')
    const row = ledger.get('fleet:test-resume')
    assert.equal(row?.sessionId, rolloutId)
    assert.equal(row?.sessionKind, 'codex')
    assert.equal(row?.sessionPath, rolloutPath)
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
