/**
 * Two people edit the same line: one in the browser (source room), one on disk.
 * Does the app publish a document with conflict markers in it?
 *
 * The timing sweep in room-conflict-repro.mjs found a boundary but the wrong
 * failure -- at a zero gap the disk write is LOST, and no conflict appears. The
 * conflicted text captured from the real project points elsewhere: the canary
 * sat on the `accepted server source` side of the hunk, so the ROOM held the
 * older text when the edit arrived. That is not a race, it is two sides having
 * changed the same region relative to their common base.
 *
 * So this makes both sides change the SAME line, which is the case Skip names
 * as the standard -- a real editing session with two people in it.
 *
 * Disposable project only.
 */
import fs from 'fs'
import * as Y from 'yjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const HOST = 'tlda-fly.cormorant-matrix.ts.net'
const PROJECT = 'sync-rootless'
const DIR = '/Users/skip/worktrees/sync-rootless'
const FILE = 'doc.md'
const PATH = `${DIR}/${FILE}`
const CONFLICTED = /<<<<<<<|>>>>>>>/

const sleep = ms => new Promise(r => setTimeout(r, ms))
const BASE = '# rootless\n\nalpha\nbravo\ncharlie\n'

async function serverText() {
  const res = await fetch(`https://${HOST}/api/projects/${PROJECT}/source/${FILE}`, { signal: AbortSignal.timeout(30_000) })
  return res.ok ? await res.text() : null
}

async function waitForServer(predicate, capMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < capMs) {
    await sleep(3000)
    const text = await serverText()
    if (text !== null && predicate(text)) return Math.round((Date.now() - started) / 1000)
  }
  return null
}

/** Connect, hand the room's text to `edit`, send the delta, flush, stay open. */
function roomSession(edit) {
  return new Promise(resolve => {
    const ws = new WebSocket(`wss://${HOST}/source-sync/${PROJECT}/${FILE}`)
    const doc = new Y.Doc()
    const timer = setTimeout(() => resolve({ ws: null, before: null }), 30_000)
    ws.onerror = () => { clearTimeout(timer); resolve({ ws: null, before: null }) }
    ws.onmessage = event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message?.type !== 'sync') return
      clearTimeout(timer)
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
      const ytext = doc.getText('source')
      const before = ytext.toString()
      if (edit) {
        const sv = Y.encodeStateVector(doc)
        const next = edit(before)
        doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, next) })
        ws.send(JSON.stringify({ type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(doc, sv)).toString('base64') }))
        ws.send(JSON.stringify({ type: 'flush' }))
      }
      setTimeout(() => resolve({ ws, before }), 1500)
    }
  })
}

// --- establish a multi-line baseline everywhere -----------------------------
fs.writeFileSync(PATH, BASE)
const settled = await waitForServer(t => t === BASE)
console.log(JSON.stringify({ step: 'baseline', diskEqualsServer: settled !== null, secs: settled }))
// Bring the room to the same baseline so both sides share a common ancestor.
const seed = await roomSession(() => BASE)
try { seed.ws?.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ }
await sleep(4000)

// --- the two edits, to THE SAME LINE ----------------------------------------
// Browser first, and the socket is held open, which is what a person with the
// editor open looks like.
const session = await roomSession(text => text.replace('bravo', 'bravo-FROM-BROWSER'))
console.log(JSON.stringify({ step: 'browser-edit', roomHadBaseline: session.before === BASE }))

// Disk changes the same line to something else, while the room is still open.
fs.writeFileSync(PATH, BASE.replace('bravo', 'bravo-FROM-DISK'))

const moved = await waitForServer(t => t !== BASE, 120_000)
await sleep(6000)

const published = await serverText()
const roomAfter = (await roomSession(null)).before
try { session.ws?.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ }

console.log(JSON.stringify({
  step: 'result',
  serverMovedSecs: moved,
  publishedConflicted: CONFLICTED.test(published || ''),
  roomConflicted: roomAfter !== null ? CONFLICTED.test(roomAfter) : null,
  publishedHasBrowserEdit: (published || '').includes('bravo-FROM-BROWSER'),
  publishedHasDiskEdit: (published || '').includes('bravo-FROM-DISK'),
  publishedBytes: (published || '').length,
}, null, 1))
if (CONFLICTED.test(published || '')) console.log('--- PUBLISHED SOURCE ---\n' + published)

// --- always leave the disposable project consistent -------------------------
fs.writeFileSync(PATH, BASE)
const back = await roomSession(() => BASE)
try { back.ws?.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ }
const reset = await waitForServer(t => t === BASE, 90_000)
console.log(JSON.stringify({ step: 'reset', clean: reset !== null }))
