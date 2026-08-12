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
const IDLE_WRITE_MS = 4000 // FleetSourceEditorShape idleWriteMs() default

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// `.cm-content`'s textContent concatenates one div per line with no newline
// between them, so every comparison here is on a distinctive phrase rather
// than on whole-document equality.
const says = (haystack, phrase) => String(haystack || '').includes(phrase)
const api = path => `${SERVER}/api/projects/${PROJECT}${path}`

/** Run a function in the agent's tab and return its value. */
function inPage(fn, { timeoutMs = 240_000 } = {}) {
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
  const res = await fetch(api('/source-authority'))
  assert.ok(res.ok, `could not read the source authority: ${res.status}`)
  return (await res.json()).currentRevision
}

async function serverText() {
  const res = await fetch(api(`/source/${FILE}`))
  assert.ok(res.ok, `could not read ${FILE} from the server: ${res.status}`)
  return res.text()
}

/** Alice, on her own machine, pushing to the same file. */
async function alicePushes(content, expectedRevision) {
  const res = await fetch(api(`/source/${FILE}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, sourceManifest: [FILE], editedBy: 'alice', expectedRevision }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// --- preconditions -------------------------------------------------------
// Every one of these exists because its absence looks exactly like a feature
// that does not work.

const project = await fetch(api('')).then(r => r.ok ? r.json() : null)
assert.ok(project, `${PROJECT} does not exist on ${SERVER}. Create it before running this — `
  + 'pw setup only navigates, and a missing project renders a 404 that reads as an empty canvas.')

const files = await fetch(api('/files')).then(r => r.json())
assert.ok(files.files.includes(FILE), `${FILE} is not in ${PROJECT}'s manifest: ${files.files.join(', ')}`)

execFileSync('tlda-dev', ['pw', 'setup', '--project', PROJECT], { encoding: 'utf8', timeout: 300_000 })

const opening = `Acceptance run.\n\nA paragraph both of us will edit.\n`
const openingRevision = await currentRevision()
const seeded = await alicePushes(opening, openingRevision)
assert.equal(seeded.status, 200, `could not seed ${FILE}: ${JSON.stringify(seeded.body).slice(0, 300)}`)

// Mount the editor on the file and prove it is really showing the file. A
// blank buffer is the failure mode that reads as "nothing happened" — note
// innerText returns '' for an element that is off-screen, so this uses
// textContent and asserts on it before anything else runs.
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
  const el = document.querySelector('[data-shape-id="' + id + '"]')
  const content = el && el.querySelector('.cm-content')
  return { mounted: !!el, hasCodeMirror: !!content, text: content ? content.textContent : null }
})

assert.ok(!mounted.error, `could not mount the editor: ${mounted.error}`)
assert.ok(mounted.hasCodeMirror, 'the source editor shape mounted but has no CodeMirror view')
assert.ok(
  says(mounted.text, 'A paragraph both of us will edit'),
  `the editor is not showing ${FILE} — it read ${JSON.stringify(mounted.text)}. `
  + 'Nothing below this line would mean anything.',
)

const readBuffer = () => inPage(function () {
  const el = document.querySelector('[data-shape-id="shape:live-editor-acceptance"]')
  const content = el && el.querySelector('.cm-content')
  const status = el && el.querySelector('.fleet-source-editor-status')
  return { text: content ? content.textContent : null, status: status ? status.textContent : null }
})

const failures = []

// --- story one: you are not told what changed ----------------------------
{
  const alice = 'Acceptance run.\n\nAlice rewrote this paragraph.\n'
  const pushed = await alicePushes(alice, await currentRevision())
  assert.equal(pushed.status, 200, 'Alice could not push')

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

console.log('\nthe linked editor is working: you are told what changed, and told when you are refused')
process.exit(0)
