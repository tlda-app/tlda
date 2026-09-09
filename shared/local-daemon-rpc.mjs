import { createConnection } from 'node:net'

export async function callLocalDaemonRpc(op, params = {}, { socketPath, timeoutMs = null, onEvent = null } = {}) {
  if (!socketPath) throw new Error('local daemon socket path is required')
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const timer = timeoutMs == null ? null : setTimeout(() => {
      fail(new Error(`local daemon ${op} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(JSON.stringify({ op, params })))
    const handlePayload = payload => {
      if (payload.event) {
        onEvent?.(payload.event, payload.data || {})
        return
      }
      if (!payload.ok) throw new Error(payload.error || `local daemon ${op} failed`)
      settled = true
      if (timer) clearTimeout(timer)
      resolve(payload.result)
    }
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try { handlePayload(JSON.parse(line)) } catch (error) { fail(error); break }
      }
    })
    socket.on('error', error => {
      if (timer) clearTimeout(timer)
      const message = error.code === 'ENOENT'
        ? `local daemon ${op} failed: no socket at ${socketPath} (ENOENT)`
        : error.code === 'ECONNREFUSED'
          ? `local daemon ${op} failed: connection refused at ${socketPath} (ECONNREFUSED)`
          : `local daemon ${op} failed: ${error.message}`
      fail(new Error(message))
    })
    socket.on('close', () => {
      if (settled) return
      if (timer) clearTimeout(timer)
      try {
        const line = buffer.trim()
        if (!line) throw new Error(`local daemon ${op} ended without a result`)
        handlePayload(JSON.parse(line))
      } catch (error) { fail(error) }
    })
  })
}
