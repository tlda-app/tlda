// How long an agent was away is a fold over runtime-status spans, not a read of
// `agents.last_seen`.
//
// `last_seen` is rewritten on the way back in, BEFORE the returning agent calls
// `login()`, so by the time the notice is computed the absence it is supposed to
// report has already been erased. Measured 2026-09-12 on two agents: one
// hibernated ~8 minutes and was told "1 minute"; one hibernated ~6 minutes and
// was told NOTHING, because the 60s "did it really go away" gate was comparing
// against the same rewritten column.
//
// So the case that matters here is not "does it read the span" but "does the
// span still win once `last_seen` says the agent was here a moment ago". That is
// the state every woken agent is actually in, and it is the one a test written
// from the happy path would miss.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

const AGENT = 'fleet:away-duration'

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-away-duration-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    await store.upsertAgent({
      id: AGENT,
      friendly_name: 'away-duration',
      labels: [],
      registered_at: new Date(Date.now() - 86_400_000).toISOString(),
      last_seen: new Date(Date.now() - 86_400_000).toISOString(),
    })
    await fn(store)
  } finally {
    await store.close()
    removeTempDir(dir)
  }
}

const iso = msAgo => new Date(Date.now() - msAgo).toISOString()

test('the hibernating span survives a `last_seen` rewritten by the wake', async () => {
  await withStore(async store => {
    const wentAway = iso(6 * 60_000)
    store.recordRuntimeState(AGENT, { kind: 'ai', status: 'hibernating' }, wentAway)

    // The wake path, reproducing the state every returning agent is in: the
    // column says "seen a moment ago" while the agent was away six minutes.
    await store.upsertAgent({ id: AGENT, last_seen: new Date().toISOString() })

    const since = store.lastRuntimeStatusSince(AGENT, 'hibernating')
    assert.equal(since, wentAway,
      'the span must answer the away question even though `last_seen` was just rewritten')

    const awayMs = Date.now() - Date.parse(since)
    assert.ok(awayMs > 5 * 60_000,
      `six minutes away must read as six minutes, got ${Math.round(awayMs / 1000)}s`)
    // The 60s gate that suppressed the notice entirely on the measured agent.
    assert.ok(awayMs >= 60_000, 'a six-minute absence must clear the "did it really go away" gate')
  })
})

// The counterfactual. Reading `last_seen` is what the code did before, so a test
// that only asserts the span is right passes just as happily against the old
// behaviour when the fixture's two clocks agree. Here they disagree by design,
// and the old read gives an answer that would re-suppress the notice.
test('CONTROL: reading `last_seen` instead gives the wrong answer on the same fixture', async () => {
  await withStore(async store => {
    store.recordRuntimeState(AGENT, { kind: 'ai', status: 'hibernating' }, iso(6 * 60_000))
    await store.upsertAgent({ id: AGENT, last_seen: new Date().toISOString() })

    const agent = await store.getAgent(AGENT)
    const byLastSeen = Date.now() - Date.parse(agent.last_seen)
    assert.ok(byLastSeen < 60_000,
      'the old source reads as "not away at all" here -- which is exactly why the notice vanished')
  })
})

// `dead` is the other status the notice is computed for ("you were killed N
// ago"), and it must not be answered with the hibernating span.
test('each status is answered by its own span', async () => {
  await withStore(async store => {
    store.recordRuntimeState(AGENT, { kind: 'ai', status: 'hibernating' }, iso(30 * 60_000))
    store.recordRuntimeState(AGENT, { kind: 'ai', status: 'awake' }, iso(20 * 60_000))
    store.recordRuntimeState(AGENT, { kind: 'ai', status: 'dead' }, iso(10 * 60_000))

    const hib = Date.parse(store.lastRuntimeStatusSince(AGENT, 'hibernating'))
    const dead = Date.parse(store.lastRuntimeStatusSince(AGENT, 'dead'))
    assert.ok(Math.abs((Date.now() - hib) - 30 * 60_000) < 5_000, 'hibernating span is the 30m one')
    assert.ok(Math.abs((Date.now() - dead) - 10 * 60_000) < 5_000, 'dead span is the 10m one')
    assert.notEqual(hib, dead, 'the two statuses must not collapse onto one span')
  })
})

test('an agent that has never hibernated has no span, and falls back', async () => {
  await withStore(async store => {
    assert.equal(store.lastRuntimeStatusSince(AGENT, 'hibernating'), null,
      'a fresh agent must answer null rather than inventing an absence')
  })
})
