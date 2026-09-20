/**
 * Token gating.
 *
 * One bearer secret admits the caller; what they may do comes from their
 * identity and its groups, never from which token they hold. There is no read
 * token and no RW token — only the token(s) in the environment. A caller
 * holding a valid token is admitted; a caller holding none is not.
 *
 * `tokenGating` (server.yaml, default false) turns that bearer check on for
 * HTTP routes. It is NOT authentication and is deliberately not named as
 * though it were: the real boundary is the network — the tailnet, plus bearer
 * secrets.
 *
 * The tokens themselves stay in the environment — they are secrets, delivered by
 * `fly secrets`, and a secret does not belong in a config file. The two POSTURE
 * decisions do not: `tokenGating` and `tokensFromEnvironmentOnly` are server.yaml
 * keys.
 *
 * The same defect used to sit one screen below this comment: a non-standard PORT
 * silently switched gating off, so "is gating on?" could not be answered from
 * configuration — the same config answered differently on a worktree port. It is
 * gone, and it costs nothing, because gating is now off unless a config file turns
 * it on: a dev or worktree server needs no escape hatch. The other silent path is
 * gone too — gating turned on with no token configured is an error, not a no-op.
 */

import { getReadToken, getRwToken, loadServerConfig } from '../../shared/config.mjs'

let tokenRead = null
let tokenRw = null
let gatingEnabled = false

export function initAuth() {
  const serverConfig = loadServerConfig()

  tokenRead = null
  tokenRw = null
  if (!serverConfig.tokenGating) {
    gatingEnabled = false
    return
  }

  const envTokensOnly = !!serverConfig.tokensFromEnvironmentOnly
  tokenRead = process.env.TLDA_TOKEN_READ || (envTokensOnly ? null : getReadToken())
  tokenRw = process.env.TLDA_TOKEN_RW || (envTokensOnly ? null : getRwToken())

  // Gating on with nothing to check is the one state that must never be reached
  // quietly: it reads as protected and behaves as open. Fail loudly instead.
  if (!tokenRead && !tokenRw) {
    throw new Error(envTokensOnly
      ? '[tokens] server.yaml sets tokensFromEnvironmentOnly but no TLDA_TOKEN_READ/TLDA_TOKEN_RW secrets are configured'
      : '[tokens] server.yaml sets tokenGating but no read or RW token is configured')
  }

  gatingEnabled = true
  console.log('[tokens] Token gating enabled')
  if (!tokenRead) console.warn('[tokens] Warning: no read token configured')
  if (!tokenRw) console.warn('[tokens] Warning: no RW token configured')
}

export function isTokenGatingEnabled() { return gatingEnabled }

/**
 * A shareable link token for handing to somebody else: one of the configured
 * tokens, suitable for writing into a URL. Which one is arbitrary now that
 * tokens carry no level — any admitted token admits the same.
 */
export function configuredReadToken() { return tokenRead || tokenRw }

/**
 * Whether the token is one this server recognises. Tokens carry no level: any
 * configured token admits the caller, and what they may do is decided from
 * their identity afterwards. Returns 'rw' for a recognised token so existing
 * level readers keep working unchanged; null for anything else.
 */
export function validateToken(token) {
  if (!gatingEnabled) return 'rw'
  if (!token) return null
  if (tokenRw && token === tokenRw) return 'rw'
  if (tokenRead && token === tokenRead) return 'rw'
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

/**
 * A credential this request carries, out of the Authorization header, the
 * `?token=` query param, and the `tlda_token` cookie. Tokens carry no level,
 * so there is nothing to rank: the first valid one wins, header first, then
 * query, then cookie. Nothing is consumed and nothing is dropped.
 *
 * This has to happen on the server because it is the only place both the
 * cookie and the URL are legible — the cookie is HttpOnly, so the page cannot
 * read it.
 */
export function extractToken(req) {
  const candidates = []
  const auth = req.headers?.authorization
  if (auth?.startsWith('Bearer ')) candidates.push(auth.slice(7))
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const qp = url.searchParams.get('token')
  if (qp) candidates.push(qp)
  const cookies = parseCookies(req)
  if (cookies.tlda_token) candidates.push(cookies.tlda_token)

  for (const candidate of candidates) {
    if (validateToken(candidate)) return candidate
  }
  return candidates[0] ?? null
}

/** GET /auth/login?token=xxx[&redirect=/path] — set cookie, redirect to viewer */
export function loginRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const token = url.searchParams.get('token')
  if (!token) return res.status(400).send('Missing ?token= parameter')

  const level = validateToken(token)
  if (!level) return res.status(401).send('Invalid token')

  // Following a link writes the presented token into the cookie outright.
  // Tokens carry no level, so no token can demote the browser: any valid token
  // admits the same.
  {
    // 30 days, HttpOnly, SameSite=Lax (works for top-level navigation)
    // Secure only when accessed over HTTPS (Funnel); allow plain HTTP for Tailscale direct
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)
  }

  const redirect = url.searchParams.get('redirect') || '/'
  res.redirect(302, redirect)
}

/** Express middleware: require a recognised token. The only question asked of
 * the token is whether it is one of ours; what the caller may do is decided
 * from their identity afterwards. `requireRead` and `requireRw` are the same
 * check — both names survive so the call sites do not churn, and neither
 * grants anything by itself. */
export function requireRead(req, res, next) {
  if (!gatingEnabled) return next()
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  req.authLevel = level
  // Auto-set cookie when ?token= is valid (so sub-requests like images get auth).
  // Tokens carry no level, so writing a valid one back can add nothing beyond
  // admission; the guard below only stops re-sending an identical cookie.
  const cookies = parseCookies(req)
  if (token && token !== cookies.tlda_token) {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)
  }
  next()
}

/** Express middleware: require a recognised token. Same check as `requireRead`
 * — see above. A caller holding any valid token passes. */
export function requireRw(req, res, next) {
  return requireRead(req, res, next)
}
