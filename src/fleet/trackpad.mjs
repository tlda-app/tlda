// trackpad.mjs — Foot trackpad → tlda camera + voice control.
//
// Gesture model designed for feet:
//   - Axis-locked pan (dominant direction only, discrete speeds)
//   - Double-click → voice toggle
//   - Triple-click → send
//   - No single click (too easy to trigger accidentally in a drag)
//
// Usage:
//   import { initTrackpad } from './trackpad.mjs'
//   initTrackpad({ getEditor, onDoubleClick, onTripleClick })

let _ws = null
let _getEditor = null
let _onDoubleClick = null
let _onTripleClick = null
let _connected = false
let _reconnectTimer = null

// --- Gesture state ---

let _fingers = new Map()      // id → { x, y }
let _dragAxis = null           // 'x' | 'y' | null — locked on first significant movement
let _dragAnchor = null         // { x, y } — centroid at drag start
let _lastCentroid = null       // { x, y } — last frame centroid
let _panInterval = null        // setInterval for continuous discrete panning
let _currentSpeed = 0          // -2, -1, 0, 1, 2
let _currentAxis = null        // 'x' | 'y'
let _touchStartTime = 0
let _totalMovement = 0
let _clickTimes = []           // timestamps of recent clicks (for double/triple detection)

// Thresholds
const AXIS_LOCK_THRESHOLD = 0.02   // normalized movement before we pick an axis
const SPEED_TIER_1 = 0.05          // displacement for speed 1
const SPEED_TIER_2 = 0.15          // displacement for speed 2
const PAN_PX_SLOW = 8              // pixels per tick at speed 1
const PAN_PX_FAST = 25             // pixels per tick at speed 2
const PAN_TICK_MS = 16             // ~60fps pan updates
const CLICK_MAX_MOVE = 0.03        // max movement for a touch to count as a click
const CLICK_MAX_MS = 400           // max duration for a click
const MULTI_CLICK_MS = 500         // window for double/triple click detection

// --- Pan engine ---

function startPan() {
  if (_panInterval) return
  _panInterval = setInterval(() => {
    if (_currentSpeed === 0 || !_currentAxis) return
    const editor = _getEditor?.()
    if (!editor) return

    const cam = editor.getCamera()
    const px = _currentSpeed > 0
      ? (Math.abs(_currentSpeed) >= 2 ? PAN_PX_FAST : PAN_PX_SLOW)
      : -(Math.abs(_currentSpeed) >= 2 ? PAN_PX_FAST : PAN_PX_SLOW)

    if (_currentAxis === 'x') {
      editor.setCamera({ x: cam.x + px / cam.z, y: cam.y, z: cam.z })
    } else {
      editor.setCamera({ x: cam.x, y: cam.y - px / cam.z, z: cam.z })
    }
  }, PAN_TICK_MS)
}

function stopPan() {
  if (_panInterval) {
    clearInterval(_panInterval)
    _panInterval = null
  }
  _currentSpeed = 0
  _currentAxis = null
}

function updatePanFromDrag(touching) {
  const cx = centroidX(touching)
  const cy = centroidY(touching)

  if (!_dragAnchor) {
    _dragAnchor = { x: cx, y: cy }
    _lastCentroid = { x: cx, y: cy }
    return
  }

  const dx = cx - _dragAnchor.x
  const dy = cy - _dragAnchor.y
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)

  // Lock axis on first significant movement
  if (!_dragAxis) {
    const maxD = Math.max(absDx, absDy)
    if (maxD > AXIS_LOCK_THRESHOLD) {
      _dragAxis = absDx > absDy ? 'x' : 'y'
      startPan()
    } else {
      return
    }
  }

  // Compute speed tier from displacement along locked axis
  const displacement = _dragAxis === 'x' ? dx : -dy  // invert y (trackpad up = scroll up)
  const absDisp = Math.abs(displacement)
  let speed = 0
  if (absDisp > SPEED_TIER_2) {
    speed = displacement > 0 ? 2 : -2
  } else if (absDisp > SPEED_TIER_1) {
    speed = displacement > 0 ? 1 : -1
  }

  _currentSpeed = speed
  _currentAxis = _dragAxis
  _lastCentroid = { x: cx, y: cy }
}

// --- Click detection ---

function registerClick() {
  const now = Date.now()
  // Prune old clicks
  _clickTimes = _clickTimes.filter(t => now - t < MULTI_CLICK_MS)
  _clickTimes.push(now)

  if (_clickTimes.length >= 3) {
    _clickTimes = []
    _onTripleClick?.()
  } else if (_clickTimes.length === 2) {
    // Wait a bit to see if triple is coming
    setTimeout(() => {
      if (_clickTimes.length === 2) {
        _clickTimes = []
        _onDoubleClick?.()
      }
    }, MULTI_CLICK_MS)
  }
}

// --- Frame processing ---

function processFrame(data) {
  const { fingers: rawFingers } = data
  const touching = rawFingers.filter(f => f.stage === 3 || f.stage === 4)
  const now = Date.now()

  // Touch start
  if (touching.length > 0 && _fingers.size === 0) {
    _touchStartTime = now
    _totalMovement = 0
    _dragAxis = null
    _dragAnchor = null
  }

  // Touch end
  if (touching.length === 0 && _fingers.size > 0) {
    stopPan()
    _dragAxis = null
    _dragAnchor = null

    // Check if it was a click (short + minimal movement)
    const duration = now - _touchStartTime
    if (duration < CLICK_MAX_MS && _totalMovement < CLICK_MAX_MOVE) {
      registerClick()
    }

    _fingers.clear()
    return
  }

  if (touching.length === 0) {
    _fingers.clear()
    return
  }

  // Track movement
  for (const f of touching) {
    const prev = _fingers.get(f.id)
    if (prev) {
      _totalMovement += Math.abs(f.x - prev.x) + Math.abs(f.y - prev.y)
    }
  }

  // Update finger map
  _fingers.clear()
  for (const f of touching) {
    _fingers.set(f.id, { x: f.x, y: f.y })
  }

  // Update pan
  updatePanFromDrag(touching)
}

// --- Helpers ---

function centroidX(fingers) {
  return fingers.reduce((s, f) => s + f.x, 0) / fingers.length
}

function centroidY(fingers) {
  return fingers.reduce((s, f) => s + f.y, 0) / fingers.length
}

// --- Public API ---

export function initTrackpad({ getEditor, onDoubleClick, onTripleClick } = {}) {
  _getEditor = getEditor
  _onDoubleClick = onDoubleClick
  _onTripleClick = onTripleClick
  console.log('trackpad: initialized — drag=axis-locked pan, 2x click=voice, 3x click=send')
}

export function isConnected() { return _connected }
