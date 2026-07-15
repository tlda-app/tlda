import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  catchupReplayBoundary,
  sessionIdentitySeatEvent,
  shouldSuppressCatchupOutput,
} from './jsonl-ingestor.mjs'
import { scanFileIdentitySync, scanFileOwnersSync } from '../agent-runtime/daemon-jsonl-hot-path.mjs'
import { tailLedgerSessionInput } from '../agent-runtime/ledger-session-tail.mjs'
import { listSessionsByRecency } from '../bin/fleet-owner-harvester.mjs'

test('large JSONL tail gaps enter display catch-up mode', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 1000,
    thresholdBytes: 500,
  }), 1000)
})

test('small JSONL tail gaps replay normally', () => {
  assert.equal(catchupReplayBoundary({
    startOffset: 100,
    liveOffset: 300,
    thresholdBytes: 500,
  }), null)
})

test('display catch-up suppresses chat/activity but preserves indexing and identity', () => {
  for (const type of ['activity', 'context', 'qualification', 'terminalChat', 'nativeTask']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), true, type)
  }
  for (const type of ['searchIndex', 'identity']) {
    assert.equal(shouldSuppressCatchupOutput({ type }), false, type)
  }
})

test('codex tail ledger input stores bare resume UUID', () => {
  const rolloutId = '11111111-2222-4333-8444-555555555555'
  const input = tailLedgerSessionInput({
    sessionId: `rollout-2026-07-10T12-00-00-${rolloutId}`,
    harnessKind: 'codex',
    jsonlPath: `/tmp/rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`,
    ownerFleetId: 'fleet:test-resume',
    contentIdentity: {
      cwd: '/tmp/tlda-resume-test',
      friendly_name: 'test-resume',
    },
  })

  assert.equal(input.session_id, rolloutId)
  assert.equal(input.fleet_id, 'fleet:test-resume')
  assert.equal(input.harness_kind, 'codex')
})

test('codex tail ledger input keys by watcher owner, not JSONL content identity', () => {
  const rolloutId = '11111111-2222-4333-8444-555555555555'
  const input = tailLedgerSessionInput({
    sessionId: `rollout-2026-07-10T12-00-00-${rolloutId}`,
    harnessKind: 'codex',
    jsonlPath: `/tmp/rollout-2026-07-10T12-00-00-${rolloutId}.jsonl`,
    ownerFleetId: 'fleet:watcher-owner',
    contentIdentity: {
      fleet_id: 'fleet:stale-content-owner',
      friendly_name: 'stale-content-owner',
      cwd: '/tmp/tlda-resume-test',
    },
  })

  assert.equal(input.session_id, rolloutId)
  assert.equal(input.fleet_id, 'fleet:watcher-owner')
  assert.equal(input.friendly_name, 'stale-content-owner')
})

test('session identity emits seat binding event only from complete runtime tuple', () => {
  const event = sessionIdentitySeatEvent({
    fleet_id: 'fleet:watcher-owner',
    session_id: 'rollout-2026-07-10T12-00-00-11111111-2222-4333-8444-555555555555',
    harness_kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/Users/skip/work/tlda',
    tmux_session: 'fleet-watcher-owner',
  }, {
    machineId: 'mini',
    envName: 'fly',
  })

  assert.deepEqual(event, {
    type: 'agent-seat',
    agent_id: 'fleet:watcher-owner',
    session_id: '11111111-2222-4333-8444-555555555555',
    resume_id: '11111111-2222-4333-8444-555555555555',
    kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/Users/skip/work/tlda',
    machine_id: 'mini',
    env_name: 'fly',
    daemon_key: 'mini:fly',
    tmux_session: 'fleet-watcher-owner',
    created_source: 'daemon-session-observed',
  })

  assert.equal(sessionIdentitySeatEvent({
    fleet_id: 'fleet:watcher-owner',
    session_id: '11111111-2222-4333-8444-555555555555',
    harness_kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/Users/skip/work/tlda',
  }, { machineId: 'mini', envName: 'fly' }), null)
})

test('daemon identity scanner recognizes current Codex login wording', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-login-scan-'))
  const file = path.join(tmp, 'rollout-2026-07-12T05-25-19-11111111-2222-4333-8444-555555555555.jsonl')
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/tlda-login-scan' } }),
      JSON.stringify({
        timestamp: '2026-07-12T09:25:28.559Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          invocation: { server: 'tlda', tool: 'login' },
          result: {
            Ok: {
              content: [{
                type: 'text',
                text: 'Logged in fleet:dd28f37d.\nYour name: "agent-88m8" — other agents and the user know you by this name.',
              }],
            },
          },
        },
      }),
    ].join('\n') + '\n')

    assert.deepEqual(scanFileOwnersSync(file).owners, ['fleet:dd28f37d'])
    assert.deepEqual(scanFileIdentitySync(file).identity, {
      cwd: '/tmp/tlda-login-scan',
      fleet_id: 'fleet:dd28f37d',
      friendly_name: 'agent-88m8',
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('owner harvester lists nested Codex rollout JSONLs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-harvest-roots-'))
  const claudeRoot = path.join(tmp, '.claude', 'projects', '-Users-skip-work-tlda')
  const codexRoot = path.join(tmp, '.codex', 'sessions', '2026', '07', '12')
  try {
    fs.mkdirSync(claudeRoot, { recursive: true })
    fs.mkdirSync(codexRoot, { recursive: true })
    const claudeFile = path.join(claudeRoot, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    const codexFile = path.join(codexRoot, 'rollout-2026-07-12T05-25-19-11111111-2222-4333-8444-555555555555.jsonl')
    fs.writeFileSync(claudeFile, '{}\n')
    fs.writeFileSync(codexFile, '{}\n')

    const sessions = listSessionsByRecency([
      path.join(tmp, '.claude', 'projects'),
      path.join(tmp, '.codex', 'sessions'),
    ])
    const files = sessions.map(item => item.filePath).sort()

    assert.deepEqual(files, [claudeFile, codexFile].sort())
    assert.equal(sessions.find(item => item.filePath === claudeFile)?.harnessKind, 'claude')
    assert.equal(sessions.find(item => item.filePath === codexFile)?.harnessKind, 'codex')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
