// Integration test for the math-heavy chat gate + report skill add.
// Spawns the worktree server with an isolated temp DB and a test qualifications
// file, then drives /api/education/check to assert: math-heavy chat gates,
// plain chat doesn't, report requires both skills, and dismiss clears the block.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PORT = 5194
const DB = path.join(os.tmpdir(), `math-gate-${process.pid}.db`)
const QUAL = '/tmp/test-qualifications.json'
const BASE = `https://127.0.0.1:${PORT}`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TLDA_FLEET_DB: DB, TLDA_QUALIFICATIONS_FILE: QUAL },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = false
const T = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failed = true }
function done(code) { try { srv.kill('SIGKILL') } catch {} try { fs.unlinkSync(DB) } catch {} process.exit(code) }

const AGENT = 'fleet:math-gate-probe'
const check = async (params) => {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/api/education/check/${encodeURIComponent(AGENT)}?${qs}`)
  return res.json()
}

async function main() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.status === 200 || r.status === 401) break } catch {}
    await sleep(500)
  }
  await sleep(500)

  // 1. math-heavy chat → gated on explain-math-concretely
  const r1 = await check({ tool: 'mcp__tlda__chat', content: 'the rate is $$\\sum_i x_i^2 \\le C n$$ so we win' })
  T('math-heavy chat gates explain-math-concretely', r1?.skills?.includes('explain-math-concretely'))

  // 2. plain chat → NOT gated
  const r2 = await check({ tool: 'mcp__tlda__chat', content: 'just a normal status update, no math here at all' })
  T('plain chat is NOT gated', !r2 || !r2.skill)

  // 3. lone $x$ in prose → NOT gated (conservative)
  const r3 = await check({ tool: 'mcp__tlda__chat', content: 'the variable $x$ is fine on its own in prose' })
  T('lone inline $x$ is NOT gated', !r3 || !r3.skill)

  // 4. report → requires BOTH math-report and explain-math-concretely
  const r4 = await check({ tool: 'mcp__tlda__report' })
  T('report gates math-report', r4?.skills?.includes('math-report'))
  T('report gates explain-math-concretely', r4?.skills?.includes('explain-math-concretely'))

  // 5. dismiss explain-math-concretely → math-heavy chat no longer blocks on it
  const dres = await fetch(`${BASE}/api/education/dismiss/${encodeURIComponent(AGENT)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'test: not actually writing math for Skip', skills: ['explain-math-concretely'] }),
  })
  const dj = await dres.json()
  T('dismiss accepted', dres.ok && dj.dismissed?.some(d => d.skill === 'explain-math-concretely'))
  const r6 = await check({ tool: 'mcp__tlda__chat', content: 'still $$\\int f$$ and more $a$ $b$ math' })
  T('after dismiss, math-heavy chat no longer gates explain-math-concretely', !r6 || !(r6.skills || []).includes('explain-math-concretely'))

  console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL MATH-GATE CHECKS PASSED')
  if (failed) console.log(out.slice(-800))
  done(failed ? 1 : 0)
}
main().catch(e => { console.log('FAIL — exception: ' + e.message + '\n' + out.slice(-800)); done(1) })
