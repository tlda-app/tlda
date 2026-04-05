/**
 * clickDetect.ts — Web Audio gesture detector for non-speech mouth sounds.
 *
 * Runs a parallel pipeline alongside speech recognition (no interference).
 * Detects five distinct non-speech gestures:
 *   - Tongue click (alveolar "tck"): broadband sharp transient, fast attack
 *   - Double click: two tongue clicks within DOUBLE_CLICK_MS
 *   - Lip pop (bilabial): lower-frequency transient → 'enter'
 *   - Whistle: sustained narrow-band energy in 500–5kHz
 *   - Hiss: sustained broadband energy without sharp attack
 *
 * Emits:
 *   'click'         — single tongue click
 *   'dblclick'      — two tongue clicks within DOUBLE_CLICK_MS
 *   'enter'         — lip pop
 *   'whistle-start' — whistle onset
 *   'whistle-end'   — whistle offset
 *   'hiss-start'    — hiss onset
 *   'hiss-end'      — hiss offset
 *
 * Usage:
 *   const cd = createClickDetector()
 *   await cd.start()
 *   cd.on('click', () => { ... })
 *   cd.on('whistle-start', () => { ... })
 *   cd.on('hiss-start', () => { ... })
 *   cd.stop()
 */

export type ClickEvent = 'click' | 'dblclick' | 'enter' | 'whistle-start' | 'whistle-end' | 'hiss-start' | 'hiss-end'

export interface ClickDetectorOptions {
  doubleClickMs?: number   // window for double-click detection (default: 300)
  cooldownMs?: number      // ignore events within this window after a detected event (default: 400)
  whistleEnabled?: boolean // enable whistle detection (default: true)
  hissEnabled?: boolean    // enable hiss detection (default: true)
}

// Tongue click: energy concentrated in high frequencies (>2kHz), very fast attack
const TONGUE_CLICK_LOW_BAND = 2000   // Hz, lower bound of tongue click detection

// Whistle: sustained narrow-band energy in 500–5kHz with high spectral purity
const WHISTLE_LOW_HZ = 500
const WHISTLE_HIGH_HZ = 5000
const WHISTLE_SUSTAIN_FRAMES = 8       // ~130ms at 60fps before onset fires
const WHISTLE_PURITY_THRESHOLD = 0.6   // peak bin energy / total band energy — high = tonal

// Hiss: sustained broadband energy (flat spectrum, no sharp attack)
const HISS_SUSTAIN_FRAMES = 12          // ~200ms at 60fps before onset fires
const HISS_SPECTRAL_FLATNESS_MIN = 0.3  // geometric/arithmetic mean ratio — high = flat/noisy

export function createClickDetector(options: ClickDetectorOptions = {}) {
  const doubleClickMs = options.doubleClickMs ?? 300
  const cooldownMs = options.cooldownMs ?? 400
  let whistleEnabled = options.whistleEnabled ?? true
  let hissEnabled = options.hissEnabled ?? true

  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null
  let rafId: number | null = null

  const handlers: Map<ClickEvent, Array<() => void>> = new Map([
    ['click', []],
    ['dblclick', []],
    ['enter', []],
    ['whistle-start', []],
    ['whistle-end', []],
    ['hiss-start', []],
    ['hiss-end', []],
  ])

  let lastClickTime = 0
  let pendingClick = false
  let pendingClickTimer: ReturnType<typeof setTimeout> | null = null
  let lastEventTime = 0

  // Whistle state
  let whistleFrameCount = 0
  let whistleActive = false

  // Hiss state
  let hissFrameCount = 0
  let hissActive = false

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

  /**
   * Spectral purity in a band: ratio of peak bin energy to total band energy.
   * High (>0.6) = tonal (whistle). Low = broadband noise.
   */
  function getSpectralPurity(data: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
    const binWidth = sampleRate / (data.length * 2)
    const lowBin = Math.floor(lowHz / binWidth)
    const highBin = Math.min(Math.ceil(highHz / binWidth), data.length - 1)
    let peak = 0
    let total = 0
    for (let i = lowBin; i <= highBin; i++) {
      const linear = Math.pow(10, data[i] / 20)
      const e = linear * linear
      if (e > peak) peak = e
      total += e
    }
    return total > 0 ? peak / total : 0
  }

  /**
   * Spectral flatness (Wiener entropy): geometric mean / arithmetic mean of bin powers.
   * 1.0 = perfectly flat (white noise). 0.0 = all energy in one bin (pure tone).
   * Hiss has high flatness; whistle has low flatness.
   */
  function getSpectralFlatness(data: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
    const binWidth = sampleRate / (data.length * 2)
    const lowBin = Math.floor(lowHz / binWidth)
    const highBin = Math.min(Math.ceil(highHz / binWidth), data.length - 1)
    const n = highBin - lowBin + 1
    if (n <= 0) return 0
    let logSum = 0
    let arithmeticSum = 0
    for (let i = lowBin; i <= highBin; i++) {
      const linear = Math.pow(10, data[i] / 20)
      const e = linear * linear + 1e-20  // avoid log(0)
      logSum += Math.log(e)
      arithmeticSum += e
    }
    const geometricMean = Math.exp(logSum / n)
    const arithmeticMean = arithmeticSum / n
    return arithmeticMean > 0 ? geometricMean / arithmeticMean : 0
  }

  // Adaptive noise floor: slow EMA of quiet-frame energy.
  // Threshold = noiseFloor * triggerRatio. Self-calibrates to mic/room.
  let noiseFloor = 1e-4          // initial estimate, will converge quickly
  let prevEnergy = 0
  const NOISE_FLOOR_ALPHA = 0.005  // slow rise — noise floor tracks ambient, not transients
  let triggerRatio = 3.0           // mutable — adjustable via setTriggerRatio()
  const ATTACK_RATIO = 1.5         // require a sharp rise frame-over-frame
  let debugLogTimer = 0

  function poll() {
    if (!analyser || !audioCtx) return

    const data = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(data)

    const sampleRate = audioCtx.sampleRate
    const nyquist = sampleRate / 2

    // Total broadband RMS energy (rough, in linear)
    const totalEnergy = getBandEnergy(data, sampleRate, 100, nyquist * 0.9)

    // Adaptive threshold: purely relative to noise floor (no hard minimum — lapel mics have low amplitude)
    const adaptiveThreshold = noiseFloor * triggerRatio

    // --- Whistle detection: sustained tonal energy in 500–5kHz ---
    const whistleBandEnergy = whistleEnabled ? getBandEnergy(data, sampleRate, WHISTLE_LOW_HZ, WHISTLE_HIGH_HZ) : 0
    const purity = whistleEnabled ? getSpectralPurity(data, sampleRate, WHISTLE_LOW_HZ, WHISTLE_HIGH_HZ) : 0
    const isWhistleFrame = whistleEnabled && whistleBandEnergy > adaptiveThreshold && purity > WHISTLE_PURITY_THRESHOLD

    if (isWhistleFrame) {
      whistleFrameCount++
      if (!whistleActive && whistleFrameCount >= WHISTLE_SUSTAIN_FRAMES) {
        whistleActive = true
        console.log('[click-detect] whistle-start — energy:', whistleBandEnergy.toFixed(4), 'purity:', purity.toFixed(2))
        emit('whistle-start')
      }
    } else {
      if (whistleActive) {
        whistleActive = false
        console.log('[click-detect] whistle-end')
        emit('whistle-end')
      }
      whistleFrameCount = 0
    }

    // --- Hiss detection: sustained broadband energy with flat spectrum ---
    const flatness = hissEnabled ? getSpectralFlatness(data, sampleRate, 200, nyquist * 0.8) : 0
    const isHissFrame = hissEnabled && totalEnergy > adaptiveThreshold && flatness > HISS_SPECTRAL_FLATNESS_MIN && !isWhistleFrame

    if (isHissFrame) {
      hissFrameCount++
      if (!hissActive && hissFrameCount >= HISS_SUSTAIN_FRAMES) {
        hissActive = true
        console.log('[click-detect] hiss-start — energy:', totalEnergy.toFixed(4), 'flatness:', flatness.toFixed(2))
        emit('hiss-start')
      }
    } else {
      if (hissActive) {
        hissActive = false
        console.log('[click-detect] hiss-end')
        emit('hiss-end')
      }
      hissFrameCount = 0
    }

    // --- Transient detection (tongue click / lip pop) ---
    // Only check transients when not in a sustained gesture
    const isTransient = !whistleActive && !hissActive &&
      totalEnergy > adaptiveThreshold && totalEnergy > prevEnergy * ATTACK_RATIO

    if (isTransient) {
      const highEnergy = getBandEnergy(data, sampleRate, TONGUE_CLICK_LOW_BAND, nyquist * 0.9)
      const highRatio = highEnergy / (totalEnergy + 1e-10)

      if (highRatio > 0.15) {
        console.log('[click-detect] tongue click — energy:', totalEnergy.toFixed(4), 'floor:', noiseFloor.toFixed(4), 'highRatio:', highRatio.toFixed(2))
        handleTongueClick()
      } else {
        console.log('[click-detect] transient unclassified — energy:', totalEnergy.toFixed(4), 'highRatio:', highRatio.toFixed(2))
      }
      // Don't update noise floor on transient frames
    } else if (!isWhistleFrame && !isHissFrame) {
      // Update noise floor only on quiet frames (not during any gesture)
      noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + totalEnergy * NOISE_FLOOR_ALPHA
    }

    prevEnergy = totalEnergy * 0.7 + prevEnergy * 0.3

    debugLogTimer++
    if (debugLogTimer >= 120) {  // ~2s at 60fps
      console.log('[click-detect] noise floor:', noiseFloor.toFixed(5), '| adaptive threshold:', (noiseFloor * triggerRatio).toFixed(5))
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
    // End any active sustained gestures
    if (whistleActive) { whistleActive = false; emit('whistle-end') }
    if (hissActive) { hissActive = false; emit('hiss-end') }
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

  function setTriggerRatio(r: number) { triggerRatio = Math.max(1.1, r) }
  function getTriggerRatio() { return triggerRatio }

  function setWhistleEnabled(v: boolean) {
    whistleEnabled = v
    if (!v && whistleActive) { whistleActive = false; whistleFrameCount = 0; emit('whistle-end') }
  }
  function setHissEnabled(v: boolean) {
    hissEnabled = v
    if (!v && hissActive) { hissActive = false; hissFrameCount = 0; emit('hiss-end') }
  }

  return { start, stop, on, setTriggerRatio, getTriggerRatio, setWhistleEnabled, setHissEnabled }
}

export type ClickDetector = ReturnType<typeof createClickDetector>
