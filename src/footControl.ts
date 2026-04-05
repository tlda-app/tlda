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
  cursorSpeed?: number   // terminal velocity px/sec at full throttle (default: 600)
  panSpeed?: number      // terminal velocity px/sec at full throttle (default: 600)
  deadzone?: number      // axis deadzone (default: 0.05)
  friction?: number      // velocity damping coefficient (default: 8). Higher = snappier stop. Controls time-to-stop after release: 0.5s at 8.
  onCursorMove?: (x: number, y: number) => void  // override cursor dispatch (default: editor.dispatch)
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
  rudder: 2,
  cursorThrottle: 0,
  panThrottle: 1,
}

const DEFAULT_OPTIONS = {
  headingRate: Math.PI * 2,  // one full rotation per second at max deflection
  cursorSpeed: 600,
  panSpeed: 600,
  deadzone: 0.05,
  friction: 8,               // velocity decays to ~1% in ~0.6s after pedal release
}

export function createFootController(editor: Editor, options: FootControlOptions = {}) {
  const axisMap: AxisMap = { ...DEFAULT_AXIS_MAP, ...options.axisMap }
  const headingRate = options.headingRate ?? DEFAULT_OPTIONS.headingRate
  const cursorSpeed = options.cursorSpeed ?? DEFAULT_OPTIONS.cursorSpeed
  const panSpeed = options.panSpeed ?? DEFAULT_OPTIONS.panSpeed
  const deadzone = options.deadzone ?? DEFAULT_OPTIONS.deadzone
  const friction = options.friction ?? DEFAULT_OPTIONS.friction

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
  let throttlesInverted = false  // true when axes rest at 1.0 and press toward -1 (e.g. T-Pedals)
  // Velocity state for physics model (acceleration + friction)
  let cursorVX = 0, cursorVY = 0
  let panVX = 0, panVY = 0
  // Response curve: maps normalized axis [0,1] → acceleration multiplier [0,1]
  // Default = linear (identity). Override via setCurveMap().
  let curveMap: (x: number) => number = x => x
  const listeners: Array<(state: FootControlState) => void> = []

  // Keyboard simulation (fallback when no gamepad connected)
  // Left/Right → rudder | Up → cursor throttle | Shift+Up → pan throttle
  const keys = new Set<string>()
  const onKeyDown = (e: KeyboardEvent) => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) { e.preventDefault(); keys.add(e.key + (e.shiftKey ? '+shift' : '')) } }
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key); keys.delete(e.key + '+shift') }

  function readKeyboardAxes(): { rudder: number; cursor: number; pan: number } {
    const rudder = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0)
    const pan = keys.has('ArrowUp+shift') ? 1 : keys.has('ArrowDown+shift') ? -1 : 0
    const cursor = !pan && keys.has('ArrowUp') ? 1 : !pan && keys.has('ArrowDown') ? -1 : 0
    return { rudder, cursor, pan }
  }

  function applyDeadzone(value: number): number {
    if (Math.abs(value) < deadzone) return 0
    const sign = value > 0 ? 1 : -1
    return sign * (Math.abs(value) - deadzone) / (1 - deadzone)
  }

  function normalizeThrottle(raw: number): number {
    // Inverted axes (e.g. T-Pedals): rest=1, pressed=-1 → map to 0..1
    if (throttlesInverted) return (1 - raw) / 2
    return raw
  }

  function readAxes(): { rudder: number; cursor: number; pan: number } {
    const gamepads = navigator.getGamepads()
    for (const gp of gamepads) {
      if (!gp) continue
      if (!state.gamepadConnected) detectInversion(gp)
      state.gamepadConnected = true
      const left  = normalizeThrottle(gp.axes[axisMap.cursorThrottle] ?? 0)
      const right = normalizeThrottle(gp.axes[axisMap.panThrottle] ?? 0)
      const rudder = applyDeadzone(-(gp.axes[axisMap.rudder] ?? 0))
      // Both brakes simultaneously = mild reverse (30% of max forward)
      if (left > 0.2 && right > 0.2) {
        return { rudder, cursor: -0.3, pan: 0 }
      }
      return { rudder, cursor: curveMap(applyDeadzone(left)), pan: curveMap(applyDeadzone(right)) }
    }
    state.gamepadConnected = false
    return readKeyboardAxes()
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

    // Cursor physics: pedal → acceleration; friction proportional to velocity.
    // Terminal velocity at full throttle = cursorSpeed. Time constant = 1/friction.
    const cursorAccel = axes.cursor * cursorSpeed * friction
    cursorVX += (dx * cursorAccel - cursorVX * friction) * dt
    cursorVY += (dy * cursorAccel - cursorVY * friction) * dt
    // Snap to zero when pedal released and nearly stopped (prevents micro-drift)
    if (axes.cursor === 0 && Math.abs(cursorVX) < 2 && Math.abs(cursorVY) < 2) { cursorVX = 0; cursorVY = 0 }
    if (cursorVX !== 0 || cursorVY !== 0) {
      state.cursorX = Math.max(0, Math.min(window.innerWidth, state.cursorX + cursorVX * dt))
      state.cursorY = Math.max(0, Math.min(window.innerHeight, state.cursorY + cursorVY * dt))
      if (options.onCursorMove) {
        options.onCursorMove(state.cursorX, state.cursorY)
      } else {
        dispatchCursorMove(state.cursorX, state.cursorY)
      }
    }

    // Pan physics: same model
    const panAccel = axes.pan * panSpeed * friction
    panVX += (dx * panAccel - panVX * friction) * dt
    panVY += (dy * panAccel - panVY * friction) * dt
    if (axes.pan === 0 && Math.abs(panVX) < 2 && Math.abs(panVY) < 2) { panVX = 0; panVY = 0 }
    if (panVX !== 0 || panVY !== 0) {
      const cam = editor.getCamera()
      editor.setCamera({ x: cam.x - panVX * dt, y: cam.y - panVY * dt, z: cam.z })
    }

    for (const fn of listeners) fn({ ...state })

    rafId = requestAnimationFrame(tick)
  }

  function dispatchCursorMove(x: number, y: number) {
    editor.dispatch({
      type: 'pointer', target: 'canvas', name: 'pointer_move',
      point: { x, y, z: 0.5 },
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      pointerId: 1, button: 0, isPen: false,
    })
  }

  /** Programmatically set cursor position (for debug sliders or mouse passthrough) */
  function setCursorPos(x: number, y: number) {
    state.cursorX = x
    state.cursorY = y
    if (options.onCursorMove) {
      options.onCursorMove(x, y)
    } else {
      dispatchCursorMove(x, y)
    }
    for (const fn of listeners) fn({ ...state })
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

  function detectInversion(gp: Gamepad) {
    const cursor0 = gp.axes[axisMap.cursorThrottle] ?? 0
    const pan0    = gp.axes[axisMap.panThrottle] ?? 0
    throttlesInverted = cursor0 > 0.8 || pan0 > 0.8
    console.log(`[foot-control] throttlesInverted=${throttlesInverted} (cursor0=${cursor0.toFixed(2)}, pan0=${pan0.toFixed(2)})`)
  }

  const onGamepadConnected = (e: GamepadEvent) => detectInversion(e.gamepad)

  function start() {
    if (rafId !== null) return
    lastTime = null
    // Detect inversion now if gamepad is already connected, and on future connects
    const gps = navigator.getGamepads()
    for (const gp of gps) { if (gp) { detectInversion(gp); break } }
    window.addEventListener('gamepadconnected', onGamepadConnected)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    rafId = requestAnimationFrame(tick)
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    window.removeEventListener('gamepadconnected', onGamepadConnected)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    keys.clear()
    lastTime = null
  }

  function setCurveMap(fn: (x: number) => number) { curveMap = fn }

  return { start, stop, state, setCursorPos, setHeading, onStateChange, setCurveMap }
}

export type FootController = ReturnType<typeof createFootController>
