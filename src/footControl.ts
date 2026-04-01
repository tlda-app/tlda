/**
 * footControl.ts — Gamepad-based foot pedal control for cursor and camera.
 *
 * Designed for rudder pedal sets with:
 *   - Axis 0: rudder (left/right, -1 to +1) — rotates heading
 *   - Axis 2: left toe brake (0 to 1) — drives cursor forward
 *   - Axis 5: right toe brake (0 to 1) — drives camera (pan)
 *
 * Axis indices vary by device. Call setAxisMap() to override defaults.
 *
 * Usage:
 *   const fc = createFootController(editor)
 *   fc.start()
 *   // later:
 *   fc.stop()
 */

import type { Editor } from 'tldraw'

export interface AxisMap {
  rudder: number      // axis index for rudder (heading rotation)
  cursorThrottle: number  // axis index for cursor speed
  panThrottle: number     // axis index for pan speed
}

export interface FootControlOptions {
  axisMap?: Partial<AxisMap>
  headingRate?: number   // radians/sec per full axis deflection (default: 2π)
  cursorSpeed?: number   // viewport px/sec per full throttle (default: 600)
  panSpeed?: number      // viewport px/sec per full throttle (default: 600)
  deadzone?: number      // axis deadzone (default: 0.05)
}

export interface FootControlState {
  heading: number       // radians
  cursorX: number       // viewport px
  cursorY: number       // viewport px
  rudderAxis: number    // raw, after deadzone
  cursorAxis: number    // raw, after deadzone
  panAxis: number       // raw, after deadzone
  gamepadConnected: boolean
}

const DEFAULT_AXIS_MAP: AxisMap = {
  rudder: 0,
  cursorThrottle: 2,
  panThrottle: 5,
}

const DEFAULT_OPTIONS = {
  headingRate: Math.PI * 2,  // one full rotation per second at max deflection
  cursorSpeed: 600,
  panSpeed: 600,
  deadzone: 0.05,
}

export function createFootController(editor: Editor, options: FootControlOptions = {}) {
  const axisMap: AxisMap = { ...DEFAULT_AXIS_MAP, ...options.axisMap }
  const headingRate = options.headingRate ?? DEFAULT_OPTIONS.headingRate
  const cursorSpeed = options.cursorSpeed ?? DEFAULT_OPTIONS.cursorSpeed
  const panSpeed = options.panSpeed ?? DEFAULT_OPTIONS.panSpeed
  const deadzone = options.deadzone ?? DEFAULT_OPTIONS.deadzone

  const state: FootControlState = {
    heading: -Math.PI / 2,  // start pointing up
    cursorX: window.innerWidth / 2,
    cursorY: window.innerHeight / 2,
    rudderAxis: 0,
    cursorAxis: 0,
    panAxis: 0,
    gamepadConnected: false,
  }

  let rafId: number | null = null
  let lastTime: number | null = null
  const listeners: Array<(state: FootControlState) => void> = []

  function applyDeadzone(value: number): number {
    if (Math.abs(value) < deadzone) return 0
    const sign = value > 0 ? 1 : -1
    return sign * (Math.abs(value) - deadzone) / (1 - deadzone)
  }

  function readAxes(): { rudder: number; cursor: number; pan: number } {
    const gamepads = navigator.getGamepads()
    for (const gp of gamepads) {
      if (!gp) continue
      state.gamepadConnected = true
      return {
        rudder: applyDeadzone(gp.axes[axisMap.rudder] ?? 0),
        cursor: applyDeadzone(gp.axes[axisMap.cursorThrottle] ?? 0),
        pan: applyDeadzone(gp.axes[axisMap.panThrottle] ?? 0),
      }
    }
    state.gamepadConnected = false
    return { rudder: 0, cursor: 0, pan: 0 }
  }

  function tick(now: number) {
    if (lastTime === null) {
      lastTime = now
      rafId = requestAnimationFrame(tick)
      return
    }
    const dt = Math.min((now - lastTime) / 1000, 0.1)  // cap at 100ms
    lastTime = now

    const axes = readAxes()
    state.rudderAxis = axes.rudder
    state.cursorAxis = axes.cursor
    state.panAxis = axes.pan

    // Rotate heading by rudder deflection
    if (axes.rudder !== 0) {
      state.heading += axes.rudder * headingRate * dt
    }

    const dx = Math.cos(state.heading)
    const dy = Math.sin(state.heading)

    // Move cursor along heading
    if (axes.cursor !== 0) {
      const speed = axes.cursor * cursorSpeed * dt
      state.cursorX = Math.max(0, Math.min(window.innerWidth, state.cursorX + dx * speed))
      state.cursorY = Math.max(0, Math.min(window.innerHeight, state.cursorY + dy * speed))
      dispatchCursorMove(state.cursorX, state.cursorY)
    }

    // Pan camera along heading
    if (axes.pan !== 0) {
      const speed = axes.pan * panSpeed * dt
      editor.pan({ x: -dx * speed, y: -dy * speed })
    }

    for (const fn of listeners) fn({ ...state })

    rafId = requestAnimationFrame(tick)
  }

  function dispatchCursorMove(x: number, y: number) {
    const canvas = editor.getContainer()
    if (!canvas) return
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 1,
    }))
  }

  /** Programmatically set cursor position (for debug sliders) */
  function setCursorPos(x: number, y: number) {
    state.cursorX = x
    state.cursorY = y
    dispatchCursorMove(x, y)
  }

  /** Set heading directly (for debug sliders) */
  function setHeading(radians: number) {
    state.heading = radians
  }

  function onStateChange(fn: (state: FootControlState) => void) {
    listeners.push(fn)
    return () => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  function start() {
    if (rafId !== null) return
    lastTime = null
    rafId = requestAnimationFrame(tick)
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    lastTime = null
  }

  return { start, stop, state, setCursorPos, setHeading, onStateChange }
}

export type FootController = ReturnType<typeof createFootController>
