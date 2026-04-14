// Connect to Chrome via CDP, subscribe to console on all tlda tabs, print messages containing a filter.
import WebSocket from 'ws'
import { setTimeout as sleep } from 'node:timers/promises'

const filter = process.argv[2] || 'img-render'
const res = await fetch('http://localhost:9222/json')
const tabs = (await res.json()).filter(t => t.type === 'page' && t.title === 'tlda')

console.log(`attaching to ${tabs.length} tlda tabs, filter="${filter}"\n`)

for (const tab of tabs) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  let id = 0
  ws.on('open', () => {
    ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
    ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }))
  })
  ws.on('message', raw => {
    const m = JSON.parse(raw)
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ')
      if (!filter || args.includes(filter)) {
        console.log(`[tab ${tab.id.slice(-6)}] ${m.params.type}:`, args)
      }
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry
      if (!filter || (e.text || '').includes(filter)) {
        console.log(`[tab ${tab.id.slice(-6)}] ${e.level}:`, e.text)
      }
    }
  })
}

await sleep(300_000)
