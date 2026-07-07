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
// Match ONLY the characters a real fleet id can contain — the union of both
// minters: hex from newFleetId() and sanitizeSessionName()'s `[A-Za-z0-9_-]`.
// A blacklist char class (anything-but-punctuation) captured markdown/template
// junk like ``Registered `fleet:<id>` `` and `Registered fleet:reconA\`` verbatim,
// writing `fleet:<id>\`` / `fleet:reconA\`` into the identity store. A whitelist
// stops at the first invalid char, so `fleet:<id>` yields no match (rejected) and
// a stray trailing backtick is dropped.
const REGISTERED_OWNER_RE = /Registered fleet:([A-Za-z0-9_-]+)/g
const REGISTERED_ID_RE = /Registered (fleet:[A-Za-z0-9_-]+)/g
const NAME_RE = /Your name: "([^"]+)"/

export function extractOwnersFromText(text) {
  const owners = new Set()
  REGISTERED_OWNER_RE.lastIndex = 0
  let m
  while ((m = REGISTERED_OWNER_RE.exec(text)) !== null) owners.add('fleet:' + m[1])
  return [...owners]
}

function textPartsFromValue(value) {
  const out = []
  function visit(item) {
    if (item == null) return
    if (typeof item === 'string') {
      out.push(item)
      return
    }
    if (Array.isArray(item)) {
      for (const part of item) visit(part)
      return
    }
    if (typeof item !== 'object') return
    if (typeof item.text === 'string') out.push(item.text)
    if (typeof item.output === 'string') out.push(item.output)
    if (typeof item.content === 'string') out.push(item.content)
    if (Array.isArray(item.content)) visit(item.content)
    if (item.Ok) visit(item.Ok)
    if (item.Err) visit(item.Err)
  }
  visit(value)
  return out
}

export function extractIdentityFromText(text) {
  REGISTERED_ID_RE.lastIndex = 0
  const m = REGISTERED_ID_RE.exec(text || '')
  if (!m) return null
  return {
    fleet_id: m[1],
    friendly_name: NAME_RE.exec(text || '')?.[1] || null,
  }
}

export function extractIdentityFromRecord(record) {
  if (!record || typeof record !== 'object') return null
  const texts = []
  if (record.toolUseResult) texts.push(...textPartsFromValue(record.toolUseResult))
  if (record.message?.content) texts.push(...textPartsFromValue(record.message.content))
  if (record.payload?.output) texts.push(...textPartsFromValue(record.payload.output))
  if (record.payload?.result) texts.push(...textPartsFromValue(record.payload.result))
  let identity = null
  for (const text of texts) {
    identity = extractIdentityFromText(text)
    if (identity) break
  }
  const cwd = record.cwd || record.payload?.cwd || record.payload?.session_meta?.cwd || record.payload?.sessionMeta?.cwd || null
  if (!identity && !cwd) return null
  return {
    ...(identity || {}),
    cwd,
  }
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

export function scanFileIdentitySync(filePath, { fromOffset = 0, chunkSize = 64 * 1024 } = {}) {
  let fd
  let offset = fromOffset
  let carry = ''
  let best = null
  const owners = new Set()
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(chunkSize)
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
      const text = carry + buf.toString('utf8', 0, bytesRead)
      for (const owner of extractOwnersFromText(text)) owners.add(owner)
      for (const line of text.split('\n')) {
        if (!line.includes('Registered fleet:') && !line.includes('"cwd"')) continue
        try {
          const rec = JSON.parse(line)
          const identity = extractIdentityFromRecord(rec)
          if (identity) {
            best = { ...(best || {}), ...identity }
            if (identity.fleet_id) owners.add(identity.fleet_id)
          }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e
          const identity = extractIdentityFromText(line)
          if (identity) {
            best = { ...(best || {}), ...identity }
            if (identity.fleet_id) owners.add(identity.fleet_id)
          }
        }
      }
      carry = text.slice(-1024)
    }
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
  return { identity: best, owners: [...owners], endOffset: offset }
}

// Read just the FIRST line of a file without loading the whole thing. Codex
// rollout files are multi-MB; reading the entire file (readFileSync) only to grab
// line 1 is the codex-side CPU/IO sink on daemon restart. Reads in chunks and stops
// at the first newline (or maxBytes).
export function readFirstLineSync(filePath, { chunkSize = 64 * 1024, maxBytes = 256 * 1024 } = {}) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(chunkSize)
    let acc = ''
    let read = 0
    while (read < maxBytes) {
      const n = fs.readSync(fd, buf, 0, buf.length, read)
      if (n <= 0) break
      read += n
      acc += buf.toString('utf8', 0, n)
      const nl = acc.indexOf('\n')
      if (nl !== -1) return acc.slice(0, nl)
    }
    return acc // no newline within maxBytes — return what we have
  } catch {
    return ''
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
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
