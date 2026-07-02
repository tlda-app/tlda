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
