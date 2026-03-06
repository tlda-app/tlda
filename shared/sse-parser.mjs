/**
 * Shared SSE (Server-Sent Events) stream parser.
 *
 * Used by the CLI watcher and MCP server to consume signal/shape SSE streams.
 */

import http from 'http'
import https from 'https'

/**
 * Parse an SSE data block into a JSON object.
 * Returns null if the block doesn't contain a valid data line.
 */
export function parseSSEBlock(block) {
  const dataLine = block.split('\n').find(l => l.startsWith('data: '))
  if (!dataLine) return null
  try {
    return JSON.parse(dataLine.slice(6))
  } catch {
    return null
  }
}

/**
 * Connect to an SSE endpoint and call onEvent for each parsed event.
 *
 * Returns { close() } to disconnect.
 *
 * Options:
 *   url      - full URL to the SSE endpoint
 *   headers  - HTTP headers (e.g. auth)
 *   onEvent  - callback(event) for each parsed JSON event
 *   onError  - callback() on connection error (optional)
 *   onEnd    - callback() on stream end (optional)
 *   filter   - if provided, only events where filter(event) is truthy are passed to onEvent
 */
export function connectSSE({ url, headers = {}, onEvent, onError, onEnd, filter }) {
  let closed = false
  let req = null

  function connect() {
    if (closed) return
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { ...headers, 'Accept': 'text/event-stream' },
    }
    const transport = isHttps ? https : http
    req = transport.get(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        onError?.()
        return
      }
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk.toString()
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 2)
          const event = parseSSEBlock(block)
          if (event && event.type !== 'connected') {
            if (!filter || filter(event)) {
              onEvent(event)
            }
          }
        }
      })
      res.on('end', () => { if (!closed) onEnd?.() })
      res.on('error', () => { if (!closed) onError?.() })
    })
    req.on('error', () => { if (!closed) onError?.() })
  }

  connect()

  return {
    close() {
      closed = true
      req?.destroy()
    },
    reconnect() {
      req?.destroy()
      connect()
    },
  }
}
