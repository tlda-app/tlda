/**
 * tlda pw — one shared playwright-cli browser any agent can drive, with a
 * PER-AGENT TAB so agents never blank each other out.
 *
 * The problem this solves, in two layers:
 *   1. Agents each ran their own `playwright-cli open`/`close` per task, so the
 *      backing browser kept dying between commands. Fix: a single canonical
 *      session ("shared") nobody opens/closes by hand — it pops up lazily and
 *      persists until reaped.
 *   2. That single session had ONE page, so when agent B navigated, agent A's
 *      page got yanked to about:blank mid-test ("blanks on everybody"). Fix:
 *      each agent drives its OWN TAB inside the one shared browser. One browser
 *      (Skip's machine can't run two), many tabs (cheap). Each forwarded verb
 *      runs under a short lock that does (select-my-tab → verb) atomically, so
 *      two agents interleave at verb granularity instead of one holding the
 *      whole browser and locking everyone else out.
 *
 * Usage:
 *   tlda pw <verb> [args...]   forward a playwright-cli verb to MY tab
 *   tlda pw acquire            open the shared browser (lazy) + ensure my tab
 *   tlda pw release            close my tab (browser stays up for others)
 *   tlda pw status             session state + my tab + current URL
 *   tlda pw reap               close the whole shared browser (the reaper)
 *   tlda pw center <region>    center the camera on doc | chat | fleet
 *
 * Identity (which tab is "mine") comes from TLDA_PW_AS → AGENT_WIN → FLEET_ID →
 * $USER@local, sanitized into a marker stamped on the tab's URL (`pwtab=<key>`).
 */

import { spawnSync } from 'child_process'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'

// Default to the one canonical session; overridable for isolated testing.
const SESSION = process.env.TLDA_PW_SESSION || 'shared'

// Each agent gets its OWN browser WINDOW (not a tab in a shared window). Why:
// only the *active tab* of a window paints — a background tab is suspended, so
// it can't be screenshotted. Giving each agent a one-tab window means that tab
// is always the active one, so it renders even while the whole window sits
// buried behind Skip's window — and we never call bringToFront (which is what
// yanked the window to the foreground over him). Windows stack at one rect so
// they read as a single parked region. Override the rect with TLDA_PW_RECT.
const WIN_RECT = (() => {
  const d = { left: 0, top: 0, width: 1280, height: 900 }
  const env = process.env.TLDA_PW_RECT
  if (env) {
    const p = env.split(',').map(n => parseInt(n, 10))
    if (p.length === 4 && p.every(Number.isFinite)) return { left: p[0], top: p[1], width: p[2], height: p[3] }
  }
  return d
})()

// Verbs the wrapper owns — agents must not drive browser/tab lifecycle directly.
const BLOCKED_VERBS = new Set([
  'open', 'close', 'close-all', 'kill-all', 'delete-data',
  'tab-new', 'tab-close', 'tab-select', 'tab-list', // tab lifecycle is automatic
])

// Image extensions a screenshot filename is allowed to have.
const IMG_EXT = /\.(png|jpg|jpeg|webp)$/i

function who() {
  return (
    process.env.TLDA_PW_AS ||
    process.env.AGENT_WIN ||
    process.env.FLEET_ID ||
    `${process.env.USER || 'unknown'}@local`
  )
}

// Sanitized, URL-safe key identifying this agent's tab.
function myTabKey() {
  return who().replace(/[^a-zA-Z0-9_.-]/g, '_')
}
function myMarker() {
  return `pwtab=${myTabKey()}`
}

function lockScript(repoRoot) {
  return join(repoRoot, 'bin', 'pw-lock.sh')
}

function pw(args, opts = {}) {
  return spawnSync('playwright-cli', [`-s=${SESSION}`, ...args], { encoding: 'utf8', ...opts })
}

// ---- lock (short, per-verb) ----

function lockStatus(repoRoot) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'status'], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  if (!out || out === 'unlocked') return null
  const m = out.match(/^(.*) \(acquired (\d+)s ago\)$/)
  if (!m) return { holder: out, ageSecs: null }
  return { holder: m[1], ageSecs: parseInt(m[2], 10) }
}

function tryLock(repoRoot, me) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'acquire', me], { encoding: 'utf8' })
  return r.status === 0
}

function unlock(repoRoot, me) {
  spawnSync('bash', [lockScript(repoRoot), 'release', me], { encoding: 'utf8' })
}

// Acquire the short lock, waiting up to ~timeoutMs for another agent's verb to
// finish. Verbs queue instead of failing — the lock is held only for the
// duration of one (select-tab → verb) pair, so waits are brief.
function lockWithWait(repoRoot, me, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  if (tryLock(repoRoot, me)) return true
  while (Date.now() < deadline) {
    spawnSync('sleep', ['0.2'])
    if (tryLock(repoRoot, me)) return true
  }
  return false
}

// ---- session + tabs ----

function sessionOpen() {
  const out = spawnSync('playwright-cli', ['list'], { encoding: 'utf8' }).stdout || ''
  const m = out.match(new RegExp(`- ${SESSION}:\\s*\\n\\s*- status: (\\w+)`, 'm'))
  return m ? m[1] === 'open' : false
}

// Locate the playwright `context.js` that the playwright-cli daemon actually
// loads, by resolving the playwright-cli binary on PATH. (Bundled under the
// @playwright/cli install, NOT this repo's node_modules.)
function playwrightContextPath() {
  const which = (spawnSync('which', ['playwright-cli'], { encoding: 'utf8' }).stdout || '').trim()
  if (!which) return null
  let real
  try { real = realpathSync(which) } catch { return null }
  const p = join(dirname(real), 'node_modules', 'playwright', 'lib', 'mcp', 'browser', 'context.js')
  return existsSync(p) ? p : null
}

// tab-select calls `await tab.page.bringToFront()`, which on headed Chromium
// raises the OS window to the foreground — yanking the browser over Skip every
// time any agent runs a verb. Selecting a page does NOT need it (Playwright
// routes input/screenshots by page object, and each agent's page is the active
// tab of its own window so it renders regardless). Strip that one line. This
// self-heals on every launch so a `brew upgrade` can't silently bring the
// front-raising back. Returns true if the daemon will load a no-raise tab-select.
function ensureNoRaisePatch() {
  const p = playwrightContextPath()
  if (!p) { console.error('pw: WARN could not locate playwright context.js — windows may still raise to front'); return false }
  let src
  try { src = readFileSync(p, 'utf8') } catch (e) { console.error(`pw: WARN cannot read ${p}: ${e.message}`); return false }
  const re = /^([ \t]*)await tab\.page\.bringToFront\(\);?[ \t]*$/m
  if (!re.test(src)) return true // already patched / line gone
  try {
    writeFileSync(p, src.replace(re, '$1/* tlda: bringToFront removed so an agent window never raises over Skip */'))
  } catch (e) { console.error(`pw: WARN cannot patch ${p} (${e.message}) — windows may still raise`); return false }
  console.error(`pw: patched tab-select to not raise the window (${p})`)
  return true
}

// Open the shared browser if it isn't already up (lazy pop-up). Patch the
// daemon's tab-select before launch so the freshly-loaded code never raises.
function ensureOpen() {
  if (sessionOpen()) return false
  ensureNoRaisePatch()
  const r = pw(['open', '--headed', '--persistent'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('failed to open shared browser')
  return true
}

// Open a brand-new OS WINDOW for this agent (window.open with a size → Chromium
// makes it a separate window, not a tab in the shared one). Run from whatever
// page the daemon currently has; the new window is same-origin about:blank so
// its opener can stamp the marker into its title for pre-goto identification.
// `eval` wraps its return in a multi-line "### Result" block, so we signal
// success with a distinctive token and test for its presence rather than
// equality. Returns true if a window was opened.
function openMyWindow() {
  const key = myTabKey()
  const feat = `popup=yes,width=${WIN_RECT.width},height=${WIN_RECT.height},left=${WIN_RECT.left},top=${WIN_RECT.top}`
  const snippet = `() => { try { var w = window.open('about:blank', 'pw_${key}', '${feat}'); if (!w) return 'PWWIN_BLOCKED'; try { w.document.title = 'pwtab=${key}'; } catch (e) {} return 'PWWIN_OK'; } catch (e) { return 'PWWIN_ERR:' + e.message; } }`
  const out = pw(['eval', snippet]).stdout || ''
  return out.includes('PWWIN_OK')
}

// Parse `tab-list` → [{ index, current, title, url }]. Format per line:
//   - 0: [title](https://…)
//   - 1: (current) [title](about:blank)
function listTabs() {
  const out = pw(['tab-list']).stdout || ''
  const tabs = []
  for (const line of out.split('\n')) {
    const m = line.match(/^- (\d+):\s*(\(current\)\s*)?\[([^\]]*)\]\(([^)]*)\)/)
    if (m) tabs.push({ index: parseInt(m[1], 10), current: !!m[2], title: m[3], url: m[4] })
  }
  return tabs
}

// A tab is mine if my marker is in its URL (after a real goto, which stamps
// pwtab=) OR in its title (a brand-new about:blank window whose title we set to
// the marker before the agent's first goto).
function isMine(t) {
  const marker = myMarker()
  return (!!t.url && t.url.includes(marker)) || (!!t.title && t.title.includes(marker))
}

// Find this agent's page, creating its own WINDOW if absent, make it the
// daemon's current page, and CONFIRM the switch before returning. Confirmation
// matters because `tab-select` runs in its own playwright-cli process and can
// lag the next process's verb — without the check, a verb could execute against
// whatever page was previously current (observed: a screenshot landing on a
// stray blank tab). Returns the confirmed index, or null if unresolved.
function selectMyTab() {
  let mine = listTabs().find(isMine)
  if (!mine) {
    // window.open needs an existing page to run from; the persistent context
    // always has its initial blank page, but guard the empty case anyway.
    if (listTabs().length === 0) pw(['tab-new'], { stdio: 'ignore' })
    if (!openMyWindow()) {
      // Popup blocked (shouldn't happen under automation) — fall back to a tab
      // in the shared window, stamped via title. Renders only while selected,
      // but better than failing outright.
      console.error('pw: WARN window.open was blocked — falling back to a shared-window tab')
      pw(['tab-new'], { stdio: 'ignore' })
      pw(['goto', `data:text/html,<title>${myMarker()}</title>`], { stdio: 'ignore' })
    }
    mine = listTabs().find(isMine)
  }
  if (!mine) return null
  for (let i = 0; i < 8; i++) {
    const cur = listTabs().find(isMine)
    if (!cur) return null
    if (cur.current) return cur.index // confirmed: my page is the current one
    pw(['tab-select', String(cur.index)], { stdio: 'ignore' })
    spawnSync('sleep', ['0.15'])
  }
  // Couldn't confirm — return index anyway, but the caller's verb may misfire.
  const last = listTabs().find(isMine)
  return last ? last.index : null
}

// ---- verb rewriting ----

// Keep my tab markable: inject pwtab=<key> (and pw=1) into http(s) goto URLs so
// the tab stays identifiable after the agent navigates. Non-http URLs untouched.
function rewriteGoto(rest) {
  const i = rest.findIndex(a => /^https?:\/\//i.test(a))
  if (i === -1 || !URL.canParse(rest[i])) return rest // malformed URL → forward as-is
  const out = [...rest]
  const u = new URL(out[i])
  if (!u.searchParams.has('pwtab')) u.searchParams.set('pwtab', myTabKey())
  if (!u.searchParams.has('pw')) u.searchParams.set('pw', '1')
  out[i] = u.toString()
  return out
}

// Screenshot guard: a filename with no image extension reads back as raw bytes
// (the exact footgun that wasted a session). Force a .png.
function rewriteScreenshot(rest) {
  const out = [...rest]
  const i = out.findIndex(a => a === '--filename' || a === '-f')
  if (i !== -1 && out[i + 1] && !IMG_EXT.test(out[i + 1])) {
    out[i + 1] = out[i + 1].replace(/\.[^./]*$/, '') + '.png'
  }
  return out
}

// Wait until the TLDraw editor has mounted, so a screenshot can't come back
// blank just because the page hadn't painted yet.
function waitForRender(maxMs = 8000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const out = pw(['eval', '() => !!window.__tldraw_editor__']).stdout || ''
    if (/true/.test(out)) return true
    spawnSync('sleep', ['0.3'])
  }
  return false
}

function forward(verb, rest) {
  return pw([verb, ...rest], { stdio: 'inherit' }).status ?? 0
}

// Camera-centering snippets, run as eval on the agent's tab.
const CENTER_EVALS = {
  doc: `() => { var ed=window.__tldraw_editor__; if(!ed) return 'no editor'; var ps=ed.getCurrentPageShapes().filter(function(s){return s.type==='svg-page'||s.type==='html-page'}); if(!ps.length) return 'no pages'; ps.sort(function(a,b){var ba=ed.getShapePageBounds(a.id),bb=ed.getShapePageBounds(b.id); return ba.y-bb.y||ba.x-bb.x}); var b=ed.getShapePageBounds(ps[0].id); var c=ed.getCamera(); ed.setCamera({x:-b.minX+32,y:-b.minY+32,z:c.z},{animation:{duration:0}}); return 'centered doc'; }`,
  chat: `() => { var ed=window.__tldraw_editor__; if(!ed) return 'no editor'; var f=ed.getCurrentPageShapes().find(function(s){return s.type==='fleet-chat'}); if(!f) return 'no fleet-chat shape'; var b=ed.getShapePageBounds(f.id); var c=ed.getCamera(); ed.setCamera({x:-b.minX+32,y:-b.minY+32,z:c.z},{animation:{duration:0}}); return 'centered chat'; }`,
  fleet: `() => { var ed=window.__tldraw_editor__; if(!ed) return 'no editor'; var f=ed.getCurrentPageShapes().find(function(s){return s.type==='fleet-chat'||s.type==='fleet-agents'||s.type==='fleet-search'||s.type==='fleet-docview'}); if(!f) return 'no fleet shapes'; var b=ed.getShapePageBounds(f.id); var c=ed.getCamera(); ed.setCamera({x:-b.minX+32,y:-b.minY+32,z:c.z},{animation:{duration:0}}); return 'centered fleet'; }`,
}

// ---- entry point ----

export async function cmdPw(args, repoRoot) {
  const verb = args[0]
  const rest = args.slice(1)
  const me = who()

  if (!verb || verb === 'help' || verb === '--help') {
    console.log(
      [
        'tlda pw — one shared browser, a private tab per agent',
        '',
        '  tlda pw acquire           open the shared browser + ensure my tab',
        '  tlda pw release           close my tab (browser stays up for others)',
        '  tlda pw status            session state + my tab + URL',
        '  tlda pw reap              close the whole shared browser',
        '  tlda pw center <region>   center camera on: doc | chat | fleet',
        '  tlda pw <verb> [args]     forward a playwright-cli verb to MY tab',
        '                            (goto, click, snapshot, screenshot, eval, …)',
        '',
        `  my tab key: ${myTabKey()}   (override identity with TLDA_PW_AS)`,
      ].join('\n')
    )
    return
  }

  if (verb === 'status') {
    const lk = lockStatus(repoRoot)
    const open = sessionOpen()
    console.log(`lock:    ${lk ? `${lk.holder} (${lk.ageSecs}s ago)` : 'unlocked'}`)
    console.log(`browser: ${open ? 'up' : 'down'} (session "${SESSION}")`)
    if (open) {
      const tabs = listTabs()
      const mine = tabs.find(isMine)
      console.log(`tabs:    ${tabs.length} open${mine ? ` (mine: #${mine.index})` : ' (none mine yet)'}`)
      if (mine) console.log(`url:     ${mine.url}`)
    }
    return
  }

  if (verb === 'acquire') {
    ensureOpen()
    if (!lockWithWait(repoRoot, me)) {
      console.error('could not take the pw lock — another agent is mid-verb; try again')
      process.exit(1)
    }
    try {
      const idx = selectMyTab()
      console.log(`browser up; my tab #${idx} (key ${myTabKey()})`)
    } finally {
      unlock(repoRoot, me)
    }
    return
  }

  if (verb === 'release') {
    if (!sessionOpen()) { console.log('browser already down'); return }
    if (!lockWithWait(repoRoot, me)) { console.error('lock busy; tab not closed'); process.exit(1) }
    try {
      const mine = listTabs().find(isMine)
      if (mine) { pw(['tab-select', String(mine.index)], { stdio: 'ignore' }); pw(['tab-close'], { stdio: 'ignore' }); console.log(`closed my window (#${mine.index})`) }
      else console.log('no window of mine to close')
    } finally {
      unlock(repoRoot, me)
    }
    return
  }

  if (verb === 'reap') {
    if (!sessionOpen()) console.log('browser already down')
    else { pw(['close'], { stdio: 'inherit' }); console.log('browser reaped') }
    // Reaping frees the lock regardless of holder.
    spawnSync('bash', [lockScript(repoRoot), 'steal', `reaper:${me}`], { encoding: 'utf8' })
    spawnSync('bash', [lockScript(repoRoot), 'release', `reaper:${me}`], { encoding: 'utf8' })
    return
  }

  if (BLOCKED_VERBS.has(verb)) {
    console.error(
      `"${verb}" is managed for you — you get your own tab automatically.\n` +
        `  • start:  tlda pw acquire\n` +
        `  • stop:   tlda pw release   (or  tlda pw reap  to close the browser)`
    )
    process.exit(2)
  }

  // ---- forwarded verb: short lock → select my tab → (rewrite) → forward ----
  ensureOpen()
  if (!lockWithWait(repoRoot, me)) {
    const lk = lockStatus(repoRoot)
    console.error(`pw busy — ${lk ? `${lk.holder} holding (${lk.ageSecs}s)` : 'another agent'}. Try again.`)
    process.exit(1)
  }
  let code = 0
  try {
    selectMyTab()

    if (verb === 'center') {
      const region = (rest[0] || 'doc').toLowerCase()
      const ev = CENTER_EVALS[region]
      if (!ev) { console.error(`center: unknown region "${region}" (use: doc | chat | fleet)`); code = 2 }
      else code = forward('eval', [ev])
    } else if (verb === 'goto') {
      code = forward('goto', rewriteGoto(rest))
    } else if (verb === 'screenshot') {
      waitForRender()
      code = forward('screenshot', rewriteScreenshot(rest))
    } else {
      code = forward(verb, rest)
    }
  } finally {
    unlock(repoRoot, me)
  }
  process.exit(code)
}
