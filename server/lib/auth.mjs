/**
 * Token gating.
 *
 * Two token capabilities:
 *   - Read token (TLDA_TOKEN_READ / config.tokenRead): GET routes, /docs/*, WebSocket
 *   - RW token (TLDA_TOKEN_RW / config.tokenRw): everything including POST/DELETE API routes
 *
 * `tokenGating` (server.yaml, default false) is what turns that read versus
 * read-write distinction on for HTTP mutations. It is NOT authentication and is
 * deliberately not named as though it were: this system does not do auth, and the
 * real boundary is the network — the tailnet, plus bearer secrets. A switch named
 * `auth…` imports a model the system does not have, and everything downstream then
 * reasons with that model.
 *
 * The tokens themselves stay in the environment — they are secrets, delivered by
 * `fly secrets`, and a secret does not belong in a config file. The two POSTURE
 * decisions do not: `tokenGating` and `tokensFromEnvironmentOnly` are server.yaml
 * keys. `tokensFromEnvironmentOnly` used to be inferred from TLDA_FLEET_SERVER
 * being set, which is a URL that says nothing about tokens — so the rule "a
 * hosted box takes tokens only from its secrets" was carried by a variable named
 * after something else, and would have silently changed meaning the moment that
 * URL moved.
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
 * The class-wide read token this server validates, or null when gating is off or
 * none is configured.
 *
 * For building a link that is handed to somebody else. `extractToken` answers a
 * different question — the strongest credential *this caller* holds — and an
 * instructor holds RW, which must never be written into a URL that leaves for a
 * student.
 */
export function configuredReadToken() { return tokenRead }

/**
 * The ordering on access levels: rw > read > none.
 *
 * This is not a new concept. `requireRw` has always treated a read token as
 * strictly less than an RW one — that is what its 403 "read-only token" says.
 * Naming the rank makes the comparison available to the two places that have to
 * refuse a downgrade, rather than each re-deriving it from a chain of ifs.
 */
const TOKEN_LEVEL_RANK = { rw: 2, read: 1 }
function rankOf(level) { return TOKEN_LEVEL_RANK[level] ?? 0 }

/** Returns 'rw' | 'read' | null */
export function validateToken(token) {
  if (!gatingEnabled) return 'rw'
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

/**
 * The strongest credential this request carries, out of the Authorization
 * header, the `?token=` query param, and the `tlda_token` cookie.
 *
 * It used to be the first of those three that was present, which is what made a
 * link able to take access away. The course syllabus points at `/app?token=…`
 * carrying the class's read token; following it from a browser that already
 * holds an RW cookie produced a request whose read token outranked the cookie by
 * being written down in a more preferred place. The session was not replaced —
 * the RW cookie was still sitting there, unread.
 *
 * So the choice is by level rather than by source. Nothing is consumed, nothing
 * is dropped, and a caller that holds only one credential is unaffected: a
 * student with no cookie still resolves to the token in their link.
 *
 * This has to happen on the server because it is the only place both credentials
 * are legible — the cookie is HttpOnly, so the page cannot read it, and cannot
 * know that the token in its URL is the weaker of the two.
 *
 * With gating off `validateToken` answers 'rw' for everything and with no valid
 * credential every candidate ranks 0; both cases fall through to the first
 * present source, which is the old header > query > cookie order.
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

  let best = null
  let bestRank = -1
  for (const candidate of candidates) {
    const rank = rankOf(validateToken(candidate))
    if (rank > bestRank) {
      best = candidate
      bestRank = rank
    }
  }
  return best
}

/** GET /auth/login?token=xxx[&redirect=/path] — set cookie, redirect to viewer */
export function loginRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const token = url.searchParams.get('token')
  if (!token) return res.status(400).send('Missing ?token= parameter')

  const level = validateToken(token)
  if (!level) return res.status(401).send('Invalid token')

  // Following a link never costs the browser access it already had. This is the
  // one route that overwrites the cookie outright, so it is the one that can
  // strand somebody: there is no logout, so a cookie replaced by a weaker token
  // is a 30-day demotion with nothing to undo it. The login still succeeds and
  // still redirects — the weaker token simply has nothing to add.
  const existing = validateToken(parseCookies(req).tlda_token)
  if (rankOf(level) >= rankOf(existing)) {
    // 30 days, HttpOnly, SameSite=Lax (works for top-level navigation)
    // Secure only when accessed over HTTPS (Funnel); allow plain HTTP for Tailscale direct
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)
  }

  const redirect = url.searchParams.get('redirect') || '/'
  res.redirect(302, redirect)
}

/** Express middleware: require at least read access */
export function requireRead(req, res, next) {
  if (!gatingEnabled) return next()
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  req.authLevel = level
  // Auto-set cookie when ?token= is valid (so sub-requests like images get auth).
  // Only ever upward: `extractToken` has already picked the strongest credential
  // present, so writing it back can add access and never remove any. The strict
  // comparison is also what stops this re-sending an identical cookie on every
  // request once the browser is already holding it.
  const cookies = parseCookies(req)
  if (token && rankOf(level) > rankOf(validateToken(cookies.tlda_token))) {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
    res.setHeader('Set-Cookie', `tlda_token=${encodeURIComponent(token)}; ${flags}`)
  }
  next()
}

/** Express middleware: require RW access */
export function requireRw(req, res, next) {
  if (!gatingEnabled) return next()
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

export const requireRecordingPrivateRead = requireRw
