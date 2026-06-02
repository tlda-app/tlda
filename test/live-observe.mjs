#!/usr/bin/env node
/**
 * Live-observe: open the chat against the live WS pipeline, stream a realistic
 * mix of real messages (plain + complex markdown/KaTeX/image) at human cadence,
 * and WATCH auto-follow — never scripting a scroll. Records drift-from-bottom
 * after each message + screenshots. This is the "does it actually stay pinned
 * under real traffic" test, not a scripted assert.
 *
 *   node test/live-observe.mjs --mode candidate|current --port 5184 --doc test-scroll2
 */
import { chromium } from 'playwright'
import WebSocket from 'ws'

const arg = (k, d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d
const MODE = arg('--mode', 'candidate')
const PORT = arg('--port', '5184')
const DOC = arg('--doc', 'test-scroll2')
const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c'
const WS_URL = 'wss://localhost:5176/ws/fleet'
const SENDER = 'fleet:scroll-test-agent'
const TARGET = 'fleet:cf397d07' // friendly_name tlda-ops — matches the chat filter

const TALL_SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#446"/><text x="20" y="110" fill="#fff" font-size="20">late image</text></svg>'
).toString('base64')

const plain = (n) => `Live message ${n} — just a normal line of chat, like a quick reply.`
const complex = (n) => [
  `### Real-ish complex message ${n}`, '',
  'Prose with **bold**, `code`, and a list:', '',
  '- alpha', '- beta', '- gamma', '',
  '```js', `const k = ${n} // code block`, '```', '',
  'Inline $\\sum_{i=1}^{n}x_i^2$ and display:', '',
  `$$\\int_0^1 e^{x}\\,dx = \\beta_${n}$$`, '',
  `![](${TALL_SVG})`,
].join('\n')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let ws, idc = 1
function connect() {
  return new Promise((res, rej) => {
    const s = new WebSocket(WS_URL, { rejectUnauthorized: false })
    const t = setTimeout(() => rej(new Error('ws timeout')), 8000)
    s.on('open', () => { clearTimeout(t); ws = s; s.send(JSON.stringify({ type: 'register', id: SENDER, name: 'scroll-test-agent', cwd: process.cwd(), labels: ['bot'], human: false })); res() })
    s.on('error', e => { clearTimeout(t); rej(e) })
  })
}
const send = (text) => ws.send(JSON.stringify({ id: idc++, type: 'chat', from: SENDER, to: TARGET, message: text }))

async function drift(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bc = -1
    for (const el of els) { const c = el.querySelectorAll('.chat-line').length; if (c > bc) { best = el; bc = c } }
    if (!best) return null
    return Math.round(best.scrollHeight - best.scrollTop - best.clientHeight)
  })
}

async function run() {
  console.log(`live-observe mode=${MODE} doc=${DOC}`)
  await connect(); await sleep(400)
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, recordVideo: { dir: `/tmp/live-observe-${MODE}/` } })
  const page = await ctx.newPage()
  await ctx.addInitScript((m) => { try { localStorage.setItem('scroll-mode', m) } catch {} }, MODE)
  await page.goto(`https://localhost:${PORT}/?doc=${DOC}&name=scroll-tester&token=${TOKEN}&scroll=${MODE}&pw=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 45000 }).catch(() => console.log('(no editor global)'))
  await sleep(2000)
  // Create a chat panel filtered to the target's live traffic
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__; if (!ed) throw new Error('no editor')
    const filter = [[['from', 'tlda-ops']], [['to', 'tlda-ops']]]
    ed.createShapes([{ id: 'shape:live-chat-1', type: 'fleet-chat', x: 0, y: 0, props: { w: 440, h: 560, filter } }])
    localStorage.setItem('fleet-hud-expanded', '1')
    const b = ed.getShapePageBounds('shape:live-chat-1')
    if (b) ed.setCamera({ x: -b.x + 60, y: -b.y + 60, z: 1 })
  })
  await sleep(1500)
  await page.waitForSelector('.fleet-chat-log', { timeout: 20000, state: 'attached' })
  await sleep(2500)

  // Stream a realistic mix at human cadence; NEVER scroll. Watch auto-follow.
  const drifts = []
  const N = 16
  for (let i = 1; i <= N; i++) {
    send(i % 3 === 0 ? complex(i) : plain(i))
    await sleep(2200)
    const d = await drift(page)
    drifts.push(d)
    if (i === 1 || i === Math.ceil(N / 2) || i === N) await page.screenshot({ path: `/tmp/live-observe-${MODE}-step${i}.png` })
  }
  // Let final complex content finish reflowing
  await sleep(2500)
  const finalDrift = await drift(page)
  await page.screenshot({ path: `/tmp/live-observe-${MODE}-final.png` })

  const maxDrift = Math.max(...drifts.filter(d => d != null))
  const pinned = drifts.filter(d => d != null && d < 40).length
  console.log(`drifts: ${drifts.join(', ')}`)
  console.log(`finalDrift=${finalDrift}  maxDrift=${maxDrift}  pinnedSamples=${pinned}/${drifts.length}`)
  console.log(`VERDICT: ${finalDrift != null && finalDrift < 40 && maxDrift < 120 ? 'STAYS PINNED under live flow' : 'DRIFTS OFF BOTTOM (auto-follow broke)'}`)

  await ctx.close(); await browser.close(); try { ws.close() } catch {}
}
run().catch(e => { console.error(e); process.exit(1) })
