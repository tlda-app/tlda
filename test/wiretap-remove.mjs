#!/usr/bin/env node
/**
 * Wiretap add/list/remove E2E.
 *
 * Regression for the remove-path bug: `sendWS()` stamps a correlation `id` onto
 * every RPC envelope (`{ type, ...params, id: uuid }`), and the server's fleet WS
 * handler reads that `id` as the correlation id. The old wiretap-remove handler
 * read the wiretap id from `msg.id` too — so it always got the correlation UUID,
 * `parseInt`→NaN→`invalid id`, and no wiretap could ever be removed. The fix
 * moves the payload field to `tap_id` (like task_id / agent_id elsewhere).
 *
 * This test drives the real /ws/fleet RPC with the SAME envelope sendWS uses
 * (correlation `id` and all), so it exercises the exact collision.
 *
 * Isolated server (own port/db, no daemon needed). Mirrors the boot in
 * test/fleet-daemon-integration.mjs.
 */
import { spawn } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'
import { WebSocket } from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const WS_OPTS = { rejectUnauthorized: false }

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(tmpdir(), 'wiretap-' + Date.now())
const FLEET_DB = path.join(TMP, 'fleet.db')
const PROJECTS = path.join(TMP, 'projects')
const PORT = 5970 + Math.floor(Math.random() * 25)
const SERVER = `https://localhost:${PORT}`
const WS = `wss://localhost:${PORT}`
const AGENT = 'fleet:wt1'
mkdirSync(TMP, { recursive: true }); mkdirSync(PROJECTS, { recursive: true })

let serverProc = null
function cleanup() { try { serverProc?.kill('SIGTERM') } catch {} ; try { rmSync(TMP, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function waitFor(pred, { timeout = 8000, interval = 120, name = 'cond' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { if (await pred()) return true } catch {} await new Promise(r => setTimeout(r, interval)) }
  throw new Error(`waitFor timeout: ${name}`)
}

// One persistent /ws/fleet connection that speaks the sendWS envelope:
// every request gets a correlation `id`, replies are matched on it.
function openRpc(agent) {
  const ws = new WebSocket(`${WS}/ws/fleet?agent=${encodeURIComponent(agent)}`, WS_OPTS)
  const pending = new Map()
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
      if (m.error) reject(new Error(m.error)); else resolve(m.result)
    }
  })
  const ready = new Promise((res) => ws.on('open', res))
  function rpc(type, params = {}) {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('rpc timeout')) } }, 5000)
      ws.send(JSON.stringify({ type, ...params, id }))  // ← same shape sendWS uses
    })
  }
  return { ws, ready, rpc }
}

async function main() {
  const env = { ...process.env }
  delete env.TLDA_TOKEN_RW; delete env.TLDA_TOKEN_READ
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', PROJECTS_DIR: PROJECTS, TLDA_FLEET_DB: FLEET_DB, TLDA_NO_AUTH: '1' })
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
  await waitFor(() => fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false), { name: 'server health' })

  const c = openRpc(AGENT)
  await c.ready
  await c.rpc('register', { id: AGENT, name: 'wt1' })

  // add a wiretap
  const f1 = [[["from", "fleet:skip"]]]
  const tap = await c.rpc('wiretap-add', { agent: AGENT, filter: f1 })
  check('wiretap-add returns a numeric id', tap && Number.isFinite(tap.id), `got ${JSON.stringify(tap)}`)

  // list shows it
  let list = await c.rpc('wiretap-list', { agent: AGENT })
  check('wiretap-list shows the added tap', Array.isArray(list) && list.some(t => t.id === tap.id), `got ${JSON.stringify(list)}`)

  // remove it by tap_id (THE FIX — previously rejected as 'invalid id')
  let removeErr = null
  let removeRes = null
  try { removeRes = await c.rpc('wiretap-remove', { tap_id: tap.id }) } catch (e) { removeErr = e.message }
  check('wiretap-remove by tap_id succeeds', removeErr === null && removeRes?.ok === true, `err=${removeErr} res=${JSON.stringify(removeRes)}`)

  // list is now empty
  list = await c.rpc('wiretap-list', { agent: AGENT })
  check('removed tap no longer in list', Array.isArray(list) && !list.some(t => t.id === tap.id), `got ${JSON.stringify(list)}`)

  // remove-all path: add two, remove each by tap_id, list empty
  const a = await c.rpc('wiretap-add', { agent: AGENT, filter: [[["from", "fleet:a"]]] })
  const b = await c.rpc('wiretap-add', { agent: AGENT, filter: [[["from", "fleet:b"]]] })
  for (const t of [a, b]) await c.rpc('wiretap-remove', { tap_id: t.id })
  list = await c.rpc('wiretap-list', { agent: AGENT })
  check('remove-all leaves no taps', Array.isArray(list) && list.length === 0, `got ${JSON.stringify(list)}`)

  // validation still rejects a missing/garbage id
  let valErr = null
  try { await c.rpc('wiretap-remove', {}) } catch (e) { valErr = e.message }
  check('wiretap-remove with no tap_id is rejected', valErr === 'invalid id', `got ${valErr}`)

  try { c.ws.close() } catch {}
  console.log(`\n[wiretap-itest] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('[wiretap-itest] CRASH:', e.stack || e.message); cleanup(); process.exit(2) })
