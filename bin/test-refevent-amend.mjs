// Reference-event amend round-trip: original is immutable, each amend is a
// SEPARATE event referencing it (metadata.amends), each carrying its own
// source. Isolated server + temp DB; reads rows directly to assert immutability.
import { spawn } from 'child_process'
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PORT = 5195
const DB = path.join(os.tmpdir(), `refevent-${process.pid}.db`)
const WS = `wss://127.0.0.1:${PORT}/ws/fleet`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TLDA_FLEET_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = false
const T = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failed = true }
function done(code) { try { srv.kill('SIGKILL') } catch {} try { fs.unlinkSync(DB) } catch {} process.exit(code) }

function connect(agent) {
  return new Promise((resolve, reject) => {
    let tries = 0
    const attempt = () => {
      const ws = new WebSocket(`${WS}?agent=${encodeURIComponent(agent)}`, { rejectUnauthorized: false })
      ws.on('open', () => resolve(ws))
      ws.on('error', () => { ws.terminate(); if (++tries > 80) return reject(new Error('connect retry exhausted')); setTimeout(attempt, 750) })
    }
    attempt()
  })
}
async function client(agent) {
  const ws = await connect(agent); ws.on('error', () => {})
  const pending = new Map(); let idc = 0
  ws.on('message', d => { let m; try { m = JSON.parse(d) } catch { return }; if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id) } })
  return (type, params) => new Promise(res => { const id = `t${++idc}`; pending.set(id, res); ws.send(JSON.stringify({ id, type, ...params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); res(null) } }, 5000) })
}

async function main() {
  const sectionFile = path.join(os.tmpdir(), `refevent-notes-${process.pid}.md`)
  fs.writeFileSync(sectionFile, '## The Plan\nv2 from file\n')
  const send = await client('fleet:re-sender')
  await send('register', { agent_id: 'fleet:re-sender', name: 're-sender' })
  const rcpt = await client('fleet:re-rcpt')
  await rcpt('register', { agent_id: 'fleet:re-rcpt', name: 're-rcpt' })
  await sleep(400)
  const db = new Database(DB)
  const ev = id => db.prepare('SELECT id,type,text,metadata FROM events WHERE id=?').get(id)
  const amendsOf = origId => db.prepare("SELECT id,text,metadata FROM events WHERE type='amend' ORDER BY id").all()
    .filter(r => { try { return JSON.parse(r.metadata).amends === origId } catch { return false } })

  // chat (original)
  const c = await send('chat', { from: 'fleet:re-sender', to: 're-rcpt', message: 'version one' })
  const origId = c?.event_ids?.[0]
  T('chat created original', !!origId && ev(origId).text === 'version one' && ev(origId).type === 'chat')

  // amend #1: file-form (source set) — separate event, original immutable
  const src = { file: sectionFile, section: 'the-plan' }
  const a1 = await send('amend', { from: 'fleet:re-sender', event_id: origId, message: 'v2 from file', source: src })
  T('amend reply references original', a1?.ok && a1.event_id === origId && a1.amend_id > origId)
  T('original STILL immutable after amend #1', ev(origId).text === 'version one')
  const am1 = ev(a1.amend_id)
  const am1meta = JSON.parse(am1.metadata)
  T('amend #1 is a separate amend event referencing orig', am1.type === 'amend' && am1meta.amends === origId && am1.text === 'v2 from file')
  T('amend #1 carries its own source', am1meta.source?.section === 'the-plan')

  // amend #2: string-form (no source) — another separate event, no chip
  const a2 = await send('amend', { from: 'fleet:re-sender', event_id: origId, message: 'v3 plain' })
  T('original STILL immutable after amend #2', ev(origId).text === 'version one')
  const am2meta = JSON.parse(ev(a2.amend_id).metadata)
  T('amend #2 references orig, NO source (no chip)', am2meta.amends === origId && !am2meta.source)

  // amend targeting the amend id chains back to the original
  const a3 = await send('amend', { from: 'fleet:re-sender', event_id: a2.amend_id, message: 'v4 via amend-id' })
  T('amend of an amend-id chains to the ORIGINAL', a3?.ok && a3.event_id === origId)
  const chain = amendsOf(origId)
  T('all three amends reference the one original', chain.length === 3 && chain.every(r => JSON.parse(r.metadata).amends === origId))

  // ownership: a different sender cannot amend
  const other = await client('fleet:re-other')
  await other('register', { agent_id: 'fleet:re-other', name: 're-other' })
  const bad = await other('amend', { from: 'fleet:re-other', event_id: origId, message: 'hijack' })
  T('amend by non-owner rejected', bad && bad.ok === false)

  db.close(); try { fs.unlinkSync(sectionFile) } catch {}
  console.log(failed ? '\nSOME CHECKS FAILED\n' + out.slice(-700) : '\nALL REFERENCE-EVENT CHECKS PASSED')
  done(failed ? 1 : 0)
}
main().catch(e => { console.log('FAIL — exception: ' + e.message + '\n' + out.slice(-700)); done(1) })
