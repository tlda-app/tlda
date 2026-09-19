/**
 * The agent row the server writes for its owner on every startup.
 *
 * `labels` belongs on the FIRST insert and must be absent on every start after
 * it. `upsertAgent` reads the key's presence as intent —
 * `hasOwnProperty(agent, 'labels')` — and the upsert writes
 * `labels = COALESCE(excluded.labels, agents.labels)`. An empty array is not
 * "no opinion": it serializes to `'[]'`, which is non-null, so COALESCE takes
 * it and REPLACES whatever the row held. Sending `labels: []` on every boot
 * therefore clears the owner's labels each time the server restarts, singleton
 * routing labels included.
 *
 * Omitting the key leaves `excluded.labels` null, and COALESCE keeps what is
 * already there. That is the whole fix, and it is why this returns an object
 * with the key conditionally rather than an array that is sometimes empty.
 *
 * `registered_at` is the same argument and was missed. It was written
 * unconditionally, so every restart reset the owner's registration date to the
 * moment the server came up — the column stopped meaning "when this identity
 * was created" and started meaning "when the server last started". Observed on
 * the live store: `fleet:skip` showed `registered_at 2026-09-19T21:26:30Z`,
 * which is the restart, visible as a burst of agent logins in the same second.
 * A human seeing their own account dated minutes ago reasonably concludes
 * something was done to their identity.
 *
 * `fleet:tlda` already does this correctly a few lines into unified-server —
 * `existing?.registered_at || new Date().toISOString()` — so this is that
 * existing rule applied to the row that was missing it, not a new one.
 */
export function serverOwnerUpsertRow({ id, name, existing = null, now = new Date().toISOString() }) {
  return {
    id,
    friendly_name: name,
    human: true,
    dead: false,
    ...(existing ? {} : { labels: [] }),
    registered_at: existing?.registered_at || now,
    last_seen: now,
  }
}
