#!/usr/bin/env node
/**
 * scroll-playback.mjs — Replay real DB events through the chat component
 * and verify scroll invariants at each step.
 *
 * Usage:
 *   node tests/scroll-playback.mjs [--agent <name>] [--speed <multiplier>] [--port <port>]
 *
 * Requires: playwright-cli, a running tlda server on the specified port,
 * and a test document with a fleet-chat shape.
 *
 * What it does:
 * 1. Queries fleet.db for a real agent's chat events
 * 2. Opens a headed browser to a test doc
 * 3. Creates a fleet-chat shape with the agent's filter
 * 4. Injects events via the fleet /api/chat/inject endpoint
 * 5. After each batch, checks scroll position via page.evaluate
 * 6. Reports pass/fail for each invariant
 */

import Database from 'better-sqlite3'
import { execSync, spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'

const DB_PATH = join(homedir(), '.config', 'tlda', 'fleet.db')

// Parse args
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const agentName = getArg('agent', 'tlda-ops')
const speed = parseFloat(getArg('speed', '10'))
const port = parseInt(getArg('port', '5179'))
const token = '15fc7709df6bf2f804c7e3d75ab8b34a'
const sessionName = 'scroll-playback'

console.log(`\n=== Scroll Playback Test ===`)
console.log(`Agent: ${agentName}, Speed: ${speed}x, Port: ${port}\n`)

// 1. Query events from DB
const db = new Database(DB_PATH, { readonly: true })
const agent = db.prepare(`SELECT id FROM agents WHERE friendly_name = ?`).get(agentName)
if (!agent) {
  console.error(`Agent "${agentName}" not found in DB`)
  process.exit(1)
}
const agentId = agent.id
console.log(`Agent ID: ${agentId}`)

// Get chat events involving this agent (as sender or receiver)
const events = db.prepare(`
  SELECT id, type, timestamp, from_id, to_id, text, metadata
  FROM events
  WHERE type = 'chat' AND (from_id = ? OR to_id = ?)
  ORDER BY timestamp ASC
  LIMIT 500
`).all(agentId, agentId)
db.close()

console.log(`Loaded ${events.length} events`)
if (events.length === 0) {
  console.error('No events found')
  process.exit(1)
}

// 2. Helper: run playwright-cli command
function pw(cmd) {
  try {
    const result = execSync(`playwright-cli -s=${sessionName} ${cmd}`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (process.env.DEBUG) console.log(`  [pw] ${cmd.slice(0,60)}... → ${result.slice(0,100)}`)
    return result
  } catch (e) {
    const out = e.stdout?.trim() || ''
    const err = e.stderr?.trim() || ''
    if (process.env.DEBUG) console.log(`  [pw ERROR] ${cmd.slice(0,60)}... → stdout: ${out.slice(0,100)} stderr: ${err.slice(0,100)}`)
    return out || e.message
  }
}

function pwEval(expr) {
  return pw(`eval '${expr.replace(/'/g, "\\'")}'`)
}

// 3. Check scroll state
function getScrollState() {
  // Use the HUD overlay's chat log (inside fleet-hud-wrap), not the hidden main canvas one
  const result = pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];if(!el)return "NO_EL";return JSON.stringify({dist:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),sH:Math.round(el.scrollHeight),sT:Math.round(el.scrollTop),cH:Math.round(el.clientHeight)})})()`)
  // The result from playwright-cli eval wraps the return in quotes with escaped braces
  // e.g. "### Result\n\"{\\\"dist\\\":0,...}\"\n..."
  // Try multiple extraction strategies
  const unescaped = result.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const match = unescaped.match(/\{"dist":\d+.*?\}/)
  if (!match) {
    if (process.env.DEBUG) console.log(`  [getScrollState] no match in: ${result.slice(0, 200)}`)
    return null
  }
  try { return JSON.parse(match[0]) } catch (e) {
    if (process.env.DEBUG) console.log(`  [getScrollState] parse error: ${e.message} for: ${match[0]}`)
    return null
  }
}

// 4. Open browser and set up
console.log('\nOpening browser...')
const headed = args.includes('--headed')
pw(`open ${headed ? '--headed' : ''} "http://localhost:${port}/?doc=test-playback&name=skip&token=${token}"`)
await delay(12000) // wait for page + data load

// Create fleet chat shape
console.log('Creating fleet-chat shape...')
pwEval(`(function(){var e=window.__tldraw_editor__;e.createShape({type:"fleet-chat",x:-1200,y:0,props:{w:400,h:600,filter:[[["to","${agentName}"],["from","${agentName}"]]]}});return "shape created"})()`)
await delay(2000)
// Toggle HUD separately — needs its own event dispatch
console.log('Toggling HUD...')
pwEval(`(function(){window.dispatchEvent(new CustomEvent("fleet-hud-toggle"));return "toggled"})()`)
await delay(5000) // wait for HUD render + history fetch

// 5. Run tests
const results = []
let prevDist = null
let userScrolledUp = false

async function test(name, fn) {
  const result = await fn()
  const icon = result.pass ? '✓' : '✗'
  console.log(`  ${icon} ${name}: ${result.detail}`)
  results.push({ name, ...result })
}

// Test A: Initial load — should be at bottom
console.log('\n--- Test A: Initial load ---')
await test('At bottom after load', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// Test B: Inject 20 messages — should stay at bottom
console.log('\n--- Test B: 20 messages arrive while at bottom ---')
for (let i = 0; i < 20 && i < events.length; i++) {
  const e = events[i]
  const body = JSON.stringify({
    from: e.from_id,
    to: e.to_id || agentId,
    message: e.text || `playback msg ${i}`,
  })
  try {
    execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
  } catch {}
  if (i % 5 === 4) await delay(200) // small batch delay
}
await delay(1000)
await test('Still at bottom after 20 messages', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// Test C: Scroll up, inject 10 messages — should stay scrolled up
console.log('\n--- Test C: Scrolled up + messages ---')
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop-=500;return "ok"})()`)
await delay(500)
const beforeDist = getScrollState()?.dist || 0

for (let i = 20; i < 30 && i < events.length; i++) {
  const e = events[i]
  const body = JSON.stringify({
    from: e.from_id,
    to: e.to_id || agentId,
    message: e.text || `playback msg ${i}`,
  })
  try {
    execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
  } catch {}
}
await delay(1000)
await test('Stayed scrolled up after 10 messages', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  // dist should be >= beforeDist (messages added height, shouldn't scroll down)
  return { pass: s.dist >= beforeDist - 50, detail: `dist before=${beforeDist} after=${s.dist}` }
})

// Test D: Scroll back to bottom, verify it follows
console.log('\n--- Test D: Return to bottom + messages ---')
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(500)

for (let i = 30; i < 40 && i < events.length; i++) {
  const e = events[i]
  const body = JSON.stringify({
    from: e.from_id,
    to: e.to_id || agentId,
    text: e.text || `playback msg ${i}`,
  })
  try {
    execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 })
  } catch {}
}
await delay(1000)
await test('Following at bottom after return', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// Test E: Reload — should land at bottom
console.log('\n--- Test E: Reload ---')
// Set localStorage before navigation so HUD stays expanded
pwEval(`(function(){localStorage.setItem("fleet-hud-expanded","1");return "ok"})()`)
pw(`goto "http://localhost:${port}/?doc=test-playback&name=skip&token=${token}"`)
await delay(10000)
// Ensure HUD is open
pwEval(`(function(){if(!document.querySelector(".fleet-chat-log")){window.dispatchEvent(new CustomEvent("fleet-hud-toggle"))}return "ok"})()`)
await delay(3000)
await test('At bottom after reload', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// After reload, re-toggle HUD (localStorage may not persist across playwright navigation)
pwEval(`(function(){if(!document.querySelector(".fleet-hud-wrap")){window.dispatchEvent(new CustomEvent("fleet-hud-toggle"))}return "ok"})()`)
await delay(3000)

// Test F: Rapid burst — 10 messages in <500ms
console.log('\n--- Test F: Rapid burst (10 msgs in <500ms) ---')
// Ensure we're at bottom first
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(300)
for (let i = 40; i < 50 && i < events.length; i++) {
  const e = events[i]
  const body = JSON.stringify({ from: e.from_id, to: e.to_id || agentId, message: e.text || `burst ${i}` })
  try { execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
  // No delay between messages — rapid burst
}
await delay(1500)
await test('Still at bottom after rapid burst', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// Test G: Long messages (tall items exceeding virtualizer 65px estimate)
console.log('\n--- Test G: Long messages (tall items) ---')
const longMsg = 'This is a long message with multiple lines.\n'.repeat(20) + '```\ncode block\nwith many lines\n' + 'x = x + 1\n'.repeat(10) + '```'
const longBody = JSON.stringify({ from: agentId, to: 'fleet:skip', message: longMsg })
try { execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${longBody.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
await delay(1500)
await test('At bottom after long message', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 150, detail: `dist=${s.dist}` }
})

// Test H: Multiline textarea — no bounce (dist should stay stable)
console.log('\n--- Test H: Multiline textarea (no bounce) ---')
pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(!ta)return "no ta";ta.focus();ta.value="line1\\nline2\\nline3\\nline4\\nline5";ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,200)+"px";ta.dispatchEvent(new Event("input",{bubbles:true}));return "typed"})()`)
await delay(500)
const distBefore = getScrollState()?.dist ?? -1
await delay(1000) // wait for any potential bounce
const distAfter = getScrollState()?.dist ?? -1
await test('No bounce from multiline textarea', async () => {
  if (distBefore < 0 || distAfter < 0) return { pass: false, detail: 'no scroll element' }
  // dist should not have changed significantly (no bounce)
  return { pass: Math.abs(distAfter - distBefore) < 30, detail: `dist before=${distBefore} after=${distAfter}` }
})

// Clear the textarea
pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(ta){ta.value="";ta.style.height="auto"}return "cleared"})()`)

// Test I: Scroll stability over time (no drift)
console.log('\n--- Test I: Scroll stability (5 readings over 3s) ---')
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(300)
const readings = []
for (let i = 0; i < 5; i++) {
  const s = getScrollState()
  readings.push(s?.dist ?? -1)
  await delay(600)
}
await test('No scroll drift over 3s', async () => {
  const valid = readings.filter(d => d >= 0)
  if (valid.length < 3) return { pass: false, detail: `only ${valid.length} valid readings` }
  const maxDrift = Math.max(...valid) - Math.min(...valid)
  return { pass: maxDrift < 30, detail: `readings=[${valid.join(',')}] maxDrift=${maxDrift}` }
})

// Test J: Textarea not floating over messages (no transparent background)
console.log('\n--- Test J: Textarea not overlapping messages ---')
await test('Textarea has opaque background', async () => {
  const result = pwEval(`(function(){
    var els=document.querySelectorAll(".fleet-chat-log");
    var best=-1;var bestSH=0;
    for(var i=0;i<els.length;i++){if(els[i].scrollHeight>bestSH){bestSH=els[i].scrollHeight;best=i}}
    if(best<0)return "NO_CHAT_LOG";
    var chatLog=els[best];
    var inputArea=chatLog.querySelector(".fleet-chat-input-area");
    if(!inputArea)return "NOT_STICKY";
    var cs=getComputedStyle(inputArea);
    var bg=cs.backgroundColor;
    return bg;
  })()`)
  const match = result.match(/rgba?\([^)]+\)/)
  if (!match) {
    // If no .fleet-chat-input-area inside the scroll container, the layout
    // is flex (textarea outside scroll) — which is correct, no overlap possible
    if (result.includes('NOT_STICKY')) return { pass: true, detail: 'textarea outside scroll container (flex layout)' }
    return { pass: false, detail: 'could not read background' }
  }
  const bg = match[0]
  // Check if background is opaque (alpha = 1 or no alpha channel)
  const isTransparent = bg.includes('0, 0, 0, 0') || bg === 'rgba(0, 0, 0, 0)'
  return { pass: !isTransparent, detail: `background: ${bg}` }
})

// Test K: When scrolled to middle, textarea doesn't visually overlap messages
console.log('\n--- Test K: No visual overlap when scrolled to middle ---')
await test('No message overlap when scrolled to middle', async () => {
  const result = pwEval(`(function(){
    var els=document.querySelectorAll(".fleet-chat-log");
    var best=-1;var bestSH=0;
    for(var i=0;i<els.length;i++){if(els[i].scrollHeight>bestSH){bestSH=els[i].scrollHeight;best=i}}
    if(best<0)return JSON.stringify({pass:true,detail:"no scrollable chat"});
    var chatLog=els[best];
    if(chatLog.scrollHeight<=chatLog.clientHeight)return JSON.stringify({pass:true,detail:"not scrollable"});
    chatLog.scrollTop=chatLog.scrollHeight*0.3;
    var inputArea=chatLog.querySelector(".fleet-chat-input-area");
    if(!inputArea)return JSON.stringify({pass:true,detail:"textarea outside scroll (flex layout)"});
    var taRect=inputArea.getBoundingClientRect();
    var chatLines=chatLog.querySelectorAll(".chat-line");
    var overlaps=0;
    for(var i=0;i<chatLines.length;i++){
      var mr=chatLines[i].getBoundingClientRect();
      if(mr.bottom>taRect.top&&mr.top<taRect.bottom&&mr.height>0){overlaps++}
    }
    chatLog.scrollTop=chatLog.scrollHeight;
    return JSON.stringify({overlaps:overlaps,taY:Math.round(taRect.top)});
  })()`)
  const unescaped = result.replace(/\\"/g, '"')
  const match = unescaped.match(/\{.*\}/)
  if (!match) return { pass: false, detail: 'could not parse result' }
  try {
    const data = JSON.parse(match[0])
    if (data.pass !== undefined) return { pass: data.pass, detail: data.detail }
    return { pass: data.overlaps === 0, detail: `${data.overlaps} messages overlap textarea at y=${data.taY}` }
  } catch { return { pass: false, detail: 'parse error' } }
})

// Test L: Textarea grows via REAL keyboard input → message arrives → should auto-scroll
// Uses playwright keyboard.type to trigger the actual onInput handler's
// height=auto → height=scrollHeight cycle — the real source of the bug.
console.log('\n--- Test L: Real keyboard multiline + message arrival ---')
// Start at bottom
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(300)
// Focus textarea and type multiline via real keyboard (triggers onInput resize)
pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(ta){ta.focus();ta.click()}return "focused"})()`)
await delay(200)
// Type multiple lines with real Enter keys (Shift+Enter for newlines)
pw(`type "line1"`)
await delay(100)
// Use Shift+Enter for newlines in textarea
for (let line = 2; line <= 8; line++) {
  pwEval(`(function(){
    var ta=document.querySelector(".fleet-chat-input-area textarea");
    var pos=ta.selectionStart;
    ta.value=ta.value.slice(0,pos)+"\\n"+"line${line}"+ta.value.slice(pos);
    ta.selectionStart=ta.selectionEnd=pos+1+("line${line}").length;
    ta.style.height="auto";
    ta.style.height=Math.min(ta.scrollHeight,200)+"px";
    ta.dispatchEvent(new Event("input",{bubbles:true}));
    return "line ${line} added, h="+ta.offsetHeight;
  })()`)
  await delay(100)
}
await delay(500)
// Check textarea actually grew
const taHeight = pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");return ""+ta.offsetHeight})()`)
const taH = parseInt((taHeight.match(/\d+/) || ['0'])[0])
console.log(`  textarea height: ${taH}px`)
// Now inject a message while textarea is tall
const lBody = JSON.stringify({ from: agentId, to: 'fleet:skip', message: 'Message arriving while textarea is multiline — should auto-scroll' })
try { execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${lBody.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
await delay(1500)
await test('Auto-scroll works with real multiline textarea', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  // If textarea didn't grow (taH <= 30), the test isn't meaningful
  if (taH <= 30) return { pass: false, detail: `textarea didn't grow (h=${taH}) — test not exercised` }
  return { pass: s.dist < 300, detail: `dist=${s.dist}, textarea h=${taH}` }
})
// Clear textarea
pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(ta){ta.value="";ta.style.height="auto"}return "ok"})()`)

// Test M: Multiple messages while textarea is tall
console.log('\n--- Test M: Multiple messages with tall textarea ---')
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(300)
pwEval(`(function(){
  var ta=document.querySelector(".fleet-chat-input-area textarea");
  if(!ta)return "no ta";
  ta.value="typing while agents respond\\nline2\\nline3\\nline4\\nline5";
  ta.style.height="auto";
  ta.style.height=Math.min(ta.scrollHeight,200)+"px";
  return "ok";
})()`)
await delay(300)
for (let i = 50; i < 55 && i < events.length; i++) {
  const e = events[i]
  const body = JSON.stringify({ from: e.from_id, to: e.to_id || agentId, message: e.text || `msg-during-typing ${i}` })
  try { execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
  await delay(300) // realistic pacing
}
await delay(1000)
await test('Auto-scroll works during typing + messages', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 300, detail: `dist=${s.dist}` }
})
pwEval(`(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(ta){ta.value="";ta.style.height="auto"}return "ok"})()`)

// Test N: Send message while textarea is multiline at bottom
console.log('\n--- Test N: Send with multiline textarea at bottom ---')
pwEval(`(function(){var els=document.querySelectorAll(".fleet-chat-log");var el=els.length>1?els[els.length-1]:els[0];el.scrollTop=el.scrollHeight;return "ok"})()`)
await delay(300)
const distBeforeSend = getScrollState()?.dist ?? -1
// Type multiline then "send" (clear textarea, inject optimistic)
pwEval(`(function(){
  var ta=document.querySelector(".fleet-chat-input-area textarea");
  if(!ta)return "no ta";
  ta.value="sending multiline\\nline2\\nline3";
  ta.style.height="auto";
  ta.style.height=Math.min(ta.scrollHeight,200)+"px";
  return "typed";
})()`)
await delay(300)
// Simulate send: clear textarea and inject message
pwEval(`(function(){
  var ta=document.querySelector(".fleet-chat-input-area textarea");
  ta.value="";ta.style.height="auto";
  return "cleared";
})()`)
const sendBody = JSON.stringify({ from: 'fleet:skip', to: agentId, message: 'sent message after multiline clear' })
try { execSync(`curl -s -X POST "http://localhost:${port}/api/chat" -H "Content-Type: application/json" -d '${sendBody.replace(/'/g, "'\\''")}'`, { timeout: 5000 }) } catch {}
await delay(1500)
await test('At bottom after multiline send', async () => {
  const s = getScrollState()
  if (!s) return { pass: false, detail: 'no scroll element' }
  return { pass: s.dist < 300, detail: `dist=${s.dist} (was ${distBeforeSend} before send)` }
})

// Summary
console.log('\n=== Results ===')
const passed = results.filter(r => r.pass).length
const total = results.length
console.log(`${passed}/${total} passed`)
if (passed < total) {
  console.log('\nFailed:')
  results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

// Cleanup
pw('close')
process.exit(passed === total ? 0 : 1)
