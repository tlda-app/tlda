export function createSourceEditEvent({ result, project, editedBy, requestId }) {
  const files = result?.acceptedChangedFiles
  if (!result?.ok || result.unchanged || result.filtered || !editedBy || !Array.isArray(files) || files.length === 0) return null
  const changedTexFiles = files
    .filter(file => file?.path?.endsWith('.tex') && Array.isArray(file.regions) && file.regions.length > 0)
    .map(file => ({ path: file.path, regions: file.regions }))
  if (changedTexFiles.length === 0) return null
  return {
    type: 'source-edit',
    from: 'fleet:tlda',
    to: editedBy,
    text: `Source edit — ${project}`,
    metadata: { project, files: changedTexFiles, requestId },
  }
}

export function emitSourceEditEvent({ emit, ...input }) {
  const event = createSourceEditEvent(input)
  if (event) emit('source-edit', event)
  return event
}
