import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  decideMissingLiveness,
  detectSpawnStartupFailureTranscript,
  harnessKindForAgent,
  isPlaywrightBrowserArgs,
  shouldClaimCodexWatcher,
  shouldFlushWatch,
  unlinkPidfileIfOwnPid,
} from '../bin/lib/daemon-guards.mjs'

test('missing metadata.kind defaults to claude once', () => {
  const warnings = []
  const log = { warn: (msg) => warnings.push(msg) }
  const agent = { id: 'fleet:test', friendly_name: 'test-agent', metadata: {} }

  assert.equal(harnessKindForAgent(agent, log), 'claude')
  assert.equal(harnessKindForAgent(agent, log), 'claude')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /defaulting to claude/)
})

test('shouldFlushWatch: no pending read never flushes', () => {
  assert.equal(shouldFlushWatch(null, 1000), false)
  assert.equal(shouldFlushWatch(undefined, 1000), false)
})

test('shouldFlushWatch: holds (trailing-debounce) while inside the max-wait window', () => {
  // First write of a burst: firstPending == now, so 0ms elapsed -> keep debouncing.
  assert.equal(shouldFlushWatch(1000, 1000, 150), false)
  // Mid-burst, still under the cap.
  assert.equal(shouldFlushWatch(1000, 1100, 150), false)
  assert.equal(shouldFlushWatch(1000, 1149, 150), false)
})

test('shouldFlushWatch: flushes immediately once the first unread write hits the cap', () => {
  // Sustained burst: once the oldest unread write is >= maxWait, flush now
  // instead of resetting the trailing timer (prevents read starvation).
  assert.equal(shouldFlushWatch(1000, 1150, 150), true)
  assert.equal(shouldFlushWatch(1000, 5000, 150), true)
})

test('pidfile is only removed when it matches our pid', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tlda-pidfile-'))
  const pidfile = path.join(dir, 'fleet-daemon.pid')

  writeFileSync(pidfile, '12345')
  assert.equal(unlinkPidfileIfOwnPid(pidfile, 99999), false)
  assert.equal(existsSync(pidfile), true)
  assert.equal(unlinkPidfileIfOwnPid(pidfile, 12345), true)
  assert.equal(existsSync(pidfile), false)

  rmSync(dir, { recursive: true, force: true })
})

test('playwright reaper does not classify codex cache grants as browsers', () => {
  assert.equal(isPlaywrightBrowserArgs(
    'FLEET_ID=fleet:test codex -m gpt-5.5 -s workspace-write --add-dir /Users/skip/Library/Caches/ms-playwright -a never'
  ), false)

  assert.equal(isPlaywrightBrowserArgs(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/playwright_chromiumdev_profile-abc'
  ), true)

  assert.equal(isPlaywrightBrowserArgs(
    '/Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium --remote-debugging-port=12345'
  ), true)
})

test('codex watcher ownership is not stolen without a matching rollout id', () => {
  const takeoverPath = '/Users/skip/.codex/sessions/2026/06/17/rollout-2026-06-17T02-15-50-019ed438-c2ee-7f72-a2c4-9708b6f04679.jsonl'

  assert.equal(shouldClaimCodexWatcher({
    currentPrimaryId: 'fleet:takeover',
    agent: { id: 'fleet:takeover', session_id: null, session_ids: [] },
    jsonlPath: takeoverPath,
  }), true)

  assert.equal(shouldClaimCodexWatcher({
    currentPrimaryId: 'fleet:takeover',
    agent: { id: 'fleet:touchtele55', session_id: '019ed4dd-9f2e-7ed3-b3b6-30c27c480eb4', session_ids: [] },
    jsonlPath: takeoverPath,
  }), false)

  assert.equal(shouldClaimCodexWatcher({
    currentPrimaryId: 'fleet:stale',
    agent: { id: 'fleet:takeover', session_id: '019ed438-c2ee-7f72-a2c4-9708b6f04679', session_ids: [] },
    jsonlPath: takeoverPath,
  }), true)
})

test('codex watcher ownership is not stolen by stale matching rollout id when file has another owner', () => {
  const ownedPath = '/Users/skip/.codex/sessions/2026/06/17/rollout-2026-06-17T02-15-50-019ed438-c2ee-7f72-a2c4-9708b6f04679.jsonl'
  const hasOwner = path => path === ownedPath
  const belongs = (_path, agent) => agent?.id === 'fleet:real-owner'

  assert.equal(shouldClaimCodexWatcher({
    currentPrimaryId: 'fleet:real-owner',
    agent: {
      id: 'fleet:stale-agent',
      session_id: '019ed438-c2ee-7f72-a2c4-9708b6f04679',
      session_ids: [],
    },
    jsonlPath: ownedPath,
    rolloutHasOwnerEvidence: hasOwner,
    rolloutBelongsToAgent: belongs,
  }), false)

  assert.equal(shouldClaimCodexWatcher({
    currentPrimaryId: 'fleet:stale-agent',
    agent: {
      id: 'fleet:stale-agent',
      session_id: '019ed438-c2ee-7f72-a2c4-9708b6f04679',
      session_ids: [],
    },
    jsonlPath: ownedPath,
    rolloutHasOwnerEvidence: hasOwner,
    rolloutBelongsToAgent: belongs,
  }), true)
})

test('first runtime liveness miss stays awake within hibernate grace', () => {
  const now = 10_000
  const graceMs = 120_000

  assert.deepEqual(decideMissingLiveness({ now, graceMs }), {
    alive: true,
    hibernate: false,
    since: now,
  })
})

test('liveness miss hibernates only after grace expires', () => {
  const graceMs = 120_000

  assert.deepEqual(decideMissingLiveness({
    now: 130_001,
    missingSince: 10_000,
    graceMs,
  }), {
    alive: false,
    hibernate: true,
    since: 10_000,
  })
})

test('already-hibernating agent remains hibernating on liveness miss', () => {
  assert.deepEqual(decideMissingLiveness({
    now: 10_000,
    missingSince: 5_000,
    graceMs: 120_000,
    alreadyHibernating: true,
  }), {
    alive: false,
    hibernate: true,
    since: 5_000,
  })
})

test('runtime liveness miss can hibernate immediately when process truth is required', () => {
  assert.deepEqual(decideMissingLiveness({
    now: 10_000,
    graceMs: 0,
  }), {
    alive: false,
    hibernate: true,
    since: 10_000,
  })
})

test('spawn startup detector catches unsupported Codex model transcript', () => {
  const pane = `
Codex CLI v0.52.0
Working directory: /Users/skip/work/tlda

Error: unsupported model "gpt-5" for this account. Try a supported model.
`

  const failure = detectSpawnStartupFailureTranscript(pane, { harness: 'codex' })
  assert.equal(failure?.code, 'codex-unsupported-model')
  assert.match(failure?.reason || '', /unsupported model "gpt-5"/)
  assert.match(failure?.snippet || '', /Codex CLI/)
})

test('spawn startup detector catches Goose wrong-provider startup transcript', () => {
  const pane = `
starting session | provider=deepseek model=deepseek/deepseek-v4-pro
Error: Unknown provider "deepseek"
goose failed to initialize provider
`

  const failure = detectSpawnStartupFailureTranscript(pane, { harness: 'goose' })
  assert.equal(failure?.code, 'goose-startup-error')
  assert.match(failure?.reason || '', /goose failed to initialize provider|Unknown provider/)
})
