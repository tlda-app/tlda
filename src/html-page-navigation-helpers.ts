export function htmlPageReloadUrl(url: string, timestamp: number) {
  const [base, hash = ''] = url.split('#', 2)
  const [path, query = ''] = base.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('_tldaReload', String(timestamp))
  const next = `${path}?${params.toString()}`
  return hash ? `${next}#${hash}` : next
}

export function htmlPageFileFromUrl(url: string, basePath: string, locationHref = window.location.href) {
  const baseUrl = new URL(basePath, locationHref)
  const pageUrl = new URL(url, locationHref)
  if (pageUrl.origin === baseUrl.origin && pageUrl.pathname.startsWith(baseUrl.pathname)) {
    return decodeURIComponent(pageUrl.pathname.slice(baseUrl.pathname.length))
  }
  return decodeURIComponent(pageUrl.pathname.replace(/^\/+/, ''))
}

export function htmlPageUrlMatchesTargetFile(url: string, targetFile: string) {
  const cleanUrl = String(url || '').split('#', 1)[0].split('?', 1)[0]
  const cleanTarget = String(targetFile || '').replace(/^\.?\//, '').split('#', 1)[0].split('?', 1)[0]
  if (!cleanUrl || !cleanTarget) return false
  const targetCandidates = new Set([
    cleanTarget,
    cleanTarget.replace(/\.(md|markdown)$/i, '.html'),
    cleanTarget.replace(/^.*\//, ''),
    cleanTarget.replace(/^.*\//, '').replace(/\.(md|markdown)$/i, '.html'),
  ])
  for (const candidate of targetCandidates) {
    if (!candidate) continue
    if (cleanUrl.endsWith('/' + candidate)) return true
    if (cleanUrl.includes('/' + candidate + '/')) return true
  }
  return false
}
