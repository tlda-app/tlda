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
