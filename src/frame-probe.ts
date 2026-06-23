/**
 * frame-probe — measures frame timing during interactions.
 * Activated by ?perf=1 or ?perf=frame.
 * Hooks into requestAnimationFrame to measure frame duration.
 */
import { probe } from './perf-probe'

if (probe.isEnabled('frame')) {
  let lastFrameTime = performance.now()
  let frameCount = 0
  
  const measureFrame = () => {
    const now = performance.now()
    const duration = now - lastFrameTime
    lastFrameTime = now
    
    // Only record frames that are part of an interaction (not idle 60fps)
    // We detect "interaction" by having frames > 8ms (idle frames are ~0-2ms)
    if (duration > 8) {
      probe.record('frame', 'frame-timing', duration, { frameCount })
    }
    
    frameCount++
    requestAnimationFrame(measureFrame)
  }
  
  requestAnimationFrame(measureFrame)
  console.info('[frame-probe] measuring frame timing')
}
