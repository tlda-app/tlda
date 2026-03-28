/**
 * FleetLockOverlay — floating lock/unlock button positioned at the top-left
 * of the bounding box of all fleet shapes. Toggles isLocked on every fleet shape.
 */
import { useCallback } from 'react'
import { useEditor, useValue } from 'tldraw'

const FLEET_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search']

export function FleetLockOverlay() {
  const editor = useEditor()

  // Compute screen-space position of the top-left of fleet bounding box
  const overlayState = useValue('fleet-lock', () => {
    const shapes = editor.getCurrentPageShapes().filter(s => FLEET_TYPES.includes(s.type))
    if (shapes.length === 0) return null

    let minX = Infinity, minY = Infinity
    for (const s of shapes) {
      const bounds = editor.getShapePageBounds(s.id)
      if (!bounds) continue
      minX = Math.min(minX, bounds.x)
      minY = Math.min(minY, bounds.y)
    }
    if (!isFinite(minX)) return null

    // Convert page coords to screen coords
    const screen = editor.pageToScreen({ x: minX, y: minY })
    const locked = shapes[0].isLocked ?? true

    return `${Math.round(screen.x)},${Math.round(screen.y)},${locked ? '1' : '0'}`
  }, [editor])

  const toggleLock = useCallback(() => {
    const shapes = editor.getCurrentPageShapes().filter(s => FLEET_TYPES.includes(s.type))
    if (shapes.length === 0) return
    const newLocked = !(shapes[0].isLocked ?? true)
    for (const s of shapes) {
      editor.updateShape({ id: s.id, type: s.type, isLocked: newLocked })
    }
    // Enable snap-to-shape guides when unlocked for easier arrangement
    editor.user.updateUserPreferences({ isSnapMode: !newLocked })
  }, [editor])

  if (!overlayState) return null

  const [sx, sy, lockedStr] = overlayState.split(',')
  const screenX = parseInt(sx)
  const screenY = parseInt(sy)
  const isLocked = lockedStr === '1'

  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggleLock}
      style={{
        position: 'fixed',
        left: screenX - 20,
        top: screenY - 20,
        background: 'none',
        border: 'none',
        padding: '2px 4px',
        cursor: 'pointer',
        fontSize: 13,
        opacity: isLocked ? 0.15 : 0.5,
        lineHeight: 1,
        pointerEvents: 'auto',
        userSelect: 'none',
        zIndex: 998,
        transition: 'opacity 0.2s',
      }}
      title={isLocked ? 'Unlock fleet layout' : 'Lock fleet layout'}
    >
      {isLocked ? '🔒' : '🔓'}
    </button>
  )
}
