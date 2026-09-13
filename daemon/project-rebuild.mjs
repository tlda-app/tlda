export async function rebuildLinkedProject(sourceSync, project) {
  if (!project) throw new Error('project is required')
  if (!sourceSync.getSourceDir(project)) {
    // Name what IS buildable here, because the obvious way to find a project
    // name is `tlda project list` -- which lists everything on the SERVER,
    // while rebuilding needs a checkout bound to THIS daemon. The two sets
    // barely overlap, and the bare refusal named neither of them, so the
    // person is told no and left to guess which half of the system is wrong.
    // Cost this measured: two wrong projects and a read of the source before
    // the reason was clear.
    const bound = sourceSync.boundProjectNames?.() || []
    throw new Error(
      `project ${project} is not linked on this daemon. `
      + `Rebuilding needs a checkout bound here, not just a project on the server -- `
      + `\`tlda project list\` shows the server's projects, which is a different set. `
      + (bound.length
        ? `Bound here: ${bound.slice(0, 8).join(', ')}${bound.length > 8 ? `, and ${bound.length - 8} more` : ''}.`
        : `Nothing is bound here; \`tlda project link\` binds a checkout.`),
    )
  }
  return sourceSync.submit(project, { forceRebuild: true })
}
