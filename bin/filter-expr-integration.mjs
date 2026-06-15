#!/usr/bin/env node
// End-to-end integration test for filter expressions against a running sandbox.
// Registers a few agents, then exercises (a) the WS chat router's expression
// resolution and (b) the /api/fleet-table REST filter. Run with the sandbox up:
//   tlda-dev sandbox filter-expr  &&  node bin/filter-expr-integration.mjs
import WebSocket from 'ws'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = 'https://localhost:5280'
const WSBASE = 'wss://localhost:5280/ws/fleet'
let idc = 0
const nextId = () => `t${++idc}`

function conn(agentId) {
  const ws = new WebSocket(`${WSBASE}?agent=${encodeURIComponent(agentId)}`, { rejectUnauthorized: false })
  const waiters = new Map()
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()) } catch { return }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result ?? { _error: m.error }); waiters.delete(m.id) }
  })
  const ready = new Promise((res) => ws.on('open', res))
  const req = (type, body) => new Promise((res) => {
    const id = nextId(); waiters.set(id, res); ws.send(JSON.stringify({ type, id, ...body }))
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ _timeout: true }) } }, 3000)
  })
  return { ws, ready, req }
}

let pass = 0, fail = 0
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok  ${label} => ${g}`) }
  else { fail++; console.log(`FAIL  ${label} => ${g} (want ${w})`) }
}
const norm = (arr) => [...new Set(arr)].map(s => s.replace(/^fleet:/, '')).sort()

const main = async () => {
  // Register four agents on their own connections (so they stay awake).
  const defs = [
    { id: 'fleet:alpha', name: 'alpha', labels: ['mathy', 'reviewers'] },
    { id: 'fleet:beta',  name: 'beta',  labels: ['mathy', 'goose'] },
    { id: 'fleet:gamma', name: 'gamma', labels: ['reviewers'] },
    { id: 'fleet:sender', name: 'sender', labels: [] },
  ]
  const conns = {}
  for (const d of defs) {
    const c = conn(d.id); await c.ready
    await c.req('register', { agent_id: d.id, name: d.name, labels: d.labels })
    conns[d.name] = c
  }
  await new Promise(r => setTimeout(r, 400))

  // --- (a) WS chat router resolution ---
  const sendTo = async (to) => {
    const r = await conns.sender.req('chat', { to, from: 'fleet:sender', message: 'x' })
    return norm(r.recipients || [])
  }
  console.log('chat router (expression -> recipients):')
  eq('to="alpha"',                 await sendTo('alpha'), ['alpha'])
  eq('to="alpha | gamma"',         await sendTo('alpha | gamma'), ['alpha', 'gamma'])
  eq('to="mathy"',                 await sendTo('mathy'), ['alpha', 'beta'])
  eq('to="mathy & !goose"',        await sendTo('mathy & !goose'), ['alpha'])
  eq('to="reviewers & !mathy"',    await sendTo('reviewers & !mathy'), ['gamma'])
  eq('to="(alpha | beta) & goose"',await sendTo('(alpha | beta) & goose'), ['beta'])

  // a malformed expression must fail loud (no recipients, error reply)
  const bad = await conns.sender.req('chat', { to: 'alpha &', from: 'fleet:sender', message: 'x' })
  eq('to="alpha &" -> error (no event_ids)', !bad.event_ids, true)

  // --- (b) fleet-table REST filter ---
  console.log('fleet-table REST (?filter=expression):')
  const table = async (filter) => {
    const u = `${BACKEND}/api/fleet-table${filter != null ? `?filter=${encodeURIComponent(filter)}` : ''}`
    const res = await fetch(u)
    const j = await res.json()
    return norm((j.agents || []).map(a => a.name))
  }
  eq('filter="mathy"',           await table('mathy'), ['alpha', 'beta'])
  eq('filter="mathy & !goose"',  await table('mathy & !goose'), ['alpha'])
  eq('filter="reviewers | goose"', await table('reviewers | goose'), ['alpha', 'beta', 'gamma'])
  const r400 = await fetch(`${BACKEND}/api/fleet-table?filter=${encodeURIComponent('a &')}`)
  eq('filter="a &" -> 400', r400.status, 400)

  for (const c of Object.values(conns)) c.ws.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error('integration error:', e); process.exit(2) })
