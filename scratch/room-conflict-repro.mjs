/**
 * Isolate WHEN an open source room turns a disk edit into published conflict
 * markers. Disposable project only.
 *
 * The sequence under test is the one that failed:
 *
 *   1. baseline: disk == server, room absent or agreeing
 *   2. edit on disk, wait for the accepted revision to reach the server
 *   3. OPEN THE ROOM AND READ IT -- the room is server-side and outlives this
 *      client, so it now holds the marker text
 *   4. wait `gap` ms
 *   5. restore the disk file, which arrives at the room as incoming accepted
 *      source that disagrees with what the room holds
 *   6. read the published source and ask whether it carries conflict markers
 *
 * Only `gap` varies between trials. Everything else is identical, so a boundary
 * in the results is a boundary in the timing and not in the setup.
 *
 *   node scratch/room-conflict-repro.mjs <gapSeconds> [...]
 */
import fs from 'fs'
import * as Y from 'yjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const HOST = 'tlda-fly.cormorant-matrix.ts.net'
const PROJECT = 'sync-rootless'
const DIR = '/Users/skip/worktrees/sync-rootless'
const FILE = 'doc.md'
const PATH = `${DIR}/${FILE}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CONFLICTED = /<<<<<<<|>>>>>>>/

async function serverBytes() {
  const res = await fetch(`https://${HOST}/api/projects/${PROJECT}/source/${FILE}`, { signal: AbortSignal.timeout(30_000) })
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null
}

/** Open the room, read it, and optionally leave the socket open. */
function readRoom({ hold = false } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`wss://${HOST}/source-sync/${PROJECT}/${FILE}`)
    const doc = new Y.Doc()
    const timer = setTimeout(() => { try { ws.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ } resolve({ text: null, ws: null }) }, 30_000)
    ws.onerror = () => { clearTimeout(timer); resolve({ text: null, ws: null }) }
    ws.onmessage = event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message?.type !== 'sync') return
      clearTimeout(timer)
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
      const text = doc.getText('source').toString()
      if (!hold) { try { ws.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ } }
      resolve({ text, ws: hold ? ws : null })
    }
  })
}

async function waitForServer(predicate, capMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < capMs) {
    await sleep(3000)
    const bytes = await serverBytes()
    if (bytes && predicate(bytes)) return Math.round((Date.now() - started) / 1000)
  }
  return null
}

/** Force disk, server and room back to `original` and prove all three agree. */
async function reset(original) {
  fs.writeFileSync(PATH, original)
  await sleep(3000)
  const { text } = await readRoom()
  if (text !== null && text !== original.toString()) {
    // Put the room back explicitly; a room left holding stale text is the very
    // condition under test and would contaminate the next trial.
    await new Promise(resolve => {
      const ws = new WebSocket(`wss://${HOST}/source-sync/${PROJECT}/${FILE}`)
      const doc = new Y.Doc()
      const done = () => { try { ws.close() } catch { /* already closed: this is a best-effort teardown of a socket that has usually gone already, and a close failure says nothing about the measurement */ } resolve() }
      const timer = setTimeout(done, 25_000)
      ws.onmessage = event => {
        let message
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message?.type !== 'sync') return
        clearTimeout(timer)
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
        const ytext = doc.getText('source')
        const sv = Y.encodeStateVector(doc)
        doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, original.toString()) })
        ws.send(JSON.stringify({ type: 'update', update: Buffer.from(Y.encodeStateAsUpdate(doc, sv)).toString('base64') }))
        ws.send(JSON.stringify({ type: 'flush' }))
        setTimeout(done, 2500)
      }
    })
  }
  const settled = await waitForServer(b => b.equals(original), 60_000)
  return settled !== null
}

async function trial(gapSeconds, original) {
  if (!(await reset(original))) return { gapSeconds, outcome: 'reset-failed' }

  const marker = `repro ${new Date().toISOString()}`
  fs.writeFileSync(PATH, Buffer.concat([original, Buffer.from(`\n${marker}\n`)]))
  const arrived = await waitForServer(b => b.toString().includes(marker))
  if (arrived === null) return { gapSeconds, outcome: 'edit-never-arrived' }

  // The room now takes on the marker text -- a READ is all it takes.
  const { text: roomText } = await readRoom()
  const roomSawMarker = roomText !== null && roomText.includes(marker)

  await sleep(gapSeconds * 1000)

  fs.writeFileSync(PATH, original)
  // Wait for the server to move at all, rather than for a specific value: the
  // question is WHAT it settles on, so waiting for the right answer would hide
  // the wrong one.
  await waitForServer(b => !b.toString().includes(marker) || CONFLICTED.test(b.toString()), 90_000)
  await sleep(4000)

  const finalBytes = await serverBytes()
  const finalRoom = (await readRoom()).text
  const published = finalBytes ? finalBytes.toString() : ''
  return {
    gapSeconds,
    roomSawMarker,
    publishedConflicted: CONFLICTED.test(published),
    roomConflicted: finalRoom !== null ? CONFLICTED.test(finalRoom) : null,
    publishedBytes: finalBytes ? finalBytes.length : null,
    restoredCleanly: finalBytes ? finalBytes.equals(original) : false,
  }
}

const original = fs.readFileSync(PATH)
const gaps = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n))
const results = []
for (const gap of gaps) {
  const r = await trial(gap, original)
  results.push(r)
  console.log(JSON.stringify(r))
}
// Always leave the disposable project consistent, whatever the trials did.
const ok = await reset(original)
console.log(JSON.stringify({ finalReset: ok, trials: results.length }))
