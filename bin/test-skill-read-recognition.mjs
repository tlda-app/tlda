// Functional test for skill-read recognition (cross-harness skill parity).
// Spawns the worktree server with an isolated DB + a test qualifications file,
// then drives /api/education/check to assert that native Read, native Goose
// Summon, and the compatibility tlda MCP read_file path all credit the skill and
// lift the education gate.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const PORT = 5195
const DB = path.join(os.tmpdir(), `skill-read-${process.pid}.db`)
const QUAL = path.join(os.tmpdir(), `skill-read-qual-${process.pid}.json`)
const PROJECTS = path.join(os.tmpdir(), `skill-read-projects-${process.pid}`)
const BASE = `https://127.0.0.1:${PORT}`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// A rule that gates `report` on a probe skill. Skill existence is irrelevant —
// the gate only tracks read/owed state by name, so a synthetic name is fine.
const SKILL = `parity-probe-skill-${process.pid}`
const SKILL_DIR = path.join(os.homedir(), 'work', 'dot-claude', 'skills', SKILL)
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')
fs.mkdirSync(SKILL_DIR, { recursive: true })
fs.writeFileSync(SKILL_FILE, ['---', `name: ${SKILL}`, '---', 'one', 'two', 'three'].join('\n') + '\n')
fs.writeFileSync(QUAL, JSON.stringify({ rules: [{ tool: 'tlda/report', requires: [SKILL] }] }))

const srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PROJECTS_DIR: PROJECTS, TLDA_FLEET_DB: DB, TLDA_QUALIFICATIONS_FILE: QUAL },
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
  try { fs.rmSync(PROJECTS, { recursive: true, force: true }) } catch (e) {
    // Best-effort test cleanup; report but do not mask the test result.
    console.error('cleanup ' + PROJECTS + ': ' + e.message)
  }
  try { fs.rmSync(SKILL_DIR, { recursive: true, force: true }) } catch (e) {
    // Best-effort test cleanup; report but do not mask the test result.
    console.error('cleanup ' + SKILL_DIR + ': ' + e.message)
  }
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
  await check(a1, { tool: 'Read', file: SKILL_FILE })
  T('1b. after native Read of the SKILL.md, report no longer gates it', !owes(await check(a1, { tool: 'mcp__tlda__report' })))

  // --- Path 2: native Goose Summon load credits the skill ---
  const a2 = 'fleet:parity-summon-probe'
  T('2a. report gates the probe skill (fresh agent, before summon)', owes(await check(a2, { tool: 'mcp__tlda__report' })))
  await check(a2, { tool: 'summon/load', source: SKILL })
  T('2b. after Summon load of the skill, report no longer gates it', !owes(await check(a2, { tool: 'mcp__tlda__report' })))

  // --- Path 3: compatibility tlda MCP read_file of a SKILL.md still credits ---
  const aCompat = 'fleet:parity-readfile-probe'
  T('3a. report gates the probe skill (fresh agent, before read_file)', owes(await check(aCompat, { tool: 'mcp__tlda__report' })))
  await check(aCompat, { tool: 'tlda/read_file', file: SKILL_FILE })
  T('3b. after read_file of the SKILL.md, report no longer gates it', !owes(await check(aCompat, { tool: 'mcp__tlda__report' })))

  // --- Path 4: sed partial reads that cover the whole SKILL.md credit it ---
  const aSed = 'fleet:parity-sed-probe'
  T('4a. report gates the probe skill (fresh agent, before sed)', owes(await check(aSed, { tool: 'mcp__tlda__report' })))
  await check(aSed, { tool: 'Bash', command: `sed -n '1,3p' ${SKILL_FILE}` })
  const partialSed = await check(aSed, { tool: 'mcp__tlda__report' })
  const sedPartial = partialSed.partial?.find(p => p.skill === SKILL)
  T('4b. after first partial sed range, report still gates it', owes(partialSed))
  T('4c. partial sed reports 50% coverage with lines 4-6 missing',
    sedPartial?.percent === 50 && sedPartial?.missing?.length === 1 && sedPartial.missing[0].start === 4 && sedPartial.missing[0].end === 6)
  await check(aSed, { tool: 'Bash', command: `sed -n '4,6p' ${SKILL_FILE}` })
  T('4d. after sed ranges cover the whole SKILL.md, report no longer gates it', !owes(await check(aSed, { tool: 'mcp__tlda__report' })))

  // --- Path 5: sed partial reads with a gap must NOT credit it ---
  const aGap = 'fleet:parity-sed-gap-probe'
  T('5a. report gates the probe skill (fresh agent, before gapped sed)', owes(await check(aGap, { tool: 'mcp__tlda__report' })))
  await check(aGap, { tool: 'Bash', command: `sed -n '1,3p' ${SKILL_FILE}` })
  await check(aGap, { tool: 'Bash', command: `sed -n '5,6p' ${SKILL_FILE}` })
  const gap = await check(aGap, { tool: 'mcp__tlda__report' })
  const gapPartial = gap.partial?.find(p => p.skill === SKILL)
  T('5b. sed ranges leaving a gap still gate the skill', owes(gap))
  T('5c. gapped sed reports line 4 missing and 83% coverage',
    gapPartial?.percent === 83 && gapPartial?.missing?.length === 1 && gapPartial.missing[0].start === 4 && gapPartial.missing[0].end === 4)

  // --- Path 6: a non-skill read must NOT credit (no false positives) ---
  const a3 = 'fleet:parity-negative-probe'
  await check(a3, { tool: 'Read', file: `/Users/skip/work/tlda/server/unified-server.mjs` })
  T('6. reading a non-skill file does NOT clear the gate', owes(await check(a3, { tool: 'mcp__tlda__report' })))

  console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL SKILL-READ-RECOGNITION CHECKS PASSED')
  if (failed) console.log(out.slice(-1200))
  done(failed ? 1 : 0)
}
main().catch(e => { console.log('FAIL — exception: ' + e.message + '\n' + out.slice(-1200)); done(1) })
