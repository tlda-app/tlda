import { fetchCachedSvgPage } from './pageSvgCache'
import { FORMATS_WITH_OWN_PAGE_INFO } from '../shared/document-formats.mjs'

export type OfflineProject = {
  projectName: string
  basePath: string
  format?: string
  pages?: number
  targets?: Array<{ name?: string; texBase?: string; pages: number }>
}

type ProjectInfo = OfflineProject & {
  lastBuild?: string | null
  sourceRevision?: string | null
  pageInfo?: Array<{ file?: string; url?: string }>
}

type VersionSentinel = { props?: { commitHash?: string } }

export type OfflineProgress = { complete: number; total: number }

export function offlineDocumentUrls(project: OfflineProject, info: ProjectInfo): string[] {
  if (info.pageInfo?.length || FORMATS_WITH_OWN_PAGE_INFO.has(info.format || project.format || '')) {
    return (info.pageInfo || []).flatMap(page => {
      const path = page.url || page.file
      if (!path) return []
      const url = new URL(path, new URL(project.basePath, 'https://tlda.invalid'))
      return [`${url.pathname}${url.search}${url.hash}`]
    })
  }

  const targets = info.targets?.length ? info.targets : project.targets
  if (!targets?.length) return []
  return targets.flatMap(target => {
    const name = target.texBase || target.name
    if (!name) return []
    return Array.from({ length: target.pages }, (_, index) => `${project.basePath}${name}-page-${index + 1}.svg`)
  })
}

/** Cache each reachable document page in sequence so explicit eager loading never recreates the render fan-out it replaces. */
export async function cacheProjectsForOffline(
  projects: OfflineProject[],
  onProgress: (progress: OfflineProgress) => void,
): Promise<void> {
  const prepared: Array<{ urls: string[]; version: string | null }> = []
  for (const project of projects) {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.projectName)}?include=page-info`)
    if (!response.ok) throw new Error(`${project.projectName} is not readable (${response.status})`)
    const info = await response.json() as ProjectInfo
    const sentinel = await fetch(`/api/projects/${encodeURIComponent(project.projectName)}/shapes/doc-version--sentinel`)
      .then(response => response.ok ? response.json() as Promise<VersionSentinel> : null)
      .catch(() => null)
    if (!info.pageInfo?.length && !info.targets?.length && !project.targets?.length) {
      const pageInfoResponse = await fetch(`${project.basePath}page-info.json`)
      if (pageInfoResponse.ok) info.pageInfo = await pageInfoResponse.json() as ProjectInfo['pageInfo']
    }
    const urls = offlineDocumentUrls(project, info)
    if (urls.length === 0) throw new Error(`${project.projectName} has no offline-readable pages`)
    const commitHash = sentinel?.props?.commitHash
    prepared.push({
      urls,
      version: commitHash && commitHash !== 'unknown'
        ? commitHash.slice(0, 7)
        : info.lastBuild || info.sourceRevision || null,
    })
  }

  const total = prepared.reduce((sum, project) => sum + project.urls.length, 0)
  let complete = 0
  onProgress({ complete, total })
  for (const project of prepared) {
    for (const url of project.urls) {
      const content = await fetchCachedSvgPage(url, project.version, { cold: true })
      if (content === null) throw new Error(`Could not cache ${url}`)
      complete += 1
      onProgress({ complete, total })
    }
  }
}
