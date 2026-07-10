/**
 * Test harness for chat-scroll behavior tests.
 *
 * Wraps playwright-cli to drive a worktree dev server (vite on alternate port)
 * and provides assertion primitives. Refuses to run against the live working copy.
 *
 * Tests built on this harness should:
 *   import { setup, teardown, getScrollState, sendChat, ... } from './harness.mjs'
 *
 *   const ctx = await setup({})
 *   try {
 *     await scrollToBottom(ctx)
 *     await sendChat(ctx, { from: 'X', message: 'test' })
 *     await delay(1000)
 *     expectAtBottom(getScrollState(ctx))
 *   } finally {
 *     await teardown(ctx)
 *   }
 *
 * Required prerequisites (the runner checks these and bails with a clear msg):
 *   - vite dev server running on TLDA_TEST_PORT (default 5179) inside this worktree
 *   - tlda server running on 5176 (Skip's live server — used for chat data)
 *   - playwright-cli on PATH
 *
 * NEVER run this against the live working copy — assertWorktree() throws if you do.
 */

import { execSync } from 'child_process'
import { setTimeout as delay } from 'timers/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'

const LIVE_WORKING_COPY = '/Users/skip/work/tlda'
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKTREE_ROOT = resolve(HERE, '..')

export const cfg = {
  port: parseInt(process.env.TLDA_TEST_PORT || '5179'),
  fleetPort: 5176,
  token: process.env.TLDA_TEST_TOKEN || 'c5e4726ab77972fc7312f3a703f9cf1c',
  doc: process.env.TLDA_TEST_DOC || 'test-playback',
  worktree: WORKTREE_ROOT,
  dbPath: join(homedir(), '.config', 'tlda', 'fleet.db'),
}

export function assertWorktree() {
  if (cfg.worktree === LIVE_WORKING_COPY) {
    throw new Error(
      `Refusing to run tests from live working copy at ${LIVE_WORKING_COPY}.\n` +
      `Run from a worktree (e.g., .worktrees/test-harness/) so uncommitted changes\n` +
      `don't pollute the test result.`
    )
  }
}

export async function checkPrereqs() {
  // A loaded server can take >2s to answer a cold curl; retry a few times with a
  // generous timeout so a momentary stall isn't a false "server down".
  const reachable = (port) => {
    for (let i = 0; i < 5; i++) {
      try { execSync(`curl -skf -o /dev/null --max-time 6 https://localhost:${port}/`); return true } catch {}
    }
    return false
  }
  // Vite/preview server in worktree (serves HTTPS with a self-signed cert → -k)
  if (!reachable(cfg.port)) {
    throw new Error(
      `Worktree server not responding on port ${cfg.port}.\n` +
      `Start it: cd ${cfg.worktree} && npx vite preview --port ${cfg.port}`
    )
  }
  // Fleet/tlda server (Skip's live one — for chat data)
  if (!reachable(cfg.fleetPort)) {
    throw new Error(`tlda server not responding on port ${cfg.fleetPort}.`)
  }
  // playwright-cli
  try {
    execSync('which playwright-cli', { stdio: 'pipe' })
  } catch {
    throw new Error('playwright-cli not on PATH. Install with: npm i -g @playwright/cli (or use the project-local one).')
  }
}

// --- playwright-cli wrappers ---------------------------------------------

export function pw(sessionName, cmd, opts = {}) {
  try {
    const result = execSync(`playwright-cli -s=${sessionName} ${cmd}`, {
      encoding: 'utf8',
      timeout: opts.timeout || 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (process.env.DEBUG) console.log(`  [pw] ${cmd.slice(0, 60)} → ${result.slice(0, 100)}`)
    return result
  } catch (e) {
    const out = (e.stdout || '').toString().trim()
    if (process.env.DEBUG) console.log(`  [pw err] ${cmd.slice(0, 60)} → ${out.slice(0, 100)}`)
    return out || e.message
  }
}

export function pwEval(sessionName, expr) {
  return pw(sessionName, `eval '${expr.replace(/'/g, "\\'")}'`)
}

// --- setup / teardown ----------------------------------------------------

// --- fleet WS (chat injection over wss://…/ws/fleet) ---------------------
// The old POST /api/chat REST route was removed; chat now flows over the fleet
// WebSocket. We register two THROWAWAY bots per run (a sender + a recipient) so
// test traffic is fully isolated: messages stay among throwaway identities,
// never to a real agent and never to fleet:skip. The chat shape filters to the
// sender bot in both directions, so it starts EMPTY (no backlog polluting scroll
// measurements).
function connectFleet(ctx) {
  const wsUrl = `wss://localhost:${cfg.fleetPort}/ws/fleet`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false })
    const timer = setTimeout(() => reject(new Error('fleet WS connect timeout')), 8000)
    ws.on('open', () => {
      clearTimeout(timer)
      ctx.fleetWs = ws
      // Register the throwaway human FIRST so the browser's ?name= auto-login
      // succeeds (the server's login handler rejects unknown names with
      // "register first"). getHumanId() then === ctx.userId, so a chat shape
      // stamped with that userId actually renders under the ownership rule.
      ws.send(JSON.stringify({ type: 'register', id: ctx.userId, name: ctx.humanSanitized, cwd: process.cwd(), labels: ['scroll-test'], human: true }))
      // Reserve then log in both throwaway bots so the recipient exists (else
      // the server rejects the chat with "no recipients matched").
      ws.send(JSON.stringify({ type: 'reserve-shell', id: ctx.agentId, name: ctx.senderName, cwd: process.cwd(), labels: ['bot', 'scroll-test'] }))
      ws.send(JSON.stringify({ type: 'login', agent_id: ctx.agentId, cwd: process.cwd(), labels: ['bot', 'scroll-test'] }))
      ws.send(JSON.stringify({ type: 'reserve-shell', id: ctx.recipientId, name: ctx.recipientName, cwd: process.cwd(), labels: ['bot', 'scroll-test'] }))
      ws.send(JSON.stringify({ type: 'login', agent_id: ctx.recipientId, cwd: process.cwd(), labels: ['bot', 'scroll-test'] }))
      resolve(ws)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Open a fresh browser page with an isolated fleet-chat shape.
 *
 * Logs in as a throwaway human so the shape gets a valid `userId` (current
 * ownership rule: a shape renders only when its userId === getHumanId()).
 * Returns a `ctx` object passed into all other harness fns.
 */
export async function setup({
  doc = cfg.doc,
  name = null,
  sessionName = null,
  headed = true,
  filter = null,
  // Persistent-window mode: open ONE headed window once and re-drive it across
  // runs instead of opening+closing per run (which spammed Skip's screen). In
  // persist mode the identity is FIXED (not stamped) so a reused window keeps
  // matching shape-ownership and WS routing.
  persist = process.env.PERSIST === '1',
  reuse = process.env.REUSE === '1',     // attach to an already-open window
  keepOpen = process.env.KEEP_OPEN === '1' || process.env.REUSE === '1',
} = {}) {
  assertWorktree()
  await checkPrereqs()

  // Human identity + window are FIXED in persist mode (so one window can be
  // reused across runs and shape-ownership stays consistent). The bot identities
  // are UNIQUE PER RUN even in persist mode, so the chat starts EMPTY every run
  // (a fresh sender bot has no history to backfill) — otherwise prior runs'
  // messages accumulate as backlog and runs aren't comparable.
  const persistStamp = persist ? 'persist' : Date.now().toString(36)
  const runStamp = Date.now().toString(36)
  sessionName = sessionName || (persist ? 'scroll-persist' : `scroll-${persistStamp}`)
  const humanName = name || (persist ? 'scrollpersist' : `scrolltester-${persistStamp}`)
  // Mirror the server's login sanitize: toLowerCase, keep [a-z0-9_-].
  const humanSanitized = humanName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const ctx = {
    sessionName, doc, db: null, fleetWs: null, keepOpen,
    humanName, humanSanitized,
    userId: `fleet:${humanSanitized}`,       // === getHumanId() after login
    senderName: `scrolltest-snd-${runStamp}`,
    recipientName: `scrolltest-rcv-${runStamp}`,
    agentId: `fleet:scrolltest-snd-${runStamp}`,
    recipientId: `fleet:scrolltest-rcv-${runStamp}`,
  }

  // Read-only DB handle (for loadEvents real-data replay).
  ctx.db = new Database(cfg.dbPath, { readonly: true })

  // Open the fleet WS and register the throwaway human + bots.
  await connectFleet(ctx)
  await delay(500) // let registrations land before the browser logs in

  if (!reuse) {
    // Open the browser, logging in as the throwaway human.
    pw(sessionName, `open ${headed ? '--headed' : ''} "https://localhost:${cfg.port}/?doc=${doc}&name=${humanName}&token=${cfg.token}&pw=1"`)
  }

  // Wait for the TLDraw editor to actually mount (cold vite can take >12s).
  // Fixed delays were the source of the flaky "no editor" / "didn't render"
  // failures — poll instead. (In reuse mode the editor is already there, so
  // this returns immediately.)
  const editorReady = await waitFor(sessionName,
    `(function(){return window.__tldraw_editor__ ? "1" : "0"})()`, '1', 45000)
  if (!editorReady) throw new Error('TLDraw editor never mounted within 45s')
  await delay(reuse ? 200 : 1000)

  // Always (re)create exactly one isolated fleet-chat shape, placed in the
  // CURRENT viewport and zoomed to so it's visible (off-canvas shapes are bad
  // proof AND don't exercise the on-screen render path Skip actually hits). We
  // recreate even in reuse mode so each run starts from a CLEAN chat with this
  // run's fresh sender filter (no backlog from a prior run).
  const filterDnf = filter || [[['from', ctx.senderName]], [['to', ctx.senderName]]]
  const filterJson = JSON.stringify(filterDnf)
  const uid = JSON.stringify(ctx.userId)
  localStorage_set(sessionName, 'fleet-hud-expanded', '1')
  pwEval(sessionName, `(function(){var e=window.__tldraw_editor__;if(!e)return "no editor";` +
    `var existing=e.getCurrentPageShapes().filter(function(s){return s.type==="fleet-chat"});` +
    `if(existing.length>0)e.deleteShapes(existing.map(function(s){return s.id}));` +
    `var vb=e.getViewportPageBounds();var x=vb.x+vb.w/2-200;var y=vb.y+vb.h/2-300;` +
    `e.createShape({type:"fleet-chat",x:x,y:y,props:{w:400,h:600,userId:${uid},filter:${filterJson}}});` +
    `var made=e.getCurrentPageShapes().filter(function(s){return s.type==="fleet-chat"});var id=made[made.length-1].id;` +
    `e.select(id);e.zoomToSelection();return id})()`)
  await delay(1000)

  // Make sure the HUD is expanded so the chat overlay renders.
  pwEval(sessionName, `(function(){if(!document.querySelector(".fleet-chat-log")){window.dispatchEvent(new CustomEvent("fleet-hud-toggle"))}return "toggled"})()`)

  // Wait for the chat-log element to actually appear (history fetch + render).
  const rendered = await waitFor(sessionName,
    `(function(){return document.querySelector(".fleet-chat-log") ? "1" : "0"})()`, '1', 20000)
  if (!rendered) throw new Error('chat HUD (.fleet-chat-log) never rendered within 20s')
  await delay(1500) // let history settle

  return ctx
}

/**
 * Extract just the evaluated value from playwright-cli's verbose output.
 * The raw blob looks like:  `### Result\n"VALUE"\n### Ran Playwright code\n...`
 * Matching against the whole blob is unsafe — it echoes the source expr (so
 * any literal in your code, including digits, shows up). Slice out the Result
 * section only.
 */
export function pwResult(blob) {
  if (!blob) return ''
  const i = blob.indexOf('### Result')
  let seg = i >= 0 ? blob.slice(i + '### Result'.length) : blob
  const j = seg.indexOf('### Ran')
  if (j >= 0) seg = seg.slice(0, j)
  return seg.trim().replace(/^"|"$/g, '')
}

/** Poll `expr` in the page until its RESULT equals `want`, or timeout. */
async function waitFor(sessionName, expr, want, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = pwResult(pwEval(sessionName, expr))
    if (v === want) return true
    await delay(500)
  }
  return false
}

function localStorage_set(sessionName, k, v) {
  pwEval(sessionName, `(function(){try{localStorage.setItem("${k}","${v}")}catch(e){}return "ok"})()`)
}

export async function teardown(ctx) {
  if (ctx?.fleetWs) try { ctx.fleetWs.close() } catch {}
  if (ctx?.db) try { ctx.db.close() } catch {}
  // keepOpen: leave the persistent window alive so the next run reuses it
  // (no more open/close pops on Skip's screen).
  if (ctx?.sessionName && !ctx?.keepOpen) try { pw(ctx.sessionName, 'close') } catch {}
}

// --- chat-log inspection -------------------------------------------------

/** Return {dist, sH, sT, cH, msgs} for the active fleet-chat-log, or null. */
export function getScrollState(ctx) {
  const r = pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");var best=null,bestC=-1;for(var i=0;i<els.length;i++){var c=els[i].querySelectorAll(".chat-line").length;if(c>bestC){bestC=c;best=els[i]}}if(!best)return "NO_EL";return JSON.stringify({dist:Math.round(best.scrollHeight-best.scrollTop-best.clientHeight),sH:Math.round(best.scrollHeight),sT:Math.round(best.scrollTop),cH:Math.round(best.clientHeight),msgs:bestC})})()`)
  const u = r.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const m = u.match(/\{"dist":-?\d+.*?\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/** Return computed style + visibility info for the scroll-to-bottom button. */
export function getScrollButtonState(ctx) {
  const r = pwEval(ctx.sessionName, `(function(){var btn=document.querySelector(".fleet-scroll-bottom-btn")||document.querySelector(".fleet-chat-scroll-button")||document.querySelector(".scroll-to-bottom-button");if(!btn)return JSON.stringify({found:false});var cs=getComputedStyle(btn);var rect=btn.getBoundingClientRect();return JSON.stringify({found:true,opacity:parseFloat(cs.opacity),display:cs.display,visibility:cs.visibility,visible:cs.display!=="none"&&cs.visibility!=="hidden"&&parseFloat(cs.opacity)>0.05,w:Math.round(rect.width),h:Math.round(rect.height)})})()`)
  const u = r.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const m = u.match(/\{"found":(true|false).*?\}/)
  if (!m) return { found: false }
  try { return JSON.parse(m[0]) } catch { return { found: false } }
}

// --- scroll actions ------------------------------------------------------

export async function scrollToBottom(ctx) {
  pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");var best=null,bC=-1;for(var i=0;i<els.length;i++){var c=els[i].querySelectorAll(".chat-line").length;if(c>bC){bC=c;best=els[i]}}if(best)best.scrollTop=best.scrollHeight;return "ok"})()`)
  await delay(300)
}

export async function scrollUp(ctx, px = 500) {
  pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");var best=null,bC=-1;for(var i=0;i<els.length;i++){var c=els[i].querySelectorAll(".chat-line").length;if(c>bC){bC=c;best=els[i]}}if(best)best.scrollTop=Math.max(0,best.scrollTop-${px});return "ok"})()`)
  await delay(300)
}

/** Wheel-scroll up — uses real wheel event so HUD routing is exercised. */
export async function wheelScrollUp(ctx, px = 300) {
  pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");var best=null,bC=-1;for(var i=0;i<els.length;i++){var c=els[i].querySelectorAll(".chat-line").length;if(c>bC){bC=c;best=els[i]}}if(!best)return "NO_EL";var rect=best.getBoundingClientRect();var cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;var ev=new WheelEvent("wheel",{deltaY:-${px},clientX:cx,clientY:cy,bubbles:true,cancelable:true});best.dispatchEvent(ev);return JSON.stringify({sT:best.scrollTop})})()`)
  await delay(300)
}

// --- chat injection ------------------------------------------------------

/** Send filler messages so the chat has enough content to be scrollable. */
export async function populateChat(ctx, n = 15) {
  for (let i = 0; i < n; i++) {
    sendChat(ctx, { from: ctx.agentId,
      message: `Padding ${i}: ensuring chat is tall enough to scroll.\nLine 2.\nLine 3.` })
  }
  await delay(2500)
}

let _wsMsgId = 1
/**
 * Send a chat over the fleet WS. Routing is forced bot→bot for isolation:
 * `from` defaults to the sender bot and the recipient is ALWAYS the throwaway
 * recipient bot so test traffic cannot reach a real agent or Skip.
 */
export function sendChat(ctx, { from, to, message } = {}) {
  if (!ctx.fleetWs || ctx.fleetWs.readyState !== WebSocket.OPEN) {
    throw new Error('fleet WS not open — call setup() first')
  }
  const target = to || ctx.recipientId
  const allowedTargets = new Set([ctx.agentId, ctx.recipientId, ctx.userId, ctx.senderName, ctx.recipientName])
  if (!allowedTargets.has(target)) {
    throw new Error(`Refusing to send test chat to non-throwaway recipient: ${target}`)
  }
  ctx.fleetWs.send(JSON.stringify({
    id: _wsMsgId++,
    type: 'chat',
    from: from || ctx.agentId,
    to: target,
    message,
  }))
  return true
}

/**
 * Pull `n` real chat events involving `agentId` from fleet.db (read-only),
 * most-recent first then reversed to chronological. Used by the replay test to
 * reproduce Skip's real-data scroll thrash. `agentId` must be a real agent
 * (ctx.agentId is a throwaway bot with no history) — e.g. resolve fleet:skip.
 */
export function loadEvents(ctx, agentId, n = 200) {
  const rows = ctx.db.prepare(`
    SELECT id, type, timestamp, from_id, to_id, text, metadata
    FROM events
    WHERE type='chat' AND (from_id=? OR to_id=?)
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(agentId, agentId, n)
  return rows.reverse()
}

/** Resolve a real agent's fleet id from a friendly name (read-only). */
export function resolveAgentId(ctx, friendlyName) {
  const a = ctx.db.prepare(`SELECT id FROM agents WHERE friendly_name = ? OR id = ?`).get(friendlyName, friendlyName)
  return a ? a.id : null
}

/**
 * Pull an ENTIRE day of the real chat traffic `who` would see in their HUD —
 * every message to/from them, chronological, with real text + timestamps.
 *
 * Skip sees ~1,900 messages a day; a 150-event sample reproduces nothing
 * because the false-bottom bug only emerges after the Virtuoso item-size cache
 * has grown across thousands of varied-height rows. This is the corpus that
 * matters. `date` is a YYYY-MM-DD prefix matched against the ISO timestamp.
 * Returns rows with {text, gapMs} where gapMs is the real wall-clock gap to the
 * previous message (so a replay can preserve burst structure).
 */
export function listChatDays(ctx, who = 'fleet:skip', limit = 14) {
  return ctx.db.prepare(`
    SELECT substr(timestamp,1,10) d, COUNT(*) c
    FROM events WHERE type='chat' AND (to_id=? OR from_id=?)
    GROUP BY d ORDER BY d DESC LIMIT ?
  `).all(who, who, limit)
}

export function loadDay(ctx, { date, who = 'fleet:skip' } = {}) {
  const rows = ctx.db.prepare(`
    SELECT timestamp, from_id, to_id, text
    FROM events
    WHERE type='chat' AND (to_id=? OR from_id=?) AND substr(timestamp,1,10)=?
    ORDER BY timestamp ASC
  `).all(who, who, date)
  let prev = null
  return rows.map(r => {
    const t = Date.parse(r.timestamp)
    const gapMs = prev == null ? 0 : Math.max(0, t - prev)
    prev = t
    return { text: r.text || '', from: r.from_id, to: r.to_id, ts: r.timestamp, gapMs }
  }).filter(r => r.text)
}

// --- assertions (return {pass, detail}) ----------------------------------

export function expectAtBottom(state, threshold = 150) {
  if (!state) return { pass: false, detail: 'no scroll state' }
  return { pass: state.dist < threshold, detail: `dist=${state.dist} (< ${threshold})` }
}
export function expectScrolledUp(state, threshold = 100) {
  if (!state) return { pass: false, detail: 'no scroll state' }
  return { pass: state.dist > threshold, detail: `dist=${state.dist} (> ${threshold})` }
}
export function expectStable(distBefore, distAfter, tolerance = 30) {
  return {
    pass: Math.abs(distAfter - distBefore) < tolerance,
    detail: `before=${distBefore} after=${distAfter} (Δ < ${tolerance})`,
  }
}
export function expectButtonVisible(state) {
  if (!state.found) return { pass: false, detail: 'button not in DOM' }
  return { pass: state.visible, detail: `opacity=${state.opacity} display=${state.display} visibility=${state.visibility}` }
}
export function expectButtonHidden(state) {
  if (!state.found) return { pass: true, detail: 'button not in DOM (hidden)' }
  return { pass: !state.visible, detail: `opacity=${state.opacity} display=${state.display}` }
}

// --- test runner integration --------------------------------------------

/**
 * A test is an async function ({ctx}) => Promise<{pass, detail}>
 *   or an array of {name, fn}.
 *
 * suite() collects results and exits with code 0 (all pass) or 1 (any fail).
 */
export class Suite {
  constructor(name) {
    this.name = name
    this.results = []
  }
  async run(name, fn) {
    let res
    try {
      res = await fn()
      if (!res || typeof res.pass !== 'boolean') res = { pass: false, detail: 'test returned no pass/fail' }
    } catch (e) {
      res = { pass: false, detail: `EXCEPTION: ${e.message}` }
    }
    const icon = res.pass ? '✓' : '✗'
    console.log(`  ${icon} ${name}: ${res.detail}`)
    this.results.push({ name, ...res })
    return res
  }
  summary() {
    const passed = this.results.filter(r => r.pass).length
    const total = this.results.length
    console.log(`\n[${this.name}] ${passed}/${total} passed`)
    if (passed < total) {
      console.log('  Failed:')
      this.results.filter(r => !r.pass).forEach(r => console.log(`    ✗ ${r.name}: ${r.detail}`))
    }
    return { passed, total, failed: total - passed, results: this.results }
  }
}

export { delay }
