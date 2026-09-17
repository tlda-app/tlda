export interface PresentationRoute {
  mode: 'app' | 'static'
  project: string
  location: string
  prefix: 'root' | 'docs'
}

export function presentationRoute(pathname: string): PresentationRoute | null {
  const docsMatch = pathname.match(/^\/docs\/([^/]+)\/(app|static)(?:\/(.*))?$/)
  const rootMatch = pathname.match(/^\/(app|static)\/([^/]+)(?:\/(.*))?$/)
  const match = docsMatch || rootMatch
  if (!match) return null
  try {
    const docs = !!docsMatch
    return {
      mode: match[docs ? 2 : 1] as PresentationRoute['mode'],
      project: decodeURIComponent(match[docs ? 1 : 2]),
      location: (match[3] || '').split('/').map(decodeURIComponent).join('/'),
      prefix: docs ? 'docs' : 'root',
    }
  } catch {
    return null
  }
}

export function presentationPath(mode: PresentationRoute['mode'], project: string, location = '', prefix: PresentationRoute['prefix'] = 'root'): string {
  const parts = prefix === 'docs'
    ? ['docs', project, mode, ...location.split('/').filter(Boolean)]
    : [mode, project, ...location.split('/').filter(Boolean)]
  return `/${parts.map(encodeURIComponent).join('/')}`
}

export function presentationLocationMatchesPage(location: string, sourceFile: string | undefined, pageUrl: string): boolean {
  if (sourceFile === location) return true
  const pathname = new URL(pageUrl, 'http://tlda.local').pathname
  return pathname.endsWith(`/app/${location}`)
}
