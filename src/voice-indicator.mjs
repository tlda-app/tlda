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
  if (label === 'speech detected') return 'receiving audio'
  return 'listening'
}

export class PcmBacklog {
  constructor() { this.chunks = [] }
  push(epoch, buffer) {
    if (Number.isInteger(epoch) && buffer instanceof ArrayBuffer && buffer.byteLength) {
      this.chunks.push({ epoch, buffer })
    }
  }
  drain(epoch, send) {
    const pending = this.chunks.filter(chunk => chunk.epoch === epoch)
    // Anything from another epoch is stale and can never be replayed.
    this.chunks = []
    for (let i = 0; i < pending.length; i++) {
      if (!send(pending[i].buffer)) {
        this.chunks.unshift(...pending.slice(i))
        return false
      }
    }
    return true
  }
  clear() { this.chunks = [] }
  get length() { return this.chunks.length }
}
