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

import * as Y from 'yjs'

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
// EVERY INGRESS EDITS THE SAME DOCUMENT, BECAUSE THAT IS THE FEATURE.
//
// This used to give each route its own file. The routes conflicted on a shared
// document -- `UU paper.tex` on most cycles -- so they were separated, and a
// comment was written justifying it as structural.
//
// Skip, 2026-08-26, on that: *"i mean part of this is editing the same file
// yeah?"* / *"TEST THE FUCKING FEATURE"* / *"the standard is that a real editing
// session, e.g. the one i worked on w/ jose earlier, actually fucking works"* /
// *"not that you can AVOID TESTING THE STUFF THAT'S ACTUALLY HARD"*.
//
// He is right and the separation was the harness removing the thing it exists to
// check. Two people in one document is not an edge case in this product, it is
// the product: him and a collaborator, in the same file, at the same time. A demo
// arranged so that never happens cannot say anything about it.
//
// So the default is one file for every route, and a conflict is a FINDING rather
// than a fixture problem -- it is what happens to two real people, and it has to
// work. The per-route overrides remain for isolating a single path while
// diagnosing one, which is a different job from demonstrating that sync works.
const LEG_FILES = {
  disk: FILE,
  browser: String(valueOfEarly('--browser-file', FILE)),
  remote: String(valueOfEarly('--remote-file', FILE)),
}
const SHAPE = `shape:${PROJECT}`
const ROOT = path.join(os.homedir(), 'worktrees', PROJECT)
// Explicit, not inferred. A checkout that is the project root and one that is a
// `checkout/` inside it are both ordinary, and guessing between them is the kind
// of convenience that ends up wrong silently.
const CHECKOUT = path.resolve(String(valueOfEarly('--checkout', path.join(ROOT, 'checkout'))))
// The git-remote fixtures live OUTSIDE the checkout. When the checkout is the
// project root — which it is whenever a project was made by `git init` in the
// directory itself — putting a bare repo under ROOT puts it inside the working
// tree, where the daemon would see it as project content.
const FIXTURES = path.resolve(String(valueOfEarly('--fixtures', ROOT)))
const REMOTE = path.join(FIXTURES, 'remote.git')
const REMOTE_CLONE = path.join(FIXTURES, 'remote-clone')
// The comment above named this hazard and the default still permitted it, which
// is how it happened: a restart that omitted `--fixtures` put the bare repo at
// <checkout>/remote.git. The remote leg then failed every cycle -- audibly, so
// nothing was hidden -- but a bare repo and a clone inside the working tree are
// project content as far as the daemon is concerned, and the next settle would
// have published them.
//
// Refuse instead of relocating. Picking a different directory on the user's
// behalf is the guess this file already declines to make about the checkout.
if (FIXTURES === CHECKOUT || FIXTURES.startsWith(CHECKOUT + path.sep)) {
  console.error(`fixtures directory is inside the checkout: ${FIXTURES}`)
  console.error(`the bare remote and its clone would sync as project content.`)
  console.error(`pass --fixtures with a path outside ${CHECKOUT}`)
  process.exit(2)
}
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

async function serverText(file = FILE) {
  try {
    const res = await fetch(api(`/source/${file}`), { signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.text() : null
  } catch { return null }
}

function checkoutText(file = FILE) {
  try { return fs.readFileSync(path.join(CHECKOUT, file), 'utf8') } catch { return null }
}

/**
 * What reached the checkout from the SERVER side, which is a parked ref and not
 * a working file.
 *
 * An accepted revision is deliberately not applied to a person's working tree.
 * `git-project-sync.mjs`: *"The accepted revision is PARKED, not applied ... that
 * is the whole obligation: the person can see it, diff it, and merge it with
 * their own git whenever they choose to."* It used to force-checkout the branch,
 * commit the dirty tree unasked and merge server history in, which left
 * unresolved merges in people's checkouts. Local is authoritative.
 *
 * So reading the working file to decide whether a browser edit "arrived" asks
 * for behaviour the app does not claim -- the same mistake this file already
 * records for the linked remote as a destination, one hop over. It reported a
 * convergence failure against a working system before this was understood.
 */
async function parkedText(file = FILE) {
  try {
    const { stdout } = await git(CHECKOUT, ['show', `refs/tlda/fetched/${PROJECT}:${file}`])
    return stdout
  } catch { return null }
}

async function remoteText() {
  try {
    await git(REMOTE_CLONE, ['fetch', 'origin'])
    const { stdout } = await git(REMOTE_CLONE, ['show', `origin/HEAD:${FILE}`])
    return stdout
  } catch {
    try {
      const { stdout } = await git(REMOTE_CLONE, ['show', `origin/tlda/${PROJECT}:${FILE}`])
      return stdout
    } catch { return null }
  }
}



// ---------------------------------------------------------------------------
// The three writers
// ---------------------------------------------------------------------------

// No `#`. It is a parameter character in LaTeX and a bare one is a compile
// error, so the demo's own marker broke the build of the paper it was
// demonstrating on — measured, not theorised: "BUILD FAILED: LaTeX produced 1
// error(s)". The marker has to be legal in every format this runs against.
const lineFor = (leg, n) => `- [${leg}] SYNCDEMO-${n} at ${stamp()}`

/**
 * Whether a surface carries a specific marker -- ANCHORED, not a substring.
 *
 * `text.includes('SYNCDEMO-9')` is satisfied by `SYNCDEMO-99999` left in the
 * document by an earlier run. Markers start at `Date.now() % 100000` and count
 * up, so a short one is a live prefix of a long one and the check passes in 0ms
 * with nothing having synced. Every marker is written followed by ` at `, so
 * requiring that suffix makes the match exact without parsing the line.
 */
function hasMarker(text, marker) {
  return String(text).includes(`${marker} at `)
}

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
  appendIntoDocument(path.join(CHECKOUT, LEG_FILES.disk), line)
  // Nothing else. No commit, no push, no CLI call: the daemon is supposed to
  // notice the edit, settle the tree, and push a proposal on its own. Doing any
  // of that here would be the harness performing the behaviour under test.
}

/**
 * The BROWSER route, driven over the source room's own socket.
 *
 * Not through a browser, deliberately. This used to drive CodeMirror inside a
 * real page, which is fragile in both directions -- it could not reach the
 * EditorView on some builds and reported a working editor as broken -- and it
 * tests the editor rather than the route. Skip's standing rule: reach for a
 * browser only when browser interaction is itself the thing under test.
 *
 * What IS under test is the third way an edit enters a project: a Yjs source
 * room, which the editor talks to and which settles into the same proposal path
 * as everything else. The room speaks JSON frames carrying base64 Yjs updates,
 * so a script can be an editor without pretending to be a person.
 */
async function writeInBrowser(line) {
  const file = LEG_FILES.browser
  const url = `${SERVER.replace(/^http/, 'ws')}/source-sync/${encodeURIComponent(PROJECT)}/${encodeURIComponent(file)}`
  const ws = new WebSocket(url)
  const doc = new Y.Doc()

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`source room sent no sync frame within 30s (${file})`)), 30_000)
    const fail = message => { clearTimeout(timer); try { ws.close() } catch { /* already gone */ } reject(new Error(message)) }
    ws.onerror = event => fail(`source room socket error: ${event?.message || 'unknown'}`)
    ws.onclose = event => { if (!event.wasClean) fail(`source room socket closed: ${event.code} ${event.reason || ''}`.trim()) }
    ws.onmessage = event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message?.type === 'error') { fail(`source room refused: ${message.message}`); return }
      if (message?.type !== 'sync') return
      clearTimeout(timer)
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
      const ytext = doc.getText('source')
      const before = ytext.toString()
      // Same anchor the other legs use, so the line lands inside the document
      // body rather than after \end{document}, where it would sync perfectly
      // and change nothing anyone can see.
      // Same placement as appendIntoDocument: before the marker, inside the
      // document body. A line after \end{document} syncs perfectly and changes
      // nothing anyone can see, which is the failure this demo exists to catch.
      const anchor = before.indexOf(LOG_MARKER)
      const stateBefore = Y.encodeStateVector(doc)
      ytext.insert(anchor >= 0 ? anchor : before.length, `${line}\n\n`)
      ws.send(JSON.stringify({ type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(doc, stateBefore)).toString('base64') }))
      // `flush` is what the editor's save timer does. Without it the room waits
      // for its own debounce and the leg times out against a room that is
      // working perfectly well.
      ws.send(JSON.stringify({ type: 'flush' }))
      setTimeout(() => { try { ws.close() } catch { /* already gone */ } resolve() }, 1000)
    }
  })
}

async function writeOnRemote(line) {
  const file = path.join(REMOTE_CLONE, LEG_FILES.remote)
  // Send the checkout's current state OUT before editing on top of it.
  //
  // Without this the clone edits a stale tree — the app does not push accepted
  // revisions to a linked remote, so the clone never sees anything the daemon
  // committed — and the pull back is then a merge of two lineages that both
  // touched the file. That conflicts, and a conflicted checkout stops the daemon
  // settling ANYTHING: `proposal not accepted: conflicted`, with the disk leg
  // dying alongside it and nothing said anywhere a person would look.
  //
  // Measured: the demo wedged its own project this way and every leg went quiet
  // for twenty minutes while I looked for a network fault that was not there.
  // Force, because this bare repo is a FIXTURE and the checkout is the truth.
  //
  // `tlda project remote push` is the app's verb and it correctly refuses a
  // non-fast-forward — the clone's own earlier pushes are on the fixture and the
  // checkout does not have them. That refusal is right and is not something to
  // work around inside the app; it is the fixture that needs to stop being a
  // second source of history. So the demo realigns its own bare repo directly,
  // and the app's remote verbs are left exercising their real behaviour.
  await git(CHECKOUT, ['push', '--force', REMOTE, `HEAD:refs/heads/tlda/${PROJECT}`])
  await git(REMOTE_CLONE, ['fetch', 'origin'])
  await git(REMOTE_CLONE, ['reset', '--hard', `origin/tlda/${PROJECT}`]).catch(() => {})
  appendIntoDocument(file, line)
  await git(REMOTE_CLONE, ['add', '--', LEG_FILES.remote])
  await git(REMOTE_CLONE, ['commit', '-m', line])
  await git(REMOTE_CLONE, ['push', 'origin', `HEAD:refs/heads/tlda/${PROJECT}`])

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
      if (hasMarker(text, marker)) {
        result[name] = { ms: Date.now() - started }
        pending.delete(name)
      }
    }
    if (pending.size) await sleep(1000)
  }
  // A destination that cannot be read is MISSING, not exempt.
  //
  // `unreadable` used to be its own outcome, and `bad` filtered on `missing`
  // only -- so a surface that never answered at all never entered `pending`,
  // never reached `failures`, and the run exited 0. `parkedText` returns null
  // when the fetched ref does not exist, which is exactly what a browser route
  // that published nothing looks like; `serverText` returns null on any
  // non-2xx. Green that depends on a read failing is not green.
  for (const [name, read] of pending) {
    const text = await read()
    result[name] = { missing: true, unreadable: text === null, ms: Date.now() - started }
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
 * Fetch what the project says it renders, and say whether it is really there.
 *
 * ASKS THE APP, rather than knowing per format. `/files` reports a `documents[]`
 * with an `outputFile` each — `doc.html` for markdown, `paper-page-1.svg` for a
 * LaTeX target — so one check covers every format the app supports and a new
 * format needs nothing here. Encoding "markdown means .html" in this file would
 * be a second copy of a fact the server already states.
 *
 * This is the check the first version lacked, and its absence is why it
 * certified a document nobody could read. A page that 404s comes back as a short
 * JSON error, so "did I get bytes" is not the test — the SIZE is, because a
 * proxy can return 200 with an error document.
 */
async function renderedOutputs() {
  let listing
  try {
    const res = await fetch(api('/files'), { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return { ok: false, reason: `file listing unreadable (HTTP ${res.status})` }
    listing = await res.json()
  } catch (error) { return { ok: false, reason: `file listing unreadable (${error.message})` } }

  const documents = Array.isArray(listing?.documents) ? listing.documents : []
  if (!documents.length) return { ok: false, reason: 'the project reports no documents, so nothing can be rendered' }

  // For a paged format the listing names page 1; the rest come from `targets`,
  // which is where the page count lives. Nothing is invented: a format that
  // declares no pages is simply checked on the one output it names.
  let targets = []
  try {
    const res = await fetch(api(''), { signal: AbortSignal.timeout(30_000) })
    if (res.ok) targets = (await res.json())?.targets || []
  } catch { /* the per-document output below is still checkable without it */ }

  const wanted = []
  for (const doc of documents) {
    const out = String(doc?.outputFile || '')
    if (!out) continue
    const paged = out.match(/^(.*)-page-1\.svg$/)
    if (paged) {
      const pages = Number(targets.find(t => t?.texBase === paged[1])?.pages || 1)
      for (let page = 1; page <= pages; page++) wanted.push(`${paged[1]}-page-${page}.svg`)
    } else {
      wanted.push(out)
    }
  }
  if (!wanted.length) return { ok: false, reason: 'no document declared an output file' }

  const results = []
  for (const file of wanted) {
    const started = Date.now()
    try {
      const res = await fetch(`${SERVER}/docs/${PROJECT}/${file}`, { signal: AbortSignal.timeout(180_000) })
      const body = await res.text()
      results.push({ file, status: res.status, bytes: body.length, ms: Date.now() - started })
    } catch (error) {
      results.push({ file, status: 0, bytes: 0, ms: Date.now() - started, error: error.message })
    }
  }
  const broken = results.filter(r => r.status !== 200 || r.bytes < 1000)
  const slowest = results.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null)
  return { ok: broken.length === 0, total: results.length, broken, slowestMs: slowest?.ms ?? null, slowestFile: slowest?.file ?? null }
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
  fs.mkdirSync(FIXTURES, { recursive: true })

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
  // Seed the branch `tlda project remote pull` actually fetches.
  //
  // It fetches `refs/heads/tlda/<project>` — the work branch — and seeding
  // `main` instead left the pull failing with "couldn't find remote ref
  // refs/heads/tlda/<project>", which reads as a broken remote rather than a
  // fixture that put the commits under the wrong name.
  const workBranch = `tlda/${PROJECT}`
  const bareHasBranch = await git(REMOTE, ['rev-parse', '--verify', `refs/heads/${workBranch}`]).then(() => true).catch(() => false)
  if (!bareHasBranch) {
    await git(CHECKOUT, ['push', REMOTE, `HEAD:refs/heads/${workBranch}`])
    console.log(`  seeded remote with ${workBranch} from the checkout`)
  }

  if (!fs.existsSync(path.join(REMOTE_CLONE, '.git'))) {
    await git(FIXTURES, ['clone', REMOTE, REMOTE_CLONE])
    await git(REMOTE_CLONE, ['config', 'user.email', 'sync-demo@tlda']).catch(() => {})
    await git(REMOTE_CLONE, ['config', 'user.name', 'sync demo']).catch(() => {})
    console.log(`  remote clone     ${REMOTE_CLONE}`)
  }

  console.log(`\nOpen it: ${SERVER}/?project=${PROJECT}`)
}

// ---------------------------------------------------------------------------
// Mount the editor in the pooled tab, once
// ---------------------------------------------------------------------------


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
// This said "remote is polled every 60s, so that leg's floor is one poll" and
// that was wrong twice over, so it is worth stating what is actually true.
//
// The daemon does poll a linked remote on a 60s timer -- but only when the
// BINDING carries a `remote`, which this project's does not, and `writeOnRemote`
// does not wait for it either way: it calls `tlda project remote pull`. So the
// remote leg here is triggered, not polled, and its timings are directly
// comparable to disk. Measured over nine cycles: disk 8.5-12s, remote 8.5-10.2s.
//
// The wrong label was committed for an hour and handed to another agent as an
// explanation for a gap that no longer existed once both build slots were free.
if (LEGS.includes('remote')) {
  console.log(`          remote is pulled explicitly by this demo, not polled -- both legs are directly comparable`)
}

// Preconditions, each because its absence looks exactly like a leg that does
// not work.
const project = await fetch(api(''), { signal: AbortSignal.timeout(90_000) }).then(r => r.ok).catch(() => null)
assert.ok(
  project !== null,
  `${SERVER} did not answer at all. That is the server, not sync — nothing below would mean anything.`,
)
assert.ok(project, `${PROJECT} does not exist on ${SERVER}. Run: node bin/sync-demo.mjs --setup`)
assert.ok(fs.existsSync(path.join(CHECKOUT, FILE)), `no demo checkout at ${CHECKOUT}. Run: node bin/sync-demo.mjs --setup`)

// NO BROWSER IS LAUNCHED ANY MORE, and that is a fix rather than a shortcut.
//
// This used to open a page and drive CodeMirror. Two costs, both real: driving a
// browser at a project writes SIX fleet shapes into that project's room per
// launch, so the demo polluted the very project it was demonstrating on every
// run; and it tested the editor rather than the route, reporting a working
// editor as broken whenever the EditorView was not reachable from the DOM.
//
// The browser leg now speaks the source room's protocol directly, which is the
// route. Skip's rule: reach for a browser only when browser interaction is
// itself the thing under test.

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
// Markers that reached the server and must never leave it again.
let witnessed = []
const unrun = []
// Markers that missed the window, re-checked on later cycles.
//
// A timeout is not a loss, and reporting it as one is the same instrument
// dishonesty this file exists to catch — measured here: an edit reported
/**
 * The daemon's last recorded admission for this project, or null.
 *
 * Reads the daemon's own log rather than asking the server, because the point
 * is to attribute a failure when the server is the suspect. The environment is
 * in the filename and this demo does not know which environment its daemon
 * runs in, so it takes whichever log actually mentions this project -- and
 * returns null rather than guessing when none does.
 */
function lastAdmission() {
  try {
    const dir = path.join(os.homedir(), '.config', 'tlda')
    const logs = fs.readdirSync(dir)
      .filter(name => /^fleet-daemon.*\.log$/.test(name))
      .map(name => path.join(dir, name))
    let best = null
    for (const file of logs) {
      // The line shape is fixed by the daemon; anchor on the project so another
      // project's admission can never be reported as this one's.
      const pattern = new RegExp(`^(\\S+) .*${PROJECT}: proposal admission confirmed id=(\\d+) state=(\\w+)`)
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = pattern.exec(line)
        if (!match) continue
        const at = Date.parse(match[1])
        if (!Number.isFinite(at)) continue
        if (!best || at > best.at) best = { at, id: match[2], state: match[3] }
      }
    }
    if (!best) return null
    return { ...best, age: Math.round((Date.now() - best.at) / 1000) }
  } catch {
    return null
  }
}

// "NEVER ARRIVED" at 300s was on the server when looked at again. Late and lost
// are different facts and only one of them is a defect in sync. Late is still
// worth printing, because "or if they do get there, they're old" is half the
// complaint this demo answers.
const pending = []

for (let cycle = 0; cycle < CYCLES; cycle++) {
  // Anything that missed its window: did it turn up since?
  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index]
    const text = await item.read()
    if (text !== null && String(text).includes(item.marker)) {
      const late = ((Date.now() - item.since) / 1000).toFixed(0)
      console.log(`LATE     ${item.marker.padEnd(16)} ${item.leg} → ${item.destination} arrived, ${late}s after it was given up on`)
      pending.splice(index, 1)
    }
  }

  // EVERY ROUTE WRITES AT THE SAME TIME.
  //
  // This used to write one route, wait up to 90s for it to land everywhere, then
  // write the next. Putting them on one file was necessary and not sufficient:
  // strict serialization meant two writers still never overlapped in time, so a
  // conflict between routes remained a state the demo could not reach. Skip's
  // standard is a real editing session -- him and a collaborator in one document
  // -- and that is overlap, not turn-taking. Caught by my advocate.
  //
  // So the writes go out together and convergence is judged afterwards. If they
  // collide, that is the finding: it is what happens to two real people.
  const plans = LEGS.map(leg => {
    n += 1
    const legFile = LEG_FILES[leg]
    const destinations = {}
    destinations.server = () => serverText(legFile)
    // The remote leg pulls explicitly, so its working file really does move.
    // A browser edit is published server-side and parked, so its arrival is the
    // parked revision -- not the file on disk.
    if (leg === 'remote') destinations.checkout = () => checkoutText(legFile)
    if (leg === 'browser') destinations.parked = () => parkedText(legFile)
    // The linked remote is a SOURCE here, never a destination. Nothing pushes
    // an accepted revision back out to it unless the binding asks for a mirror,
    // so expecting a disk or browser edit to appear there was the harness
    // asking for behaviour the app does not claim.
    return { leg, marker: `SYNCDEMO-${n}`, line: lineFor(leg, n), destinations }
  })

  const beforeTip = LEGS.includes('disk') ? (await branchState()).tip : null
  const editedAt = Date.now()
  const outcomes = await Promise.allSettled(plans.map(plan => WRITERS[plan.leg](plan.line)))
  const written = []
  for (const [at, plan] of plans.entries()) {
    if (outcomes[at].status === 'fulfilled') { written.push(plan); continue }
    const error = outcomes[at].reason
    const message = error?.message || String(error)
    console.log(`${plan.leg.padEnd(8)} ${plan.marker.padEnd(8)} COULD NOT WRITE — ${message}`)
    // A leg that could not write is NOT a pass. Tracked apart from convergence
    // failures because they mean opposite things: a convergence failure is the
    // app losing an edit, this is the harness never having made one.
    unrun.push(`${plan.leg}: ${message.split('\n')[0]}`)
  }

  for (const { leg, marker, destinations } of written) {

    // `editedAt` and `beforeTip` are from before the concurrent write phase, so
    // the admission check can still tell an admission of THIS cycle from an
    // older one, and the disk branch check still has a tip to compare against.
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
    // Only markers that DID arrive are worth watching for loss. One that never
    // arrived is already a failure and would otherwise be reported twice.
    if (result.server && !result.server.missing) witnessed.push({ marker, leg })
    const bad = Object.entries(result).filter(([, r]) => r.missing)
    console.log(`${leg.padEnd(8)} ${marker.padEnd(8)} ${parts.join('   ')}`)
    // NEVER ARRIVED says the text is not there. It does not say which half of
    // the path stopped, and those two failures need opposite responses: an edit
    // that was never admitted is a daemon or checkout problem, and an edit that
    // was admitted and never built is a server-side build queue problem. On
    // 2026-08-25 the second one presented as the first for most of a night --
    // the daemon log said `admission confirmed` for a revision that then sat
    // pending for 35 minutes behind a build worker stuck in state T.
    //
    // So say which, from the daemon's own record, at the moment it goes bad.
    // Only the SERVER destination can be explained by an admission. Saying "the
    // edit did not reach the server" about a leg whose server hop SUCCEEDED and
    // whose checkout hop failed is a false statement about the wrong half --
    // which is what it printed the first time the browser leg ran.
    if (bad.some(([name]) => name === 'server')) {
      const admitted = lastAdmission()
      // An admission OLDER than this edit says nothing about this edit, and
      // reporting it as though it did is the exact mistake this line exists to
      // stop someone else making.
      console.log(admitted && admitted.at >= editedAt
        ? `         admitted id=${admitted.id} state=${admitted.state} -- the edit reached the server; it is not built`
        : admitted
          ? `         nothing admitted since this edit (last was ${admitted.age}s ago, id=${admitted.id}) -- the edit did not reach the server`
          : `         no admission ever recorded for ${PROJECT} -- the edit did not reach the server`)
    }
    for (const [name] of bad) {
      pending.push({ leg, destination: name, marker, since: Date.now(), read: destinations[name] })
    }
  }

  // NOTHING THAT ARRIVED MAY GO MISSING.
  //
  // Every check above asks "did MY line arrive". None of them asks whether the
  // lines already there survived. So a route whose write clobbers an earlier
  // one -- a stale Yjs room overwriting the file, a merge dropping a side, a
  // revision published from a partial tree -- passes every per-line check while
  // destroying the document. That is the failure this whole demo exists for,
  // and it was the one thing not being measured.
  //
  // Cheap, because the data is already here: every marker written this run must
  // still be on the server. One that was present and is now gone is a hard
  // failure, and it names the leg that wrote it so the loss is attributable.
  const serverNow = await serverText(LEG_FILES.disk)
  if (serverNow === null) {
    failures.push('the server copy could not be read, so loss could not be checked')
  } else {
    const lost = witnessed.filter(entry => !hasMarker(serverNow, entry.marker))
    for (const entry of lost) {
      failures.push(`${entry.marker} (written by ${entry.leg}) ARRIVED AND IS NOW GONE from the server copy`)
    }
    // Stop re-reporting a line already counted as lost.
    witnessed = witnessed.filter(entry => !lost.includes(entry))
  }

  const versions = await versionCount()
  if (versions !== null && startingVersions !== null) {
    console.log(`         versions ${startingVersions} → ${versions}`)
  }

  // The check the first version of this file did not have. Bytes arriving is
  // not the product; a page a person can see is.
  const rendered = await renderedOutputs()
  if (!rendered.ok && rendered.reason) {
    failures.push(`pages: ${rendered.reason}`)
    console.log(`         pages   COULD NOT CHECK — ${rendered.reason}`)
  } else if (!rendered.ok) {
    const sample = rendered.broken.slice(0, 3)
      .map(b => `${b.file} ${b.status} ${b.bytes}b`).join(', ')
    failures.push(`pages: ${rendered.broken.length} of ${rendered.total} do not render (${sample})`)
    console.log(`         pages   ${rendered.broken.length}/${rendered.total} BROKEN — ${sample}`)
  } else {
    console.log(`         output  ${rendered.total}/${rendered.total} render, slowest ${rendered.slowestFile} ${(rendered.slowestMs / 1000).toFixed(1)}s`)
  }

  if (cycle + 1 < CYCLES) await sleep(EVERY_MS)
}

for (const item of pending) {
  failures.push(`${item.leg} → ${item.destination}: ${item.marker} still absent ${((Date.now() - item.since) / 1000).toFixed(0)}s after the window closed`)
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
