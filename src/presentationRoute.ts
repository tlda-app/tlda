export interface PresentationRoute {
  mode: 'app' | 'static'
  project: string
  location: string
  prefix: 'root' | 'docs'
}

/**
 * One route object per pathname, by reference.
 *
 * SvgDocumentEditor calls presentationRoute(window.location.pathname) on every
 * render and feeds it into the presentationDocument useMemo deps. When each
 * call returned a fresh object the memo recomputed on every render, the
 * SlidesNavigator `document` prop changed identity on every render, and its
 * mount effect re-ran — resetting the deck to slide 1 on any ambient parent
 * re-render (story-2 nondeterministic counter resets, Sep 24). Callers only
 * read fields, so sharing the reference is safe; pathnames per session are
 * few, so the cache stays small.
 */
const routeCache = new Map<string, PresentationRoute | null>()

export function presentationRoute(pathname: string): PresentationRoute | null {
  if (routeCache.has(pathname)) return routeCache.get(pathname) ?? null
  const route = parsePresentationRoute(pathname)
  routeCache.set(pathname, route)
  return route
}

function parsePresentationRoute(pathname: string): PresentationRoute | null {
  const docsMatch = pathname.match(/^\/docs\/([^/]+)\/(app|static)(?:\/(.*))?$/)
  const rootMatch = pathname.match(/^\/(app|static)\/(.+)$/)
  const match = docsMatch || rootMatch
  if (!match) return null
  try {
    const docs = !!docsMatch
    return {
      mode: match[docs ? 2 : 1] as PresentationRoute['mode'],
      project: docs ? decodeURIComponent(match[1]) : '',
      location: (match[docs ? 3 : 2] || '').split('/').map(decodeURIComponent).join('/'),
      prefix: docs ? 'docs' : 'root',
    }
  } catch {
    return null
  }
}

export function presentationPath(mode: PresentationRoute['mode'], project: string, location = '', prefix: PresentationRoute['prefix'] = 'root'): string {
  const parts = prefix === 'docs'
    ? ['docs', project, mode, ...location.split('/').filter(Boolean)]
    : [mode, ...location.split('/').filter(Boolean)]
  return `/${parts.map(encodeURIComponent).join('/')}`
}

/**
 * Keep the classroom marker across a mode switch.
 *
 * The switch changes how a page is presented, not which course it belongs
 * to, so a reader arriving with `?course=` keeps it; without one the path is
 * unchanged. Course only — never a classroom token, which is a capability
 * and must not ride a link (see deviceTransferUrl's note on the same rule).
 */
export function presentationPathWithCourse(path: string, search: string): string {
  const course = new URLSearchParams(search).get('course')
  if (!course) return path
  return `${path}?course=${encodeURIComponent(course)}`
}

export function presentationLocationMatchesPage(routeOrLocation: PresentationRoute | string, sourceFile: string | undefined, pageUrl: string): boolean {
  if (typeof routeOrLocation === 'string') {
    if (sourceFile === routeOrLocation) return true
    return new URL(pageUrl, 'http://tlda.local').pathname.endsWith(`/app/${routeOrLocation}`)
  }
  const legacyLocation = routeOrLocation.location.replace(/^book\//, '')
  if (sourceFile === routeOrLocation.location || sourceFile?.replace(/\.qmd$/i, '.html') === legacyLocation) return true
  const pathname = new URL(pageUrl, 'http://tlda.local').pathname
  return pathname === presentationPath('app', routeOrLocation.project, routeOrLocation.location, routeOrLocation.prefix)
    || pathname.endsWith(`/_book/${legacyLocation}`)
}
