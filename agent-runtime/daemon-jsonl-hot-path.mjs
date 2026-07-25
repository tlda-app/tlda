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
// login lines — the fingerprint the daemon uses to learn which agent owns a
// session. Older Claude transcripts say `Registered fleet:<id>`; current Codex
// MCP login output says `Logged in fleet:<id>`. Extract every fleet id mentioned
// that way.
// Match ONLY the characters a real fleet id can contain — the union of both
// minters: hex from newFleetId() and sanitizeSessionName()'s `[A-Za-z0-9_-]`.
// A blacklist char class (anything-but-punctuation) captured markdown/template
// junk like ``Registered `fleet:<id>` `` and `Registered fleet:reconA\`` verbatim,
// writing `fleet:<id>\`` / `fleet:reconA\`` into the identity store. A whitelist
// stops at the first invalid char, so `fleet:<id>` yields no match (rejected) and
// a stray trailing backtick is dropped.
const LOGIN_OWNER_RE = /(?:Registered|Logged in) fleet:([A-Za-z0-9_-]+)/g
const LOGIN_ID_RE = /(?:Registered|Logged in) (fleet:[A-Za-z0-9_-]+)/g
const NAME_RE = /Your name: "([^"]+)"/
export const TLDA_LOGIN_MARKER_PREFIX = 'TLDA_LOGIN_MARKER '

function cleanString(value) {
  const text = String(value || '').trim()
  return text || null
}

export function normalizeLoginMarker(input = {}) {
  const mintId = cleanString(input.mint_id || input.local_agent_id || input.localAgentId)
  const daemonKey = cleanString(input.daemon_key || input.daemonKey)
  const machineId = cleanString(input.machine_id || input.machineId)
  const envName = cleanString(input.env_name || input.envName)
  const fleetId = cleanString(input.fleet_id || input.fleetId)
  return {
    type: 'tlda-login-marker',
    version: 1,
    ...(mintId ? { mint_id: mintId } : {}),
    ...(daemonKey ? { daemon_key: daemonKey } : {}),
    ...(machineId ? { machine_id: machineId } : {}),
    ...(envName ? { env_name: envName } : {}),
    ...(fleetId ? { fleet_id: fleetId } : {}),
    ...(cleanString(input.friendly_name || input.friendlyName) ? { friendly_name: cleanString(input.friendly_name || input.friendlyName) } : {}),
    ...(cleanString(input.session_id || input.sessionId) ? { session_id: cleanString(input.session_id || input.sessionId) } : {}),
    ...(cleanString(input.harness_kind || input.harnessKind || input.kind) ? { harness_kind: cleanString(input.harness_kind || input.harnessKind || input.kind) } : {}),
    ...(cleanString(input.tmux_session || input.tmuxSession) ? { tmux_session: cleanString(input.tmux_session || input.tmuxSession) } : {}),
    ...(cleanString(input.cwd) ? { cwd: cleanString(input.cwd) } : {}),
    ...(cleanString(input.model) ? { model: cleanString(input.model) } : {}),
  }
}

export function formatLoginMarker(input = {}) {
  return `${TLDA_LOGIN_MARKER_PREFIX}${JSON.stringify(normalizeLoginMarker(input))}`
}

export function extractLoginMarkerFromText(text) {
  const raw = String(text || '')
  const idx = raw.indexOf(TLDA_LOGIN_MARKER_PREFIX)
  if (idx === -1) return null
  const after = raw.slice(idx + TLDA_LOGIN_MARKER_PREFIX.length)
  const line = after.split(/\r?\n/, 1)[0]?.trim()
  if (!line) return null
  try {
    const parsed = JSON.parse(line)
    if (parsed?.type !== 'tlda-login-marker') return null
    return normalizeLoginMarker(parsed)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export function extractOwnersFromText(text) {
  const owners = new Set()
  LOGIN_OWNER_RE.lastIndex = 0
  let m
  while ((m = LOGIN_OWNER_RE.exec(text)) !== null) owners.add('fleet:' + m[1])
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
  const marker = extractLoginMarkerFromText(text)
  if (marker) {
    return {
      ...(marker.fleet_id ? { fleet_id: marker.fleet_id } : {}),
      ...(marker.friendly_name ? { friendly_name: marker.friendly_name } : {}),
      marker,
    }
  }
  LOGIN_ID_RE.lastIndex = 0
  const m = LOGIN_ID_RE.exec(text || '')
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
    ...(cwd ? { cwd } : {}),
  }
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
