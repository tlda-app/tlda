export async function rebuildLinkedProject(sourceSync, project) {
  if (!project) throw new Error('project is required')
  if (!sourceSync.getSourceDir(project)) throw new Error(`project ${project} is not linked on this daemon`)
  return sourceSync.submit(project, { forceRebuild: true })
}
