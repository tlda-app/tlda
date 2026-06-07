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
import { join } from 'path'

// Default to the one canonical session; overridable for isolated testing.
const SESSION = process.env.TLDA_PW_SESSION || 'shared'

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

// Open the shared browser if it isn't already up (lazy pop-up).
function ensureOpen() {
  if (sessionOpen()) return false
  const r = pw(['open', '--headed', '--persistent'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('failed to open shared browser')
  return true
}

// Parse `tab-list` → [{ index, current, url }]. Format per line:
//   - 0: [title](https://…)
//   - 1: (current) [title](about:blank)
function listTabs() {
  const out = pw(['tab-list']).stdout || ''
  const tabs = []
  for (const line of out.split('\n')) {
    const m = line.match(/^- (\d+):\s*(\(current\)\s*)?\[[^\]]*\]\(([^)]*)\)/)
    if (m) tabs.push({ index: parseInt(m[1], 10), current: !!m[2], url: m[3] })
  }
  return tabs
}

// Find this agent's tab (by URL marker), creating one if absent, and select it.
// Returns the selected index, or null if it couldn't be resolved.
function selectMyTab() {
  const marker = myMarker()
  let tabs = listTabs()
  let mine = tabs.find(t => t.url.includes(marker))
  if (!mine) {
    // Create a fresh tab (becomes current) and stamp it so future verbs find it
    // even before the agent's first goto.
    pw(['tab-new'], { stdio: 'ignore' })
    pw(['goto', `data:text/html,<title>${marker}</title>`], { stdio: 'ignore' })
    tabs = listTabs()
    mine = tabs.find(t => t.url.includes(marker))
  }
  if (mine && !mine.current) pw(['tab-select', String(mine.index)], { stdio: 'ignore' })
  return mine ? mine.index : null
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
      const mine = tabs.find(t => t.url.includes(myMarker()))
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
      const mine = listTabs().find(t => t.url.includes(myMarker()))
      if (mine) { pw(['tab-select', String(mine.index)], { stdio: 'ignore' }); pw(['tab-close'], { stdio: 'ignore' }); console.log(`closed my tab (#${mine.index})`) }
      else console.log('no tab of mine to close')
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
