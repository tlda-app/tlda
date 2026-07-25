export function pcmInputLevel(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) return 0
  const samples = new Int16Array(buffer)
  let sumSquares = 0
  for (const sample of samples) {
    const normalized = sample / 32768
    sumSquares += normalized * normalized
  }
  return Math.min(1, Math.sqrt(sumSquares / samples.length) * 4)
}

export function voiceIndicatorState(recording, healthLabel) {
  if (!recording) return 'off'
  const label = healthLabel || ''
  if (label.includes('reconnecting') || label.includes('restarting') || label.includes('recovering') ||
      label.includes('connection lost') || label.includes('connecting') ||
      label.includes('recognizer idle') || label.includes('recognizer unavailable') ||
      label.includes('waiting for recognizer') || label.includes('mic failed') ||
      label.includes('mic unavailable') || label === 'no mic input' ||
      label === 'starting voice') return 'reconnecting'
  // These two strings are the steady states Skip sits in while dictating, and they are
  // rendered as visible text — showRecordingHud() builds `${voiceStatusLabel()} -> ${who}`
  // and centers it in a fixed-width row. So the WIDTH of these words is part of the
  // design, not a cosmetic detail: both are 8 characters, which is why the panel holds
  // still while he works.
  //
  // They were renamed to 'receiving audio' (15) and 'listening' (9) in b82f6e84 — a pure
  // rename riding inside a real reliability fix, states and logic untouched. Centered
  // text of different lengths shifts on every transition, so the panel strobed in his
  // face while he read. His words: "the persistent flickering between receiving and
  // listening, it's just nausea." 'listening' was invented; the app never had it.
  //
  // DO NOT "improve" this wording. If you change either string, match the other's
  // width, or the panel starts moving again.
  if (label === 'speech detected') return 'speaking'
  return 'mic live'
}

export function composeVoiceText(left, interim, right) {
  return `${left || ''}${interim || ''}${right || ''}`
}

export function partitionAtCursor(value, selectionStart, selectionEnd = selectionStart) {
  const text = typeof value === 'string' ? value : ''
  const start = Number.isFinite(selectionStart) ? Math.max(0, Math.min(text.length, selectionStart)) : text.length
  const end = Number.isFinite(selectionEnd) ? Math.max(start, Math.min(text.length, selectionEnd)) : start
  return { left: text.slice(0, start), interim: '', right: text.slice(end), cursor: start }
}

export function deliverVoiceComposition(textarea, composition, write) {
  const beforeLength = typeof textarea?.value === 'string' ? textarea.value.length : 0
  const connectedBefore = textarea?.isConnected === true
  const text = composeVoiceText(composition?.left, composition?.interim, composition?.right)
  if (!connectedBefore) {
    return { connectedBefore, connectedAfter: false, beforeLength, afterLength: beforeLength, written: false }
  }
  write(textarea, text)
  const connectedAfter = textarea.isConnected === true
  const afterLength = typeof textarea.value === 'string' ? textarea.value.length : 0
  return {
    connectedBefore,
    connectedAfter,
    beforeLength,
    afterLength,
    written: connectedAfter && textarea.value === text,
  }
}

export class PcmBacklog {
  constructor({ maxBytes = 16000 * 2 * 3, maxAgeMs = 3000 } = {}) {
    this.chunks = []
    this.maxBytes = maxBytes
    this.maxAgeMs = maxAgeMs
    this.bytes = 0
    this.dropped = 0
    this.flushed = 0
  }
  _dropAt(index) {
    const [chunk] = this.chunks.splice(index, 1)
    if (!chunk) return null
    this.bytes = Math.max(0, this.bytes - chunk.buffer.byteLength)
    this.dropped++
    return chunk
  }
  _prune(now = Date.now()) {
    if (this.maxAgeMs > 0) {
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        if (now - this.chunks[i].queuedAt > this.maxAgeMs) this._dropAt(i)
      }
    }
    while (this.maxBytes > 0 && this.bytes > this.maxBytes && this.chunks.length) {
      this._dropAt(0)
    }
  }
  push(epoch, buffer) {
    if (Number.isInteger(epoch) && buffer instanceof ArrayBuffer && buffer.byteLength) {
      this.chunks.push({ epoch, buffer, queuedAt: Date.now() })
      this.bytes += buffer.byteLength
      this._prune()
    }
  }
  drain(epoch, send) {
    this._prune()
    const pending = this.chunks.filter(chunk => chunk.epoch === epoch)
    // Anything from another epoch is stale and can never be replayed.
    const stale = this.chunks.filter(chunk => chunk.epoch !== epoch)
    this.dropped += stale.length
    this.chunks = []
    this.bytes = 0
    for (let i = 0; i < pending.length; i++) {
      if (!send(pending[i].buffer)) {
        this.chunks.unshift(...pending.slice(i))
        this.bytes = this.chunks.reduce((sum, chunk) => sum + chunk.buffer.byteLength, 0)
        return false
      }
      this.flushed++
    }
    return true
  }
  clear() {
    this.chunks = []
    this.bytes = 0
  }
  snapshot(now = Date.now()) {
    this._prune(now)
    return {
      frames: this.chunks.length,
      bytes: this.bytes,
      oldestAgeMs: this.chunks.length ? Math.max(0, now - this.chunks[0].queuedAt) : null,
      droppedFrames: this.dropped,
      flushedFrames: this.flushed,
      maxBytes: this.maxBytes,
      maxAgeMs: this.maxAgeMs,
    }
  }
  get length() { return this.chunks.length }
}
