/**
 * usePageColumn — lazy page column manager.
 *
 * Creates a vertical column of svg-page shapes where only visible pages
 * (plus prefetch) are fetched and rendered. Shape creation is fully
 * imperative (outside React render cycles) to avoid TLDraw hooks crashes.
 */

import { useEffect, useRef, useCallback } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor, TLShapeId } from 'tldraw'
import { setSvgText, deleteSvgText, svgViewBoxStore } from '../stores'
import { TARGET_WIDTH, PAGE_GAP, PDF_WIDTH, PDF_HEIGHT } from '../layoutConstants'

// ── Types ──────────────────────────────────────────────────────────────────

export interface PageSource {
  type: 'live' | 'shadow' | 'snapshot'
  docName: string
  ref?: string
}

export interface PageColumnOptions {
  docName: string
  source: PageSource
  columnX: number
  totalPages: number
  prefetch?: number
  opacity?: number
  yOffset?: number
}

export interface PageColumnHandle {
  loadedPages: ReadonlySet<number>
  destroy: () => void
  setColumnX: (x: number) => void
  setYOffset: (dy: number) => void
}

// ── Constants ──────────────────────────────────────────────────────────────

const PAGE_HEIGHT = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)

// ── Helpers ────────────────────────────────────────────────────────────────

function pageUrl(source: PageSource, docName: string, pageNum: number): string {
  switch (source.type) {
    case 'live':
      return `/docs/${docName}/page-${pageNum}.svg`
    case 'shadow': {
      const hash7 = (source.ref || '').slice(0, 7)
      return `/docs/${docName}/history/shadow-${hash7}/page-${pageNum}.svg`
    }
    case 'snapshot':
      return `/docs/${docName}/history/${source.ref}/page-${pageNum}.svg`
  }
}

let columnSession = 0

function makeShapeId(columnId: string, pageNum: number): TLShapeId {
  return `shape:col-${columnId}-p${pageNum}` as TLShapeId
}

function parseSvgDimensions(svgText: string) {
  const vbMatch = svgText.match(/viewBox="([^"]+)"/)
  if (vbMatch) {
    const parts = vbMatch[1].split(/[\s,]+/).map(Number)
    if (parts.length === 4) {
      return {
        width: parts[2], height: parts[3],
        viewBox: { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] },
      }
    }
  }
  const w = parseFloat(svgText.match(/width="([\d.]+)"/)?.[1] || '') || PDF_WIDTH
  const h = parseFloat(svgText.match(/height="([\d.]+)"/)?.[1] || '') || PDF_HEIGHT
  return { width: w, height: h, viewBox: { minX: 0, minY: 0, width: w, height: h } }
}

function visiblePageRange(
  editor: Editor, columnX: number, totalPages: number, yOffset: number, prefetch: number,
): { first: number; last: number } | null {
  const vp = editor.getViewportPageBounds()
  const columnRight = columnX + TARGET_WIDTH
  if (columnRight < vp.x - TARGET_WIDTH || columnX > vp.x + vp.w + TARGET_WIDTH) return null

  const pageStride = PAGE_HEIGHT + PAGE_GAP
  const first = Math.max(1, Math.floor((vp.y - yOffset) / pageStride) + 1 - prefetch)
  const last = Math.min(totalPages, Math.floor((vp.y + vp.h - yOffset) / pageStride) + 1 + prefetch)
  if (first > totalPages || last < 1) return null
  return { first, last }
}

// ── Imperative column manager ──────────────────────────────────────────────

const AXIS_RATIO = 3  // must exceed this ratio for horizontal movement

class PageColumn {
  editor: Editor
  options: PageColumnOptions
  columnId: string
  loaded = new Set<number>()
  private fetching = new Set<number>()
  destroyed = false
  columnX: number
  private yOffset: number
  private handleId: TLShapeId | null = null
  private handlePos: { x: number; y: number } | null = null
  private handleUnsub: (() => void) | null = null

  constructor(editor: Editor, options: PageColumnOptions) {
    columnSession++
    this.editor = editor
    this.options = options
    this.columnId = `${columnSession}-${options.source.type}-${(options.source.ref || 'live').slice(0, 7)}`
    this.columnX = options.columnX
    this.yOffset = options.yOffset ?? 0
  }

  /** Create a draggable handle line in the gap between columns */
  createHandle(mainRightEdge: number) {
    const isRight = this.columnX > mainRightEdge
    const handleX = isRight
      ? mainRightEdge + (this.columnX - mainRightEdge) / 2
      : this.columnX + TARGET_WIDTH + (mainRightEdge - this.columnX - TARGET_WIDTH) / 2

    // Deterministic ID based on source ref — stable across sessions so Yjs doesn't accumulate
    const hash7 = (this.options.source.ref || 'live').slice(0, 7)
    this.handleId = createShapeId(`shadow-col-handle-${hash7}`)

    // Sweep ALL existing shadow column handles (any hash7, any session) before creating new one
    for (const s of this.editor.getCurrentPageShapes()) {
      if ((s.id as string).startsWith('shape:shadow-col-handle-')) {
        if (s.isLocked) this.editor.updateShape({ id: s.id, type: s.type, isLocked: false })
        this.editor.deleteShapes([s.id])
      }
    }

    // Render as a very thin geo rectangle — 0.25 canvas units wide, hairline divider
    const handleH = 99999
    const handleY = this.yOffset - handleH / 2
    this.editor.createShape({
      id: this.handleId,
      type: 'geo' as any,
      x: handleX - 0.125, y: handleY,
      isLocked: false, opacity: 0.05,
      props: {
        w: 0.25, h: handleH,
        geo: 'rectangle', color: 'grey', fill: 'solid', dash: 'solid', size: 's',
      },
    })
    this.handlePos = { x: handleX - 0.125, y: handleY }

    // Listen for handle drag — apply Y offset (default) or X gap (if strongly horizontal)
    this.handleUnsub = this.editor.store.listen(({ changes }) => {
      if (this.destroyed || !this.handleId) return
      for (const [, to] of Object.values(changes.updated)) {
        const rec = to as any
        if (rec.typeName !== 'shape' || rec.id !== this.handleId) continue
        const prev = this.handlePos
        if (!prev) { this.handlePos = { x: rec.x, y: rec.y }; return }

        const dx = rec.x - prev.x
        const dy = rec.y - prev.y
        this.handlePos = { x: rec.x, y: rec.y }
        if (Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) return

        // Axis lock: vertical by default, horizontal only if strongly horizontal
        const applyDx = Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? dx : 0
        const applyDy = dy

        // Defer store mutations (can't write inside a listener)
        setTimeout(() => {
          if (this.destroyed) return
          // Apply Y offset to all column pages
          if (Math.abs(applyDy) > 0.5) {
            this.yOffset += applyDy
            for (const p of this.loaded) {
              const shapeId = makeShapeId(this.columnId, p)
              const shape = this.editor.getShape(shapeId)
              if (shape) {
                if (shape.isLocked) this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
                this.editor.updateShape({ id: shapeId, type: shape.type, y: shape.y + applyDy })
                this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: true })
              }
            }
          }
          // Apply X gap change to all column pages
          if (Math.abs(applyDx) > 0.5) {
            this.columnX += applyDx
            for (const p of this.loaded) {
              const shapeId = makeShapeId(this.columnId, p)
              const shape = this.editor.getShape(shapeId)
              if (shape) {
                if (shape.isLocked) this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
                this.editor.updateShape({ id: shapeId, type: shape.type, x: this.columnX })
                this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: true })
              }
            }
          }
        }, 0)
      }
    })
  }

  private removePages(pages: number[]) {
    if (pages.length === 0) return
    for (const p of pages) {
      const shapeId = makeShapeId(this.columnId, p)
      deleteSvgText(shapeId as string)
      svgViewBoxStore.delete(shapeId as string)
      this.loaded.delete(p)
      const shape = this.editor.getShape(shapeId)
      if (shape) {
        if (shape.isLocked) this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
        this.editor.deleteShapes([shapeId])
      }
    }
  }

  private async createPage(pageNum: number) {
    if (this.destroyed || this.loaded.has(pageNum) || this.fetching.has(pageNum)) return
    this.fetching.add(pageNum)
    try {
      const url = pageUrl(this.options.source, this.options.docName, pageNum)
      const resp = await fetch(url)
      if (!resp.ok || this.destroyed) return
      const svgText = await resp.text()
      if (this.destroyed) return

      const dims = parseSvgDimensions(svgText)
      const scale = TARGET_WIDTH / dims.width
      const shapeId = makeShapeId(this.columnId, pageNum)
      setSvgText(shapeId as string, svgText)
      svgViewBoxStore.set(shapeId as string, dims.viewBox)

      if (this.destroyed) return  // final check before creating shape
      const pageY = this.yOffset + (pageNum - 1) * (PAGE_HEIGHT + PAGE_GAP)
      if (!this.editor.getShape(shapeId)) {
        this.editor.createShape({
          id: shapeId, type: 'svg-page' as any,
          x: this.columnX, y: pageY,
          isLocked: true, opacity: this.options.opacity ?? 0.9,
          props: { w: TARGET_WIDTH, h: dims.height * scale, pageIndex: pageNum - 1 },
        })
      }
      this.loaded.add(pageNum)
    } catch (e) {
      console.warn(`[page-column] fetch page ${pageNum} failed:`, e)
    } finally {
      this.fetching.delete(pageNum)
    }
  }

  sync() {
    if (this.destroyed) return
    const range = visiblePageRange(
      this.editor, this.columnX, this.options.totalPages,
      this.yOffset, this.options.prefetch ?? 1,
    )
    if (!range) {
      if (this.loaded.size > 0) this.removePages([...this.loaded])
      return
    }

    // Remove pages far from viewport
    const toRemove: number[] = []
    for (const p of this.loaded) {
      if (p < range.first - 3 || p > range.last + 3) toRemove.push(p)
    }
    if (toRemove.length > 0) this.removePages(toRemove)

    // Add missing pages (sequential fetch)
    const toAdd: number[] = []
    for (let p = range.first; p <= range.last; p++) {
      if (!this.loaded.has(p) && !this.fetching.has(p)) toAdd.push(p)
    }
    if (toAdd.length > 0) {
      ;(async () => {
        for (const p of toAdd) {
          if (this.destroyed) break
          await this.createPage(p)
        }
      })()
    }
  }

  destroy() {
    this.destroyed = true
    // Stop listening for handle drags
    this.handleUnsub?.()
    this.handleUnsub = null
    // Remove handle shape
    if (this.handleId) {
      const h = this.editor.getShape(this.handleId)
      if (h) {
        if (h.isLocked) this.editor.updateShape({ id: this.handleId, type: h.type, isLocked: false })
        this.editor.deleteShapes([this.handleId])
      }
      this.handleId = null
    }
    // Clean up orphan handles from old session-counter-based naming scheme
    for (const s of this.editor.getCurrentPageShapes()) {
      if (/^shape:col-\d+.*-handle$/.test(s.id as string)) {
        if (s.isLocked) this.editor.updateShape({ id: s.id, type: s.type, isLocked: false })
        this.editor.deleteShapes([s.id])
      }
    }
    // Remove tracked pages
    if (this.loaded.size > 0) this.removePages([...this.loaded])
    // Scan for orphan shapes from in-flight fetches
    const prefix = `shape:col-${this.columnId}-`
    const orphans = this.editor.getCurrentPageShapes()
      .filter(s => (s.id as string).startsWith(prefix))
    for (const s of orphans) {
      deleteSvgText(s.id as string)
      svgViewBoxStore.delete(s.id as string)
      if (s.isLocked) this.editor.updateShape({ id: s.id, type: s.type, isLocked: false })
      this.editor.deleteShapes([s.id])
    }
    this.loaded = new Set()
    this.fetching = new Set()
  }

  setColumnX(x: number) {
    this.columnX = x
    for (const p of this.loaded) {
      const shapeId = makeShapeId(this.columnId, p)
      const shape = this.editor.getShape(shapeId)
      if (shape) {
        if (shape.isLocked) this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
        this.editor.updateShape({ id: shapeId, type: shape.type, x })
        this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: true })
      }
    }
  }

  setYOffset(dy: number) {
    const delta = dy - this.yOffset
    this.yOffset = dy
    for (const p of this.loaded) {
      const shapeId = makeShapeId(this.columnId, p)
      const shape = this.editor.getShape(shapeId)
      if (shape) {
        if (shape.isLocked) this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
        this.editor.updateShape({ id: shapeId, type: shape.type, y: shape.y + delta })
        this.editor.updateShape({ id: shapeId, type: shape.type, isLocked: true })
      }
    }
  }
}

// ── React hook ─────────────────────────────────────────────────────────────

export function usePageColumn(
  editor: Editor | null,
  options: PageColumnOptions | null,
): PageColumnHandle | null {
  // Manage column imperatively via refs — render-time reconciliation avoids
  // React Strict Mode double-fire issues that destroy columns mid-fetch.
  const columnRef = useRef<PageColumn | null>(null)
  // '__startup__' sentinel so the first null→null transition fires reconcile for orphan cleanup
  const activeKeyRef = useRef<string | null>('__startup__')
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const optionsKey = options
    ? `${options.source.type}:${options.source.ref || 'live'}:${options.docName}`
    : null

  // Reconcile column state on every render.
  if (optionsKey !== activeKeyRef.current) {
    // Destroy previous column.
    // Unsub camera listener synchronously (prevents new shape creation).
    // Defer shape deletion to avoid mutating TLDraw store during render.
    const prevCol = columnRef.current
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    if (prevCol) {
      columnRef.current = null
      prevCol.destroyed = true  // stop in-flight fetches immediately
      // Defer shape deletion — must happen after React finishes rendering.
      // Use requestAnimationFrame (not setTimeout/queueMicrotask) because
      // React may still be in its commit phase during setTimeout(0).
      requestAnimationFrame(() => { if (prevCol.destroyed) prevCol.destroy() })
    }
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current)
      syncTimerRef.current = null
    }
    activeKeyRef.current = optionsKey

    // Startup orphan cleanup: on the first transition (from '__startup__' sentinel to null),
    // sweep handle shapes AND page column shapes left over from previous sessions.
    if (!options && editor) {
      requestAnimationFrame(() => {
        if (columnRef.current) return  // column was created before rAF fired
        for (const s of editor.getCurrentPageShapes()) {
          const id = s.id as string
          if (id.startsWith('shape:shadow-col-handle-') || /^shape:col-\d+-shadow-/.test(id)) {
            if (s.isLocked) editor.updateShape({ id: s.id, type: s.type, isLocked: false })
            editor.deleteShapes([s.id])
          }
        }
      })
    }

    // Create new column
    if (editor && options) {
      const col = new PageColumn(editor, options)
      columnRef.current = col

      // Deferred initial sync + handle creation
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null
        if (col.destroyed) return
        col.sync()
        // Create handle after first sync — compute main document edge
        if (!col.handleId) {
          const mainPages = editor.getCurrentPageShapes()
            .filter(s => (s as any).type === 'svg-page' && !(s.id as string).includes('col-'))
          let mainEdge = 0
          for (const p of mainPages) {
            const b = editor.getShapePageBounds(p.id)
            if (b && b.x + b.w > mainEdge) mainEdge = b.x + b.w
          }
          col.createHandle(mainEdge)
        }
      }, 100)

      // Camera listener (throttled)
      let timer: ReturnType<typeof setTimeout> | null = null
      const unsub = editor.store.listen(() => {
        if (timer || col.destroyed) return
        timer = setTimeout(() => {
          timer = null
          if (!col.destroyed) col.sync()
        }, 150)
      }, { source: 'user', scope: 'session' })
      unsubRef.current = () => {
        if (timer) clearTimeout(timer)
        unsub()
      }
    }
  }

  // No useEffect for cleanup — React Strict Mode double-fires effects,
  // which destroys columns mid-fetch. Cleanup happens via reconciliation
  // when optionsKey changes to null (consumer sets options to null).

  const destroy = useCallback(() => {
    const col = columnRef.current
    const unsub = unsubRef.current
    columnRef.current = null
    unsubRef.current = null
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    activeKeyRef.current = null
    // Defer store mutations to avoid crashing during React render
    setTimeout(() => {
      col?.destroy()
      unsub?.()
    }, 0)
  }, [])

  const setColumnX = useCallback((x: number) => { columnRef.current?.setColumnX(x) }, [])
  const setYOffset = useCallback((dy: number) => { columnRef.current?.setYOffset(dy) }, [])

  if (!editor || !options) return null

  return {
    loadedPages: columnRef.current?.loaded ?? new Set(),
    destroy,
    setColumnX,
    setYOffset,
  }
}
