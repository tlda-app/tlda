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
 * A third secret, `TLDA_TOKEN_AGENT`, is the agents' own credential: same
 * operator admission as the other two, a separate value so it can be rotated
 * and revoked without touching what the box already runs on. Env-only, always —
 * it is never read from tokens.json.
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
let tokenAgent = null
let gatingEnabled = false

export function initAuth() {
  const serverConfig = loadServerConfig()

  tokenRead = null
  tokenRw = null
  tokenAgent = null
  if (!serverConfig.tokenGating) {
    gatingEnabled = false
    return
  }

  const envTokensOnly = !!serverConfig.tokensFromEnvironmentOnly
  tokenRead = process.env.TLDA_TOKEN_READ || (envTokensOnly ? null : getReadToken())
  tokenRw = process.env.TLDA_TOKEN_RW || (envTokensOnly ? null : getRwToken())
  tokenAgent = process.env.TLDA_TOKEN_AGENT || null

  // Gating on with nothing to check is the one state that must never be reached
  // quietly: it reads as protected and behaves as open. Fail loudly instead.
  if (!tokenRead && !tokenRw && !tokenAgent) {
    throw new Error(envTokensOnly
      ? '[tokens] server.yaml sets tokensFromEnvironmentOnly but no TLDA_TOKEN_READ/TLDA_TOKEN_RW/TLDA_TOKEN_AGENT secrets are configured'
      : '[tokens] server.yaml sets tokenGating but no read, RW, or agent token is configured')
  }

  gatingEnabled = true
  rebuildIdentityTable()
  console.log('[tokens] Token gating enabled')
  if (!tokenRead) console.warn('[tokens] Warning: no read token configured')
  if (!tokenRw) console.warn('[tokens] Warning: no RW token configured')
}

export function isTokenGatingEnabled() { return gatingEnabled }

/**
 * A shareable link token for handing to somebody else: one of the configured
 * tokens, suitable for writing into a URL. Which one is arbitrary now that
 * tokens carry no level — any admitted token admits the same. Never the agent
 * token: it authenticates agents to the box, and a URL is how a secret stops
 * being one.
 */
export function configuredReadToken() { return tokenRead || tokenRw }

/**
 * The identities one bearer token can resolve to.
 *
 * A table rather than two configured strings, and deliberately small: with
 * gating off there is exactly one row (everything resolves to operator), and
 * with gating on there is one row per configured token. A shared bearer has
 * no members, so every row is the operator — classroom persons resolve
 * through their own per-person tokens (students / instructors tables), never
 * here. The table exists so the shape is a seam and not an assumption: if a
 * day comes when two callers on the operator surface must resolve to two
 * different identities, the rows change and the callers do not.
 *
 * `groups` is the unix half. Today the operator's groups are empty; the
 * instructors group lives on the classroom side (`isInstructorOf`), and the
 * person tables carry the membership. An operator group added here must mean
 * the same thing everywhere it is checked, or it is a second membership store
 * wearing the name of the first.
 */
const OPERATOR = { kind: 'operator', groups: [] }

let identityTable = [{ token: null, identity: OPERATOR }]

function rebuildIdentityTable() {
  if (!gatingEnabled) {
    identityTable = [{ token: null, identity: OPERATOR }]
    return
  }
  identityTable = []
  if (tokenRw) identityTable.push({ token: tokenRw, identity: OPERATOR })
  if (tokenRead && tokenRead !== tokenRw) identityTable.push({ token: tokenRead, identity: OPERATOR })
  if (tokenAgent && tokenAgent !== tokenRw && tokenAgent !== tokenRead) {
    identityTable.push({ token: tokenAgent, identity: OPERATOR })
  }
}

/**
 * Who this token is, or null when it is not one of ours. A table lookup —
 * the token resolves to an identity, and what that identity may do is decided
 * afterwards. This is the 3.1 seam: `may()` and the route gates read the
 * returned identity, never the token.
 */
export function resolveIdentity(token) {
  if (!gatingEnabled) return OPERATOR
  if (!token) return null
  const row = identityTable.find(row => row.token && token === row.token)
  return row ? row.identity : null
}

/**
 * May this identity do this action on this resource — 3.3, the one predicate.
 *
 * Two surfaces, one signature. The operator surface (projects, history,
 * agent/daemon, git-http): the operator may do anything, nobody may do
 * nothing — `isOperator ? allow : deny`, exactly the (a) answer, with the
 * resource and action carried so a future per-resource rule has somewhere to
 * read from rather than a new parameter to thread through forty routes. The
 * classroom surface does NOT come here: persons resolve through
 * `studentForToken` / `instructorForToken`, and their predicate is
 * `classroomRoomAccess` / `mayReadStudentWork` over the resolved principal —
 * 3.6 makes the sync-room check call that, it does not reroute through this.
 *
 * The seam rule, and it is load-bearing: a route that looks operator-ish but
 * touches a student's work belongs on the classroom side. `projects.mjs`
 * answer-thread gating already does this by hand — that is the shape, and the
 * file a route lives in does not decide which predicate it gets.
 */
export function may(identity, resource, action) {
  if (!identity) return false
  if (identity.kind === 'operator') return true
  return false
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
    if (resolveIdentity(candidate)) return candidate
  }
  return candidates[0] ?? null
}

/** GET /auth/login?token=xxx[&redirect=/path] — set cookie, redirect to viewer */
export function loginRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  const token = url.searchParams.get('token')
  if (!token) return res.status(400).send('Missing ?token= parameter')

  if (!resolveIdentity(token)) return res.status(401).send('Invalid token')

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

/**
 * Admit the operator, refuse nobody-with-a-name — 3.4, the gate the forty
 * routes share. The token resolves to an identity (3.1) and the identity
 * answers `may()` (3.3); the resource rides along so a per-resource rule has
 * somewhere to read from. Admission grants nothing by itself.
 *
 * Classroom persons do not come here; their routes resolve through
 * `studentForToken` / `instructorForToken` and gate on the principal.
 */
export function requireIdentity(resource) {
  return (req, res, next) => {
    const identity = resolveIdentity(extractToken(req))
    if (!may(identity, resource, req.method)) return res.status(401).json({ error: 'Unauthorized' })
    req.identity = identity
    next()
  }
}

/** Express middleware: require a recognised token. The only question asked of
 * the token is whether it is one of ours; what the caller may do is decided
 * from their identity afterwards. */
export function requireRead(req, res, next) {
  const token = extractToken(req)
  const identity = resolveIdentity(token)
  if (!identity) return res.status(401).json({ error: 'Unauthorized' })
  req.identity = identity
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

/**
 * The operator's write gate — 3.4, the name the forty write routes share.
 * Resolves the bearer to an identity (3.1) and asks `may()` (3.3) about the
 * operator's own machinery: projects, history, shapes, recordings-as-lectures,
 * fleet operations, git-http. Anything touching a student's work does not come
 * here — it gates on the classroom principal instead, whatever file it lives
 * in. Same admission as `requireRead` plus the write predicate, so a caller
 * admitted to read is admitted to write exactly when they are the operator.
 */
export function requireOperatorWrite(req, res, next) {
  const identity = resolveIdentity(extractToken(req))
  if (!may(identity, { type: 'operator-machinery' }, 'write')) return res.status(401).json({ error: 'Unauthorized' })
  req.identity = identity
  next()
}
