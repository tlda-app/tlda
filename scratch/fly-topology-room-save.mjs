/**
 * The real resolution endpoint, on an isolated server with Fly's topology.
 *
 * On the deployed box `/app/server/projects` is a SYMLINK to
 * `/app/server/persist/projects` (`fly-entrypoint-live.sh`). That is the one
 * thing that made `repoPathFor` answer `inRepo: false` about a room's own
 * working file, so every `POST /api/projects/<p>/source-room/files` returned
 * 409 `was not staged` — and before that error existed, `202 queued` with
 * nothing staged and the edit gone.
 *
 * A local server without that symlink cannot show it. So this builds the
 * topology: a real `persist/projects` directory, and a `projects` symlink
 * pointing at it, with the server told to use the SYMLINK path.
 *
 * Run it from a checkout WITHOUT the canonicalisation to see the 409, and from
 * one WITH it to see the save land. Same script, two trees — that is the whole
 * measurement.
 *
 *   node scratch/fly-topology-room-save.mjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startServer, stopServer, unusedPort } from '../server/lib/unified-server-test-harness.mjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-fly-topology-')))
const canonicalProjects = path.join(root, 'server', 'persist', 'projects')
const linkedProjects = path.join(root, 'server', 'projects')
fs.mkdirSync(canonicalProjects, { recursive: true })
fs.mkdirSync(path.dirname(linkedProjects), { recursive: true })
fs.symlinkSync(canonicalProjects, linkedProjects)

// Prove the fixture is the reported shape before drawing anything from it.
const linkResolves = fs.realpathSync(linkedProjects)
console.log(`  projects path : ${linkedProjects}`)
console.log(`  resolves to   : ${linkResolves}`)
if (linkResolves === linkedProjects) {
  console.log('  FIXTURE BROKEN: the symlink did not resolve anywhere else; this cannot measure the defect')
  process.exit(2)
}

const port = await unusedPort()
const base = `https://127.0.0.1:${port}`
// The server is told the SYMLINK path, exactly as Fly does.
const server = await startServer({ port, projectsDir: linkedProjects, fleetDb: path.join(root, 'fleet.db') })

const created = await fetch(`${base}/api/projects`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'trio-copy', title: 'trio-copy', format: 'markdown', mainFile: 'paper.md' }),
})
console.log(`  create project: ${created.status}`)

// THE REAL RESOLUTION ENDPOINT — the one `resolveConflict` -> `writeSource`
// calls in the editor. Not a websocket write; that was the shortcut that hid
// this.
const save = await fetch(`${base}/api/projects/trio-copy/source-room/files`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    files: [{ path: 'paper.md', content: '# paper\n\nresolved by the control\n' }],
    editedBy: 'fly-topology-probe',
  }),
})
const body = await save.text()
console.log('')
console.log(`  POST /source-room/files -> ${save.status}`)
console.log(`  ${body.slice(0, 200)}`)
console.log('')
console.log(save.status === 202
  ? '  SAVED — the room staged its own file through the symlinked projects path'
  : '  NOT SAVED — this is the failure the deployed box shows')

// POSITIVELY VERIFY THE ROOM STATE, rather than inferring it from a 202.
// The chief's two conditions: markers absent AND blocked === false. A save that
// returns 202 while the room is still blocked would leave every later edit
// stuck at `flushRoom`'s early return.
if (save.status === 202) {
  const Y = await import('yjs')
  const state = await new Promise(resolve => {
    const ws = new WebSocket(`${base.replace(/^https/, 'wss')}/source-sync/trio-copy/paper.md`)
    const doc = new Y.Doc()
    const finish = value => { try { ws.close() } catch { /* already closed: best-effort teardown */ } resolve(value) }
    const timer = setTimeout(() => finish(null), 25_000)
    ws.onerror = () => { clearTimeout(timer); finish(null) }
    ws.onmessage = event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message?.type !== 'sync') return
      clearTimeout(timer)
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(message.update, 'base64')))
      finish({ blocked: message.blocked, text: doc.getText('source').toString() })
    }
  })
  if (!state) console.log('  room state: UNREADABLE — not claiming either condition')
  else {
    const markers = /^(<{7}|={7}|>{7})/m.test(state.text)
    console.log(`  room blocked   : ${state.blocked}`)
    console.log(`  markers present: ${markers}`)
    console.log(state.blocked === false && !markers
      ? '  BOTH CONDITIONS HOLD — markers absent and blocked false'
      : '  CONDITIONS NOT MET')
  }
}

await stopServer(server)
fs.rmSync(root, { recursive: true, force: true })
process.exit(save.status === 202 ? 0 : 1)
