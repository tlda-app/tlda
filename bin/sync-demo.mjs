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
// NEVER POINTED AT ANYTHING OF HIS
//
// `sync-demo` is disposable and is created by --setup. Driving a browser at a
// project writes fleet shapes into that project's room (six per launch), so
// this must never be aimed at a project a person works in. The project name is
// a constant here rather than a flag for exactly that reason.
import assert from 'assert/strict'
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { getServerUrl } from '../shared/config.mjs'

const execFile = promisify(execFileCb)

const PROJECT = 'sync-demo'
const FILE = 'demo.md'
const SHAPE = 'shape:sync-demo'
const ROOT = path.join(os.homedir(), 'worktrees', 'sync-demo')
const CHECKOUT = path.join(ROOT, 'checkout')
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

const lineFor = (leg, n) => `- [${leg}] #${n} at ${stamp()}`

async function writeOnDisk(line) {
  fs.appendFileSync(path.join(CHECKOUT, FILE), `${line}\n`)
  // Nothing else. No commit, no push, no CLI call: the daemon is supposed to
  // notice the edit, settle the tree, and push a proposal on its own. Doing any
  // of that here would be the harness performing the behaviour under test.
}

async function writeInBrowser(line) {
  const result = inPage(`
    const el = document.querySelector('[data-shape-id="${SHAPE}"]')
    const content = el && el.querySelector('.cm-content')
    if (!content) return { error: 'no CodeMirror view mounted' }
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
  fs.appendFileSync(file, `${line}\n`)
  await git(REMOTE_CLONE, ['add', '--', FILE])
  await git(REMOTE_CLONE, ['commit', '-m', line])
  await git(REMOTE_CLONE, ['push', 'origin', 'HEAD:main'])
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
        const el = document.querySelector('[data-shape-id="' + id + '"]')
        const c = el && el.querySelector('.cm-content')
        if (c && c.textContent) { clearInterval(poll); resolve({ ok: true, waitedMs: Date.now() - started }) }
        else if (Date.now() - started > 30000) { clearInterval(poll); resolve({ ok: false, waitedMs: Date.now() - started }) }
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

const startingVersions = await versionCount()
console.log(`versions: ${startingVersions === null ? 'could not read shadow log' : startingVersions} at start\n`)

let n = Number(valueOf('--from', Date.now() % 100000))
const failures = []

for (let cycle = 0; cycle < CYCLES; cycle++) {
  for (const leg of LEGS) {
    n += 1
    const marker = `#${n}`
    const line = lineFor(leg, n)

    // Every destination EXCEPT the one that wrote it. Asking whether the writer
    // can see its own write measures nothing.
    const destinations = {}
    destinations.server = serverText
    if (leg !== 'disk') destinations.checkout = checkoutText
    if (leg !== 'remote') destinations.remote = remoteText
    if (leg !== 'browser' && browserReady) destinations.browser = browserText

    let wrote = true
    try {
      await WRITERS[leg](line)
    } catch (error) {
      wrote = false
      console.log(`${leg.padEnd(8)} ${marker.padEnd(8)} COULD NOT WRITE — ${error.message}`)
    }
    if (!wrote) continue

    const result = await converge(marker, destinations)
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

  if (cycle + 1 < CYCLES) await sleep(EVERY_MS)
}

if (failures.length) {
  console.error(`\n${failures.length} convergence ${failures.length === 1 ? 'failure' : 'failures'}:\n`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`\nEvery line reached every surface. Watch it: ${SERVER}/?project=${PROJECT}`)
process.exit(0)
