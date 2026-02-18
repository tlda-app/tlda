/**
 * Anchor index and navigation callbacks.
 * Built during SVG loading so cross-page links can be resolved.
 */

export interface AnchorEntry {
  pageShapeId: string
  // view element's viewBox attribute gives us the scroll target
  viewBox?: string
}
export const anchorIndex = new Map<string, AnchorEntry>()

// Callback for cross-page navigation — set by SvgDocument
// anchorId is the <view> element ID (e.g. "loc84"), title is xlink:title (e.g. "equation.28")
let navigateToAnchor: ((anchorId: string, title: string) => void) | null = null
export function setNavigateToAnchor(fn: ((anchorId: string, title: string) => void) | null) {
  navigateToAnchor = fn
}
export function getNavigateToAnchor() { return navigateToAnchor }

// Callback for Cmd-click → open source in editor (set by SvgDocument)
// shapeId identifies which page was clicked, clickY is relative to the shape (0..1 fraction)
let onSourceClick: ((shapeId: string, clickY: number) => void) | null = null
export function setOnSourceClick(fn: ((shapeId: string, clickY: number) => void) | null) {
  onSourceClick = fn
}
export function getOnSourceClick() { return onSourceClick }
