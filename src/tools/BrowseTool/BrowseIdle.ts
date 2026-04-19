/**
 * BrowseIdle — forked from tldraw SelectTool/Idle.
 *
 * Adds fleet/HTML routing: locked fleet shapes and HTML pages get DOM
 * interaction instead of being treated as inert locked shapes.
 *
 * All other behavior is identical to tldraw's Idle state.
 */
import {
  Editor,
  StateNode,
  Vec,
  kickoutOccludedShapes,
  pointInPolygon,
  throttle,
  isShapeId,
  richTextValidator,
} from '@tldraw/editor'
import type {
  TLAdjacentDirection,
  TLClickEventInfo,
  TLKeyboardEventInfo,
  TLPointerEventInfo,
  TLShape,
  TLRichText,
  VecLike,
} from '@tldraw/editor'
import {
  getHitShapeOnCanvasPointerDown,
  startEditingShapeWithRichText,
} from 'tldraw'
import { fleetLayoutActiveRef } from '../../overlays/FleetHUD'

// --- Fleet shape types that get DOM interaction ---
const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'])

// --- Inlined helpers (not exported from tldraw) ---

function _updateHoveredShapeId(editor: Editor) {
  const hitShape = editor.getShapeAtPoint(editor.inputs.getCurrentPagePoint(), {
    hitInside: false,
    hitLabels: false,
    margin: editor.options.hitTestMargin / editor.getZoomLevel(),
    renderingOnly: true,
  })
  if (!hitShape) return editor.setHoveredShape(null)
  let shapeToHover: TLShape | undefined = undefined
  const outermostShape = editor.getOutermostSelectableShape(hitShape)
  if (outermostShape === hitShape) {
    shapeToHover = hitShape
  } else {
    if (
      outermostShape.id === editor.getFocusedGroupId() ||
      editor.getSelectedShapeIds().includes(outermostShape.id)
    ) {
      shapeToHover = hitShape
    } else {
      shapeToHover = outermostShape
    }
  }
  return editor.setHoveredShape(shapeToHover.id)
}
const updateHoveredShapeId = throttle(_updateHoveredShapeId, 32)

function selectOnCanvasPointerUp(
  editor: Editor,
  info: TLPointerEventInfo | TLClickEventInfo
) {
  const selectedShapeIds = editor.getSelectedShapeIds()
  const currentPagePoint = editor.inputs.getCurrentPagePoint()
  const { shiftKey, altKey, accelKey } = info
  const additiveSelectionKey = shiftKey || accelKey
  const hitShape = editor.getShapeAtPoint(currentPagePoint, {
    hitInside: false,
    margin: editor.options.hitTestMargin / editor.getZoomLevel(),
    hitLabels: true,
    renderingOnly: true,
    filter: (shape) => !shape.isLocked,
  })
  if (hitShape) {
    const outermostSelectableShape = editor.getOutermostSelectableShape(hitShape)
    if (additiveSelectionKey && !altKey) {
      editor.cancelDoubleClick()
      if (selectedShapeIds.includes(outermostSelectableShape.id)) {
        editor.markHistoryStoppingPoint('deselecting shape')
        editor.deselect(outermostSelectableShape)
      } else {
        editor.markHistoryStoppingPoint('shift selecting shape')
        editor.setSelectedShapes([...selectedShapeIds, outermostSelectableShape.id])
      }
    } else {
      let shapeToSelect: TLShape | undefined = undefined
      if (outermostSelectableShape === hitShape) {
        shapeToSelect = hitShape
      } else {
        if (
          outermostSelectableShape.id === editor.getFocusedGroupId() ||
          selectedShapeIds.includes(outermostSelectableShape.id)
        ) {
          shapeToSelect = hitShape
        } else {
          shapeToSelect = outermostSelectableShape
        }
      }
      if (shapeToSelect && !selectedShapeIds.includes(shapeToSelect.id)) {
        editor.markHistoryStoppingPoint('selecting shape')
        editor.select(shapeToSelect.id)
      }
    }
  } else {
    if (additiveSelectionKey) return
    if (selectedShapeIds.length > 0) {
      editor.markHistoryStoppingPoint('selecting none')
      editor.selectNone()
    }
    const focusedGroupId = editor.getFocusedGroupId()
    if (isShapeId(focusedGroupId)) {
      const groupShape = editor.getShape(focusedGroupId)!
      if (!editor.isPointInShape(groupShape, currentPagePoint, { margin: 0, hitInside: true })) {
        editor.setFocusedGroup(null)
      }
    }
  }
}

function hasRichText(shape: TLShape): shape is TLShape & { props: { richText: TLRichText } } {
  return 'richText' in shape.props && richTextValidator.isValid((shape.props as any).richText)
}

// --- Constants ---
const SKIPPED_KEYS_FOR_AUTO_EDITING = ['Delete', 'Backspace', '[', ']', 'Enter', ' ', 'Shift', 'Tab']
const MAJOR_NUDGE_FACTOR = 10
const MINOR_NUDGE_FACTOR = 1
const GRID_INCREMENT = 5

// --- BrowseIdle state ---

export class BrowseIdle extends StateNode {
  static override id = 'idle'

  selectedShapesOnKeyDown: TLShape[] = []
  private _deselHandler: ((e: PointerEvent) => void) | null = null
  private _selUnsub: (() => void) | null = null
  private _selectedFleetIds = new Set<string>()

  override onEnter() {
    this.parent.setCurrentToolIdMask(undefined)
    updateHoveredShapeId(this.editor)
    this.selectedShapesOnKeyDown = []
    this.editor.setCursor({ type: 'default', rotation: 0 })

    // Capture-phase listener: clears selection when clicking outside the
    // selected shape.  Runs before fleet shapes' stopEventPropagation can
    // swallow the event, so the state machine always sees the click.
    this._deselHandler = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null

      // Mark anchor link clicks as handled so tldraw skips setPointerCapture —
      // letting the click event reach the <a data-anchor> element naturally.
      if (target?.closest('[data-anchor]')) {
        this.editor.markEventAsHandled(e)
      }

      const selected = this.editor.getSelectedShapeIds()
      if (selected.length === 0) return
      if (!target) return

      // In HUD layout mode, don't deselect on empty-area clicks — let TLDraw
      // handle it via pointing_canvas (BrowsePointingCanvas skips selectNone).
      // Uses a JS ref (not the CSS class) to avoid circular dependency.
      if (fleetLayoutActiveRef.current && target.closest('.fleet-hud-wrap .tl-canvas')) return

      // If clicking on a tldraw selection/resize handle, don't interfere
      if (target.closest('.tl-corner-handle, .tl-resize-handle, .tl-selection__fg')) return

      // Check if the click is inside the selected shape's DOM element
      // Scope to main editor container — document.querySelector would find
      // the HUD editor's copy of the shape first (same shape IDs, synced store).
      const container = this.editor.getContainer()
      const pagePoint = this.editor.screenToPage({ x: e.clientX, y: e.clientY })
      for (const id of selected) {
        const el = container.querySelector(`[data-shape-id="${id}"]`)
        if (el?.contains(target)) return
        // When a fleet shape has pointer-events:none (drag mode), the click
        // passes through the DOM, so el.contains fails. Fall back to geometric
        // bounds check so we don't deselect during drag.
        const bounds = this.editor.getShapePageBounds(id)
        if (bounds?.containsPoint(pagePoint)) return
      }

      this.editor.selectNone()
    }

    const container = this.editor.getContainer()
    container.addEventListener('pointerdown', this._deselHandler, { capture: true })

    // Selection → pointer-events sync: when a fleet shape is selected,
    // disable pointer-events on its content so clicks pass through to
    // tldraw's canvas (enabling drag/resize). On deselect, restore them.
    this._updateFleetPointerEvents()
    this._selUnsub = this.editor.store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'instance_page_state') {
          this._updateFleetPointerEvents()
          return
        }
      }
    }, { scope: 'session', source: 'all' })
  }

  override onExit() {
    updateHoveredShapeId.cancel()
    if (this._deselHandler) {
      const container = this.editor.getContainer()
      container.removeEventListener('pointerdown', this._deselHandler, { capture: true })
      this._deselHandler = null
    }
    if (this._selUnsub) { this._selUnsub(); this._selUnsub = null }
    this._restoreAllFleetPointerEvents()
  }

  private _updateFleetPointerEvents() {
    const container = this.editor.getContainer()
    const selected = new Set(this.editor.getSelectedShapeIds() as string[])

    // Restore deselected fleet shapes
    for (const id of this._selectedFleetIds) {
      if (!selected.has(id)) {
        const el = container.querySelector(`[data-shape-id="${id}"]`)
        el?.classList.remove('fleet-drag-mode')
      }
    }

    // Mark newly selected fleet shapes for drag mode.
    // CSS rule makes .fleet-drag-mode .tl-html-container { pointer-events: none }
    // so clicks pass through to tldraw's canvas for drag/resize.
    const newFleet = new Set<string>()
    for (const id of selected) {
      const shape = this.editor.getShape(id as any)
      if (shape && FLEET_TYPES.has(shape.type as string)) {
        newFleet.add(id)
        if (!this._selectedFleetIds.has(id)) {
          const el = container.querySelector(`[data-shape-id="${id}"]`)
          el?.classList.add('fleet-drag-mode')
        }
      }
    }
    this._selectedFleetIds = newFleet
  }

  private _restoreAllFleetPointerEvents() {
    const container = this.editor.getContainer()
    for (const id of this._selectedFleetIds) {
      const el = container.querySelector(`[data-shape-id="${id}"]`)
      el?.classList.remove('fleet-drag-mode')
    }
    this._selectedFleetIds.clear()
  }

  override onPointerMove() {
    updateHoveredShapeId(this.editor)
  }

  override onPointerDown(info: TLPointerEventInfo) {
    switch (info.target) {
      case 'canvas': {
        const hitShape = getHitShapeOnCanvasPointerDown(this.editor)

        // ===== BROWSE ADDITION: fleet/HTML shape passthrough =====
        // Fleet shapes and locked HTML pages get DOM passthrough when NOT selected.
        // When selected (via ⊞ button), fall through so the shape can be dragged/resized.
        if (hitShape && (FLEET_TYPES.has(hitShape.type as string) || hitShape.isLocked)) {
          if (this.editor.getSelectedShapeIds().includes(hitShape.id)) {
            // Shape is selected — treat as pointing_selection for drag
            this.onPointerDown({ ...info, target: 'selection' })
            return
          }
          // Fleet shapes: always pass through to DOM (content interaction)
          if (FLEET_TYPES.has(hitShape.type as string)) {
            this.editor.selectNone()
            return
          }
          // Locked non-fleet shapes (document pages, etc.) in the HUD overlay:
          // treat as empty canvas so drag-box select works over document backgrounds.
          // In the main canvas, keep passing through to DOM.
          if (fleetLayoutActiveRef.current && this.editor.getContainer().closest('.fleet-hud-wrap')) {
            this.parent.transition('pointing_canvas', info)
            return
          }
          this.editor.selectNone()
          return
        }
        // ===== END BROWSE ADDITION =====

        if (hitShape && !hitShape.isLocked) {
          this.onPointerDown({
            ...info,
            shape: hitShape,
            target: 'shape',
          })
          return
        }

        const selectedShapeIds = this.editor.getSelectedShapeIds()
        const onlySelectedShape = this.editor.getOnlySelectedShape()
        const currentPagePoint = this.editor.inputs.getCurrentPagePoint()

        if (
          selectedShapeIds.length > 1 ||
          (onlySelectedShape && FLEET_TYPES.has(onlySelectedShape.type as string)) ||
          (onlySelectedShape &&
            !this.editor.getShapeUtil(onlySelectedShape).hideSelectionBoundsBg(onlySelectedShape))
        ) {
          if (isPointInRotatedSelectionBounds(this.editor, currentPagePoint)) {
            this.onPointerDown({
              ...info,
              target: 'selection',
            })
            return
          }
        }

        this.parent.transition('pointing_canvas', info)
        break
      }
      case 'shape': {
        const { shape } = info

        // ===== BROWSE ADDITION: fleet shapes =====
        // When selected: allow drag (pointing_selection). When not: DOM passthrough.
        if (FLEET_TYPES.has(shape.type as string)) {
          if (this.editor.getSelectedShapeIds().includes(shape.id)) {
            this.parent.transition('pointing_selection', info)
            break
          }
          this.editor.selectNone()
          return
        }
        // ===== END BROWSE ADDITION =====

        if (this.editor.isShapeOrAncestorLocked(shape)) {
          // Locked HTML pages: same pattern as fleet shapes
          if (shape.isLocked) {
            if (this.editor.getSelectedShapeIds().includes(shape.id)) {
              this.parent.transition('pointing_selection', info)
              break
            }
            this.editor.selectNone()
            return
          }
          this.parent.transition('pointing_canvas', info)
          break
        }

        this.parent.transition('pointing_shape', info)
        break
      }
      case 'handle': {
        if (this.editor.getIsReadonly()) break
        if (this.editor.inputs.getAltKey()) {
          this.parent.transition('pointing_shape', info)
        } else {
          this.parent.transition('pointing_handle', info)
        }
        break
      }
      case 'selection': {
        switch (info.handle) {
          case 'mobile_rotate':
          case 'top_left_rotate':
          case 'top_right_rotate':
          case 'bottom_left_rotate':
          case 'bottom_right_rotate': {
            if (info.accelKey) {
              this.parent.transition('brushing', info)
              break
            }
            this.parent.transition('pointing_rotate_handle', info)
            break
          }
          case 'top':
          case 'right':
          case 'bottom':
          case 'left':
          case 'top_left':
          case 'top_right':
          case 'bottom_left':
          case 'bottom_right': {
            const onlySelectedShape = this.editor.getOnlySelectedShape()
            if (info.ctrlKey && this.editor.canCropShape(onlySelectedShape)) {
              this.parent.transition('crop.pointing_crop_handle', info)
            } else {
              if (info.accelKey) {
                this.parent.transition('brushing', info)
                break
              }
              this.parent.transition('pointing_resize_handle', info)
            }
            break
          }
          default: {
            const hoveredShape = this.editor.getHoveredShape()
            if (
              hoveredShape &&
              !this.editor.getSelectedShapeIds().includes(hoveredShape.id) &&
              !hoveredShape.isLocked
            ) {
              this.onPointerDown({
                ...info,
                shape: hoveredShape,
                target: 'shape',
              })
              return
            }

            this.parent.transition('pointing_selection', info)
          }
        }
        break
      }
    }
  }

  override onDoubleClick(info: TLClickEventInfo) {
    if (this.editor.inputs.getShiftKey() || info.phase !== 'up') return
    if (info.ctrlKey || info.shiftKey) return

    switch (info.target) {
      case 'canvas': {
        const hoveredShape = this.editor.getHoveredShape()
        const currentPagePoint = this.editor.inputs.getCurrentPagePoint()
        const hitShape =
          hoveredShape && !this.editor.isShapeOfType(hoveredShape, 'group')
            ? hoveredShape
            : (this.editor.getSelectedShapeAtPoint(currentPagePoint) ??
                this.editor.getShapeAtPoint(currentPagePoint, {
                  margin: this.editor.options.hitTestMargin / this.editor.getZoomLevel(),
                  hitInside: false,
                }))

        const focusedGroupId = this.editor.getFocusedGroupId()

        if (hitShape) {
          if (this.editor.isShapeOfType(hitShape, 'group')) {
            selectOnCanvasPointerUp(this.editor, info)
            return
          } else {
            const parent = this.editor.getShape(hitShape.parentId)
            if (parent && this.editor.isShapeOfType(parent, 'group')) {
              if (focusedGroupId && parent.id === focusedGroupId) {
                // noop
              } else {
                selectOnCanvasPointerUp(this.editor, info)
                return
              }
            }
          }

          this.onDoubleClick({
            ...info,
            shape: hitShape,
            target: 'shape',
          })
          return
        }

        // ===== BROWSE ADDITION: don't create text when double-clicking inside a fleet shape =====
        // getShapeAtPoint above uses hitInside:false so it misses fleet shape interiors.
        // Check explicitly before falling through to handleDoubleClickOnCanvas.
        const fleetHit = this.editor.getShapeAtPoint(
          this.editor.inputs.getCurrentPagePoint(),
          { hitInside: true, hitLocked: false, hitLabels: false, renderingOnly: true,
            margin: this.editor.options.hitTestMargin / this.editor.getZoomLevel(),
            filter: (s) => FLEET_TYPES.has(s.type as string) }
        )
        if (fleetHit) return
        // ===== END BROWSE ADDITION =====

        if (!this.editor.inputs.getShiftKey()) {
          this.handleDoubleClickOnCanvas(info)
        }
        break
      }
      case 'selection': {
        const onlySelectedShape = this.editor.getOnlySelectedShape()

        if (onlySelectedShape) {
          const util = this.editor.getShapeUtil(onlySelectedShape)
          const isEdge = info.handle === 'right' || info.handle === 'left' || info.handle === 'top' || info.handle === 'bottom'
          const isCorner = info.handle === 'top_left' || info.handle === 'top_right' || info.handle === 'bottom_right' || info.handle === 'bottom_left'

          if (this.editor.getIsReadonly()) {
            if (this.editor.canEditShape(onlySelectedShape, {
              type: isCorner ? 'double-click-corner' : isEdge ? 'double-click-edge' : 'double-click',
            })) {
              this.startEditingShape(onlySelectedShape, info, true)
            }
            break
          }

          if (isEdge) {
            const change = util.onDoubleClickEdge?.(onlySelectedShape, info)
            if (change) {
              this.editor.markHistoryStoppingPoint('double click edge')
              this.editor.updateShapes([change])
              kickoutOccludedShapes(this.editor, [onlySelectedShape.id])
              return
            }
          }

          if (isCorner) {
            const change = util.onDoubleClickCorner?.(onlySelectedShape, info)
            if (change) {
              this.editor.markHistoryStoppingPoint('double click corner')
              this.editor.updateShapes([change])
              kickoutOccludedShapes(this.editor, [onlySelectedShape.id])
              return
            }
          }

          if (this.editor.canCropShape(onlySelectedShape)) {
            this.parent.transition('crop', info)
            return
          }

          if (this.editor.canEditShape(onlySelectedShape)) {
            this.startEditingShape(onlySelectedShape, info, true)
          }
        }
        break
      }
      case 'shape': {
        const { shape } = info
        const util = this.editor.getShapeUtil(shape)

        // ===== BROWSE ADDITION: fleet shapes don't edit — eat the double-click =====
        if (FLEET_TYPES.has(shape.type as string)) return
        // ===== END BROWSE ADDITION =====

        if (shape.type !== 'video' && shape.type !== 'embed' && this.editor.getIsReadonly()) break

        if (util.onDoubleClick) {
          const change = util.onDoubleClick?.(shape)
          if (change) {
            this.editor.updateShapes([change])
            return
          }
        }

        if (util.canCrop(shape) && !this.editor.isShapeOrAncestorLocked(shape)) {
          this.editor.markHistoryStoppingPoint('select and crop')
          this.editor.select(info.shape?.id)
          this.parent.transition('crop', info)
          return
        }

        if (this.editor.canEditShape(shape)) {
          this.startEditingShape(shape, info, true)
        } else {
          this.handleDoubleClickOnCanvas(info)
        }
        break
      }
      case 'handle': {
        if (this.editor.getIsReadonly()) break
        const { shape, handle } = info
        const util = this.editor.getShapeUtil(shape)
        const changes = util.onDoubleClickHandle?.(shape, handle)
        if (changes) {
          this.editor.updateShapes([changes])
        } else {
          if (this.editor.canEditShape(shape)) {
            this.startEditingShape(shape, info, true)
          }
        }
      }
    }
  }

  override onRightClick(info: TLPointerEventInfo) {
    switch (info.target) {
      case 'canvas': {
        const hoveredShape = this.editor.getHoveredShape()
        const hitShape =
          hoveredShape && !this.editor.isShapeOfType(hoveredShape, 'group')
            ? hoveredShape
            : this.editor.getShapeAtPoint(this.editor.inputs.getCurrentPagePoint(), {
                margin: this.editor.options.hitTestMargin / this.editor.getZoomLevel(),
                hitInside: false,
                hitLabels: true,
                hitLocked: true,
                hitFrameInside: true,
                renderingOnly: true,
              })

        if (hitShape) {
          this.onRightClick({ ...info, shape: hitShape, target: 'shape' })
          return
        }

        const selectedShapeIds = this.editor.getSelectedShapeIds()
        const onlySelectedShape = this.editor.getOnlySelectedShape()
        const currentPagePoint = this.editor.inputs.getCurrentPagePoint()

        if (
          selectedShapeIds.length > 1 ||
          (onlySelectedShape && FLEET_TYPES.has(onlySelectedShape.type as string)) ||
          (onlySelectedShape &&
            !this.editor.getShapeUtil(onlySelectedShape).hideSelectionBoundsBg(onlySelectedShape))
        ) {
          if (isPointInRotatedSelectionBounds(this.editor, currentPagePoint)) {
            this.onRightClick({ ...info, target: 'selection' })
            return
          }
        }

        this.editor.selectNone()
        break
      }
      case 'shape': {
        const { selectedShapeIds } = this.editor.getCurrentPageState()
        const { shape } = info
        const targetShape = this.editor.getOutermostSelectableShape(
          shape,
          (parent) => !selectedShapeIds.includes(parent.id)
        )
        if (
          !selectedShapeIds.includes(targetShape.id) &&
          !this.editor.findShapeAncestor(targetShape, (shape) =>
            selectedShapeIds.includes(shape.id)
          )
        ) {
          this.editor.markHistoryStoppingPoint('selecting shape')
          this.editor.setSelectedShapes([targetShape.id])
        }
        break
      }
    }
  }

  override onCancel() {
    if (
      this.editor.getFocusedGroupId() !== this.editor.getCurrentPageId() &&
      this.editor.getSelectedShapeIds().length > 0
    ) {
      this.editor.popFocusedGroupId()
    } else {
      this.editor.markHistoryStoppingPoint('clearing selection')
      this.editor.selectNone()
    }
  }

  override onKeyDown(info: TLKeyboardEventInfo) {
    this.selectedShapesOnKeyDown = this.editor.getSelectedShapes()

    switch (info.code) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (info.accelKey) {
          if (info.shiftKey) {
            if (info.code === 'ArrowDown') {
              this.editor.selectFirstChildShape()
            } else if (info.code === 'ArrowUp') {
              this.editor.selectParentShape()
            }
          } else {
            this.editor.selectAdjacentShape(
              info.code.replace('Arrow', '').toLowerCase() as TLAdjacentDirection
            )
          }
          return
        }
        this.nudgeSelectedShapes(false)
        return
      }
    }

    if (!SKIPPED_KEYS_FOR_AUTO_EDITING.includes(info.key) && !info.altKey && !info.ctrlKey) {
      const onlySelectedShape = this.editor.getOnlySelectedShape()
      if (
        onlySelectedShape &&
        this.editor.isShapeOfType(onlySelectedShape, 'note') &&
        this.editor.canEditShape(onlySelectedShape)
      ) {
        this.startEditingShape(onlySelectedShape, info, true)
        return
      }
    }
  }

  override onKeyRepeat(info: TLKeyboardEventInfo) {
    switch (info.code) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (info.accelKey) {
          this.editor.selectAdjacentShape(
            info.code.replace('Arrow', '').toLowerCase() as TLAdjacentDirection
          )
          return
        }
        this.nudgeSelectedShapes(true)
        break
      }
      case 'Tab': {
        const selectedShapes = this.editor.getSelectedShapes()
        if (selectedShapes.length && !info.altKey) {
          this.editor.selectAdjacentShape(info.shiftKey ? 'prev' : 'next')
        }
        break
      }
    }
  }

  override onKeyUp(info: TLKeyboardEventInfo) {
    switch (info.key) {
      case 'Enter': {
        if (!this.selectedShapesOnKeyDown.length) return
        const selectedShapes = this.editor.getSelectedShapes()
        if (selectedShapes.every((shape) => this.editor.isShapeOfType(shape, 'group'))) {
          this.editor.setSelectedShapes(
            selectedShapes.flatMap((shape) => this.editor.getSortedChildIdsForParent(shape.id))
          )
          return
        }
        const onlySelectedShape = this.editor.getOnlySelectedShape()
        if (
          onlySelectedShape &&
          this.editor.canEditShape(onlySelectedShape, { type: 'press_enter' })
        ) {
          this.startEditingShape(onlySelectedShape, info, true)
          return
        }
        if (this.editor.canCropShape(onlySelectedShape)) {
          this.parent.transition('crop', info)
        }
        break
      }
      case 'Tab': {
        const selectedShapes = this.editor.getSelectedShapes()
        if (selectedShapes.length && !info.altKey) {
          this.editor.selectAdjacentShape(info.shiftKey ? 'prev' : 'next')
        }
        break
      }
    }
  }

  private startEditingShape(
    shape: TLShape,
    info: TLClickEventInfo | TLKeyboardEventInfo,
    shouldSelectAll?: boolean
  ) {
    this.editor.markHistoryStoppingPoint('editing shape')
    if (hasRichText(shape)) {
      startEditingShapeWithRichText(this.editor, shape, { selectAll: shouldSelectAll })
    } else {
      this.editor.setEditingShape(shape)
    }
    this.parent.transition('editing_shape', info)
  }

  handleDoubleClickOnCanvas(_info: TLClickEventInfo) {
    // No-op in browse mode — double-click on empty canvas shouldn't create text shapes
    return
  }

  private nudgeSelectedShapes(ephemeral = false) {
    const { editor: { inputs: { keys } } } = this
    const shiftKey = keys.has('ShiftLeft')
    const delta = new Vec(0, 0)
    if (keys.has('ArrowLeft')) delta.x -= 1
    if (keys.has('ArrowRight')) delta.x += 1
    if (keys.has('ArrowUp')) delta.y -= 1
    if (keys.has('ArrowDown')) delta.y += 1
    if (delta.equals(new Vec(0, 0))) return
    if (!ephemeral) this.editor.markHistoryStoppingPoint('nudge shapes')
    const { gridSize } = this.editor.getDocumentSettings()
    const step = this.editor.getInstanceState().isGridMode
      ? shiftKey ? gridSize * GRID_INCREMENT : gridSize
      : shiftKey ? MAJOR_NUDGE_FACTOR : MINOR_NUDGE_FACTOR
    const selectedShapeIds = this.editor.getSelectedShapeIds()
    this.editor.nudgeShapes(selectedShapeIds, delta.mul(step))
    kickoutOccludedShapes(this.editor, selectedShapeIds)
  }
}

function isPointInRotatedSelectionBounds(editor: Editor, point: VecLike) {
  const selectionBounds = editor.getSelectionRotatedPageBounds()
  if (!selectionBounds) return false
  const selectionRotation = editor.getSelectionRotation()
  if (!selectionRotation) return selectionBounds.containsPoint(point)
  return pointInPolygon(
    point,
    selectionBounds.corners.map((c) => Vec.RotWith(c, selectionBounds.point, selectionRotation))
  )
}
