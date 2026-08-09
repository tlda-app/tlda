const SVG_PAGE_CACHE = 'tlda-svg-pages'

const inflight = new Map<string, Promise<string | null>>()

type FetchCachedSvgPageOptions = RequestInit & { cold?: boolean }

function withColdMarker(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.origin)
    url.searchParams.set('_tldaCold', '1')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    const [baseAndSearch, hash = ''] = rawUrl.split('#')
    const [base, search = ''] = baseAndSearch.split('?')
    const params = new URLSearchParams(search)
    params.set('_tldaCold', '1')
    return `${base}?${params.toString()}${hash ? `#${hash}` : ''}`
  }
}

export function versionedSvgPageUrl(rawUrl: string, buildHash?: string | null): string {
  if (!buildHash || buildHash === 'unknown') return rawUrl
  try {
    const url = new URL(rawUrl, window.location.origin)
    url.searchParams.set('v', buildHash)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    const [baseAndSearch, hash = ''] = rawUrl.split('#')
    const [base, search = ''] = baseAndSearch.split('?')
    const params = new URLSearchParams(search)
    params.set('v', buildHash)
    return `${base}?${params.toString()}${hash ? `#${hash}` : ''}`
  }
}

export async function fetchCachedSvgPage(
  rawUrl: string,
  buildHash?: string | null,
  init?: FetchCachedSvgPageOptions,
): Promise<string | null> {
  const url = versionedSvgPageUrl(rawUrl, buildHash)
  const cached = await readCachedSvgPage(url)
  if (cached !== null) return cached

  const hotKey = `${init?.method || 'GET'} hot ${url}`
  const coldKey = `${init?.method || 'GET'} cold ${url}`
  const key = init?.cold ? coldKey : hotKey
  const existingHot = inflight.get(hotKey)
  if (existingHot) return existingHot
  const existing = inflight.get(key)
  if (existing && init?.cold) return existing

  const { cold: _cold, ...fetchInit } = init || {}
  const fetchUrl = init?.cold ? withColdMarker(url) : url
  const promise = fetch(fetchUrl, fetchInit)
    .then(async (response) => {
      if (!response.ok) return null
      await writeCachedSvgPage(url, response.clone())
      return response.text()
    })
    .catch((error) => {
      if ((error as Error)?.name === 'AbortError') throw error
      return null
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

async function readCachedSvgPage(url: string): Promise<string | null> {
  if (!('caches' in window)) return null
  try {
    const cache = await caches.open(SVG_PAGE_CACHE)
    const response = await cache.match(url)
    return response ? response.text() : null
  } catch {
    return null
  }
}

async function writeCachedSvgPage(url: string, response: Response): Promise<void> {
  if (!('caches' in window)) return
  try {
    const cache = await caches.open(SVG_PAGE_CACHE)
    await cache.put(url, response)
  } catch {
    // The fetched SVG is still usable; Cache API failures only reduce reuse.
  }
}
