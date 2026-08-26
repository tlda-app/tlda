import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ClassroomStore } from '../server/lib/classroom-store.mjs'
import { studentOverlayRoomId } from '../shared/classroom-rooms.mjs'

// The wire, not the rule.
//
// `classroom-room-access.test.mjs` proves the decision. This proves the socket
// actually asks it: a real server, a real WebSocket upgrade, real credentials.
// The rule and the call site can both be perfect while nothing consults them —
// that is the failure this file exists for, and no unit test can see it.
//
// Both directions on purpose. A gate that refuses the public link would pass
// every denial check here and destroy the thing it was built to enable, so each
// refusal is paired with the access it must not catch.

const READ_TOKEN = 'read-token-for-the-wire-test'
const RW_TOKEN = 'rw-token-for-the-wire-test'
const BOOK_ROOM = 'doc-wire-test-book'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return output
}

/**
 * Attempt the sync upgrade and report what the server did.
 *
 * Raw HTTP rather than a WebSocket client, so a refusal is observable as a
 * status line. A client library would turn 403 into a generic connection error
 * and the test could not tell "refused" from "server down" — which is the
 * distinction the whole file rests on.
 */
function upgrade(port, room, query) {
  return new Promise((resolve, reject) => {
    // TLS, because the server serves HTTPS. A plain socket here is closed with
    // no response, which is indistinguishable from the refusal being tested —
    // the first run of this file failed exactly that way and read as a pass.
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(
        `GET /sync/${room}?${query} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let data = ''
    socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error('upgrade timed out')) })
    socket.on('data', chunk => {
      data += chunk
      if (data.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(data.split('\r\n')[0])
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(data.split('\r\n')[0] || 'CLOSED WITHOUT RESPONSE'))
  })
}

test('the sync socket asks who you are before letting you into a room', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-sync-wire-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const classroomDb = join(dir, 'classroom.db')
  const store = new ClassroomStore(classroomDb)
  store.upsertCourse({ id: 'c', title: 'C' })
  store.upsertStudent({ id: 'ada', courseId: 'c', displayName: 'Ada', enrollmentToken: 'tok-ada' })
  store.upsertStudent({ id: 'bo', courseId: 'c', displayName: 'Bo', enrollmentToken: 'tok-bo' })
  store.close()

  // Gating is a server.yaml decision, not an env one: without this the server
  // starts ungated, validateToken returns 'rw' for everyone, and every check
  // below passes as 'write'. That ungated state IS the hole this change closes,
  // so a test that did not turn gating on would prove nothing while looking green.
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
  // The rest of the server's config is not what is under test; borrow the
  // machine's, read-only, so this dir differs from the real one only in gating.
  for (const file of ['daemon.yaml', 'localhost+2.pem', 'localhost+2-key.pem']) {
    copyFileSync(join(homedir(), '.config', 'tlda', file), join(configDir, file))
  }

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: join(dir, 'fleet.db'),
      TLDA_CLASSROOM_DB: classroomDb,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      // Gating ON. With it off every visitor is 'rw', which is the configuration
      // this whole change exists to make survivable.
      TLDA_TOKEN_READ: READ_TOKEN,
      TLDA_TOKEN_RW: RW_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) })
  await waitForServer(child)

  const adaRoom = studentOverlayRoomId(BOOK_ROOM, 'ada')

  // --- the refusals, which are the point ---
  const boIntoAda = await upgrade(port, adaRoom, `token=${READ_TOKEN}&classroomToken=tok-bo`)
  assert.match(boIntoAda, /403/, `a student entered another student's layer: ${boIntoAda}`)

  const anonIntoAda = await upgrade(port, adaRoom, `token=${READ_TOKEN}`)
  assert.match(anonIntoAda, /403/, `the public link entered a student's layer: ${anonIntoAda}`)

  const noCredential = await upgrade(port, BOOK_ROOM, '')
  assert.doesNotMatch(noCredential, /101/, `an uncredentialed visitor was let in: ${noCredential}`)

  // --- the accesses, without which the refusals prove nothing ---
  const publicIntoBook = await upgrade(port, BOOK_ROOM, `token=${READ_TOKEN}`)
  assert.match(publicIntoBook, /101/, `the public link was locked out of the book: ${publicIntoBook}`)

  const adaIntoOwn = await upgrade(port, adaRoom, `token=${READ_TOKEN}&classroomToken=tok-ada`)
  assert.match(adaIntoOwn, /101/, `a student was locked out of their own layer: ${adaIntoOwn}`)

  const adaIntoBook = await upgrade(port, BOOK_ROOM, `token=${READ_TOKEN}&classroomToken=tok-ada`)
  assert.match(adaIntoBook, /101/, `a student was locked out of the common layer: ${adaIntoBook}`)

  const instructor = await upgrade(port, adaRoom, `token=${RW_TOKEN}`)
  assert.match(instructor, /101/, `an instructor was locked out: ${instructor}`)
})
