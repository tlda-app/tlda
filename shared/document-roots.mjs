const DOCUMENT_FORMATS = new Set(['svg', 'png', 'html', 'diff', 'slides', 'markdown', 'qmd'])

export function normalizeDocumentRoots(documentRoots, { mainFile = null, format = 'svg' } = {}) {
  const roots = Array.isArray(documentRoots) ? documentRoots : []
  const result = []
  const seen = new Set()
  for (const value of roots) {
    const path = typeof value === 'string' ? value : value?.path
    if (typeof path !== 'string' || !path.trim()) continue
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!normalizedPath || seen.has(normalizedPath)) continue
    const candidateFormat = typeof value === 'object' ? value.format : format
    const rootFormat = DOCUMENT_FORMATS.has(candidateFormat) ? candidateFormat : format
    result.push({ path: normalizedPath, format: rootFormat })
    seen.add(normalizedPath)
  }
  if (result.length === 0 && typeof mainFile === 'string' && mainFile.trim()) {
    result.push({
      path: mainFile.replace(/\\/g, '/').replace(/^\.?\//, ''),
      format: DOCUMENT_FORMATS.has(format) ? format : 'svg',
    })
  }
  return result
}

export function latexDocumentRootPaths(documentRoots, { mainFile = null, format = 'svg', xrSiblings = [] } = {}) {
  const declared = normalizeDocumentRoots(documentRoots, { mainFile, format })
    .filter(root => root.format === 'svg' && /\.tex$/i.test(root.path))
    .map(root => root.path)
  return [...new Set([mainFile, ...declared, ...xrSiblings].filter(Boolean))]
}
