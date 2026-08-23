import { readdirSync, rmSync } from 'node:fs'

// Teardown for a test's own temp directory.
//
// `rmSync(dir, { recursive: true, force: true })` is copied verbatim into 38
// test files here, and it intermittently throws ENOTEMPTY — a directory that
// gained an entry between the readdir and the rmdir, i.e. something was still
// writing after the test believed it had stopped everything. The failure lands
// in the `finally` block, AFTER the assertions passed, so a green test is
// reported as a failure. A red that means nothing is how a real one gets waved
// through, and this file sits in front of the notification path.
//
// **What I could not establish, stated because the next person will otherwise
// re-derive it.** The obvious candidate was `FleetStore.close()`, which is
// async and is called without `await` at 83 sites — the promise is dropped, so
// the SQLite worker's close and `terminate()` can outlive the call. That is a
// real bug and it is fixed separately. **It is not this bug:** 15 trials with
// the close unawaited and 15 with it awaited produced zero failed removals
// either way. The writer is something else and I did not identify it.
//
// So this does two things and claims only what it does:
//
//   1. Retries, which is Node's own documented remedy for exactly this class
//      (ENOTEMPTY/EBUSY/EPERM on rm) and is correct whichever writer is lagging.
//   2. If it still cannot remove the directory, says WHAT WAS IN IT. The
//      original failure was `ENOTEMPTY` and a path, which names the symptom and
//      hides the evidence — with the entries listed, whoever hits it next has
//      the culprit instead of a hypothesis.
const MAX_RETRIES = 20
const RETRY_DELAY_MS = 50

export function removeTempDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: MAX_RETRIES, retryDelay: RETRY_DELAY_MS })
  } catch (e) {
    let survivors = '(could not read the directory)'
    try { survivors = readdirSync(dir, { recursive: true }).join(', ') || '(empty)' } catch { /* reported as unreadable */ }
    throw new Error(
      `temp dir teardown failed after ${MAX_RETRIES} retries over ~${MAX_RETRIES * RETRY_DELAY_MS}ms: ` +
      `${e.code || e.message} at ${dir}. Something is still writing here. Surviving entries: ${survivors}`,
    )
  }
}
