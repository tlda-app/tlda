# HELD — the unchecked codex kickoff in `spawnCodexSession`

**Status: written, NOT landed.** `chief-of-staff-3` authorised writing it and
explicitly held it, 2026-09-13: *"fixing it makes `enlist` throw where it
currently succeeds silently, and that is a live path."* Skip has been told it
exists and is held.

**Do not apply this without the chief's word.** It is tracked here rather than
left in a working directory because an uncommitted carrier is one `rm` from gone.

## What is wrong

`agent-launch/index.mjs`, in `spawnCodexSession` — the `--session` / `--enroll`
path, which is what `tlda agent enlist` runs:

```js
await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, enrolled: !!params.enroll }
```

**The return value is discarded.** `injectCodexPrompt` returns false when it
misses its deadline, having withdrawn the prompt from the composer on the way
out. This path then returns `ok: true`.

**Five of the six codex kickoff call sites check delivery.** This is the sixth.

**It did not cause the 15 husks found on 2026-09-13** — their `launch_recipe`s
carry no `enroll` or session key, so they came through the fresh-mint paths,
which do throw. This is a separate hole in the same wall.

## Why it is held rather than landed

Applying it makes `tlda agent enlist` **fail where it currently returns
success**. Anything that enlists a codex session on a loaded box — where the
60-second deadline is missed most often — starts erroring. That is a live path
and the behaviour change is the chief's call, not mine.

## The change

```diff
--- a/agent-launch/index.mjs
+++ b/agent-launch/index.mjs
@@ spawnCodexSession
   const launched = await (deps.spawnTmux || spawnTmux)(tmuxSession, cwd, cmd, { sendKeys, tmuxSocket: params.tmuxSocket, crashLogPath: params.crashLogPath })
   if (!launched) return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, alreadyAlive: true }
-  await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
+  const injected = await (deps.injectCodexPrompt || injectCodexPrompt)(tmuxSession, codex.kickoffPrompt(friendlyName), { tmuxSocket: params.tmuxSocket })
+  if (!injected) {
+    recordKickoffFailure(tmuxSession, params.crashLogPath, { name: friendlyName, fleet_id: fleetId, path: 'enlist' })
+    throw new SpawnError('launch-failed', `codex prompt injection did not reach ${tmuxSession}`, { fleetId, tmuxSession })
+  }
   return { ok: true, fleetId, tmuxSession, harness: 'codex', model, resumeId: sessionId, enrolled: !!params.enroll }
```

`recordKickoffFailure` is already imported in this file by the landed logging
change, so the diff above is complete as written.

## The test, showing both sides

The chief asked for both directions explicitly. Save as
`tests/enlist-codex-kickoff.test.mjs` when this lands:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

// Both sides of the same call site: a delivered kickoff must still return a
// normal enrolment, and an undelivered one must stop being reported as success.
// The first half is the control -- without it this is a rule that could fire on
// a healthy enlist and nobody would notice until it did.

test('enlist still succeeds when the kickoff is delivered', async () => {
  const result = await spawnCodexSessionUnderTest({ injectCodexPrompt: async () => true })
  assert.equal(result.ok, true)
  assert.equal(result.enrolled, true)
})

test('enlist fails instead of silently succeeding when the kickoff is not delivered', async () => {
  await assert.rejects(
    () => spawnCodexSessionUnderTest({ injectCodexPrompt: async () => false }),
    error => error?.code === 'launch-failed' && /did not reach/.test(error.message),
  )
})
```

**`spawnCodexSessionUnderTest` is not written.** `spawnCodexSession` is module-private
and reached through `runFleetSpawn`, and its `deps` bag already takes
`injectCodexPrompt` and `spawnTmux`, which is the seam — but it also scans a real
codex rollout file via `scanCodexRolloutIdentity(codexPath)`, so the harness needs a
rollout fixture or that scan injected too. **I have not built that**, and saying so
rather than shipping a test skeleton that looks runnable and is not.

**So this is held at: diff ready and verified by reading; test written as
intent, not yet executable.** Whoever lands it owes the harness.

## Related, and NOT in this patch

**Wiring `cleanupFailedFreshBinding` into the mint path** so a failed kickoff
tears its session down. That is the fix that would stop husks being created at
all — and it is with Skip, because it makes a launch failure end a being by
inference, against `DEATH IS A FLAG IN THE DATABASE`. Do not fold it in here.
