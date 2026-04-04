/**
 * clickDetect.ts — Web Audio transient detector for tongue clicks and lip pops.
 *
 * Runs a parallel pipeline alongside speech recognition (no interference).
 * Detects two distinct non-speech sounds:
 *   - Tongue click (alveolar "tck"): broadband sharp transient, fast attack
 *   - Lip pop (bilabial): lower-frequency transient
 *
 * Emits:
 *   'click'   — single tongue click
 *   'dblclick' — two tongue clicks within DOUBLE_CLICK_MS
 *   'enter'   — lip pop
 *
 * Usage:
 *   const cd = createClickDetector()
 *   await cd.start()
 *   cd.on('click', () => { ... })
 *   cd.on('dblclick', () => { ... })
 *   cd.on('enter', () => { ... })
 *   cd.stop()
 */

export type ClickEvent = 'click' | 'dblclick' | 'enter'

export interface ClickDetectorOptions {
  doubleClickMs?: number   // window for double-click detection (default: 300)
  cooldownMs?: number      // ignore events within this window after a detected event (default: 100)
  clickThreshold?: number  // amplitude threshold for tongue click (default: 0.002)
  popThreshold?: number    // amplitude threshold for lip pop (default: 0.002)
}

// Tongue click: energy concentrated in high frequencies (>2kHz), very fast attack
// Lip pop: energy concentrated in low frequencies (<800Hz), slightly slower
const TONGUE_CLICK_LOW_BAND = 2000   // Hz, lower bound of tongue click detection
const LIP_POP_HIGH_BAND = 800        // Hz, upper bound of lip pop detection

export function createClickDetector(options: ClickDetectorOptions = {}) {
  const doubleClickMs = options.doubleClickMs ?? 300
  const cooldownMs = options.cooldownMs ?? 400
  const clickThreshold = options.clickThreshold ?? 0.002
  const popThreshold = options.popThreshold ?? 0.002

  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null
  let rafId: number | null = null

  const handlers: Map<ClickEvent, Array<() => void>> = new Map([
    ['click', []],
    ['dblclick', []],
    ['enter', []],
  ])

  let lastClickTime = 0
  let pendingClick = false
  let pendingClickTimer: ReturnType<typeof setTimeout> | null = null
  let lastEventTime = 0

  function emit(event: ClickEvent) {
    for (const fn of handlers.get(event) ?? []) fn()
  }

  function handleTongueClick() {
    const now = performance.now()
    if (now - lastEventTime < cooldownMs) return
    lastEventTime = now

    if (pendingClick && now - lastClickTime < doubleClickMs) {
      // Double click
      if (pendingClickTimer) { clearTimeout(pendingClickTimer); pendingClickTimer = null }
      pendingClick = false
      emit('dblclick')
    } else {
      // Start waiting for possible second click
      pendingClick = true
      lastClickTime = now
      if (pendingClickTimer) clearTimeout(pendingClickTimer)
      pendingClickTimer = setTimeout(() => {
        pendingClick = false
        pendingClickTimer = null
        emit('click')
      }, doubleClickMs)
    }
  }

  function handleLipPop() {
    const now = performance.now()
    if (now - lastEventTime < cooldownMs) return
    lastEventTime = now
    emit('enter')
  }

  function getBandEnergy(data: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
    const binWidth = sampleRate / (data.length * 2)
    const lowBin = Math.floor(lowHz / binWidth)
    const highBin = Math.min(Math.ceil(highHz / binWidth), data.length - 1)
    let sum = 0
    for (let i = lowBin; i <= highBin; i++) {
      // data is in dBFS, convert to linear
      const linear = Math.pow(10, data[i] / 20)
      sum += linear * linear
    }
    return Math.sqrt(sum / (highBin - lowBin + 1))
  }

  // Adaptive noise floor: slow EMA of quiet-frame energy.
  // Threshold = noiseFloor * TRIGGER_RATIO. Self-calibrates to mic/room.
  let noiseFloor = 1e-4          // initial estimate, will converge quickly
  let prevEnergy = 0
  const NOISE_FLOOR_ALPHA = 0.005  // slow rise — noise floor tracks ambient, not transients
  const TRIGGER_RATIO = 1.4        // fire when energy is 1.4x the noise floor
  const ATTACK_RATIO = 1.5         // also require a sharp rise frame-over-frame
  let debugLogTimer = 0

  function poll() {
    if (!analyser || !audioCtx) return

    const data = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(data)

    const sampleRate = audioCtx.sampleRate
    const nyquist = sampleRate / 2

    // Total broadband RMS energy (rough, in linear)
    const totalEnergy = getBandEnergy(data, sampleRate, 100, nyquist * 0.9)

    // Adaptive threshold: 4x the current noise floor estimate
    const adaptiveThreshold = Math.max(noiseFloor * TRIGGER_RATIO, clickThreshold)

    // Transient detection: sharp rise AND above adaptive threshold
    const isTransient = totalEnergy > adaptiveThreshold && totalEnergy > prevEnergy * ATTACK_RATIO

    if (isTransient) {
      // High-band energy for tongue click detection
      const highEnergy = getBandEnergy(data, sampleRate, TONGUE_CLICK_LOW_BAND, nyquist * 0.9)
      // Low-band energy for lip pop detection
      const lowEnergy = getBandEnergy(data, sampleRate, 100, LIP_POP_HIGH_BAND)

      const highRatio = highEnergy / (totalEnergy + 1e-10)
      const lowRatio = lowEnergy / (totalEnergy + 1e-10)

      if (highRatio > 0.4) {
        console.log('[click-detect] tongue click — energy:', totalEnergy.toFixed(4), 'floor:', noiseFloor.toFixed(4), 'highRatio:', highRatio.toFixed(2))
        handleTongueClick()
      } else if (lowRatio > 0.5) {
        console.log('[click-detect] lip pop — energy:', totalEnergy.toFixed(4), 'floor:', noiseFloor.toFixed(4), 'lowRatio:', lowRatio.toFixed(2))
        handleLipPop()
      } else {
        console.log('[click-detect] transient unclassified — energy:', totalEnergy.toFixed(4), 'highRatio:', highRatio.toFixed(2), 'lowRatio:', lowRatio.toFixed(2))
      }
      // Don't update noise floor on transient frames
    } else {
      // Update noise floor only on quiet frames
      noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + totalEnergy * NOISE_FLOOR_ALPHA
    }

    prevEnergy = totalEnergy * 0.7 + prevEnergy * 0.3

    debugLogTimer++
    if (debugLogTimer >= 120) {  // ~2s at 60fps
      console.log('[click-detect] noise floor:', noiseFloor.toFixed(5), '| adaptive threshold:', (noiseFloor * TRIGGER_RATIO).toFixed(5))
      debugLogTimer = 0
    }

    rafId = requestAnimationFrame(poll)
  }

  async function start() {
    if (audioCtx) return  // already running

    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    audioCtx = new AudioContext()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0  // no smoothing — we want sharp transients

    source = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)
    // Deliberately not connecting to destination — no feedback

    prevEnergy = 0
    console.log('[click-detect] started — mic ready, sampleRate:', audioCtx.sampleRate)
    rafId = requestAnimationFrame(poll)
  }

  function stop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
    if (pendingClickTimer) { clearTimeout(pendingClickTimer); pendingClickTimer = null }
    source?.disconnect()
    audioCtx?.close()
    stream?.getTracks().forEach(t => t.stop())
    audioCtx = null; analyser = null; source = null; stream = null
  }

  function on(event: ClickEvent, fn: () => void) {
    handlers.get(event)?.push(fn)
    return () => {
      const arr = handlers.get(event)
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1) }
    }
  }

  return { start, stop, on }
}

export type ClickDetector = ReturnType<typeof createClickDetector>
