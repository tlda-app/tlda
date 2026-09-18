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

export function compareChatMessagesChronologically(a, b) {
  const byTs = chatMessageTimestampMs(a) - chatMessageTimestampMs(b)
  if (byTs !== 0) return byTs
  const ida = a?._dbId
  const idb = b?._dbId
  if (ida != null && idb != null) return Number(ida) - Number(idb)
  if (ida == null && idb == null) {
    return String(a?._tempId || '').localeCompare(String(b?._tempId || ''))
  }
  return ida == null ? 1 : -1
}
