export function createRuntimeErrorCardFanin({ docNameFromData, emit, onError = () => {}, now = () => Date.now(), windowMs = 24 * 60 * 60 * 1000 }) {
  const seen = new Map()

  return function recordRuntimeError(entry) {
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : {}
    const kind = entry?.ns === 'doc-capability' ? 'capability' : 'runtime'
    if (kind === 'capability' && (!Array.isArray(data.broken) || data.broken.length === 0)) return false
    const error = typeof entry?.msg === 'string' && entry.msg
      ? entry.msg
      : kind === 'capability' ? `document capability failed: ${data.broken.join(', ')}` : null
    if (!error) return false
    const docName = docNameFromData(data)
    if (!docName) return false
    const key = `${docName}\u0000${kind}\u0000${error}`
    const timestamp = now()
    const last = seen.get(key)
    if (last && timestamp - last < windowMs) return false
    seen.set(key, timestamp)
    if (seen.size > 5_000) {
      for (const [seenKey, seenAt] of seen) {
        if (timestamp - seenAt >= windowMs) seen.delete(seenKey)
        if (seen.size <= 4_000) break
      }
    }
    const page = typeof data.url === 'string' ? data.url.split('?')[0].split('/').slice(-2).join('/') : null
    Promise.resolve().then(() => emit(docName, error, page, kind)).catch(onError)
    return true
  }
}
