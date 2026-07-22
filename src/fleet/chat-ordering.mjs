export function chatMessageTimestampMs(m) {
  const ts = m?.timestamp ? Date.parse(m.timestamp) : NaN
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
