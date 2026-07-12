export type SourceCursorAnchorKind = 'synctex' | 'html-page'

export type TrackedSourceCursorAnchor = {
  file: string
  line: number | null
  source?: SourceCursorAnchorKind
  anchored: boolean
}

export type ResolvedSourceCursorAnchor = {
  file: string
  line: number | null
  source: SourceCursorAnchorKind
  anchored: boolean
}

export function shouldReuseTrackedSourceAnchor(
  prev: TrackedSourceCursorAnchor,
  next: ResolvedSourceCursorAnchor,
  lineThreshold: number,
) {
  if (prev.source !== next.source) return false
  if (prev.file === next.file && prev.line === next.line && prev.anchored === next.anchored) return true
  return !!(
    next.anchored &&
    prev.anchored &&
    prev.file === next.file &&
    prev.line != null &&
    next.line != null &&
    Math.abs(prev.line - next.line) < lineThreshold
  )
}
