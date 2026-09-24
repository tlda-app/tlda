import { useEffect, useState } from 'react'
import { HTMLContainer, stopEventPropagation, useEditor, useValue } from 'tldraw'
import { deckLayout, type DeckSlide, type DeckSlideRect } from '../loaders/deckLayout'
import { SPATIAL_MAP_ZOOM } from '../spatialDocumentWorld'
import './DeckMidLevel.css'

type DeckMidLevelShape = {
  id: string
  x: number
  y: number
  props: { url?: unknown; w: number; h: number }
}

type DeckPageInfo = {
  variant?: string
  width?: number
  height?: number
  slides?: DeckSlide[]
}

/**
 * Mid-level deck sketch: every slide as a clickable cell, in place.
 *
 * A deck shape is one whole-strip iframe, so without this the deck jumps
 * from full content straight to a blank placeholder. The cells come from the
 * build's page-info.json run through the same deckLayout the loader used, so
 * they sit exactly where the slides are. Clicking one zooms the canvas to it.
 */
export function DeckMidLevel({ shape }: { shape: DeckMidLevelShape }) {
  const editor = useEditor()
  const [cells, setCells] = useState<Array<{ rect: DeckSlideRect; title: string }>>([])
  const zoom = useValue(`deck-mid-zoom-${shape.id}`, () => editor.getZoomLevel(), [editor, shape.id])
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    const load = async () => {
      try {
        const pageUrl = new URL(String(shape.props.url || ''), window.location.origin)
        const dir = pageUrl.pathname.slice(0, pageUrl.pathname.lastIndexOf('/') + 1)
        const res = await fetch(`${dir}page-info.json`, { signal: controller.signal })
        if (!res.ok) return
        const infos = await res.json()
        if (!Array.isArray(infos)) return
        const deck = (infos as DeckPageInfo[]).find(info => info?.variant === 'slides' && Array.isArray(info.slides))
          ?? (infos as DeckPageInfo[]).find(info => Array.isArray(info?.slides))
        if (!deck || typeof deck.width !== 'number' || typeof deck.height !== 'number') return
        const layout = deckLayout(deck.slides ?? [], { width: deck.width, height: deck.height })
        const titles = new Map<number, string>()
        for (const slide of deck.slides ?? []) {
          if (slide && typeof slide.title === 'string' && slide.title) titles.set(slide.index, slide.title)
        }
        if (!live) return
        setCells(layout.rects.map(rect => ({
          rect,
          title: titles.get(rect.index) ?? `Slide ${rect.index + 1}`,
        })))
      } catch {
        // A deck with no address space keeps the blank wash below — the same
        // look as the map placeholder, never a broken sketch.
      }
    }
    void load()
    return () => { live = false; controller.abort() }
  }, [shape.props.url])
  // Canvas-space lengths shrink with the zoom; sizing against it keeps
  // titles, padding, and the cell hairline constant in screen px.
  const z = Math.max(zoom, SPATIAL_MAP_ZOOM)
  const titlePx = 13 / z
  const padPx = 10 / z
  const hairPx = 1.2 / z
  return (
    <HTMLContainer>
      <div
        className="deck-mid-level"
        style={{ width: shape.props.w, height: shape.props.h }}
      >
        {cells.map(cell => (
          <button
            key={cell.rect.index}
            type="button"
            className="deck-mid-cell"
            style={{
              left: cell.rect.x,
              top: cell.rect.y,
              width: cell.rect.width,
              height: cell.rect.height,
              boxShadow: `inset 0 0 0 ${hairPx}px color-mix(in srgb, currentColor 22%, transparent)`,
            }}
            onPointerDown={(event) => stopEventPropagation(event)}
            onClick={() => {
              editor.zoomToBounds({
                x: shape.x + cell.rect.x,
                y: shape.y + cell.rect.y,
                w: cell.rect.width,
                h: cell.rect.height,
              }, { animation: { duration: 300 } })
            }}
            title={cell.title}
          >
            <span
              className="deck-mid-cell-title"
              style={{ fontSize: titlePx, top: padPx, left: padPx, right: padPx }}
            >
              {cell.title}
            </span>
          </button>
        ))}
      </div>
    </HTMLContainer>
  )
}
