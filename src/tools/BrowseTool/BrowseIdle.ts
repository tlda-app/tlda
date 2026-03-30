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
  createShapeId,
  kickoutOccludedShapes,
  pointInPolygon,
  toRichText,
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

// --- Fleet shape types that get DOM interaction ---
const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search'])

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

  override onEnter() {
    this.parent.setCurrentToolIdMask(undefined)
    updateHoveredShapeId(this.editor)
    this.selectedShapesOnKeyDown = []
    this.editor.setCursor({ type: 'default', rotation: 0 })
  }

  override onExit() {
    updateHoveredShapeId.cancel()
  }

  override onPointerMove() {
    updateHoveredShapeId(this.editor)
  }

  override onPointerDown(info: TLPointerEventInfo) {
    switch (info.target) {
      case 'canvas': {
        const hitShape = getHitShapeOnCanvasPointerDown(this.editor)

        // ===== BROWSE ADDITION: locked HTML page (iframe) passthrough =====
        // Locked HTML pages should let the DOM handle clicks (iframe navigation etc).
        if (hitShape && hitShape.isLocked) return
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

        if (this.editor.isShapeOrAncestorLocked(shape)) {
          // ===== BROWSE ADDITION: fleet/HTML shapes stay idle =====
          // Locked fleet shapes: DOM handles events (passthrough)
          if (FLEET_TYPES.has(shape.type as string) && shape.isLocked) return
          // Other locked shapes (HTML pages): stay idle for DOM passthrough
          if (shape.isLocked) return
          // ===== END BROWSE ADDITION =====
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

  handleDoubleClickOnCanvas(info: TLClickEventInfo) {
    if (this.editor.getIsReadonly()) return
    if (!this.editor.options.createTextOnCanvasDoubleClick) return

    this.editor.markHistoryStoppingPoint('creating text shape')
    const id = createShapeId()
    const { x, y } = this.editor.inputs.getCurrentPagePoint()
    this.editor.createShapes([{
      id,
      type: 'text',
      x,
      y,
      props: { richText: toRichText(''), autoSize: true },
    }])
    const shape = this.editor.getShape(id)
    if (!shape) return
    if (!this.editor.canEditShape(shape)) return
    startEditingShapeWithRichText(this.editor, id, { info })
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
