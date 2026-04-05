/**
 * Handwriting recognition route.
 *
 * POST /api/recognize
 *   Body: { strokes: [{ x: number[], y: number[] }] }
 *   Returns: { latex: string } or { error: string }
 *
 * Proxies to MyScript iink batch API with Math content type.
 * Keeps API keys server-side (MYSCRIPT_APP_KEY, MYSCRIPT_HMAC_KEY).
 */

import { Router } from 'express'
import { createHmac } from 'crypto'

const router = Router()

const API_URL = 'https://cloud.myscript.com/api/v4.0/iink/batch'

router.post('/', async (req, res) => {
  const APP_KEY = process.env.MYSCRIPT_APP_KEY
  const HMAC_KEY = process.env.MYSCRIPT_HMAC_KEY
  if (!APP_KEY || !HMAC_KEY) {
    return res.status(503).json({ error: 'MyScript API keys not configured (MYSCRIPT_APP_KEY, MYSCRIPT_HMAC_KEY)' })
  }

  const { strokes } = req.body
  if (!strokes || !Array.isArray(strokes) || strokes.length === 0) {
    return res.status(400).json({ error: 'strokes array required' })
  }

  // Build StrokeGroup for MyScript
  const strokeGroups = [{
    strokes: strokes.map(s => ({
      x: s.x,
      y: s.y,
      // Synthesize timestamps from point index if not provided
      t: s.t || s.x.map((_, i) => i * 10),
    })),
  }]

  const body = JSON.stringify({
    contentType: 'Math',
    configuration: {
      math: {
        mimeTypes: ['application/x-latex'],
        solver: { enable: false },
      },
    },
    strokeGroups,
  })

  // HMAC authentication
  const hmac = createHmac('sha512', APP_KEY + HMAC_KEY)
  hmac.update(body)
  const signature = hmac.digest('hex')

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-latex',
        'applicationKey': APP_KEY,
        'hmac': signature,
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[recognize] MyScript error ${response.status}: ${text}`)
      return res.status(502).json({ error: `MyScript API error: ${response.status}` })
    }

    const latex = (await response.text()).trim()

    res.json({ latex })
  } catch (err) {
    console.error('[recognize] Request failed:', err.message)
    res.status(502).json({ error: 'MyScript API request failed' })
  }
})

export default router
