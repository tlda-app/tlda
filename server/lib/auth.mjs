/**
 * Bearer token authentication.
 *
 * Two tokens:
 *   - Read token (TLDA_TOKEN_READ / config.tokenRead): GET routes, /docs/*, WebSocket
 *   - RW token (TLDA_TOKEN_RW / config.tokenRw): everything including POST/DELETE API routes
 *
 * When no tokens are configured, auth is disabled (backward-compatible local use).
 *
 * The tokens themselves stay in the environment — they are secrets, delivered by
 * `fly secrets`, and a secret does not belong in a config file. The two POSTURE
 * decisions do not: `authDisabled` and `tokensFromEnvironmentOnly` are server.yaml
 * keys. `tokensFromEnvironmentOnly` used to be inferred from TLDA_FLEET_SERVER
 * being set, which is a URL that says nothing about tokens — so the rule "a
 * hosted box takes tokens only from its secrets" was carried by a variable named
 * after something else, and would have silently changed meaning the moment that
 * URL moved.
 */

import { getReadToken, getRwToken, loadServerConfig, DEFAULT_PORT } from '../../shared/config.mjs'

let tokenRead = null
let tokenRw = null
let authEnabled = false

export function initAuth() {
  const serverConfig = loadServerConfig()

  if (serverConfig.authDisabled) {
    authEnabled = false
    return
  }

  // Non-standard port = dev/worktree server, skip auth so agents aren't blocked
  if ((process.env.PORT || String(DEFAULT_PORT)) !== String(DEFAULT_PORT)) {
    console.log('[auth] Dev port detected — auth disabled')
    authEnabled = false
    return
  }

  const envTokensOnly = !!serverConfig.tokensFromEnvironmentOnly
  tokenRead = process.env.TLDA_TOKEN_READ || (envTokensOnly ? null : getReadToken())
  tokenRw = process.env.TLDA_TOKEN_RW || (envTokensOnly ? null : getRwToken())

  if (envTokensOnly && !tokenRead && !tokenRw) {
    throw new Error('[auth] server.yaml sets tokensFromEnvironmentOnly but no TLDA_TOKEN_READ/TLDA_TOKEN_RW secrets are configured')
  }

  authEnabled = !!(tokenRead || tokenRw)

  if (authEnabled) {
    console.log('[auth] Token auth enabled')
    if (!tokenRead) console.warn('[auth] Warning: no read token configured')
    if (!tokenRw) console.warn('[auth] Warning: no RW token configured')
  }
}

export function isAuthEnabled() { return authEnabled }

/** Returns 'rw' | 'read' | null */
export function validateToken(token) {
  if (!authEnabled) return 'rw'
  if (!token) return null
  if (tokenRw && token === tokenRw) return 'rw'
  if (tokenRead && token === tokenRead) return 'read'
  return null
}

/** Parse cookies from a request */
function parseCookies(req) {
  const header = req.headers?.cookie
  if (!header) return {}
  const cookies = {}
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=')
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='))
  }
  return cookies
}

/** Extract token from Authorization header, ?token= query param, or tlda_token cookie */
export function extractToken(req) {
  const auth = req.headers?.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const qp = url.searchParams.get('token')
  if (qp) return qp
  const cookies = parseCookies(req)
  return cookies.tlda_token || null
}

/** GET /auth/login?token=xxx[&redirect=/path] — set cookie, redirect to viewer */
export function loginRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const token = url.searchParams.get('token')
  if (!token) return res.status(400).send('Missing ?token= parameter')

  const level = validateToken(token)
  if (!level) return res.status(401).send('Invalid token')

  // 30 days, HttpOnly, SameSite=Lax (works for top-level navigation)
  // Secure only when accessed over HTTPS (Funnel); allow plain HTTP for Tailscale direct
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
  const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
  res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)

  const redirect = url.searchParams.get('redirect') || '/'
  res.redirect(302, redirect)
}

/** Express middleware: require at least read access */
export function requireRead(req, res, next) {
  if (!authEnabled) return next()
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  req.authLevel = level
  // Auto-set cookie when ?token= is valid (so sub-requests like images get auth)
  const cookies = parseCookies(req)
  if (!cookies.tlda_token && token) {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)
  }
  next()
}

/** Express middleware: require RW access */
export function requireRw(req, res, next) {
  if (!authEnabled) return next()
  const token = extractToken(req)
  const level = validateToken(token)
  if (level !== 'rw') {
    const status = level ? 403 : 401
    const error = level ? 'Forbidden: read-only token' : 'Unauthorized'
    return res.status(status).json({ error })
  }
  req.authLevel = level
  next()
}
