export function createSourceEditEvent({ result, project, files, editedBy, requestId }) {
  if (!result?.ok || !editedBy || !Array.isArray(files) || files.length === 0) return null
  return {
    type: 'source-edit',
    from: 'fleet:tlda',
    to: editedBy,
    text: `Source edit — ${project}`,
    metadata: { project, files, requestId },
  }
}
