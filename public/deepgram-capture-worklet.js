// deepgram-capture-worklet.js — AudioWorklet processor for Deepgram mic capture.
//
// Runs on the audio rendering thread. Reads mono mic input, downsamples from the
// context sample rate to 16 kHz (Deepgram's configured rate), converts Float32
// [-1,1] to Int16 linear-PCM, and posts the raw ArrayBuffer to the main thread,
// which relays it to the bridge over the WebSocket.
//
// Replaces the deprecated ScriptProcessorNode (src/voice.mjs). Unlike that node,
// a worklet does not need to be connected to the destination to run, so the
// caller drops the zero-gain / output-zeroing apparatus entirely.
//
// `sampleRate` is a global in AudioWorkletGlobalScope (the context's rate).

const TARGET_SR = 16000

class DeepgramCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Fractional read position carried across process() calls so nearest-neighbor
    // downsampling stays continuous across 128-sample render quanta (no clicks at
    // frame boundaries, no drift).
    this._phase = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch || ch.length === 0) return true

    const ratio = sampleRate / TARGET_SR
    // Nearest-neighbor downsample with the carried phase.
    const out = []
    let phase = this._phase
    while (phase < ch.length) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(phase)]))
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff)
      phase += ratio
    }
    this._phase = phase - ch.length // carry remainder into the next quantum

    if (out.length) {
      const int16 = new Int16Array(out)
      // Transfer the buffer (zero-copy) to the main thread.
      this.port.postMessage(int16.buffer, [int16.buffer])
    }
    return true // keep the processor alive
  }
}

registerProcessor('deepgram-capture', DeepgramCaptureProcessor)
