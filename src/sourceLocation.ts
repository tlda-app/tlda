export type SourceLocationReason =
  | 'missing-iframe'
  | 'missing-line-anchor'
  | 'missing-synctex'
  | 'ambiguous'
  | 'unresolved'

const SOURCE_LOCATION_REASONS = new Set<SourceLocationReason>([
  'missing-iframe',
  'missing-line-anchor',
  'missing-synctex',
  'ambiguous',
  'unresolved',
])

export type SourceLocation =
  | {
      anchored: true
      file: string
      line: number
    }
  | {
      anchored: false
      reason: SourceLocationReason
    }

export type SourceLineMeta = SourceLocation & {
  content?: string
  highlighted?: boolean
  hlStart?: number
  hlEnd?: number
  confidence?: number
  /**
   * Span-level ambiguity only. `reason: 'ambiguous'` means the line is not
   * trustworthy; `ambiguous` on an anchored value means the line is trustworthy
   * but columns are not.
   */
  ambiguous?: boolean
}

export function normalizeSourceFile(file: string, fallback = '') {
  const normalized = String(file || '').replace(/^\.\//, '')
  return normalized || fallback
}

export function isSourceLocationReason(value: unknown): value is SourceLocationReason {
  return typeof value === 'string' && SOURCE_LOCATION_REASONS.has(value as SourceLocationReason)
}

export function sourceLocationReason(value: unknown, fallback: SourceLocationReason = 'unresolved'): SourceLocationReason {
  return isSourceLocationReason(value) ? value : fallback
}

export function isAnchoredSourceLocation(value: SourceLocation | null | undefined): value is Extract<SourceLocation, { anchored: true }> {
  return value?.anchored === true
}

export function anchoredSourceLocation(file: string, line: number, fallbackFile = ''): SourceLocation | null {
  const normalized = normalizeSourceFile(file, fallbackFile)
  const sourceLine = Math.floor(Number(line))
  if (!normalized || !Number.isFinite(sourceLine) || sourceLine < 1) return null
  return { anchored: true, file: normalized, line: sourceLine }
}

export function unanchoredSourceLocation(reason: SourceLocationReason): SourceLocation {
  return { anchored: false, reason }
}

export function sourceLineMetaFromRankerLine(
  line: any,
  fallbackFile = '',
): SourceLineMeta {
  const location = anchoredSourceLocation(line?.file || fallbackFile, Number(line?.line))
    || unanchoredSourceLocation(sourceLocationReason(line?.reason))
  const meta: SourceLineMeta = { ...location }
  if (location.anchored) {
    if (typeof line?.content === 'string') meta.content = line.content
    if (line?.highlighted === true) meta.highlighted = true
    if (line?.hlStart != null && line?.hlEnd != null && Number(line.hlEnd) > Number(line.hlStart)) {
      meta.hlStart = Number(line.hlStart)
      meta.hlEnd = Number(line.hlEnd)
    }
  }
  if (line?.confidence != null && Number.isFinite(Number(line.confidence))) meta.confidence = Number(line.confidence)
  if (line?.ambiguous === true) meta.ambiguous = true
  if (!meta.anchored) {
    delete meta.content
    delete meta.highlighted
    delete meta.hlStart
    delete meta.hlEnd
    delete meta.ambiguous
  } else if (meta.ambiguous) {
    delete meta.hlStart
    delete meta.hlEnd
  }
  return meta
}
