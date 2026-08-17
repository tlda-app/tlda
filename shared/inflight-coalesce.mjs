// Coalesce concurrent/retried calls that share a key onto one in-flight
// promise. A caller whose client-side wait timed out (e.g.
// FLEET_DURABLE_SEND_DEADLINE_MS) but whose durable-send outbox keeps the
// same operation_id across retries must not cause the underlying work to run
// twice while the first attempt is still in progress -- only completed
// results are safe to re-derive from storage (a DB check), because nothing
// marks "in flight" until the work finishes. This fills that gap.
//
// The check-then-set is synchronous (no `await` between reading and writing
// `map`), so within one process it is race-free regardless of how many
// callers arrive back-to-back on the event loop.
export function coalesceInflight(map, key, run) {
  if (!key) return run()
  const existing = map.get(key)
  if (existing) return existing
  const promise = run()
  map.set(key, promise)
  promise.catch(() => {}).finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  return promise
}
