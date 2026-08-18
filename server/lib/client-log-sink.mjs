import { createRotatingAppender } from '../../shared/rotating-log.mjs'

const MAX_ACKNOWLEDGED_BATCHES = 10_000

export function createClientLogHandler({ clientLogFile, recordLivePerfEntry = () => {}, append = null }) {
  const acknowledgedBatches = new Set()
  // Nothing rotated this file and it reached 955 MB on his disk. Rotation, not
  // truncation: this log is the instrument several of 2026-08-18's findings were
  // measured from, so the generations have to survive the file getting big.
  const appendLines = append || createRotatingAppender(clientLogFile, {
    onRotate: (file, size) => console.log(`[client-log] rotated at ${size} bytes: ${file} -> ${file}.1`),
  })

  return async function clientLogHandler(req, res) {
    const body = req.body
    const deliveryId = typeof body?.deliveryId === 'string' ? body.deliveryId : null
    const entries = deliveryId && Array.isArray(body.entries)
      ? body.entries
      : Array.isArray(body) ? body : [body]

    if (deliveryId && acknowledgedBatches.has(deliveryId)) {
      return res.json({ ok: true, n: 0, duplicate: true })
    }

    const lines = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const obj = {
        ts: entry.ts || new Date().toISOString(),
        level: entry.level || 'info',
        ns: entry.ns || 'unknown',
        msg: entry.msg ?? '',
        ...(entry.data !== undefined ? { data: entry.data } : {}),
        ...(entry.session ? { session: entry.session } : {}),
      }
      if (obj.ns === 'live-perf') recordLivePerfEntry(obj)
      lines.push(JSON.stringify(obj))
    }

    try {
      if (lines.length) await appendLines(lines.join('\n') + '\n')
      if (deliveryId) {
        acknowledgedBatches.add(deliveryId)
        if (acknowledgedBatches.size > MAX_ACKNOWLEDGED_BATCHES) {
          acknowledgedBatches.delete(acknowledgedBatches.values().next().value)
        }
      }
      res.json({ ok: true, n: lines.length })
    } catch (error) {
      console.log(`[client-log] append failed: ${error.message}`)
      res.status(500).json({ ok: false, error: 'client log append failed' })
    }
  }
}
