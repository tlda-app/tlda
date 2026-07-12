const HIGHLIGHT_THEMES = {
  'light-green': { type: 'approve', label: 'Good, keep this' },
  'green':       { type: 'approve', label: 'Good, keep this' },
  'light-red':   { type: 'reject', label: 'Fix this' },
  'red':         { type: 'reject', label: 'Fix this' },
  'yellow':      { type: 'question', label: 'Question / unsure' },
  'light-violet': { type: 'expand', label: 'Develop further' },
  'violet':      { type: 'expand', label: 'Develop further' },
  'orange':      { type: 'comment', label: 'General comment' },
  'light-blue':  { type: 'info', label: 'Note / reference' },
  'blue':        { type: 'info', label: 'Note / reference' },
}

function normalizedSourceLines(meta) {
  return Array.isArray(meta?.sourceLines)
    ? meta.sourceLines.filter(line => line && typeof line === 'object').map(line => ({ ...line }))
    : []
}

function anchoredSourceLines(sourceLines) {
  return sourceLines.filter(line => line?.anchored !== false && Number.isFinite(Number(line?.line)))
}

export function highlightFeedbackFromShape(shape) {
  const meta = shape?.meta || {}
  if (!meta.highlightText) return null

  const color = shape.props?.color || 'yellow'
  const theme = HIGHLIGHT_THEMES[color] || { type: 'comment', label: 'General comment' }
  const sourceLines = normalizedSourceLines(meta)
  const anchoredLines = anchoredSourceLines(sourceLines)
  const firstLine = anchoredLines[0]?.line ?? null
  const lastLine = anchoredLines[anchoredLines.length - 1]?.line ?? null

  return {
    type: theme.type,
    label: theme.label,
    color,
    shapeId: shape.id,
    text: meta.highlightText || '',
    highlightLines: meta.highlightLines || [],
    sourceLines,
    sourceFile: anchoredLines.find(line => line.file)?.file || null,
    lines: firstLine != null && lastLine != null ? [firstLine, lastLine] : null,
    addressed: meta.addressed === true,
    createdAt: meta.createdAt ?? null,
    opacity: shape.opacity ?? 1,
  }
}

export function compareHighlightFeedbackBySource(a, b) {
  const aLine = a.lines?.[0] ?? Number.MAX_SAFE_INTEGER
  const bLine = b.lines?.[0] ?? Number.MAX_SAFE_INTEGER
  return aLine - bLine
}
