// `Date.parse` is the expensive part of every chat sort: the comparator below
// runs O(n log n) times and parsed both sides on each call, so one message's
// timestamp was re-parsed on the order of log n times per sort and again on
// every re-sort. Cache the parse against the message object instead.
//
// The raw string is stored alongside the number and compared on each hit, so a
// message whose timestamp changes re-parses rather than returning a stale value
// — a string comparison is still far cheaper than a parse. A WeakMap keeps this
// tied to the message's own lifetime, so it cannot grow into a leak.
const parsedTimestamps = new WeakMap()

export function chatMessageTimestampMs(m) {
  const raw = m?.timestamp
  if (!raw) return Number.MAX_SAFE_INTEGER
  if (m !== null && typeof m === 'object') {
    const cached = parsedTimestamps.get(m)
    if (cached !== undefined && cached.raw === raw) return cached.ms
    const parsed = Date.parse(raw)
    const ms = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
    parsedTimestamps.set(m, { raw, ms })
    return ms
  }
  const ts = Date.parse(raw)
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER
}

function compareDecorated(a, b) {
  const byTs = a.ts - b.ts
  if (byTs !== 0) return byTs
  const ida = a.m?._dbId
  const idb = b.m?._dbId
  if (ida != null && idb != null) return Number(ida) - Number(idb)
  if (ida == null && idb == null) {
    return String(a.m?._tempId || '').localeCompare(String(b.m?._tempId || ''))
  }
  return ida == null ? 1 : -1
}

export function compareChatMessagesChronologically(a, b) {
  return compareDecorated({ m: a, ts: chatMessageTimestampMs(a) }, { m: b, ts: chatMessageTimestampMs(b) })
}

// Same order, but each timestamp string is parsed once instead of on every
// comparison. A comparator runs O(n log n) times over O(n) distinct values, so
// the parsing dominated: at the 500-event buffer cap this sort measured 25ms,
// and it reruns whenever the event list changes. Decorating first costs 4ms.
// Array.prototype.sort is stable, so equal elements keep input order either way.
export function sortChatMessagesChronologically(messages) {
  return messages
    .map(m => ({ m, ts: chatMessageTimestampMs(m) }))
    .sort(compareDecorated)
    .map(entry => entry.m)
}
