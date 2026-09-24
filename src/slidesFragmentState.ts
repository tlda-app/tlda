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
