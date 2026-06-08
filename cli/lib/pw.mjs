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
import { readFileSync, writeFileSync, existsSync, realpathSync, rmSync, mkdirSync } from 'fs'
import { homedir } from 'os'

// Default to the one canonical session; overridable for isolated testing.
const SESSION = process.env.TLDA_PW_SESSION || 'shared'

// Each agent gets its own TAB in the one shared window. An earlier design gave
// each agent its own window.open() popup so a background tab couldn't suspend
// its paint — but under automation window.open is popup-BLOCKED, and the
// fallback then stranded the agent on a `data:`/`about:blank` tab that every
// verb misfired onto (blank screenshots, editor:false). Tabs are safe because
// the pw lock serializes verbs: selectMyTab() makes an agent's tab the current
// (painting) tab before its verb runs, so "only the active tab paints" never
// bites. We never call bringToFront, so no tab raises over Skip.

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

// Per-agent last-touch files so eliza's idle reaper can tell how long an agent's
// window has sat unused. Each verb refreshes it; release/park removes it. The
// raw `id` (fleet id) is recorded so eliza can map the window back to an agent
// to check liveness and warn it before parking.
const TOUCH_DIR = join(homedir(), '.config', 'tlda', 'pw-touch')
function touchFile() { return join(TOUCH_DIR, `${myTabKey()}.json`) }
function touchMine() {
  try {
    mkdirSync(TOUCH_DIR, { recursive: true })
    writeFileSync(touchFile(), JSON.stringify({ id: who(), key: myTabKey(), session: SESSION, ts: Date.now() }))
  } catch (e) { console.error(`pw: WARN last-touch stamp failed: ${e.message}`) }
}
function clearTouch() {
  try { rmSync(touchFile(), { force: true }) } catch (e) { console.error(`pw: WARN clearing last-touch failed: ${e.message}`) }
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

// The session's Chrome profile dir, parsed from `playwright-cli list`.
function sessionUserDataDir() {
  const out = spawnSync('playwright-cli', ['list'], { encoding: 'utf8' }).stdout || ''
  const m = out.match(new RegExp(`- ${SESSION}:[\\s\\S]*?- user-data-dir:\\s*(\\S+)`, 'm'))
  return m ? m[1] : null
}

// Recover from the stuck state that blocks EVERY launch: a zombie shared Chrome
// (its daemon dead, so the session reads "closed") is still alive holding the
// profile's SingletonLock, so a fresh `open` can't take the profile and fails.
// Only called after sessionOpen()===false AND `open` already failed — i.e. no
// live daemon owns this session, so any surviving ud-<session>-chrome is an
// orphan that's safe to kill. Kills it and clears the stale singleton locks.
function recoverStaleSharedBrowser() {
  const udir = `ud-${SESSION}-chrome`
  const dir = sessionUserDataDir()
  console.error(`pw: launch failed — clearing orphaned "${udir}" (zombie holding the profile lock)`)
  spawnSync('pkill', ['-9', '-f', udir], { encoding: 'utf8' })
  if (dir) {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(join(dir, f), { force: true }) } catch (e) { console.error(`pw: WARN could not clear ${f}: ${e.message}`) }
    }
  }
  spawnSync('sleep', ['0.5'])
}

// Open the shared browser if it isn't already up (lazy pop-up). Patch the
// daemon's tab-select before launch so the freshly-loaded code never raises.
// If the launch fails on a closed session, it's almost always a zombie Chrome
// holding the profile lock — recover and retry once before giving up.
// The repo's playwright-cli config carries the HTTPS-ignore flags
// (--ignore-certificate-errors + ignoreHTTPSErrors) the shared browser needs to
// trust the server's mkcert cert — Chromium has its own cert store and ignores
// the macOS keychain, so without this every https://localhost goto lands on
// chrome-error://. `open` only reads --config at launch, so it must be passed on
// every (re)open or a fresh `acquire` silently drops the flags.
function openArgs(repoRoot) {
  const args = ['open', '--headed', '--persistent']
  const cfg = join(repoRoot, '.playwright', 'cli.config.json')
  if (existsSync(cfg)) args.push('--config', cfg)
  return args
}

function ensureOpen(repoRoot) {
  if (sessionOpen()) return false
  ensureNoRaisePatch()
  if (pw(openArgs(repoRoot), { stdio: 'inherit' }).status === 0) return true
  recoverStaleSharedBrowser()
  if (pw(openArgs(repoRoot), { stdio: 'inherit' }).status !== 0) {
    throw new Error('failed to open shared browser (even after clearing a stale profile lock)')
  }
  return true
}

// A parked, claimable window: about:blank with no agent marker in its title.
// `release` (and the daemon reaper) park a window by navigating it here, which
// both tears down its TLDraw page (reclaiming ~all of its memory) and clears
// the marker — returning it to the pool for the next agent to reuse.
function freeParkedWindow(tabs) {
  return tabs.find(t => /^about:blank/i.test(t.url || '') && !/pwtab=/.test(t.title || ''))
}

// Claim the daemon's CURRENT page as mine by stamping the marker into its title
// (same-origin about:blank → settable). Lets isMine find it before first goto.
function claimCurrentWindow() {
  const out = pw(['eval', `() => { document.title = 'pwtab=${myTabKey()}'; return 'PWCLAIM_OK'; }`]).stdout || ''
  return out.includes('PWCLAIM_OK')
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

// `tab-list` can come back EMPTY during the intermittent snapshot hang even
// though tabs exist. selectMyTab must never read that transient empty as "no
// tab of mine — spawn one" (that's how an about:blank stray is born). Returns a
// non-empty list when the session is up; returns [] only when the session is
// genuinely DOWN (crashed context → caller re-opens, don't retry) or the daemon
// stays wedged past the retry budget (→ caller fails clean, never spawns).
// Bounded retries so the wrapper never piles onto a wedged daemon.
function stableTabs(retries = 5) {
  for (let i = 0; i < retries; i++) {
    const tabs = listTabs()
    if (tabs.length > 0) return tabs
    if (!sessionOpen()) return [] // genuinely down — re-open path, not retry
    spawnSync('sleep', ['0.2'])
  }
  return [] // session up but tab-list stayed empty — wedged; fail clean
}

// Find this agent's page, creating its own TAB if absent, make it the daemon's
// current page, and CONFIRM the switch before returning. Confirmation matters
// because `tab-select` runs in its own playwright-cli process and can lag the
// next process's verb — without the check, a verb could execute against
// whatever page was previously current (observed: a screenshot landing on a
// stray blank tab). Returns the confirmed index, or null if unresolved (the
// caller must NOT forward on null — see the forwarded-verb path).
function selectMyTab() {
  touchMine() // refresh idle clock — every verb runs through here
  const tabs = stableTabs()
  let mine = tabs.find(isMine)
  if (!mine) {
    // Never spawn off an empty list. stableTabs() returns [] only when the
    // session is genuinely down (crashed context — caller re-opens) or the
    // daemon stayed wedged past its budget. Reading that as "pool exhausted" is
    // exactly what spawned the stray. Fail clean; the agent retries when idle.
    if (tabs.length === 0) return null
    const free = freeParkedWindow(tabs)
    if (free) {
      // Reuse a parked window from the pool — no window.open, so NO raise. This
      // is the common path once the fleet has warmed up: agents recycle windows
      // freed by agents that finished or were reaped.
      pw(['tab-select', String(free.index)], { stdio: 'ignore' })
      claimCurrentWindow()
    } else {
      // Pool exhausted — open a fresh TAB. `tab-new` can't be popup-blocked the
      // way window.open was; it becomes the current tab, so stamp my marker into
      // its title exactly as the parked-window-reuse path above does. The confirm
      // loop below re-selects by marker if tab-new's focus lagged.
      pw(['tab-new'], { stdio: 'ignore' })
      claimCurrentWindow()
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
    ensureOpen(repoRoot)
    if (!lockWithWait(repoRoot, me)) {
      console.error('could not take the pw lock — another agent is mid-verb; try again')
      process.exit(1)
    }
    try {
      const idx = selectMyTab()
      if (idx == null) console.error("pw: couldn't resolve a tab (daemon wedged or session down) — try again when the page is idle")
      else console.log(`browser up; my tab #${idx} (key ${myTabKey()})`)
    } finally {
      unlock(repoRoot, me)
    }
    return
  }

  if (verb === 'release') {
    if (!sessionOpen()) { console.log('browser already down'); return }
    if (!lockWithWait(repoRoot, me)) { console.error('lock busy; window not parked'); process.exit(1) }
    try {
      const mine = listTabs().find(isMine)
      if (mine) {
        // Park, don't close: navigating to about:blank tears down the TLDraw
        // page (reclaims its memory) and clears the marker, returning the window
        // to the pool for the next agent to claim — no churn, no new raise.
        pw(['tab-select', String(mine.index)], { stdio: 'ignore' })
        pw(['goto', 'about:blank'], { stdio: 'ignore' })
        clearTouch()
        console.log(`parked my window (#${mine.index}) back to the pool`)
      } else console.log('no window of mine to park')
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
  ensureOpen(repoRoot)
  if (!lockWithWait(repoRoot, me)) {
    const lk = lockStatus(repoRoot)
    console.error(`pw busy — ${lk ? `${lk.holder} holding (${lk.ageSecs}s)` : 'another agent'}. Try again.`)
    process.exit(1)
  }
  let code = 0
  try {
    const idx = selectMyTab()
    if (idx == null) {
      // selectMyTab couldn't resolve my tab (daemon wedged or session down). Do
      // NOT forward — the verb would run on whatever tab is currently selected
      // (a stray or another agent's tab). Fail clean; retry when the page is idle.
      console.error("pw: couldn't resolve my tab (daemon wedged or session down); not forwarding — try again when the page is idle")
      code = 1
    } else if (verb === 'center') {
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
