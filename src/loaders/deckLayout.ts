/**
 * Where a deck's slides sit on the canvas.
 *
 * Skip, 2026-09-01, working it out from the interface rather than the code:
 *
 *   "I guess it's they're not spatially laid out. That's a good point. The
 *    controls are semantic ... time to fix fucking reveal's layout bullshit.
 *    And we can do it"
 *
 * In reveal, `h`/`v` are navigation structure — addresses — and only the current
 * slide has a box. Nothing is spatially anywhere. So there is no reveal layout
 * to inherit or fight:
 *
 *   reveal  gives  existence + address  (h, v, f)
 *   tlda    gives  position
 *
 * This module is the whole of "position", and it is deliberately pure: it takes
 * addresses and returns rectangles. It runs on the client, and the rectangles
 * are POSTED to the deck's bridge, which only applies numbers. That keeps one
 * implementation of the rule rather than one on each side of the iframe, and it
 * means changing the layout does not touch the injector.
 *
 * The gap is a fraction of a slide rather than a constant, because what it
 * separates is slides — the same reasoning the old per-slide loader used, from
 * Skip: "maybe the slides should be half a slide. Apart."
 */

export type DeckLayoutMode = 'horizontal' | 'vertical'

export interface DeckSlide {
  index: number
  indexh: number
  indexv: number
  title?: string
  id?: string
}

export interface DeckLayoutOptions {
  /** Authored slide size, from the deck's own Reveal.initialize({width, height}). */
  width: number
  height: number
  /**
   * Skip: "I'm happy to have fucking slide layout be, like, configurable, like,
   * as an attribute of the deck." Horizontal is the default, not the only one.
   */
  mode?: DeckLayoutMode
  /** Gap between neighbours, as a fraction of a slide. */
  gap?: number
}

export interface DeckSlideRect {
  index: number
  indexh: number
  indexv: number
  x: number
  y: number
  width: number
  height: number
}

export interface DeckLayout {
  rects: DeckSlideRect[]
  stripWidth: number
  stripHeight: number
}

export const DEFAULT_DECK_GAP = 0.5

/**
 * Lay a deck's addresses out in the plane.
 *
 * `horizontal` is Skip's rule: horizontals across, verticals down under their
 * own column. It is the deck's own structure made spatial — a column per `h`,
 * and a slide per `v` beneath it — so a deck with no verticals is one row and
 * needs no special case.
 */
export function deckLayout(slides: DeckSlide[], options: DeckLayoutOptions): DeckLayout {
  const { width, height, mode = 'horizontal', gap = DEFAULT_DECK_GAP } = options
  const colStride = width * (1 + gap)
  const rowStride = height * (1 + gap)

  // ONE LINE, in reading order. Not a grid.
  //
  // Laying verticals DOWN made the deck a plane -- measured on his deck,
  // 7095 x 31000 -- and a plane is what let the camera come to rest between
  // slide boundaries, so a slide clipped vertically. Skip, on his own tab:
  // slides must not clip, and that is why the layout has to be horizontal.
  //
  // A single row cannot clip vertically: there is only ever one slide on the
  // vertical axis, so any camera that fits a slide's height fits every slide.
  // The deck's `v` addresses still exist and still travel in the rect -- they
  // are how up/down navigation works -- they just do not consume a second
  // spatial axis.
  const rects = slides.map((slide, i) => {
    const along = mode === 'horizontal' ? i * colStride : 0
    const down = mode === 'horizontal' ? 0 : i * rowStride
    return {
      index: slide.index,
      indexh: slide.indexh,
      indexv: slide.indexv,
      x: along,
      y: down,
      width,
      height,
    }
  })

  // The extent is the slides' own, not a count: a deck whose columns are uneven
  // has no rectangular grid, and asking max() of what is actually there avoids
  // inventing empty space under the short columns.
  const right = rects.reduce((max, r) => Math.max(max, r.x + r.width), width)
  const bottom = rects.reduce((max, r) => Math.max(max, r.y + r.height), height)

  return { rects, stripWidth: right, stripHeight: bottom }
}
