#!/usr/bin/env node
// A running proof that sync works, and a thing you can sit and watch.
//
//   node bin/sync-demo.mjs --setup      # once: build the demo project
//   node bin/sync-demo.mjs              # run a few cycles and report
//   node bin/sync-demo.mjs --watch      # keep going, one cycle a minute
//
// Skip, 2026-08-25: "is there a way we can 1. test sync and 2. like demo it for
// me? like it'd be cool to sort of be able to passively watch sync working."
//
// ---------------------------------------------------------------------------
// WHY THESE THREE WRITERS AND NOT SOME OTHER SET
//
// They are not a sample. They are every way an edit can enter a project:
//
//   disk    — a person or agent editing files in a daemon-bound checkout.
//             The daemon settles the tree and pushes a proposal.
//   browser — the source editor. CodeMirror, through the source room.
//   remote  — a linked Git remote somebody else pushed to.
//
// So a run that exercises all three and watches them converge is a statement
// about sync, not about one path through it. A run that exercises two is not.
//
// ---------------------------------------------------------------------------
// THE DOCUMENT IS THE LOG
//
// Every writer appends one line carrying its own name and a number:
//
//   - [disk] #47 at 2026-08-25T04:12:03.114Z
//
// That is deliberate and it is the whole demo. Open the project in the app and
// the lines arrive in front of you, tagged with which path carried them. If a
// leg stops working its lines stop appearing and you can see WHICH one at a
// glance — no dashboard, no log to read, nothing to correlate. The version
// history grows alongside it in the same window.
//
// The numbers are unique, so "did the browser's line reach the checkout" is an
// exact question. Eyeballing a document for whether it looks up to date is the
// thing this exists to replace.
//
// ---------------------------------------------------------------------------
// WHAT IT MEASURES, AND WHY IT IS LATENCY RATHER THAN A BOOLEAN
//
// Skip's complaint has two halves: "the files don't get there, OR IF THEY DO
// GET THERE, THEY'RE OLD". A pass/fail on arrival only answers the first half.
// So every leg is timed to each destination, and the report prints the number.
// Arrived-in-40-seconds and arrived-in-400ms are both green and only one of
// them is the product working.
//
// ---------------------------------------------------------------------------
// IT CHECKS THE PAGES RENDER, NOT ONLY THAT THE BYTES ARRIVED
//
// The first version of this measured disk -> server and browser -> server to the
// millisecond and never asked whether a page could be SEEN. On 2026-08-25 that
// gap cost a day: a paper's pages were requested under a filename the server
// does not serve, every request returned 29 bytes of `{"error":...}`, and the
// canvas drew an empty box per failure — indistinguishable from still loading.
// Sync was perfect throughout. The demo could not have caught it, because the
// project it ran on was markdown and had no pages at all.
//
// So every cycle now fetches the rendered pages and fails on a page that does
// not come back as a real SVG. Skip: "i want a version making real fucking edits
// to a real project."
//
// NEVER POINTED AT ANYTHING OF HIS
//
// Driving a browser at a project writes fleet shapes into that project's room
// (six per launch), and this edits files. It therefore refuses any project whose
// name is not a disposable demo one — see ALLOWED_PREFIXES.
import assert from 'assert/strict'
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { getServerUrl } from '../shared/config.mjs'

// Read one flag before the option block below exists. Two readers of argv is one
// too many, so this is the only early one and `valueOf` delegates to it.
function valueOfEarly(flag, fallback) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : process.argv[at + 1]
}

const execFile = promisify(execFileCb)

// The project is an argument now, but ONLY a disposable one. Driving a browser
// at a project writes fleet shapes into its room, and a demo that edits files
// must never be aimable at something someone works in. The guard is a name
// prefix rather than a constant so the demo can run against a paper-SHAPED
// project — Skip, 2026-08-25: "i want a version making real fucking edits to a
// real project", after the markdown toy it used before proved it could not
// catch a rendering fault.
const ALLOWED_PREFIXES = ['sync-', 'pageurl-']
const PROJECT = String(valueOfEarly('--project', 'sync-demo'))
if (!ALLOWED_PREFIXES.some(prefix => PROJECT.startsWith(prefix))) {
  console.error(`refusing to run against "${PROJECT}": this edits files and drives a browser, so it only runs on a disposable project (${ALLOWED_PREFIXES.join('* , ')}*)`)
  process.exit(1)
}
const FILE = String(valueOfEarly('--file', 'demo.md'))
const SHAPE = `shape:${PROJECT}`
const ROOT = path.join(os.homedir(), 'worktrees', PROJECT)
// Explicit, not inferred. A checkout that is the project root and one that is a
// `checkout/` inside it are both ordinary, and guessing between them is the kind
// of convenience that ends up wrong silently.
const CHECKOUT = path.resolve(String(valueOfEarly('--checkout', path.join(ROOT, 'checkout'))))
const REMOTE = path.join(ROOT, 'remote.git')
const REMOTE_CLONE = path.join(ROOT, 'remote-clone')
const SERVER = getServerUrl().replace(/\/$/, '')

const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : args[at + 1]
}

const CYCLES = Number(valueOf('--cycles', has('--watch') ? Infinity : 3))
const EVERY_MS = Number(valueOf('--every', 60_000))
// Generous on purpose. This is not a latency budget — it is the point past
// which "slow" becomes "did not arrive", and calling a working path broken is
// far more expensive here than waiting another twenty seconds.
const CONVERGE_MS = Number(valueOf('--timeout', 90_000))
const LEGS = String(valueOf('--legs', 'disk,browser,remote')).split(',').map(s => s.trim()).filter(Boolean)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const api = suffix => `${SERVER}/api/projects/${PROJECT}${suffix}`
const stamp = () => new Date().toISOString()
const git = (cwd, gitArgs) => execFile('git', gitArgs, { cwd, encoding: 'utf8', timeout: 120_000 })

// ---------------------------------------------------------------------------
// Reading each surface. Each returns text, or null when the surface could not
// be read at all — which is a different fact from "the text is not there yet"
// and is never allowed to count as a convergence failure.
// ---------------------------------------------------------------------------

async function serverText() {
  try {
    const res = await fetch(api(`/source/${FILE}`), { signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.text() : null
  } catch { return null }
}

function checkoutText() {
  try { return fs.readFileSync(path.join(CHECKOUT, FILE), 'utf8') } catch { return null }
}

async function remoteText() {
  try {
    await git(REMOTE_CLONE, ['fetch', 'origin'])
    const { stdout } = await git(REMOTE_CLONE, ['show', `origin/HEAD:${FILE}`])
    return stdout
  } catch {
    try {
      const { stdout } = await git(REMOTE_CLONE, ['show', `origin/main:${FILE}`])
      return stdout
    } catch { return null }
  }
}

/**
 * Run code in this agent's pooled tab and return its value.
 *
 * Takes a function OR a source string. The string form is here because most of
 * these bodies need the project's file name and shape id interpolated into
 * them, and `new Function(...).toString()` wraps the body in `function
 * anonymous(\n)` — which is one more thing between what is written here and
 * what the page runs, for no gain.
 */
function inPage(fn, { timeoutMs = 600_000 } = {}) {
  const source = typeof fn === 'string' ? `() => { ${fn} }` : fn.toString()
  // 10 minutes, and that is not paranoia: the pool serialises on a lock, so an
  // eval that returns in milliseconds can sit behind another agent's turn.
  const out = execFileSync('tlda-dev', ['pw', 'eval', source], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  })
  const start = out.indexOf('### Result')
  if (start === -1) throw new Error(`pw eval returned no result:\n${out.slice(0, 800)}`)
  const body = out.slice(start + '### Result'.length)
  const end = body.indexOf('### Ran Playwright code')
  const json = (end === -1 ? body : body.slice(0, end)).trim()
  try { return JSON.parse(json) } catch { return json }
}

// `.cm-content`'s textContent concatenates one div per line with NO newline
// between them, so nothing here may compare whole documents — only look for a
// distinctive phrase, which is what the per-line marker is for.
function browserText() {
  try {
    // Reads EVERY rendered copy, not the first. With the HUD open the shape
    // exists twice, and `querySelector` would silently pick one of them — the
    // difference between "the editor received it" and "one of the two editors
    // received it", and only the second is an answer.
    const read = inPage(`
      const els = [...document.querySelectorAll('[data-shape-id="${SHAPE}"]')]
      return els.map(el => { const c = el.querySelector('.cm-content'); return c ? c.textContent : null })
                .filter(Boolean).join(' | ')
    `)
    return typeof read === 'string' ? read : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// The three writers
// ---------------------------------------------------------------------------

// No `#`. It is a parameter character in LaTeX and a bare one is a compile
// error, so the demo's own marker broke the build of the paper it was
// demonstrating on — measured, not theorised: "BUILD FAILED: LaTeX produced 1
// error(s)". The marker has to be legal in every format this runs against.
const lineFor = (leg, n) => `- [${leg}] SYNCDEMO-${n} at ${stamp()}`

// Where a demo line goes in the file.
//
// Appending to the end is wrong for LaTeX: everything after \end{document} is
// ignored, so the lines land in the source, sync perfectly, and change nothing
// a person can see — which is the exact failure this demo exists to detect,
// reproduced by the demo itself. A file carrying the marker gets its lines
// inserted there, inside the document body.
const LOG_MARKER = '% SYNC-DEMO-LOG'
function appendIntoDocument(absolutePath, line) {
  const text = fs.readFileSync(absolutePath, 'utf8')
  if (!text.includes(LOG_MARKER)) {
    fs.appendFileSync(absolutePath, `${line}\n`)
    return
  }
  fs.writeFileSync(absolutePath, text.replace(LOG_MARKER, `${line}\n\n${LOG_MARKER}`))
}

async function writeOnDisk(line) {
  appendIntoDocument(path.join(CHECKOUT, FILE), line)
  // Nothing else. No commit, no push, no CLI call: the daemon is supposed to
  // notice the edit, settle the tree, and push a proposal on its own. Doing any
  // of that here would be the harness performing the behaviour under test.
}

async function writeInBrowser(line) {
  const result = inPage(`
    // Every copy, and the one that actually has a CodeMirror in it — never the
    // first. A fleet shape renders twice when the HUD is open, and the
    // main-canvas copy is deliberately EMPTY: FleetHudRenderGate returns null
    // there so the HUD's viewport owns it. querySelector returns that empty one,
    // which reads exactly like an editor that failed to mount. It cost this
    // harness a false "browser leg is broken" against a working editor.
    const content = [...document.querySelectorAll('[data-shape-id="${SHAPE}"]')]
      .map(el => el.querySelector('.cm-content')).find(Boolean)
    if (!content) return { error: 'no CodeMirror view mounted in any rendered copy' }
    const view = (content.cmView && content.cmView.view) || (content.cmTile && content.cmTile.view)
      || window.__source_editor_view__ || null
    if (!view) return { unreachable: true }
    // CodeMirror's own transaction path: the update listener fires and the idle
    // save timer arms exactly as it does for a keystroke.
    view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(`${line}\n`)} } })
    return { typed: true }
  `)
  if (result.error) throw new Error(result.error)
  if (result.unreachable) {
    throw new Error(
      'the CodeMirror EditorView is not reachable from the DOM on this build (no `cmView` on\n'
      + '    .cm-content). The browser leg cannot be driven from outside the page until the shape\n'
      + '    exposes it — e.g. window.__source_editor_view__. Reported, not counted as a sync failure.',
    )
  }
}

async function writeOnRemote(line) {
  const file = path.join(REMOTE_CLONE, FILE)
  await git(REMOTE_CLONE, ['fetch', 'origin'])
  await git(REMOTE_CLONE, ['reset', '--hard', 'origin/main']).catch(() => {})
  appendIntoDocument(file, line)
  await git(REMOTE_CLONE, ['add', '--', FILE])
  await git(REMOTE_CLONE, ['commit', '-m', line])
  await git(REMOTE_CLONE, ['push', 'origin', 'HEAD:main'])

  // Then pull it in, because for this project nothing would.
  //
  // A linked remote is only POLLED when the binding carries a `remote` — the
  // daemon builds a remote bridge from that field and nothing else, and the
  // field is written at link time. `tlda project remote add` runs a plain `git
  // remote add` in the checkout and never touches the binding, so a remote
  // added after linking is one you pull by hand.
  //
  // Measured before this was understood: a commit pushed to the bare remote sat
  // there and reached neither the server nor the checkout in 90s. That was the
  // harness asking for behaviour the app does not claim, not a sync failure —
  // which is exactly why the leg now exercises the path that does exist.
  execFileSync('tlda', ['project', 'remote', 'pull', 'origin', '--project', PROJECT], {
    cwd: CHECKOUT, encoding: 'utf8', timeout: 300_000, stdio: 'pipe',
  })
}

const WRITERS = { disk: writeOnDisk, browser: writeInBrowser, remote: writeOnRemote }

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

/**
 * Wait for `marker` to appear on every destination, timing each one separately.
 *
 * Each destination is polled until it has the marker or the deadline passes, and
 * what is recorded is the elapsed time — not a boolean. A surface that could not
 * be read AT ALL is reported as `unreadable` rather than as a failure to
 * converge: an unmounted editor and an editor that never received the text look
 * identical from here, and only one of them is a defect in sync.
 */
async function converge(marker, destinations) {
  const started = Date.now()
  const pending = new Map(Object.entries(destinations))
  const result = {}
  while (pending.size && Date.now() - started < CONVERGE_MS) {
    for (const [name, read] of [...pending]) {
      const text = await read()
      if (text === null) continue
      if (String(text).includes(marker)) {
        result[name] = { ms: Date.now() - started }
        pending.delete(name)
      }
    }
    if (pending.size) await sleep(1000)
  }
  for (const [name, read] of pending) {
    const text = await read()
    result[name] = text === null
      ? { unreadable: true, ms: Date.now() - started }
      : { missing: true, ms: Date.now() - started }
  }
  return result
}

/**
 * The checkout's branch and whether its tree is clean.
 *
 * Both are part of what sync now means, so the demo asserts them rather than
 * only watching text arrive. A checkout that is not standing on its work branch
 * does not sync at all — by design — and one that never goes clean is the state
 * every checkout on this machine was stuck in: the daemon committing to a branch
 * the author was not on, so `git status` always had the file and `git checkout`
 * always refused.
 */
async function branchState() {
  try {
    const head = (await git(CHECKOUT, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim()
    const dirty = (await git(CHECKOUT, ['status', '--porcelain'])).stdout.trim()
    const tip = (await git(CHECKOUT, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    return { head, clean: dirty === '', dirty, tip }
  } catch (error) {
    return { head: null, clean: null, dirty: '', tip: null, error: error.message }
  }
}

/**
 * Fetch every rendered page and say whether it is really there.
 *
 * This is the check the first version of this file lacked, and its absence is
 * why it certified a document nobody could read. A page that 404s comes back as
 * a short JSON error, so "did I get bytes" is not enough — the size is the test.
 *
 * The URL is built from the project's own `targets`, exactly as the client does,
 * because the filename is keyed on the TEX BASE and not the project name. Asking
 * under the wrong name is precisely the bug this exists to catch, so it must not
 * guess: no targets means no answer, reported as such.
 */
async function pagesRender() {
  let project
  try {
    const res = await fetch(api(''), { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return { ok: false, reason: `project record unreadable (HTTP ${res.status})` }
    project = await res.json()
  } catch (error) { return { ok: false, reason: `project record unreadable (${error.message})` } }

  const targets = Array.isArray(project?.targets) ? project.targets : []
  if (!targets.length) return { ok: false, reason: 'the project reports no targets, so no page can be addressed' }

  const results = []
  for (const target of targets) {
    const pages = Number(target?.pages || 0)
    for (let page = 1; page <= pages; page++) {
      const url = `${SERVER}/docs/${PROJECT}/${target.texBase}-page-${page}.svg`
      const started = Date.now()
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
        const body = await res.text()
        results.push({ page, status: res.status, bytes: body.length, ms: Date.now() - started })
      } catch (error) {
        results.push({ page, status: 0, bytes: 0, ms: Date.now() - started, error: error.message })
      }
    }
  }
  // A real page is tens of kilobytes. A 404 body is a few dozen bytes, which is
  // why the threshold is on SIZE and not on the status code alone — a proxy or a
  // rewrite can return 200 with an error document.
  const broken = results.filter(r => r.status !== 200 || r.bytes < 1000)
  const slowest = results.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null)
  return {
    ok: broken.length === 0,
    total: results.length,
    broken,
    slowestMs: slowest?.ms ?? null,
    slowestPage: slowest?.page ?? null,
  }
}

async function versionCount() {
  try {
    const res = await fetch(api('/shadow/log'), { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const body = await res.json()
    const entries = Array.isArray(body) ? body : (body.log || body.commits || body.entries || [])
    return Array.isArray(entries) ? entries.length : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  console.log(`Building the demo project under ${ROOT}`)
  fs.mkdirSync(ROOT, { recursive: true })

  if (!fs.existsSync(path.join(REMOTE, 'HEAD'))) {
    fs.mkdirSync(REMOTE, { recursive: true })
    await git(REMOTE, ['init', '--bare', '--initial-branch=main'])
    console.log(`  bare remote      ${REMOTE}`)
  }

  if (!fs.existsSync(path.join(CHECKOUT, '.git'))) {
    fs.mkdirSync(CHECKOUT, { recursive: true })
    await git(CHECKOUT, ['init', '--initial-branch=main'])
    fs.writeFileSync(path.join(CHECKOUT, FILE),
      '# sync demo\n\nEvery line below was written by one of the three ways an edit can\n'
      + 'enter a project, and carries the name of the one that wrote it.\n\n')
    await git(CHECKOUT, ['add', '--', FILE])
    await git(CHECKOUT, ['commit', '-m', 'Start the sync demo document'])
    console.log(`  checkout         ${CHECKOUT}`)
  }

  const exists = await fetch(api(''), { signal: AbortSignal.timeout(30_000) }).then(r => r.ok).catch(() => false)
  if (!exists) {
    execFileSync('tlda', ['project', 'link', PROJECT, FILE], { cwd: CHECKOUT, encoding: 'utf8', stdio: 'inherit', timeout: 600_000 })
    console.log(`  linked project   ${PROJECT}`)
  } else {
    console.log(`  project ${PROJECT} already exists on ${SERVER}`)
  }

  try {
    execFileSync('tlda', ['project', 'remote', 'add', 'origin', REMOTE], { cwd: CHECKOUT, encoding: 'utf8', stdio: 'inherit', timeout: 300_000 })
  } catch {
    // Already added. `remote add` on an existing name is an error and this is
    // the idempotent path — re-running --setup must converge, not fail, since
    // the whole point of it is to be re-runnable on a machine where things die
    // halfway through.
    console.log('  remote origin already present')
  }

  // Seed the bare remote from the checkout, so the two share a history.
  // Otherwise `tlda project remote pull` reaches `git merge` and stops at
  // "refusing to merge unrelated histories" — which is git being right, and the
  // harness having built a remote that was never a copy of this project.
  const bareHasCommits = await git(REMOTE, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
  if (!bareHasCommits) {
    await git(CHECKOUT, ['push', REMOTE, 'HEAD:main'])
    console.log('  seeded remote from the checkout')
  }

  if (!fs.existsSync(path.join(REMOTE_CLONE, '.git'))) {
    await git(ROOT, ['clone', REMOTE, REMOTE_CLONE])
    await git(REMOTE_CLONE, ['config', 'user.email', 'sync-demo@tlda']).catch(() => {})
    await git(REMOTE_CLONE, ['config', 'user.name', 'sync demo']).catch(() => {})
    console.log(`  remote clone     ${REMOTE_CLONE}`)
  }

  console.log(`\nOpen it: ${SERVER}/?project=${PROJECT}`)
}

// ---------------------------------------------------------------------------
// Mount the editor in the pooled tab, once
// ---------------------------------------------------------------------------

async function mountEditor() {
  execFileSync('tlda-dev', ['pw', 'setup', '--project', PROJECT], { encoding: 'utf8', timeout: 300_000 })
  const mounted = inPage(`
    const ed = window.__tldraw_editor__
    if (!ed) return { error: 'no tldraw editor on window' }
    const id = '${SHAPE}'
    if (!ed.getShape(id)) {
      const peer = ed.getCurrentPageShapes().find(s => s.type === 'fleet-chat')
      if (!peer) return { error: 'no fleet-chat shape to borrow identity and position from' }
      const b = ed.getShapePageBounds(peer.id)
      ed.createShape({ id, type: 'fleet-source-editor', x: b.x, y: b.y + b.h + 40,
        props: { w: 640, h: 520, file: '${FILE}', line: 1, title: 'Source', userId: peer.props.userId, deviceId: peer.props.deviceId } })
    }
    ed.zoomToBounds(ed.getShapePageBounds(id), { inset: 60 })
    // Creating the shape and reading it in the same turn finds a mounted element
    // with no CodeMirror in it: React has not rendered, and the editor then has
    // to fetch the file. Both are asynchronous, so wait rather than sampling
    // once and calling it broken.
    return new Promise(resolve => {
      const started = Date.now()
      const poll = setInterval(() => {
        // Across every rendered copy — see the note in writeInBrowser. With the
        // HUD open the main-canvas copy is an empty container by design, so
        // polling the first match waits out the full timeout on a shape whose
        // editor mounted immediately in the HUD.
        const copies = [...document.querySelectorAll('[data-shape-id="' + id + '"]')]
        const c = copies.map(el => el.querySelector('.cm-content')).find(Boolean)
        if (c && c.textContent) {
          resolve({ ok: true, waitedMs: Date.now() - started, copies: copies.length })
          clearInterval(poll)
        } else if (Date.now() - started > 30000) {
          resolve({ ok: false, waitedMs: Date.now() - started, copies: copies.length })
          clearInterval(poll)
        }
      }, 250)
    })
  `)
  return mounted
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (has('--setup')) {
  await setup()
  process.exit(0)
}

console.log(`server:   ${SERVER}`)
console.log(`project:  ${PROJECT}  (${SERVER}/?project=${PROJECT})`)
console.log(`legs:     ${LEGS.join(', ')}`)

// Preconditions, each because its absence looks exactly like a leg that does
// not work.
const project = await fetch(api(''), { signal: AbortSignal.timeout(90_000) }).then(r => r.ok).catch(() => null)
assert.ok(
  project !== null,
  `${SERVER} did not answer at all. That is the server, not sync — nothing below would mean anything.`,
)
assert.ok(project, `${PROJECT} does not exist on ${SERVER}. Run: node bin/sync-demo.mjs --setup`)
assert.ok(fs.existsSync(path.join(CHECKOUT, FILE)), `no demo checkout at ${CHECKOUT}. Run: node bin/sync-demo.mjs --setup`)

let browserReady = false
if (LEGS.includes('browser')) {
  const mounted = await mountEditor().catch(e => ({ error: e.message }))
  browserReady = !!mounted.ok
  console.log(mounted.ok
    ? `browser:  editor mounted on ${FILE} after ${mounted.waitedMs}ms`
    : `browser:  NOT mounted (${mounted.error || `waited ${mounted.waitedMs}ms`}) — that leg will report, not assert`)
}

const WORK_BRANCH = `tlda/${PROJECT}`
const startBranch = await branchState()
console.log(`checkout: on ${startBranch.head || 'a detached HEAD'}${startBranch.clean ? ', clean' : `, DIRTY (${startBranch.dirty.split('\n').length} paths)`}`)
if (LEGS.includes('disk') && startBranch.head !== WORK_BRANCH) {
  console.log(`          the disk leg will NOT sync: the daemon only commits when ${WORK_BRANCH} is checked out.`)
  console.log(`          this checkout predates that repair — relink it, or: git -C ${CHECKOUT} checkout ${WORK_BRANCH}`)
}

const startingVersions = await versionCount()
console.log(`versions: ${startingVersions === null ? 'could not read shadow log' : startingVersions} at start\n`)

let n = Number(valueOf('--from', Date.now() % 100000))
const failures = []
const unrun = []

for (let cycle = 0; cycle < CYCLES; cycle++) {
  for (const leg of LEGS) {
    n += 1
    const marker = `SYNCDEMO-${n}`
    const line = lineFor(leg, n)

    // Every destination EXCEPT the one that wrote it. Asking whether the writer
    // can see its own write measures nothing.
    const destinations = {}
    destinations.server = serverText
    if (leg !== 'disk') destinations.checkout = checkoutText
    if (leg !== 'browser' && browserReady) destinations.browser = browserText
    // The linked remote is a SOURCE here, never a destination. Nothing pushes
    // an accepted revision back out to it unless the binding asks for a mirror,
    // so expecting a disk or browser edit to appear there was the harness
    // asking for behaviour the app does not claim — it reported two convergence
    // failures against a working system before this was understood.

    let wrote = true
    try {
      await WRITERS[leg](line)
    } catch (error) {
      wrote = false
      console.log(`${leg.padEnd(8)} ${marker.padEnd(8)} COULD NOT WRITE — ${error.message}`)
      // A leg that could not write is NOT a pass. It used to `continue`
      // silently, so a run where the remote leg never executed still ended on
      // "Every line reached every surface" and exit 0 — the harness reporting
      // success for work it had not done. That is the failure this whole script
      // exists to catch, and it was in the script.
      //
      // Tracked apart from convergence failures because they mean opposite
      // things: a convergence failure is the app losing an edit, this is the
      // harness never having made one. Reporting them as the same number would
      // send somebody debugging sync over a broken fixture.
      unrun.push(`${leg}: ${error.message.split('\n')[0]}`)
    }
    if (!wrote) continue

    const beforeTip = leg === 'disk' ? (await branchState()).tip : null
    const result = await converge(marker, destinations)
    if (leg === 'disk') {
      // The author's edit is committed UNDER them, so the tree goes clean and
      // their branch moves. Watching only the text arrive would have been green
      // throughout the period when neither of these was true.
      const after = await branchState()
      if (after.head === WORK_BRANCH) {
        if (!after.clean) failures.push(`disk: the working tree did not go clean after ${marker} (${after.dirty.split('\n')[0]})`)
        if (after.tip === beforeTip) failures.push(`disk: ${WORK_BRANCH} did not advance for ${marker} (still ${beforeTip})`)
      }
    }
    const parts = Object.entries(result).map(([name, r]) =>
      r.ms !== undefined && !r.missing && !r.unreadable
        ? `${name} ${(r.ms / 1000).toFixed(1)}s`
        : r.unreadable ? `${name} UNREADABLE` : `${name} NEVER ARRIVED`)
    const bad = Object.entries(result).filter(([, r]) => r.missing)
    console.log(`${leg.padEnd(8)} ${marker.padEnd(8)} ${parts.join('   ')}`)
    for (const [name] of bad) {
      failures.push(`${leg} → ${name}: ${marker} never arrived within ${CONVERGE_MS / 1000}s`)
    }
  }

  const versions = await versionCount()
  if (versions !== null && startingVersions !== null) {
    console.log(`         versions ${startingVersions} → ${versions}`)
  }

  // The check the first version of this file did not have. Bytes arriving is
  // not the product; a page a person can see is.
  const rendered = await pagesRender()
  if (!rendered.ok && rendered.reason) {
    failures.push(`pages: ${rendered.reason}`)
    console.log(`         pages   COULD NOT CHECK — ${rendered.reason}`)
  } else if (!rendered.ok) {
    const sample = rendered.broken.slice(0, 3)
      .map(b => `p${b.page} ${b.status} ${b.bytes}b`).join(', ')
    failures.push(`pages: ${rendered.broken.length} of ${rendered.total} do not render (${sample})`)
    console.log(`         pages   ${rendered.broken.length}/${rendered.total} BROKEN — ${sample}`)
  } else {
    console.log(`         pages   ${rendered.total}/${rendered.total} render, slowest p${rendered.slowestPage} ${(rendered.slowestMs / 1000).toFixed(1)}s`)
  }

  if (cycle + 1 < CYCLES) await sleep(EVERY_MS)
}

if (unrun.length) {
  console.error(`\n${unrun.length} leg${unrun.length === 1 ? '' : 's'} did not run, so ${unrun.length === 1 ? 'it is' : 'they are'} neither passed nor failed:\n`)
  for (const item of unrun) console.error(`  ${item}`)
}

if (failures.length) {
  console.error(`\n${failures.length} convergence ${failures.length === 1 ? 'failure' : 'failures'} — an edit was made and did not arrive:\n`)
  for (const failure of failures) console.error(`  ${failure}`)
}

if (failures.length || unrun.length) process.exit(1)

// Names only the legs that actually ran. The fixed sentence this replaces said
// "Every line reached every surface" on a run where a leg had thrown before
// writing anything.
console.log(`\nEvery line written by ${LEGS.join(', ')} reached every surface. Watch it: ${SERVER}/?project=${PROJECT}`)
process.exit(0)
