import fs from 'fs'

export function createJsonlReadCoalescer({
  readNow,
  delayMs = 100,
  maxDelayMs = 300,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof readNow !== 'function') throw new TypeError('readNow is required')
  const pending = new Map()

  function flush(key) {
    const state = pending.get(key)
    if (!state) return
    pending.delete(key)
    if (state.timer) clearTimer(state.timer)
    readNow(...state.args)
  }

  function schedule(key, ...args) {
    const ts = now()
    let state = pending.get(key)
    if (!state) {
      state = { firstAt: ts, timer: null, args }
      pending.set(key, state)
    } else {
      state.args = args
    }

    if (ts - state.firstAt >= maxDelayMs) {
      flush(key)
      return
    }

    if (state.timer) clearTimer(state.timer)
    state.timer = setTimer(() => flush(key), delayMs)
  }

  function cancel(key) {
    const state = pending.get(key)
    if (!state) return
    if (state.timer) clearTimer(state.timer)
    pending.delete(key)
  }

  return { schedule, flush, cancel, pendingCount: () => pending.size }
}

export function createOncePerKeyGate() {
  const seen = new Set()
  return {
    claim(key) {
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
    has(key) {
      return seen.has(key)
    },
  }
}

// A session JSONL contains one (or, if something rotated through it, several)
// `Registered fleet:<id>` lines — the fingerprint the daemon uses to learn which
// agent owns a session. Extract every fleet id mentioned that way.
const REGISTERED_OWNER_RE = /Registered fleet:([^\s.,;:)"'\\]+)/g
export function extractOwnersFromText(text) {
  const owners = new Set()
  REGISTERED_OWNER_RE.lastIndex = 0
  let m
  while ((m = REGISTERED_OWNER_RE.exec(text)) !== null) owners.add('fleet:' + m[1])
  return [...owners]
}

// Chunk-scan a file (optionally from a byte offset) collecting every owner id,
// WITHOUT loading the whole file into one string. Returns the owners found in the
// scanned range plus the byte offset scanned to (EOF). This is the one read that
// classifies a session; after it, the caller caches `owners` and never re-reads.
export function scanFileOwnersSync(filePath, { fromOffset = 0, chunkSize = 64 * 1024 } = {}) {
  const owners = new Set()
  let fd
  let offset = fromOffset
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(chunkSize)
    // Carry the tail of each chunk so a marker split across a chunk boundary is
    // still matched. The marker phrase is short, so a small carry suffices.
    let carry = ''
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
      const text = carry + buf.toString('utf8', 0, bytesRead)
      for (const o of extractOwnersFromText(text)) owners.add(o)
      carry = text.slice(-64)
    }
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
  return { owners: [...owners], endOffset: offset }
}

// Decide whether a session file needs a full search-index backfill for `fleetId`,
// classifying it (learning its owners) AT MOST ONCE. `entry` is the cursor entry
// (or undefined). `scan()` runs the one-time owner scan and returns { owners }.
// The whole point: a session already classified (or already search-backfilled) is
// answered WITHOUT calling scan() — that's what stops the O(files × spawns) re-read.
export function decideSessionBackfill(entry, fleetId, scan) {
  if (entry?.searchBackfilled) {
    return { owners: entry.owners || [], shouldBackfill: false, didScan: false }
  }
  let owners = entry?.owners || []
  let didScan = false
  if (!entry?.classified) {
    owners = scan().owners
    didScan = true
  }
  return { owners, shouldBackfill: owners.includes(fleetId), didScan }
}

export function fileContainsUtf8MarkerSync(filePath, marker, { chunkSize = 64 * 1024 } = {}) {
  const markerBuf = Buffer.from(marker, 'utf8')
  if (markerBuf.length === 0) return true

  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(chunkSize)
    let carry = Buffer.alloc(0)
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null)
      if (bytesRead <= 0) return false
      const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
      const haystack = carry.length ? Buffer.concat([carry, chunk]) : chunk
      if (haystack.indexOf(markerBuf) !== -1) return true
      const carryLen = Math.min(markerBuf.length - 1, haystack.length)
      carry = carryLen > 0 ? Buffer.from(haystack.subarray(haystack.length - carryLen)) : Buffer.alloc(0)
    }
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}
