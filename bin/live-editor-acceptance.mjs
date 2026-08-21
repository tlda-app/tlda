#!/usr/bin/env node
// Acceptance story for the linked source editor. FAILS ON MAIN BY DESIGN.
//
// Not named `-test.mjs`: it needs the shared browser pool and the live server,
// so bin/run-test-suite.mjs must not pick it up.
//
//   node bin/live-editor-acceptance.mjs
//
// Setup it assumes, and checks rather than trusts:
//   - the project `sync-editor-race-probe` exists on the configured server,
//     with `notes.md` in its manifest. `tlda-dev pw setup --project NAME` only
//     navigates; it does not create anything, and against a name that does not
//     exist it renders a correct 404 that reads as an empty canvas.
//   - a browser tab is available in this agent's pool slot.
//
// ---------------------------------------------------------------------------
// The two stories, both about the same missing thing
//
// **One: you are not told what changed.** You have main.tex open. Alice's
// daemon pushes to it. Your editor never hears — the source editor shape
// subscribes to nothing; `onSourceChangedSignal` exists in src/useYjsSync.ts
// and the shape never calls it — so your buffer still shows the old text and
// your next save goes up against a revision the server left behind.
//
// **Two: you are not told you were refused.** You finish a sentence and it
// saves. Before the answer comes back you type another word. Alice's daemon
// pushes to the same file. The server answers *stale, here is the conflict* —
// and `writeSource` returns early because `seq !== saveSeqRef.current`
// (FleetSourceEditorShape.tsx), so the conflict is discarded with the rest of
// the response. You see nothing.
//
// Story one is deterministic. Story two is a race, and a race that does not
// reproduce proves nothing — so story two reports what it observed and only
// fails on an outcome that cannot be explained by losing the race.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'

import { getServerUrl } from '../shared/config.mjs'

const PROJECT = 'sync-editor-race-probe'
const FILE = 'notes.md'
const SHAPE = 'shape:live-editor-acceptance'
const SERVER = getServerUrl().replace(/\/$/, '')
console.log(`server: ${SERVER}`)
const IDLE_WRITE_MS = 4000 // FleetSourceEditorShape idleWriteMs() default

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// `.cm-content`'s textContent concatenates one div per line with no newline
// between them, so every comparison here is on a distinctive phrase rather
// than on whole-document equality.
const says = (haystack, phrase) => String(haystack || '').includes(phrase)
const api = path => `${SERVER}/api/projects/${PROJECT}${path}`

/** Run a function in the agent's tab and return its value. */
// 10 minutes, and that is not paranoia: the pool serialises on a lock, so an
// eval that returns in milliseconds can sit behind another agent's turn for
// minutes. A 4-minute limit SIGTERM'd a healthy run tonight.
function inPage(fn, { timeoutMs = 600_000 } = {}) {
  const out = execFileSync('tlda-dev', ['pw', 'eval', fn.toString()], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  })
  const start = out.indexOf('### Result')
  if (start === -1) throw new Error(`pw eval returned no result:\n${out.slice(0, 800)}`)
  const body = out.slice(start + '### Result'.length)
  const end = body.indexOf('### Ran Playwright code')
  const json = (end === -1 ? body : body.slice(0, end)).trim()
  try { return JSON.parse(json) } catch { return json }
}

async function currentRevision() {
  const res = await fetch(api('/source-head'))
  assert.ok(res.ok, `could not read the source head: ${res.status}`)
  return (await res.json()).revision
}

async function serverText() {
  const res = await fetch(api(`/source/${FILE}`))
  assert.ok(res.ok, `could not read ${FILE} from the server: ${res.status}`)
  return res.text()
}

/** Alice, on her own machine, pushing to the same file.
 *
 * The JSON accept carrier, not the retired `PUT /source/:file`. That handler
 * was a thin wrapper that turned one file into `files: [{path, content}]` and
 * called the old push, so the translation here is the one it used to do. The
 * stories above are unchanged: what this exercises is still a second machine
 * pushing to the file you have open. */
async function alicePushes(content, expectedRevision) {
  const res = await fetch(api('/source-room/files'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ path: FILE, content }],
      sourceManifest: [FILE], editedBy: 'alice', expectedRevision,
    }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// --- preconditions -------------------------------------------------------
// Every one of these exists because its absence looks exactly like a feature
// that does not work.

// Retry, and say which of the two things went wrong. A single unretried fetch
// against a cold-starting Fly box comes back as a transport error, and
// reporting that as "the project does not exist" is a confident falsehood —
// the same mistake as reading an unmounted view as a missing feature. The
// project really was there when this fired tonight.
async function getJson(url, { tries = 4 } = {}) {
  let last = null
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
      if (res.ok) return { ok: true, body: await res.json() }
      if (res.status === 404) return { ok: false, notFound: true, status: 404 }
      last = `HTTP ${res.status}`
    } catch (e) {
      last = e.message
    }
    if (attempt < tries) await sleep(attempt * 5_000)
  }
  return { ok: false, unreachable: last }
}

const project = await getJson(api(''))
assert.ok(
  !project.unreachable,
  `${SERVER} did not answer for ${PROJECT} after 4 tries (${project.unreachable}). `
  + 'That is the server, not the project — a cold Fly box takes about 90s. Nothing is proven either way.',
)
assert.ok(
  project.ok,
  `${PROJECT} does not exist on ${SERVER}. That server is chosen by the environment, not by\n`
  + `    this script — the probe project lives on testing, so run it as TLDA_ENV=testing if you\n`
  + '    are pointed at stable. If you are already on testing, create the project first: pw setup\n'
  + '    only navigates, and a missing project renders a 404 that reads as an empty canvas.',
)

const files = await getJson(api('/files'))
assert.ok(files.ok, `could not read ${PROJECT}'s file list: ${files.unreachable || files.status}`)
assert.ok(files.body.files.includes(FILE), `${FILE} is not in ${PROJECT}'s manifest: ${files.body.files.join(', ')}`)

// The browser loads the DEPLOYED bundle, not this checkout. A red run against a
// bundle that does not contain the room means "not deployed yet" and nothing
// about the wiring — so feature-detect the served JavaScript rather than
// trusting a sha, and refuse to draw a conclusion instead of drawing a wrong
// one. (Inspect the bundle named by the served index.html; other bundles and
// source maps are not proof of what the browser loads.)
const indexHtml = await fetch(SERVER, { signal: AbortSignal.timeout(90_000) }).then(r => r.text())
const bundlePath = (indexHtml.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0]
assert.ok(bundlePath, `could not find the app bundle in the served index.html at ${SERVER}`)
const bundle = await fetch(`${SERVER}${bundlePath}`, { signal: AbortSignal.timeout(180_000) }).then(r => r.text())
const buildInfo = await getJson(`${SERVER}/api/build-info`)
const deployedSha = buildInfo.ok ? String(buildInfo.body.gitSha || '').slice(0, 9) : 'unknown'
assert.ok(
  bundle.includes('source-sync'),
  `The deployed bundle (${bundlePath}, sha ${deployedSha}) has no source-room client in it.\n`
  + '    This run cannot answer whether the editor receives changes: a failure would mean\n'
  + '    "not deployed", not "the wiring is incomplete". Deploy the room and run it again.',
)

// The bundle check above proves a room client is there. It cannot say WHICH
// one — a bundle built an hour ago still contains `source-sync`. So name the
// deployed sha and the room commits inside it, and print them, so a green is
// green against something specific rather than against "a room".
//
// Matched by message, not by ancestry: main is built by cherry-pick here, so
// `merge-base --is-ancestor` false-negatives on landed work. A sha this
// checkout has never seen is reported as unknown rather than treated as a
// failure — that is a fact about my clone, not about the deploy.
if (buildInfo.ok && deployedSha !== 'unknown') {
  let roomCommits = null
  try {
    roomCommits = execFileSync('git', ['log', '--oneline', '-i', '--grep=source room', deployedSha], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Deliberately swallowed: `git log` on a sha this clone has never fetched
    // exits non-zero, and that is a fact about my checkout rather than about
    // the deploy. Reporting it as a failure would block a run for a reason
    // that has nothing to do with what is served. roomCommits stays null and
    // the block below is skipped.
    console.log(`deployed sha ${deployedSha} is not in this checkout — cannot name the room it was built from`)
  }
  if (roomCommits !== null) {
    console.log(`deployed sha ${deployedSha}; room commits in its history:`)
    for (const line of (roomCommits ? roomCommits.split('\n') : ['  (none by message)'])) console.log(`  ${line}`)
    assert.ok(
      roomCommits,
      `The served bundle contains a source-room client, but ${deployedSha} has no commit whose\n`
      + '    message names the source room. Either it was built from something this checkout has\n'
      + '    not seen, or the bundle and the server disagree. Either way a result here would be\n'
      + '    green against an unknown room.',
    )
  }
}

execFileSync('tlda-dev', ['pw', 'setup', '--project', PROJECT], { encoding: 'utf8', timeout: 300_000 })

const opening = `Acceptance run.\n\nA paragraph both of us will edit.\n`
const openingRevision = await currentRevision()
const seeded = await alicePushes(opening, openingRevision)
assert.equal(seeded.status, 200, `could not seed ${FILE}: ${JSON.stringify(seeded.body).slice(0, 300)}`)

// Mount the editor on the file and prove it is really showing the file. A
// blank buffer is the failure mode that reads as "nothing happened" — note
// innerText returns '' for an element that is off-screen, so this uses
// textContent and asserts on it before anything else runs.
// Before anything is read from the page, establish that there is a page. A
// parked tab on about:blank answers every question with a well-formed zero —
// no HUD, no shapes, no CodeMirror — and that reads exactly like an app in
// which nothing works. This cost a false finding tonight: `hudOpen: false`
// from a blank tab, reported as "the pool runs with the HUD closed" when the
// pool actually lands HUD-open, which is Skip's configuration.
const pageState = inPage(function () {
  const ed = window.__tldraw_editor__
  return {
    url: location.href,
    hasEditor: !!ed,
    shapes: ed ? ed.getCurrentPageShapes().length : 0,
    hudOpen: document.body.classList.contains('fleet-hud-open'),
    hudWraps: document.querySelectorAll('.fleet-hud-wrap').length,
  }
})
assert.ok(
  pageState.hasEditor && !/^about:/.test(pageState.url),
  `The tab is not on the app — url ${JSON.stringify(pageState.url)}, editor `
  + `${pageState.hasEditor ? 'present' : 'absent'}. A parked tab answers every question with a\n`
  + '    well-formed zero, and nothing below could tell that apart from a broken app.',
)
// Recorded every run, because how many times the editor renders is part of
// what is being measured: the HUD is a second viewport over the same store, so
// with it open each shape renders twice, each copy with its own CodeMirror.
console.log(`page: ${pageState.shapes} shapes, HUD ${pageState.hudOpen ? 'OPEN' : 'closed'} `
  + `(${pageState.hudWraps} wrap${pageState.hudWraps === 1 ? '' : 's'})`)

const mounted = inPage(function () {
  const ed = window.__tldraw_editor__
  if (!ed) return { error: 'no tldraw editor on window' }
  const id = 'shape:live-editor-acceptance'
  if (!ed.getShape(id)) {
    const peer = ed.getCurrentPageShapes().find(s => s.type === 'fleet-chat')
    if (!peer) return { error: 'no fleet-chat shape to borrow identity and position from' }
    const bounds = ed.getShapePageBounds(peer.id)
    ed.createShape({
      id, type: 'fleet-source-editor', x: bounds.x, y: bounds.y + bounds.h + 40,
      props: { w: 640, h: 520, file: 'notes.md', line: 1, title: 'Source', userId: peer.props.userId, deviceId: peer.props.deviceId },
    })
  }
  ed.zoomToBounds(ed.getShapePageBounds(id), { inset: 60 })
  // Creating the shape and reading it in the same turn finds a mounted element
  // with no CodeMirror in it: React has not rendered yet, and the editor then
  // has to fetch the file. Both are asynchronous, so wait for the view and for
  // the text rather than sampling once and calling it broken.
  return new Promise(resolve => {
    const started = Date.now()
    const poll = setInterval(() => {
      const el = document.querySelector('[data-shape-id="' + id + '"]')
      const content = el && el.querySelector('.cm-content')
      const text = content ? content.textContent : null
      if (text) {
        clearInterval(poll)
        resolve({ mounted: true, hasCodeMirror: true, text, waitedMs: Date.now() - started })
      } else if (Date.now() - started > 30000) {
        clearInterval(poll)
        resolve({ mounted: !!el, hasCodeMirror: !!content, text, waitedMs: Date.now() - started })
      }
    }, 250)
  })
})

assert.ok(!mounted.error, `could not mount the editor: ${mounted.error}`)
assert.ok(mounted.hasCodeMirror, `the source editor shape mounted but has no CodeMirror view after ${mounted.waitedMs}ms`)
assert.ok(
  says(mounted.text, 'A paragraph both of us will edit'),
  `the editor is not showing ${FILE} — it read ${JSON.stringify(mounted.text)}. `
  + 'Nothing below this line would mean anything.',
)

// Reads every rendered copy, not the first. With the HUD open the shape exists
// twice and `querySelector` would silently pick one of them — which is the
// difference between "the editor was told" and "one of the two editors was
// told", and only the second is a real answer.
const readBuffer = () => inPage(function () {
  const els = [...document.querySelectorAll('[data-shape-id="shape:live-editor-acceptance"]')]
  const copies = els.map(el => {
    const content = el.querySelector('.cm-content')
    const status = el.querySelector('.fleet-source-editor-status')
    return { text: content ? content.textContent : null, status: status ? status.textContent : null }
  })
  return { copies, text: copies.map(c => c.text).join(' | '), status: copies.map(c => c.status).join(' | ') }
})

const failures = []
let storyOnePassed = false
let storyTwoOutcome = 'did not run'

// --- story one: you are not told what changed ----------------------------
{
  const alice = 'Acceptance run.\n\nAlice rewrote this paragraph.\n'
  const pushed = await alicePushes(alice, await currentRevision())
  assert.equal(pushed.status, 200, 'Alice could not push')
  // A 200 is the outcome of the thing that produced the state, not the state.
  // Tonight the CLI printed 1/10, exited 0, and reported success on a push the
  // server had rejected — so read the file back and let the server say what it
  // holds. Otherwise a lying success sets up a red that blames the editor for
  // never being told about a change that never landed.
  assert.ok(
    says(await serverText(), 'Alice rewrote this paragraph'),
    `Alice's push answered 200 and ${FILE} on the server does not contain her text. `
    + 'Nothing below could tell "the editor was not told" apart from "there was nothing to tell".',
  )

  // Generous: this is not a race. If the editor has any receive path at all,
  // ten seconds is plenty.
  await sleep(10_000)
  const buffer = readBuffer()

  if (!says(buffer.text, 'Alice rewrote this paragraph')) {
    failures.push(
      'STORY ONE — the editor was never told.\n'
      + `    Alice pushed to ${FILE} ten seconds ago and the open editor still shows:\n`
      + `      ${JSON.stringify((buffer.text || '').slice(0, 120))}\n`
      + '    The person is looking at text the server has already replaced, and their\n'
      + '    next save will claim a revision the server left behind.',
    )
  }
}

// --- story two: you are not told you were refused ------------------------
{
  // Put the editor back on a known base by reloading it onto current content,
  // so the race below is the only thing being measured.
  const base = 'Acceptance run.\n\nA paragraph both of us will edit.\n'
  await alicePushes(base, await currentRevision())
  await sleep(3_000)

  const raced = inPage(function () {
    const el = document.querySelector('[data-shape-id="shape:live-editor-acceptance"]')
    const content = el && el.querySelector('.cm-content')
    if (!content) return { error: 'no CodeMirror view' }
    // CodeMirror's own transaction path: the update listener fires and the
    // idle timer arms exactly as it does for a keystroke. There is no
    // interaction gate between that listener and the write — the checks are
    // docChanged, equality with the saved text, and the conflict hold.
    const view = (content.cmView && content.cmView.view)
      || (content.cmTile && content.cmTile.view)
      || (window.__source_editor_view__ || null)
    if (!view) return { unreachable: true }
    const type = text => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    const statusNow = () => {
      const s = el.querySelector('.fleet-source-editor-status')
      return s ? s.textContent : null
    }
    const seen = []
    type('Acceptance run.\n\nBob is most of the way through a sentence.\n')
    return new Promise(resolve => {
      const started = Date.now()
      const tick = setInterval(() => {
        seen.push(statusNow())
        // The moment the save is in flight, type again. That bumps
        // saveSeqRef, and the response that comes back is discarded.
        if (String(statusNow() || '').toLowerCase().includes('syncing')) {
          type('Acceptance run.\n\nBob is most of the way through a sentence and then some.\n')
          clearInterval(tick)
          setTimeout(() => resolve({ seen, raced: true, final: statusNow(), text: content.textContent }), 12_000)
        } else if (Date.now() - started > 20_000) {
          clearInterval(tick)
          resolve({ seen, raced: false, final: statusNow(), text: content.textContent })
        }
      }, 120)
    })
  })

  if (raced.unreachable) {
    console.log('STORY TWO — SKIPPED. The EditorView is not reachable from the DOM on this build\n'
      + '    (no `cmView` on .cm-content or .cm-editor), and the race cannot be driven from\n'
      + '    outside the page: the window between the save going out and its answer coming\n'
      + '    back is a few hundred milliseconds, and every `tlda-dev pw` verb is a separate\n'
      + '    process. Real keystrokes via `pw click` + `pw type` are real input but cannot be\n'
      + '    timed finely enough.\n'
      + '    To turn this on, expose the view (e.g. `window.__source_editor_view__`) from the\n'
      + '    shape, or land the room and let this assert on the room instead.')
  } else {

  const server = await serverText()
  const editorClaimsSynced = String(raced.final || '').toLowerCase().includes('sync')
    && !String(raced.final || '').toLowerCase().includes('conflict')
  const editorHasBobsText = says(raced.text, 'and then some')
  const serverHasBobsText = says(server, 'and then some')

  if (!raced.raced) {
    storyTwoOutcome = 'did not reproduce the race'
    console.log('STORY TWO — did not observe the save in flight, so the race never ran. '
      + `Statuses seen: ${JSON.stringify(raced.seen.filter(Boolean).slice(0, 8))}. Not counted either way.`)
  } else if (editorHasBobsText && !serverHasBobsText && editorClaimsSynced) {
    failures.push(
      'STORY TWO — the editor believes it saved and the server does not have the text.\n'
      + `    Editor status: ${JSON.stringify(raced.final)}\n`
      + `    Editor buffer has Bob's last words, the server does not.\n`
      + '    This is the superseded response being discarded: the person is looking at\n'
      + '    a buffer that says it is safe, and it is not on the server.',
    )
  } else {
    storyTwoOutcome = 'ran and converged'
    console.log(`STORY TWO — ran, and converged. Editor status ${JSON.stringify(raced.final)}; `
      + `server ${serverHasBobsText ? 'has' : 'does not have'} the final text. `
      + 'Recorded, not counted as a failure.')
  }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} acceptance ${failures.length === 1 ? 'story fails' : 'stories fail'} — this is the current product:\n`)
  for (const failure of failures) console.error(`  ${failure}\n`)
  process.exit(1)
}

// Names only what ran. The fixed line this replaces claimed "told what changed,
// and told when you are refused" on the verdict run, where story two had
// skipped — an overclaim in the one sentence a person is most likely to quote.
console.log(`\nno acceptance story failed. STORY ONE ${storyOnePassed ? 'passed' : 'did not run'}; STORY TWO ${storyTwoOutcome}.`)
process.exit(0)
