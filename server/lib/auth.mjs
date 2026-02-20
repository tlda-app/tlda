/**
 * Bearer token authentication.
 *
 * Two tokens:
 *   - Read token (CTD_TOKEN_READ / config.tokenRead): GET routes, /docs/*, WebSocket
 *   - RW token (CTD_TOKEN_RW / config.tokenRw): everything including POST/DELETE API routes
 *
 * When no tokens are configured, auth is disabled (backward-compatible local use).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

let tokenRead = null
let tokenRw = null
let authEnabled = false

export function initAuth() {
  tokenRead = process.env.CTD_TOKEN_READ || null
  tokenRw = process.env.CTD_TOKEN_RW || null

  if (!tokenRead || !tokenRw) {
    const configPath = join(homedir(), '.config', 'ctd', 'config.json')
    try {
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        tokenRead = tokenRead || config.tokenRead || null
        tokenRw = tokenRw || config.tokenRw || null
      }
    } catch {}
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

/** Extract token from Authorization header or ?token= query param */
export function extractToken(req) {
  const auth = req.headers?.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`)
  return url.searchParams.get('token') || null
}

/** Express middleware: require at least read access */
export function requireRead(req, res, next) {
  if (!authEnabled) return next()
  const token = extractToken(req)
  const level = validateToken(token)
  if (!level) return res.status(401).json({ error: 'Unauthorized' })
  req.authLevel = level
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
