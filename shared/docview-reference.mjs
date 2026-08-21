export function updateReferenceDocviews(editor, reference) {
  let updated = 0
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'fleet-docview') continue
    let sources = ['ref']
    try { sources = JSON.parse(shape.props?.sources || '["ref"]') } catch { sources = ['ref'] }
    if (!Array.isArray(sources) || !sources.includes('ref')) continue
    if (shape.isLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { ...shape.props, ...reference },
    })
    updated++
  }
  return updated
}

export function buildErrorReferenceFromPosition(error, position, { viewboxOffset, pageHeight }) {
  if (!position) return null
  const center = position.y + viewboxOffset
  return {
    label: '',
    page: position.page,
    yTop: Math.max(0, center - 40),
    yBottom: Math.min(pageHeight, center + 40),
    title: `${error.file.split('/').pop()}:${error.line}`,
  }
}
