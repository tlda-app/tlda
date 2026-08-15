export function activityPreambleDoc(activity) {
  const manual = activity?.metadata?.preambleRef?.doc
  if (typeof manual === 'string' && manual) return manual

  const sourceProject = activity?._toolInput?.canonical_source?.project || activity?.metadata?.project
  return typeof sourceProject === 'string' && sourceProject ? sourceProject : null
}
