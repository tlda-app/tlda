import { presentationLocationMatchesPage, type PresentationRoute } from './presentationRoute.ts'

/** The pages SvgDocument hands the restore block: a 1-based page number. */
export interface RoutablePage {
  src: string
  source?: { file?: string }
}

/**
 * The 1-based page number a deck/chapter route resolves to, or null when no
 * page matches. This is the number `navigateToPage` needs — not just the
 * TLDraw page id — because a chapter and its deck share one TLDraw map and
 * the id alone always lands on whichever shape the saved camera left
 * centered.
 */
export function routedAppPageNumber(
  route: PresentationRoute | string | null | undefined,
  pages: RoutablePage[],
): number | null {
  if (route == null) return null
  const idx = pages.findIndex(page =>
    presentationLocationMatchesPage(route, page.source?.file, page.src),
  )
  return idx >= 0 ? idx + 1 : null
}

/** The row fields the deck-chip pairing reads. No nav, no React. */
export interface TocDeckRow {
  level: string
  page?: number | null
  chapterRoot?: string
  deckOf?: string
}

/** One row of the served `page-info.json`: the build's own pairing statement. */
export interface TocPageInfo {
  file?: string
  title?: string
  variant?: string
  map?: string
  source?: { file?: string }
}

/**
 * Fill in the pairing a served `toc.json` predates, from the build's own
 * `page-info.json` on the same surface. A chapter/part row names its root
 * through `pages[page - 1].map`; a slides-variant page names its chapter
 * through its own `map`. Rows keep their order, titles, and pages; only the
 * pairing fields are added, and only where the page exists. A `toc.json`
 * that already carries the fields is returned untouched in shape — existing
 * values win, so a fresh build's statement is never overwritten by derivation.
 */
export function enrichTocWithPageInfo<T extends TocDeckRow>(rows: T[], pages: TocPageInfo[] | null | undefined): T[] {
  if (!pages) return rows
  return rows.map(row => {
    if (row.page == null || row.page < 1 || row.page > pages.length) return row
    const info = pages[row.page - 1]
    if (!info) return row
    if ((row.level === 'chapter' || row.level === 'part') && row.chapterRoot == null && info.map) {
      return { ...row, chapterRoot: info.map }
    }
    if (row.level === 'section' && row.deckOf == null && info.variant === 'slides' && info.map) {
      return { ...row, deckOf: info.map }
    }
    return row
  })
}

/**
 * The index of the deck row paired with row `i`, or null when it has none.
 * Pairs by `chapterRoot`/`deckOf`, never by display level or title: the
 * Welcome deck hangs off a `part` row, and titles reflow through renders
 * while the pairing the build used is exact. The sibling scan stops at the
 * next chapter/part/divider so a deck attached elsewhere cannot match, and
 * unbuilt deck rows (no page) are skipped — their own row still shows their
 * mark. `TocTab` renders `items[idx].nav`; the test asserts the index.
 */
export function deckNavIndex(rows: TocDeckRow[], i: number): number | null {
  const head = rows[i]
  if (!head?.chapterRoot || head.page == null) return null
  for (let j = i + 1; j < rows.length; j++) {
    const row = rows[j]
    if (row.level === 'chapter' || row.level === 'part' || row.level === 'divider') break
    if (row.deckOf != null && row.deckOf === head.chapterRoot && row.page != null) return j
  }
  return null
}
