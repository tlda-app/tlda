export function createSourceEditEvent({ result, project, editedBy, requestId }) {
  const files = result?.acceptedChangedFiles
  if (!result?.ok || result.unchanged || result.filtered || !editedBy || !Array.isArray(files) || files.length === 0) return null
  const changedSourceFiles = files
    .filter(file => (file?.path?.endsWith('.tex') || file?.path?.endsWith('.md')) && Array.isArray(file.regions) && file.regions.length > 0)
    .map(file => ({ path: file.path, regions: file.regions }))
  if (changedSourceFiles.length === 0) return null
  return {
    type: 'source-edit',
    from: 'fleet:tlda',
    to: editedBy,
    text: `Source edit — ${project}`,
    metadata: { project, files: changedSourceFiles, requestId },
  }
}

export function emitSourceEditEvent({ emit, ...input }) {
  const event = createSourceEditEvent(input)
  if (event) emit('source-edit', event)
  return event
}
