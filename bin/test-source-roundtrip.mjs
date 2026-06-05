// Isolated round-trip test for the chat/amend `source` field.
// Starts the worktree server on a private port + temp DB, drives the fleet WS
// directly, and asserts that source:{file,section} persists in event metadata
// through chat and amend (set on file-form, cleared on string-form).
import { spawn } from 'child_process'
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PORT = 5193
const DB = path.join(os.tmpdir(), `source-roundtrip-${process.pid}.db`)
const WS = `wss://127.0.0.1:${PORT}/ws/fleet`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TLDA_FLEET_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let srvOut = ''
srv.stdout.on('data', d => { srvOut += d })
srv.stderr.on('data', d => { srvOut += d })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.log('FAIL — ' + m); cleanup(1) }
function cleanup(code) { try { srv.kill('SIGKILL') } catch {} try { fs.unlinkSync(DB) } catch {} process.exit(code) }

// connect a WS with retry (server warms up over ~20-30s; port refuses until then)
function connectWithRetry(agent) {
  return new Promise((resolve, reject) => {
    let tries = 0
    const attempt = () => {
      const ws = new WebSocket(`${WS}?agent=${encodeURIComponent(agent)}`, { rejectUnauthorized: false })
      ws.on('open', () => resolve(ws))
      ws.on('error', () => {
        ws.terminate()
        if (++tries > 80) return reject(new Error('connect retry exhausted'))
        setTimeout(attempt, 750)
      })
    }
    attempt()
  })
}

async function makeClient(agent) {
  const ws = await connectWithRetry(agent)
  ws.on('error', () => {})
  const pending = new Map()
  let idc = 0
  ws.on('message', d => {
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id) }
  })
  const req = (type, params) => new Promise((res) => {
    const id = `t${++idc}`
    pending.set(id, res)
    ws.send(JSON.stringify({ id, type, ...params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res(null) } }, 5000)
  })
  return { ws, req }
}

async function main() {
  const sectionFile = path.join(os.tmpdir(), `roundtrip-notes-${process.pid}.md`)
  fs.writeFileSync(sectionFile, '## Intro\nintro text\n\n## The Plan\nfirst version\n\n## Other\nz\n')

  const sender = await makeClient('fleet:rt-sender')
  await sender.req('register', { agent_id: 'fleet:rt-sender', name: 'rt-sender' })
  const rcpt = await makeClient('fleet:rt-rcpt')
  await rcpt.req('register', { agent_id: 'fleet:rt-rcpt', name: 'rt-rcpt' })
  await sleep(400)

  const db = new Database(DB)
  const lastEvent = () => db.prepare("SELECT id, text, metadata FROM events WHERE type IN ('chat') ORDER BY id DESC LIMIT 1").get()

  // 1) chat with source (file form) — server gets the already-extracted body + source
  const body1 = '## The Plan\nfirst version'
  const src = { file: sectionFile, section: 'the-plan' }
  const r1 = await sender.req('chat', { message: body1, to: [['rt-rcpt']], from: 'fleet:rt-sender', source: src })
  if (!r1?.ok) return fail('chat send failed: ' + JSON.stringify(r1))
  const e1 = lastEvent()
  const m1 = e1.metadata ? JSON.parse(e1.metadata) : {}
  if (!m1.source || m1.source.file !== sectionFile || m1.source.section !== 'the-plan')
    return fail('chat did not persist source: ' + JSON.stringify(m1))
  if (e1.text !== body1) return fail('chat body mismatch: ' + JSON.stringify(e1.text))
  console.log('PASS — chat persists source + body')

  // 2) amend file-form: re-extracted updated section + same ref
  const body2 = '## The Plan\nsecond version'
  const r2 = await sender.req('amend', { message: body2, event_id: e1.id, from: 'fleet:rt-sender', source: src })
  if (!r2?.ok) return fail('amend(file) failed: ' + JSON.stringify(r2))
  const e2 = db.prepare('SELECT text, metadata FROM events WHERE id=?').get(e1.id)
  const m2 = e2.metadata ? JSON.parse(e2.metadata) : {}
  if (e2.text !== body2) return fail('amend(file) did not update body: ' + JSON.stringify(e2.text))
  if (!m2.source || m2.source.section !== 'the-plan') return fail('amend(file) lost source: ' + JSON.stringify(m2))
  console.log('PASS — amend(file) updates body in place, keeps source')

  // 3) amend string-form: clears provenance
  const r3 = await sender.req('amend', { message: 'plain correction', event_id: e1.id, from: 'fleet:rt-sender' })
  if (!r3?.ok) return fail('amend(string) failed: ' + JSON.stringify(r3))
  const e3 = db.prepare('SELECT text, metadata FROM events WHERE id=?').get(e1.id)
  const m3 = e3.metadata ? JSON.parse(e3.metadata) : {}
  if (e3.text !== 'plain correction') return fail('amend(string) did not update body')
  if (m3.source) return fail('amend(string) did NOT clear source: ' + JSON.stringify(m3))
  console.log('PASS — amend(string) clears source provenance')

  db.close()
  try { fs.unlinkSync(sectionFile) } catch {}
  console.log('\nALL ROUND-TRIP CHECKS PASSED')
  cleanup(0)
}
main().catch(e => { console.log('FAIL — exception: ' + e.message + '\n' + srvOut.slice(-800)); cleanup(1) })
