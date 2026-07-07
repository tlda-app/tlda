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
