/**
 * tlda-dev pw — one shared playwright-cli browser any agent can drive, with a
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
 *   tlda-dev pw <verb> [args...]   forward a playwright-cli verb to MY tab
 *   tlda-dev pw acquire            open the shared browser (lazy) + ensure my tab
 *   tlda-dev pw release            close my tab (browser stays up for others)
 *   tlda-dev pw status             session state + my tab + current URL
 *   tlda-dev pw reap               close the whole shared browser (the reaper)
 *   tlda-dev pw center <region>    center the camera on doc | chat | fleet
 *
 * Identity (which tab is "mine") comes from TLDA_PW_AS → AGENT_WIN → FLEET_ID →
 * $USER@local, sanitized into a marker stamped on the tab's URL (`pwtab=<key>`).
 */

import { spawnSync } from 'child_process'
import { join, dirname, resolve, isAbsolute } from 'path'
import { readFileSync, writeFileSync, existsSync, realpathSync, rmSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

// Default to the one canonical session; overridable for isolated testing.
const SESSION = process.env.TLDA_PW_SESSION || 'shared'
const CANONICAL_SESSION = 'shared'
const ALLOW_ISOLATED_SESSION = process.env.TLDA_PW_ALLOW_ISOLATED_SESSION === '1'

// ---- one daemon for everyone: pin the playwright-cli WORKSPACE ----
//
// playwright-cli keys its per-session daemon by a hash of the "workspace dir" it
// finds by walking UP from process.cwd() looking for a `.playwright/` dir
// (playwright-core cli-client/registry: createClientInfo → findWorkspaceDir, with
// the package dir as the fallback when none is found). So two agents invoking
// `tlda-dev pw` from different cwds — the main checkout, a worktree that has its
// OWN `.playwright`, or any cwd with no `.playwright` ancestor — resolve to
// DIFFERENT workspace hashes and each spawn a SEPARATE `shared` daemon+browser.
// The reaper then sees duplicate `shared` processes and (old behavior) nuked them
// ALL and reopened, yanking every agent's tab to about:blank. That is the
// duplicate-daemon / about:blank-reset wedge.
//
// Fix: pin EVERY playwright-cli spawn's cwd to ONE canonical workspace — the main
// checkout, which owns `.playwright/cli.config.json` — so all agents (any cwd, any
// worktree, fenced or not) discover the same single daemon. CANONICAL_HASH lets
// the reaper tell the canonical shared browser from an interloper and spare it.
//
// (The legacy PLAYWRIGHT_DAEMON_SOCKETS_DIR pin was dead code: this playwright-cli
// has no such env var — it records the daemon's socket path in the session file
// under the workspace-hash dir and clients read config.socketPath from there,
// not from a fixed sockets dir. Fenced reachability therefore has to allow the
// canonical daemon/session path; pinning the workspace is what actually makes
// one daemon shared.)
const AGENT_CWD = process.cwd()
function canonicalWorkspace() {
  try {
    const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' })
    if (r.status === 0) {
      let g = (r.stdout || '').trim()
      if (g) {
        if (!isAbsolute(g)) g = resolve(REPO_ROOT, g)
        const main = g.replace(/\/?\.git\/?$/, '') || REPO_ROOT
        if (existsSync(join(main, '.playwright'))) return main
      }
    }
  } catch { /* git unavailable — fall back to this checkout */ }
  return REPO_ROOT
}
const PW_CWD = canonicalWorkspace()
const CANONICAL_HASH = createHash('sha1').update(PW_CWD).digest('hex').slice(0, 16)

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
const CONSOLE_LEVELS = new Set(['info', 'warning', 'error'])

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

// ---- hard disable (Skip's kill switch) ----
//
// A sentinel file that, while present, makes `tlda-dev pw` REFUSE to open or drive
// the shared browser for ANYONE. This is the "no windows on my screen" lock:
// agents (and eliza's reaper) all reach the browser through this wrapper, so
// gating every launch/drive path here is a single chokepoint. Only `status`,
// `unlock`, `reap`, and `help` work while disabled. Created by `tlda-dev pw lock`,
// removed by `tlda-dev pw unlock`.
const DISABLE_FILE = join(homedir(), '.config', 'tlda', 'pw-disabled')
function isDisabled() {
  return existsSync(DISABLE_FILE)
}
function disableInfo() {
  try { return JSON.parse(readFileSync(DISABLE_FILE, 'utf8')) } catch { return {} }
}
function writeDisable(by, reason) {
  try {
    mkdirSync(dirname(DISABLE_FILE), { recursive: true })
    writeFileSync(DISABLE_FILE, JSON.stringify({ by, reason: reason || null, ts: Date.now() }))
    return true
  } catch (e) { console.error(`pw: WARN could not write disable sentinel: ${e.message}`); return false }
}
function clearDisable() {
  try { rmSync(DISABLE_FILE, { force: true }) } catch (e) { console.error(`pw: WARN could not clear disable sentinel: ${e.message}`) }
}

function playwrightCliBin() {
  if (process.env.PLAYWRIGHT_CLI_BIN) return process.env.PLAYWRIGHT_CLI_BIN
  const local = join(REPO_ROOT, 'node_modules', '.bin', 'playwright-cli')
  return existsSync(local) ? local : 'playwright-cli'
}

function playwrightCliRealPath() {
  const bin = playwrightCliBin()
  const which = bin === 'playwright-cli'
    ? (spawnSync('which', ['playwright-cli'], { encoding: 'utf8' }).stdout || '').trim()
    : bin
  if (!which) return null
  try { return realpathSync(which) } catch { return null }
}

function pw(args, opts = {}) {
  // cwd PINNED to the canonical workspace so this command targets the ONE shared
  // daemon regardless of where the agent invoked tlda-dev pw from (see PW_CWD).
  return spawnSync(playwrightCliBin(), [`-s=${SESSION}`, ...args], { encoding: 'utf8', cwd: PW_CWD, ...opts })
}

export function classifyPlaywrightProcessLine(line, session = CANONICAL_SESSION) {
  const m = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
  if (!m) return null
  const pid = Number(m[1])
  const ppid = Number(m[2])
  const command = m[3]
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null
  const exe = command.trim().split(/\s+/)[0] || ''
  const isNode = /(^|\/)node(?:$|[\s])?/.test(exe)
  if (isNode && command.includes('/cliDaemon.js') && new RegExp(`(?:^|\\s)${session}(?:\\s|$)`).test(command)) {
    return { kind: 'daemon', pid, ppid, command }
  }
  const isChromeBrowser = command.includes('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  if (isChromeBrowser && command.includes(`ud-${session}-chrome`) && !command.includes('--type=')) {
    // The browser's --user-data-dir lives under .../daemon/<workspaceHash>/ud-…,
    // so the hash tells us which workspace daemon owns this browser — the reaper
    // uses it to spare the canonical shared browser and kill only interlopers.
    const hm = command.match(/\/daemon\/([0-9a-f]{16})\/ud-/)
    return { kind: 'browser', pid, ppid, command, hash: hm ? hm[1] : null }
  }
  return null
}

function listSessionProcesses(session = SESSION) {
  const out = spawnSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8' }).stdout || ''
  return out.split('\n').map(line => classifyPlaywrightProcessLine(line, session)).filter(Boolean)
}

function killProcess(pid) {
  if (!pid || pid === process.pid) return
  spawnSync('kill', ['-9', String(pid)], { encoding: 'utf8' })
}

function reapSessionProcesses(session = SESSION) {
  const procs = listSessionProcesses(session)
  // Kill daemon first so it cannot respawn or reattach while browsers are dying.
  for (const p of procs.filter(p => p.kind === 'daemon')) killProcess(p.pid)
  for (const p of procs.filter(p => p.kind === 'browser')) killProcess(p.pid)
  return procs
}

function enforceCanonicalSession() {
  if (SESSION === CANONICAL_SESSION || ALLOW_ISOLATED_SESSION) return
  throw new Error(
    `refusing non-canonical playwright session "${SESSION}". ` +
    `Use the shared session, or set TLDA_PW_ALLOW_ISOLATED_SESSION=1 for an explicitly isolated test.`
  )
}

// Reap any `shared` daemon/browser that is NOT the canonical one — a browser
// under a different workspace hash, or a daemon that doesn't parent the canonical
// browser. SURGICAL on purpose: the canonical shared browser is left running, so
// its tabs never reset to about:blank. (The old version nuked ALL `shared`
// processes and reopened on any duplicate — that reopen is what produced the
// repeated about:blank reset across every agent.) With cwd pinned to PW_CWD every
// wrapper-spawned daemon is canonical, so this only cleans up interlopers started
// outside the wrapper or before the cwd pin. Returns true if anything was killed.
function reapAlienSessionProcesses() {
  const procs = listSessionProcesses(SESSION)
  const browsers = procs.filter(p => p.kind === 'browser')
  const daemons = procs.filter(p => p.kind === 'daemon')
  // Keep the first canonical browser and the daemon that parents it.
  const keepBrowser = browsers.find(b => b.hash === CANONICAL_HASH) || null
  const keepDaemonPid = keepBrowser ? keepBrowser.ppid : null
  let killed = 0
  for (const b of browsers) {
    if (keepBrowser && b.pid === keepBrowser.pid) continue
    killProcess(b.pid); killed++
  }
  for (const d of daemons) {
    if (keepDaemonPid && d.pid === keepDaemonPid) continue
    killProcess(d.pid); killed++
  }
  if (killed) {
    console.error(`pw: reaped ${killed} non-canonical "${SESSION}" process(es)${keepBrowser ? ' (kept the canonical shared browser)' : ''}`)
    spawnSync('sleep', ['0.3'])
  }
  return killed > 0
}

// ---- lock (short, per-verb) ----

function lockStatus(repoRoot) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'status'], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  if (!out || out === 'unlocked') return null
  // Status is "<holder> (acquired <N>s ago[, <pid info>])" — tolerate the
  // trailing pid clause pw-lock.sh now appends so the age still parses.
  const m = out.match(/^(.*) \(acquired (\d+)s ago(?:,[^)]*)?\)$/)
  if (!m) return { holder: out, ageSecs: null }
  return { holder: m[1], ageSecs: parseInt(m[2], 10) }
}

function tryLock(repoRoot, me) {
  // Record THIS wrapper process as the liveness pid. A verb holds the lock only
  // for its own (short) lifetime, so while we run the pid is alive and other
  // agents queue; the instant this process exits or is killed, the pid is dead and
  // pw-lock.sh frees the lock immediately (liveness IS the heartbeat) — so a verb
  // whose wrapper was killed mid-flight no longer blocks the next agent for the
  // full stale window. That stuck-lock window is what made agents time out and
  // re-hibernate without ever getting the browser.
  const r = spawnSync('bash', [lockScript(repoRoot), 'acquire', me, '--pid', String(process.pid)], { encoding: 'utf8' })
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
  const out = spawnSync(playwrightCliBin(), ['list'], { encoding: 'utf8', cwd: PW_CWD }).stdout || ''
  const m = out.match(new RegExp(`- ${SESSION}:\\s*\\n\\s*- status: (\\w+)`, 'm'))
  return m ? m[1] === 'open' : false
}

// Locate the playwright-cli implementation that owns tab-select. Older
// playwright-cli installs shipped a separate mcp/browser/context.js; the current
// @playwright/cli package bundles that code into playwright-core/lib/coreBundle.js.
function playwrightPatchTargets() {
  const real = playwrightCliRealPath()
  if (!real) return []
  const cliRoot = dirname(real)
  return [
    {
      path: join(cliRoot, 'node_modules', 'playwright', 'lib', 'mcp', 'browser', 'context.js'),
      regexes: [/^([ \t]*)await tab\.page\.bringToFront\(\);?[ \t]*$/m],
    },
    {
      path: join(cliRoot, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'),
      regexes: [
        /([ \t]*)await tab2\.page\.bringToFront\(\);/m,
        /([ \t]*)await tab\.page\.bringToFront\(\);/m,
      ],
    },
  ].filter(t => existsSync(t.path))
}

// tab-select calls `await tab.page.bringToFront()`, which on headed Chromium
// raises the OS window to the foreground — yanking the browser over Skip every
// time any agent runs a verb. Selecting a page does NOT need it (Playwright
// routes input/screenshots by page object, and each agent's page is the active
// tab of its own window so it renders regardless). Strip that one line. This
// self-heals on every launch so a `brew upgrade` can't silently bring the
// front-raising back. Returns true if the daemon will load a no-raise tab-select.
function ensureNoRaisePatch() {
  const targets = playwrightPatchTargets()
  if (!targets.length) {
    console.error('pw: WARN could not locate playwright-cli tab-select implementation — windows may still raise to front')
    return false
  }
  for (const target of targets) {
    let src
    try { src = readFileSync(target.path, 'utf8') } catch (e) { console.error(`pw: WARN cannot read ${target.path}: ${e.message}`); continue }
    for (const re of target.regexes) {
      if (!re.test(src)) continue
      try {
        writeFileSync(target.path, src.replace(re, '$1/* tlda: bringToFront removed so an agent window never raises over Skip */'))
      } catch (e) { console.error(`pw: WARN cannot patch ${target.path} (${e.message}) — windows may still raise`); return false }
      console.error(`pw: patched tab-select to not raise the window (${target.path})`)
      return true
    }
    return true // already patched / line gone
  }
  console.error('pw: WARN could not find tab-select bringToFront call — windows may still raise to front')
  return false
}

// The session's Chrome profile dir, parsed from `playwright-cli list`.
function sessionUserDataDir() {
  const out = spawnSync(playwrightCliBin(), ['list'], { encoding: 'utf8', cwd: PW_CWD }).stdout || ''
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
  const args = ['open', '--browser', 'chromium', '--headed', '--persistent']
  const cfg = join(repoRoot, '.playwright', 'cli.config.json')
  if (existsSync(cfg)) args.push('--config', cfg)
  return args
}

function ensureOpen(repoRoot) {
  if (sessionOpen()) return false
  // If the playwright-cli binary can't even be resolved, `open` will "fail" for a
  // reason that has nothing to do with a zombie profile lock — and the recover
  // path below would then pkill the LIVE shared browser out from under everyone
  // (observed: running the wrapper from a worktree with no node_modules). Fail
  // clean instead of destructively reaping a browser we simply can't talk to.
  if (!playwrightCliRealPath()) {
    throw new Error(
      'cannot resolve the playwright-cli binary (no node_modules/.bin/playwright-cli and none on PATH) — ' +
      'run tlda-dev pw from a checkout with deps installed, or set PLAYWRIGHT_CLI_BIN. ' +
      'Not touching the shared browser.'
    )
  }
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
// (the exact footgun that wasted a session). Force a .png. Also absolutize a
// relative path against the AGENT's cwd — playwright-cli now runs with cwd pinned
// to the canonical workspace (PW_CWD), so a bare `foo.png` would otherwise be
// written into the main checkout instead of where the agent expects it.
function resolveArtifactFilename(rest, { image = false } = {}) {
  const out = [...rest]
  const i = out.findIndex(a => a === '--filename' || a === '-f')
  let resolved = null
  if (i !== -1 && out[i + 1]) {
    let f = out[i + 1]
    if (image && !IMG_EXT.test(f)) f = f.replace(/\.[^./]*$/, '') + '.png'
    if (!isAbsolute(f)) f = resolve(AGENT_CWD, f)
    out[i + 1] = f
    resolved = f
  }
  return { args: out, resolved }
}

function rewriteScreenshot(rest) {
  return resolveArtifactFilename(rest, { image: true })
}

function rewriteSnapshot(rest) {
  return resolveArtifactFilename(rest)
}

function parseConsoleArgs(rest) {
  let level = null
  let clear = false
  let lines = null
  const pass = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--clear') {
      clear = true
      continue
    }
    if (a === '--lines') {
      const n = Number(rest[i + 1])
      if (!Number.isInteger(n) || n < 1) return { error: 'console --lines requires a positive integer' }
      lines = n
      i++
      continue
    }
    if (a.startsWith('--lines=')) {
      const n = Number(a.slice('--lines='.length))
      if (!Number.isInteger(n) || n < 1) return { error: 'console --lines requires a positive integer' }
      lines = n
      continue
    }
    if (!level && CONSOLE_LEVELS.has(a)) {
      level = a
      pass.push(a)
      continue
    }
    return { error: `unexpected console argument: ${a}` }
  }
  if (clear) pass.push('--clear')
  return { pass, lines }
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

function forwardConsole(rest) {
  const parsed = parseConsoleArgs(rest)
  if (parsed.error) {
    console.error(`${parsed.error}\nUsage: tlda-dev pw console [info|warning|error] [--clear] [--lines N]`)
    return 2
  }
  if (!parsed.lines) return forward('console', parsed.pass)
  const r = pw(['console', ...parsed.pass], { encoding: 'utf8' })
  const out = r.stdout || ''
  const err = r.stderr || ''
  if (err) process.stderr.write(err)
  const lines = out.trimEnd().split('\n')
  process.stdout.write(lines.slice(-parsed.lines).join('\n'))
  if (lines.length) process.stdout.write('\n')
  return r.status ?? 0
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
        'tlda-dev pw — one shared browser, a private tab per agent',
        '',
        '  tlda-dev pw acquire           open the shared browser + ensure my tab',
        '  tlda-dev pw release           close my tab (browser stays up for others)',
        '  tlda-dev pw status            session state + my tab + URL',
        '  tlda-dev pw reap              close the whole shared browser',
        '  tlda-dev pw center <region>   center camera on: doc | chat | fleet',
        '  tlda-dev pw console [level]   print console messages; supports --lines N',
        '  tlda-dev pw <verb> [args]     forward a playwright-cli verb to MY tab',
        '                            (goto, click, snapshot, screenshot, eval, …)',
        '',
        `  my tab key: ${myTabKey()}   (override identity with TLDA_PW_AS)`,
      ].join('\n')
    )
    return
  }

  // Skip's kill switch: lock / unlock the whole shared browser for everyone.
  if (verb === 'lock') {
    writeDisable(me, rest.join(' '))
    // Take the browser down too, so a lock issued while it's up clears the screen.
    if (sessionOpen()) { pw(['close'], { stdio: 'inherit' }); console.log('browser reaped') }
    spawnSync('bash', [lockScript(repoRoot), 'steal', `lock:${me}`], { encoding: 'utf8' })
    spawnSync('bash', [lockScript(repoRoot), 'release', `lock:${me}`], { encoding: 'utf8' })
    console.log('playwright LOCKED — `tlda-dev pw` will not open a browser for anyone. Unlock: tlda-dev pw unlock')
    return
  }
  if (verb === 'unlock') {
    if (!isDisabled()) { console.log('playwright was not locked'); return }
    clearDisable()
    console.log('playwright unlocked — `tlda-dev pw` can open the shared browser again')
    return
  }

  // While locked, refuse anything that could open or drive the browser. Only
  // status / unlock / reap / help / lock are allowed through.
  if (isDisabled() && !['status', 'unlock', 'reap', 'help', '--help', 'lock'].includes(verb)) {
    const info = disableInfo()
    const ago = info.ts ? `${Math.round((Date.now() - info.ts) / 1000)}s ago` : 'unknown when'
    console.error(
      `playwright is LOCKED by ${info.by || 'Skip'} (${ago})${info.reason ? ` — "${info.reason}"` : ''}.\n` +
        '  No browser will open. This is deliberate — Skip turned playwright off.\n' +
        '  Do NOT work around it. To re-enable: tlda-dev pw unlock'
    )
    process.exit(3)
  }

  if (!['status', 'reap', 'help', '--help', 'lock', 'unlock'].includes(verb)) {
    enforceCanonicalSession()
  }

  if (verb === 'console') {
    const parsed = parseConsoleArgs(rest)
    if (parsed.error) {
      console.error(`${parsed.error}\nUsage: tlda-dev pw console [info|warning|error] [--clear] [--lines N]`)
      process.exit(2)
    }
  }

  if (verb === 'status') {
    const lk = lockStatus(repoRoot)
    const open = sessionOpen()
    if (isDisabled()) {
      const info = disableInfo()
      console.log(`DISABLED: playwright is LOCKED by ${info.by || 'Skip'}${info.reason ? ` — "${info.reason}"` : ''} (unlock: tlda-dev pw unlock)`)
    }
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
    if (!lockWithWait(repoRoot, me)) {
      console.error('could not take the pw lock — another agent is mid-verb; try again')
      process.exit(1)
    }
    try {
      // ensureOpen runs INSIDE the lock so concurrent agents can't each launch /
      // recover the browser at once. That race is what produced the kill+reopen
      // thrash — every reopen raises a headed window over Skip. Serialized, only
      // the first agent opens; the rest find it up and reuse it (no raise).
      reapAlienSessionProcesses()
      ensureOpen(repoRoot)
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
    const killed = reapSessionProcesses(SESSION)
    if (killed.length) console.log(`killed ${killed.length} playwright ${SESSION} process(es)`)
    // Reaping frees the lock regardless of holder.
    spawnSync('bash', [lockScript(repoRoot), 'steal', `reaper:${me}`], { encoding: 'utf8' })
    spawnSync('bash', [lockScript(repoRoot), 'release', `reaper:${me}`], { encoding: 'utf8' })
    return
  }

  if (BLOCKED_VERBS.has(verb)) {
    console.error(
      `"${verb}" is managed for you — you get your own tab automatically.\n` +
        `  • start:  tlda-dev pw acquire\n` +
        `  • stop:   tlda-dev pw release   (or  tlda-dev pw reap  to close the browser)`
    )
    process.exit(2)
  }

  // ---- forwarded verb: short lock → ensure open → select my tab → forward ----
  // ensureOpen runs INSIDE the lock (not before it) so two agents arriving at
  // once can't both launch/recover the browser — that race is what kill+reopened
  // the window and raised it over Skip. The first holder opens; the rest wait,
  // then find it up and just reuse their tab.
  if (!lockWithWait(repoRoot, me)) {
    const lk = lockStatus(repoRoot)
    console.error(`pw busy — ${lk ? `${lk.holder} holding (${lk.ageSecs}s)` : 'another agent'}. Try again.`)
    process.exit(1)
  }
  let code = 0
  try {
    reapAlienSessionProcesses()
    ensureOpen(repoRoot)
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
      const rewritten = rewriteScreenshot(rest)
      if (rewritten.resolved) console.error(`pw: artifact filename resolved to ${rewritten.resolved}`)
      code = forward('screenshot', rewritten.args)
    } else if (verb === 'snapshot') {
      const rewritten = rewriteSnapshot(rest)
      if (rewritten.resolved) console.error(`pw: artifact filename resolved to ${rewritten.resolved}`)
      code = forward('snapshot', rewritten.args)
    } else if (verb === 'console') {
      code = forwardConsole(rest)
    } else {
      code = forward(verb, rest)
    }
  } finally {
    unlock(repoRoot, me)
  }
  process.exit(code)
}
