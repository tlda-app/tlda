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
 */
export function serverOwnerUpsertRow({ id, name, existing = null, now = new Date().toISOString() }) {
  return {
    id,
    friendly_name: name,
    human: true,
    dead: false,
    ...(existing ? {} : { labels: [] }),
    registered_at: now,
    last_seen: now,
  }
}
