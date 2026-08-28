#!/usr/bin/env node
/**
 * **A confirmation that never arrives is re-asked. Nothing else is redone.**
 *
 * `project link` puts a project's history on the server and waits to be told it
 * landed. When that answer went missing, the whole link failed, the CLI's retry
 * ran the whole command again, and the seed was rebuilt from scratch —
 * `git archive`, `tar -xf`, a filtered repository in a temp dir — and pushed
 * again, per lost answer.
 *
 * Measured 2026-08-27 against a server whose store queue was saturated
 * (`fleetStoreQueue` maxDepth 128, waits of ~88s, against a 15s reply timeout):
 * one `project link` did six full seed-and-push cycles in eleven minutes and
 * never succeeded, with several such commands running at once. The retry was
 * generating server work for the queue that was eating its confirmations.
 *
 * So the property is about what does NOT happen: the expensive halves run once,
 * however many answers go missing. Counting the cheap retry is not enough —
 * a version that re-asks correctly while also re-pushing would pass that and
 * still be the bug.
 */
import assert from 'node:assert/strict'
import { seedAndConfirmHistory, HISTORY_ADOPTION_CONFIRM_ATTEMPTS } from '../daemon/shadow-mirror.mjs'

const quiet = { warn() {}, info() {}, error() {} }
const seed = (over = {}) => ({ empty: false, head: 'a'.repeat(40), repositoryDir: '/tmp/x', ...over })

// --- The whole point: answers go missing, the expensive work still runs once ---
{
  const state = { prepare: 0, push: 0, confirm: 0 }
  await assert.rejects(
    seedAndConfirmHistory({
      project: 'probe',
      log: quiet,
      prepareSeed: async () => { state.prepare++; return seed() },
      pushSeed: async () => { state.push++; return { ref: 'refs/seed/abc' } },
      confirmAdoption: async () => {
        state.confirm++
        throw new Error('daemon request timed out: adopt-shadow-history-ref')
      },
    }),
    /timed out/,
    'a confirmation that never arrives still fails the link',
  )
  assert.equal(state.prepare, 1, `the seed is built ONCE, not once per lost answer (built ${state.prepare} times)`)
  assert.equal(state.push, 1, `the seed is pushed ONCE, not once per lost answer (pushed ${state.push} times)`)
  assert.equal(state.confirm, HISTORY_ADOPTION_CONFIRM_ATTEMPTS,
    `and the cheap half is what gets re-asked (asked ${state.confirm} times)`)
}

// --- Counterfactual: make it fail on purpose. A version that rebuilds is caught ---
{
  // This is the OLD shape: one ask, and the caller retries the whole thing.
  const state = { prepare: 0, push: 0 }
  const oldShape = async () => {
    state.prepare++
    state.push++
    throw new Error('daemon request timed out: adopt-shadow-history-ref')
  }
  for (let i = 0; i < HISTORY_ADOPTION_CONFIRM_ATTEMPTS; i++) await oldShape().catch(() => {})
  assert.equal(state.prepare, HISTORY_ADOPTION_CONFIRM_ATTEMPTS,
    'control: the behaviour this test exists to forbid does trip the assertion above')
  assert.notEqual(state.prepare, 1, 'control: so a passing result above is not vacuous')
}

// --- A late answer is still an answer: it succeeds without rebuilding ---
{
  const state = { prepare: 0, push: 0, confirm: 0, cleanup: 0 }
  const result = await seedAndConfirmHistory({
    project: 'probe',
    log: quiet,
    prepareSeed: async () => { state.prepare++; return seed({ cleanup: async () => { state.cleanup++ } }) },
    pushSeed: async () => { state.push++; return { ref: 'refs/seed/abc' } },
    confirmAdoption: async () => {
      state.confirm++
      if (state.confirm < 3) throw new Error('daemon request timed out: adopt-shadow-history-ref')
      return { ok: true, versions: 7 }
    },
  })
  assert.equal(result.seeded, true, 'a confirmation on the third ask links the project')
  assert.equal(state.prepare, 1, 'without rebuilding the seed')
  assert.equal(state.push, 1, 'and without pushing it again')
  assert.equal(state.cleanup, 1, 'and the temp seed is cleaned up exactly once')
}

// --- An ANSWER is definitive. A negative one is not re-asked ---
{
  let confirms = 0
  await assert.rejects(
    seedAndConfirmHistory({
      project: 'probe',
      log: quiet,
      prepareSeed: async () => seed(),
      pushSeed: async () => ({ ref: 'refs/seed/abc' }),
      confirmAdoption: async () => { confirms++; return { ok: false, error: 'invalid history seed ref' } },
    }),
    /did not confirm its history/,
    'a refusal fails the link',
  )
  assert.equal(confirms, 1,
    'and is asked ONCE — re-asking a server that answered cannot change its answer')
}

// --- versions:0 is NOT a failure signal, and must not fail the link ---
{
  // `listVersions` drops commits messaged exactly `init` after applying its
  // limit, so a repository whose newest commit is `init` — an ordinary first
  // commit — adopts correctly and is reported as 0. Measured 2026-08-27 on a
  // disposable repo committed with `-m init`. Gating on this number re-breaks
  // what `adoptShadowHistoryRef` deliberately avoids by checking HEAD instead.
  const result = await seedAndConfirmHistory({
    project: 'probe',
    log: quiet,
    prepareSeed: async () => seed(),
    pushSeed: async () => ({ ref: 'refs/seed/abc' }),
    confirmAdoption: async () => ({ ok: true, versions: 0 }),
  })
  assert.equal(result.seeded, true,
    'a confirmed adoption reporting 0 versions is an ordinary `init`-named history, not a loss')
}

// --- A source with no history never asks at all ---
{
  let pushes = 0
  let confirms = 0
  const result = await seedAndConfirmHistory({
    project: 'probe',
    log: quiet,
    prepareSeed: async () => ({ empty: true }),
    pushSeed: async () => { pushes++; return { ref: 'x' } },
    confirmAdoption: async () => { confirms++; return { ok: true, versions: 0 } },
  })
  assert.equal(result.seeded, false, 'a paper that has never been built has no history to seed')
  assert.equal(pushes, 0, 'nothing is pushed')
  assert.equal(confirms, 0, 'and nothing is asked')
}

console.log('a-lost-confirmation-does-not-rebuild-the-seed: all assertions passed')
