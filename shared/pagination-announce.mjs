// pagination-announce — the two halves every paginated surface owes its reader.
//
// Skip, 2026-08-13 03:04 EDT: "announcing pagination generally everywhere that is
// fucking paginated, it should announce pagination at the fucking top and bottom.
// What's the bottom telling you how to get the next fucking page."
//
// TWO HALVES, AND THEY ARE NOT THE SAME CLAIM. The top says the page is a page —
// it exists so a reader cannot mistake the slice for the set. The bottom says how
// to get the rest, and it is the more useful one: "there are more" is a warning,
// "call it again with this" is an instruction. A reader who has finished reading
// is at the BOTTOM, which is why the continuation belongs there and not only in a
// header they scrolled past.
//
// WHY THIS EXISTS. `/api/fleet-table?limit=500` returned 500 rows of 2154 and said
// nothing about the other 1654. An agent reported "zero dead agents" from it — an
// absence produced by an instrument that could not see past its own first page,
// reported to Skip as a fact about the fleet.
//
// A page is announced from the numbers the surface already has. Nothing here
// changes what is returned, what a page holds, or how big it is.

/**
 * Is this reply a slice of something larger?
 *
 * `total` unknown is not the same as "no more". A surface that cannot count its
 * own set says so by passing `total: null`, and gets the honest announcement
 * rather than a confident one.
 */
export function isPaged({ shown, total, nextCursor = null }) {
  if (nextCursor) return true
  if (!Number.isFinite(total)) return false
  return shown < total
}

/**
 * Top half: this is a page, and of what.
 *
 * Returns the plain count when there is nothing withheld, so a complete answer
 * does not wear pagination language it has not earned.
 */
export function announcePageTop({ shown, total, noun = 'row', order = null, nextCursor = null }) {
  const plural = shown === 1 ? noun : `${noun}s`
  const suffix = order ? `, ${order}` : ''
  if (!isPaged({ shown, total, nextCursor })) {
    return Number.isFinite(total) && total !== shown
      ? `${shown} ${plural}${suffix}.`
      : `${shown} ${plural}${suffix}.`
  }
  if (!Number.isFinite(total)) {
    return `Showing ${shown} ${plural}${suffix} — this is one page and the total is not counted here.`
  }
  return `Showing ${shown} of ${total} ${total === 1 ? noun : `${noun}s`}${suffix}.`
}

/**
 * Bottom half: how to get the next page, as something the reader can run.
 *
 * `nextCall` is the literal call, already formatted by the caller — it is the
 * caller that knows which arguments the reader actually used, and continuing with
 * an argument nobody passed is how a continuation hint becomes a call that fails.
 *
 * Returns null when there is nothing to continue, so a caller can append
 * unconditionally without emitting a footer that says "no more" on every reply.
 */
export function announcePageBottom({ shown, total, noun = 'row', nextCall = null, nextCursor = null }) {
  if (!isPaged({ shown, total, nextCursor })) return null
  const remaining = Number.isFinite(total) ? total - shown : null
  const plural = remaining === 1 ? noun : `${noun}s`
  const head = remaining === null
    ? `More ${noun}s exist after this page.`
    : `${remaining} more ${plural} not shown.`
  if (!nextCall) {
    // Say the continuation is missing rather than implying the page is the set.
    // A surface with no continuation is a different defect from a surface with
    // one it declined to print, and the reader needs to know which they have.
    return `${head} This surface does not expose a way to fetch the next page.`
  }
  return `${head} Next page: ${nextCall}`
}

/**
 * Both halves for a JSON body, where "top and bottom" has no meaning.
 *
 * An HTTP consumer scrolls nothing, so the announcement is a field — one
 * human-readable sentence carrying the same two claims, next to the machine
 * fields it describes. `/api/fleet-table` already returned `nextCursor` and
 * `page_limited`; what it never did was say so in a sentence anyone reading the
 * response would notice.
 */
export function announcePageJson({ shown, total, noun = 'row', nextCall = null, nextCursor = null }) {
  const top = announcePageTop({ shown, total, noun, nextCursor })
  const bottom = announcePageBottom({ shown, total, noun, nextCall, nextCursor })
  return bottom ? `${top} ${bottom}` : top
}
