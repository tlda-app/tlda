import { createHash, timingSafeEqual } from 'node:crypto'

export function promotionExportToken() {
  return process.env.TLDA_PROMOTION_EXPORT_TOKEN || null
}

export function promotionExportHeaders() {
  const token = promotionExportToken()
  if (!token) throw new Error('server-to-server project promotion requires a dedicated export token')
  return { authorization: `Bearer ${token}` }
}

export function validatePromotionSourceOrigin(value) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid promotion source origin')
  }
  if (url.protocol === 'https:') return url.origin
  if (url.protocol !== 'http:' || !url.port || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.internal$/i.test(url.hostname)) {
    throw new Error('invalid promotion source origin')
  }
  if (!promotionExportToken()) throw new Error('internal promotion source requires a dedicated export token')
  return url.origin
}

export function requirePromotionExport(req, res, next) {
  const expected = promotionExportToken()
  const header = req.headers?.authorization
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!expected || !supplied) return res.status(401).json({ error: 'Unauthorized' })
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(supplied).digest()
  if (!timingSafeEqual(left, right)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
