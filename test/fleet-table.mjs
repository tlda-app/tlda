#!/usr/bin/env node
/**
 * fleet_table E2E (the roll_call replacement).
 *
 * Verifies GET /api/fleet-table: whole-fleet totals + a DNF-filterable, capped
 * slice of agent rows, read passively from the registry (humans excluded). This
 * is the data layer the fleet_table MCP tool formats.
 *
 * Isolated server (own port/db, no daemon). Mirrors test/wiretap-remove.mjs.
 */
import { spawn } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
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
const TMP = path.join(tmpdir(), 'fleettable-' + Date.now())
const FLEET_DB = path.join(TMP, 'fleet.db')
const PROJECTS = path.join(TMP, 'projects')
const PORT = 5860 + Math.floor(Math.random() * 30)
const SERVER = `https://localhost:${PORT}`
const WS = `wss://localhost:${PORT}`
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
async function get(urlPath) {
  const r = await fetch(`${SERVER}${urlPath}`)
  const text = await r.text(); let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, body: json }
}
function register(fields) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/ws/fleet`, WS_OPTS)
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'register', ...fields })); setTimeout(() => { try { ws.close() } catch {}; resolve() }, 400) })
    ws.on('error', () => resolve())
  })
}

async function main() {
  const env = { ...process.env }
  delete env.TLDA_TOKEN_RW; delete env.TLDA_TOKEN_READ
  Object.assign(env, { PORT: String(PORT), HOST: '127.0.0.1', PROJECTS_DIR: PROJECTS, TLDA_FLEET_DB: FLEET_DB, TLDA_NO_AUTH: '1' })
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))
  await waitFor(() => fetch(`${SERVER}/health`).then(r => r.ok).catch(() => false), { name: 'server health' })

  // 3 agents (one labelled) + 1 human
  await register({ id: 'fleet:a1', name: 'alpha', cwd: '/tmp/a', labels: ['worker'] })
  await register({ id: 'fleet:a2', name: 'bravo', cwd: '/tmp/b' })
  await register({ id: 'fleet:a3', name: 'charlie', cwd: '/tmp/c', labels: ['worker'] })
  await register({ id: 'fleet:hu', name: 'thehuman', human: true })

  // ---- shape + totals ----
  let r = await get('/api/fleet-table')
  const d = r.body
  check('returns totals + agents + shown/matched', d && d.totals && Array.isArray(d.agents) && typeof d.shown === 'number' && typeof d.matched === 'number', `got ${JSON.stringify(d).slice(0, 200)}`)
  check('totals.total counts the 3 agents (human excluded)', d.totals.total === 3, `got ${d.totals.total}`)
  check('human is not in rows', !d.agents.some(a => a.id === 'fleet:hu'), `rows: ${d.agents.map(a => a.id).join(',')}`)
  check('rows carry name/status/cwd', d.agents.every(a => a.name && a.status && 'cwd' in a), `got ${JSON.stringify(d.agents[0])}`)
  check('totals.awake + hibernating + dead === total', (d.totals.awake + d.totals.hibernating + d.totals.dead) === d.totals.total, `${JSON.stringify(d.totals)}`)

  // ---- filter by name ----
  r = await get(`/api/fleet-table?filter=${encodeURIComponent(JSON.stringify([['alpha']]))}`)
  check('filter by name returns just that agent', r.body.agents.length === 1 && r.body.agents[0].name === 'alpha', `got ${JSON.stringify(r.body.agents.map(a => a.name))}`)
  check('filter still reports whole-fleet totals', r.body.totals.total === 3, `got ${r.body.totals.total}`)
  check('matched reflects the filter (1)', r.body.matched === 1, `got ${r.body.matched}`)

  // ---- filter by label ----
  r = await get(`/api/fleet-table?filter=${encodeURIComponent(JSON.stringify([['worker']]))}`)
  check('filter by label returns the 2 labelled agents', r.body.matched === 2 && r.body.agents.length === 2, `got matched=${r.body.matched} names=${r.body.agents.map(a => a.name)}`)

  // ---- limit caps rows, totals untouched ----
  r = await get('/api/fleet-table?limit=1')
  check('limit caps rows to 1', r.body.agents.length === 1 && r.body.shown === 1, `got shown=${r.body.shown}`)
  check('limit leaves whole-fleet totals intact', r.body.totals.total === 3 && r.body.matched === 3, `got total=${r.body.totals.total} matched=${r.body.matched}`)

  // ---- bad filter rejected ----
  r = await get('/api/fleet-table?filter=not-json')
  check('non-JSON filter is rejected (400)', r.status === 400, `got ${r.status}`)

  console.log(`\n[fleettable-itest] === ${pass} pass / ${fail} fail ===`)
  if (failures.length) for (const f of failures) console.log('  - ' + f)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('[fleettable-itest] CRASH:', e.stack || e.message); cleanup(); process.exit(2) })
