// Functional test for native/MCP skill-read recognition (cross-harness skill
// parity). Spawns the worktree server with an isolated DB + a test
// qualifications file, then drives /api/education/check to assert that reading a
// skill's SKILL.md — via the native Read tool OR the tlda MCP read_file tool —
// credits the skill and lifts the education gate, exactly as the old skill()
// tool did. This is the registration layer the bespoke skill() tool was removed
// in favor of.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PORT = 5195
const DB = path.join(os.tmpdir(), `skill-read-${process.pid}.db`)
const QUAL = path.join(os.tmpdir(), `skill-read-qual-${process.pid}.json`)
const BASE = `https://127.0.0.1:${PORT}`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// A rule that gates `report` on a probe skill. Skill existence is irrelevant —
// the gate only tracks read/owed state by name, so a synthetic name is fine.
const SKILL = 'parity-probe-skill'
fs.writeFileSync(QUAL, JSON.stringify({ rules: [{ tool: 'tlda/report', requires: [SKILL] }] }))

const srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TLDA_FLEET_DB: DB, TLDA_QUALIFICATIONS_FILE: QUAL },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = false
const T = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failed = true }
function rmQuiet(p) { try { fs.unlinkSync(p) } catch (e) { if (e.code !== 'ENOENT') console.error('cleanup ' + p + ': ' + e.message) } }
function done(code) {
  try { srv.kill('SIGKILL') } catch { /* already exited — nothing to kill */ }
  rmQuiet(DB); rmQuiet(QUAL)
  process.exit(code)
}

const check = async (agent, params) => {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/api/education/check/${encodeURIComponent(agent)}?${qs}`)
  return res.json()
}
const owes = (r) => !!r && Array.isArray(r.skills) ? r.skills.includes(SKILL) : (r?.skill === SKILL)

async function main() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.status === 200 || r.status === 401) break } catch { /* server not up yet — keep polling */ }
    await sleep(500)
  }
  await sleep(500)

  // --- Path 1: native Read of a SKILL.md credits the skill (Claude/codex) ---
  const a1 = 'fleet:parity-read-probe'
  T('1a. report gates the probe skill (before read)', owes(await check(a1, { tool: 'mcp__tlda__report' })))
  // A native Read whose path is …/skills/<name>/SKILL.md
  await check(a1, { tool: 'Read', file: `/Users/skip/work/dot-claude/skills/${SKILL}/SKILL.md` })
  T('1b. after native Read of the SKILL.md, report no longer gates it', !owes(await check(a1, { tool: 'mcp__tlda__report' })))

  // --- Path 2: tlda MCP read_file of a SKILL.md credits the skill (goose) ---
  const a2 = 'fleet:parity-readfile-probe'
  T('2a. report gates the probe skill (fresh agent, before read)', owes(await check(a2, { tool: 'mcp__tlda__report' })))
  // The daemon-normalized form a sandboxed goose read_file arrives as.
  await check(a2, { tool: 'tlda/read_file', file: `/Users/skip/work/dot-claude/skills/${SKILL}/SKILL.md` })
  T('2b. after read_file of the SKILL.md, report no longer gates it', !owes(await check(a2, { tool: 'mcp__tlda__report' })))

  // --- Path 3: a non-skill read must NOT credit (no false positives) ---
  const a3 = 'fleet:parity-negative-probe'
  await check(a3, { tool: 'Read', file: `/Users/skip/work/tlda/server/unified-server.mjs` })
  T('3. reading a non-skill file does NOT clear the gate', owes(await check(a3, { tool: 'mcp__tlda__report' })))

  console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL SKILL-READ-RECOGNITION CHECKS PASSED')
  if (failed) console.log(out.slice(-1200))
  done(failed ? 1 : 0)
}
main().catch(e => { console.log('FAIL — exception: ' + e.message + '\n' + out.slice(-1200)); done(1) })
