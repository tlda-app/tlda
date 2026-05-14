import { WebSocket } from 'ws'

const PORT = parseInt(process.argv[2] || '5190', 10)
const DOC = process.argv[3] || 'test-doc-pings'
const MODE = process.argv[4] || 'pings-only'   // 'pings-only' | 'active'

const sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const url = `ws://localhost:${PORT}/sync/${DOC}?sessionId=${sessionId}`
const ws = new WebSocket(url)
console.log(`[client mode=${MODE}] connecting to ${url}`)

ws.on('open', () => {
  console.log(`[client] open`)
  // tldraw clients first send a connect request. Without it the room may
  // reject. But for our reaper test we just need the message listener to
  // see pings and ignore them.
  ws.send(JSON.stringify({ type: 'connect', sessionId, clientId: 'reaper-test', protocolVersion: 7, lastServerClock: 0 }))
  console.log('[client] sent connect')
  setInterval(() => {
    try { ws.send('{"type":"ping"}'); console.log('[client] sent ping') } catch (e) {}
  }, 5000)
  if (MODE === 'active') {
    // Pretend to send small "push" messages so they look like real activity
    setInterval(() => {
      try { ws.send('{"type":"push","diff":{}}'); console.log('[client] sent push (synthetic activity)') } catch (e) {}
    }, 7000)
  }
})
ws.on('message', (data) => {
  const s = data.toString()
  console.log(`[client] recv: ${s.slice(0, 80)}${s.length > 80 ? '...' : ''}`)
})
ws.on('error', (e) => console.error('[client] error', e.message))
ws.on('close', (code, reason) => console.log(`[client] closed code=${code} reason=${reason?.toString() || '(none)'}`))

setTimeout(() => process.exit(0), 600000)
