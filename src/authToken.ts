/**
 * Auth token management for the viewer SPA.
 *
 * Token comes from the URL query param `?token=xxx`.
 * Call initToken() early in App.tsx before any fetches.
 *
 * Patches window.fetch to automatically inject Authorization headers
 * on same-origin requests, so no other viewer code needs changes.
 */

let _token: string | null = null

export function initToken() {
  const params = new URLSearchParams(window.location.search)
  _token = params.get('token')

  if (_token) {
    const originalFetch = window.fetch
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      // Only inject auth for same-origin requests (relative URLs or matching host)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const isRelative = url.startsWith('/') || url.startsWith('./') || url.startsWith('../')
      const isSameOrigin = isRelative || url.startsWith(window.location.origin)

      if (isSameOrigin) {
        const headers = new Headers(init?.headers)
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${_token}`)
        }
        return originalFetch.call(window, input, { ...init, headers })
      }

      return originalFetch.call(window, input, init)
    }
  }
}

export function getToken(): string | null {
  return _token
}

/** Append ?token=xxx to a URL (for WebSocket or other URL-based auth) */
export function appendToken(url: string): string {
  if (!_token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${_token}`
}
