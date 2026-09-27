/**
 * syncBlockView: when the document canvas says anything about a sync that
 * has not finished. tldraw owns the first seconds (its loader); the error
 * screen owns status 'error'; the offline badge owns synced-remote + offline.
 * Everything else unsynced gets silence, then reassurance, then the blocked
 * state with the one safe action.
 */

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const { syncBlockView, SYNC_BLOCK_WAIT_MS, SYNC_BLOCK_BLOCKED_MS } = await import('./syncBlockState')

// Thresholds are what the copy promises: reassurance at 15s, blocked at 30s.
equal(SYNC_BLOCK_WAIT_MS, 15_000, 'wait threshold')
equal(SYNC_BLOCK_BLOCKED_MS, 30_000, 'blocked threshold')

// Owned elsewhere at every elapsed time, including forever.
for (const status of ['synced-remote', 'error']) {
  equal(syncBlockView(status, 0), null, `${status} at 0`)
  equal(syncBlockView(status, 29_999), null, `${status} at 29.999s`)
  equal(syncBlockView(status, 600_000), null, `${status} at 10min`)
}

// Unsynced statuses share the clock: silence, then waiting, then blocked.
for (const status of ['loading', 'synced-local', 'offline']) {
  equal(syncBlockView(status, 0), null, `${status} silent at 0`)
  equal(syncBlockView(status, 14_999), null, `${status} silent at 14.999s`)
  equal(syncBlockView(status, 15_000), 'waiting', `${status} waiting at 15s`)
  equal(syncBlockView(status, 29_999), 'waiting', `${status} waiting at 29.999s`)
  equal(syncBlockView(status, 30_000), 'blocked', `${status} blocked at 30s`)
  equal(syncBlockView(status, 600_000), 'blocked', `${status} blocked at 10min`)
}

console.log('syncBlockState: 26/26 ok')
