import { Router } from 'express'
import { AccessToken } from 'livekit-server-sdk'
import { requireRead } from '../lib/auth.mjs'

const router = Router()

function livekitConfig() {
  const url = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || ''
  const apiKey = process.env.LIVEKIT_API_KEY || ''
  const apiSecret = process.env.LIVEKIT_API_SECRET || ''
  return { url, apiKey, apiSecret, configured: !!(url && apiKey && apiSecret) }
}

function cleanPart(value, fallback) {
  const s = String(value || fallback || '').trim().toLowerCase()
  return s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback
}

function roomName(doc, session) {
  return `tlda-${cleanPart(doc, 'doc')}-${cleanPart(session, 'live')}`
}

router.get('/config', requireRead, (req, res) => {
  const cfg = livekitConfig()
  res.json({
    configured: cfg.configured,
    url: cfg.configured ? cfg.url : '',
  })
})

router.post('/token', requireRead, async (req, res) => {
  const cfg = livekitConfig()
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'LiveKit is not configured',
      required: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
    })
  }

  const doc = cleanPart(req.body?.doc, 'doc')
  const session = cleanPart(req.body?.session, 'live')
  const identity = cleanPart(req.body?.identity, `viewer-${Date.now().toString(36)}`)
  const name = String(req.body?.name || identity).slice(0, 80)
  const room = roomName(doc, session)

  try {
    const token = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity,
      name,
      ttl: '6h',
      metadata: JSON.stringify({
        app: 'tlda',
        doc,
        session,
      }),
      attributes: {
        'tlda.doc': doc,
        'tlda.session': session,
      },
    })
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    })

    res.json({
      url: cfg.url,
      room,
      token: await token.toJwt(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
