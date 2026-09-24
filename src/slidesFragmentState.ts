/**
 * Per-slide fragment state keys for the slides navigator.
 *
 * A deck is ONE page shape carrying every slide, so every slide reports
 * fragments under the SAME shapeId. Keying fragment state by shapeId alone
 * lets one slide's fragments answer for another: with reveal's address pinned
 * on an early slide, Next keeps stepping that slide's fragments instead of
 * advancing the camera, and the counter decouples from the strip.
 * Keying by shape + reveal address keeps each slide's fragments its own.
 * Documents without addresses (one shape per slide) keep the shapeId key.
 */

export interface FragmentCounts {
  total: number
  current: number
}

export function fragmentKeyForSlide(shapeId: string, indexh?: number, indexv?: number): string {
  if (indexh === undefined || indexh === null) return shapeId
  return `${shapeId}#${indexh},${indexv ?? 0}`
}

export function fragmentKeyForReport(
  report: { shapeId: string; indexh?: number | null; indexv?: number | null },
  documentHasDeckAddresses: boolean,
): string {
  if (documentHasDeckAddresses && report.indexh !== undefined && report.indexh !== null) {
    return fragmentKeyForSlide(report.shapeId, report.indexh, report.indexv ?? 0)
  }
  return report.shapeId
}

/**
 * Per-tab resume for deck position.
 *
 * The navigator's current slide lives only in React state, so any reload or
 * remount (tab death, navigation away and back, crash) restarts the deck at
 * slide 1: the mount path reads `?slide` or defaults to the first slide and
 * nothing ever records where the reader was. Keying the last shown index by
 * document in sessionStorage lets a reloaded tab resume instead of resetting.
 * sessionStorage is tab-local on purpose: no URL change, no cross-tab
 * cross-talk, an explicit `?slide` link still wins.
 */
export function deckPositionKey(documentName: string): string {
  return `tlda-deck-slide:${documentName}`
}

export function resolveInitialSlide(
  slideParam: string | null,
  stored: unknown,
  totalSlides: number,
): number {
  const last = Math.max(0, totalSlides - 1)
  if (slideParam !== null) {
    const requested = Number.parseInt(slideParam, 10) - 1
    if (!Number.isFinite(requested)) return 0
    return Math.max(0, Math.min(requested, last))
  }
  const n = typeof stored === 'string' ? Number.parseInt(stored, 10) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(n, last))
}

export function hasUnsteppedFragments(fs: FragmentCounts | undefined): boolean {
  return !!fs && fs.current < fs.total
}

export function hasSteppedFragments(fs: FragmentCounts | undefined): boolean {
  return !!fs && fs.current > 0
}

export type NextSlideAction = 'step-fragment' | 'advance-slide' | 'stay'

export function nextSlideAction(
  state: Map<string, FragmentCounts>,
  key: string,
  currentSlide: number,
  totalSlides: number,
): NextSlideAction {
  if (hasUnsteppedFragments(state.get(key))) return 'step-fragment'
  if (currentSlide < totalSlides - 1) return 'advance-slide'
  return 'stay'
}

export type PrevSlideAction = 'step-fragment' | 'retreat-slide' | 'stay'

export function prevSlideAction(
  state: Map<string, FragmentCounts>,
  key: string,
  currentSlide: number,
): PrevSlideAction {
  if (hasSteppedFragments(state.get(key))) return 'step-fragment'
  if (currentSlide > 0) return 'retreat-slide'
  return 'stay'
}
