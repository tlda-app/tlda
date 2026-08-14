export function resolveMintCwd({ cwd, project, getProjectSourceDir }) {
  if (cwd) return cwd
  if (!project) throw new Error('Mint requires cwd or project')

  const sourceDir = getProjectSourceDir?.(project) ?? null
  if (!sourceDir) {
    throw new Error(`Project "${project}" has no local source directory on this daemon`)
  }
  return sourceDir
}
