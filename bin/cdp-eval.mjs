// Run JS in a specific tab via CDP, print the result.
import WebSocket from 'ws'

const expr = process.argv[2]
if (!expr) { console.error('Usage: cdp-eval.mjs "expression"'); process.exit(1) }

const res = await fetch('http://localhost:9222/json')
const tabs = (await res.json()).filter(t => t.type === 'page' && t.title === 'tlda')
if (tabs.length === 0) { console.error('no tlda tab'); process.exit(1) }

const tab = tabs[0]
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise(r => ws.once('open', r))

let id = 0
const call = (method, params) => new Promise(resolve => {
  const rid = ++id
  const handler = raw => {
    const m = JSON.parse(raw)
    if (m.id === rid) { ws.off('message', handler); resolve(m.result) }
  }
  ws.on('message', handler)
  ws.send(JSON.stringify({ id: rid, method, params }))
})

const result = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(result, null, 2))
ws.close()
