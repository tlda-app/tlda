#!/usr/bin/env node
// verify-goose-toolcalls — does an OpenRouter model emit STRUCTURED tool-calls
// through goose, or does it narrate them as text?
//
// OpenRouter advertising "tools" support is necessary but NOT sufficient: some
// models (deepseek-r1 was the first we hit) emit tool-calls as text in a native
// format (`function<｜tool▁sep｜>tlda__read_project …`) instead of invoking them,
// which leaves a fleet agent unable to act. This probe spawns a throwaway goose
// agent on the model, lets it run its login()+inbox() boot kickoff (both
// real tool-calls), then reads goose's own sqlite to see whether those came
// through as structured `toolRequest` blocks or leaked into assistant text.
//
// Usage:  node bin/verify-goose-toolcalls.mjs <model-alias-or-id> [--keep]
//   PASS  → ≥1 structured toolRequest, 0 text-format tool-calls  (exit 0)
//   FAIL  → narrated tool-calls / none structured                 (exit 1)
//   ERROR → never booted / no goose session                       (exit 2)
// --keep leaves the probe session alive (default: kill it on exit).

import { spawnSync, execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

const model = process.argv[2]
const keep = process.argv.includes('--keep')
if (!model) {
  console.error('usage: verify-goose-toolcalls.mjs <model-alias-or-id> [--keep]')
  process.exit(2)
}

const SPAWN = path.join(os.homedir(), 'bin', 'fleet-spawn')
const REPO = path.join(os.homedir(), 'work', 'tlda')
const SESSIONS_DB = path.join(os.homedir(), '.local', 'share', 'goose', 'sessions', 'sessions.db')
const BOOT_TIMEOUT_MS = 120_000
const POLL_MS = 4_000

// Text-format tool-call tells: the DeepSeek native separator token, or a tool
// name / tool-call JSON leaking into an assistant TEXT block instead of a
// toolRequest. Any of these = the model narrated instead of invoking.
const TEXT_TOOLCALL_RE = /tool[▁㆗\s_]*sep|function\s*<|"name"\s*:\s*"(?:tlda__|mcp__)/i

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 })
}

function killSession(tmuxSession) {
  if (!tmuxSession) return
  try { execFileSync('tmux', ['kill-session', '-t', tmuxSession], { timeout: 5000 }) } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function readTurn(hex) {
  // Returns { toolReqs, textCalls, total } or null if the session isn't there yet.
  if (!fs.existsSync(SESSIONS_DB)) return null
  let db
  try { db = new Database(SESSIONS_DB, { readonly: true, fileMustExist: true }) }
  catch { return null }
  try {
    const s = db.prepare(
      "SELECT id FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1"
    ).get('fleet-' + hex)
    if (!s) return null
    const rows = db.prepare(
      'SELECT role, content_json FROM messages WHERE session_id = ? ORDER BY id'
    ).all(s.id)
    let toolReqs = 0, textCalls = 0
    const names = []
    for (const r of rows) {
      let blocks
      try { blocks = JSON.parse(r.content_json) } catch { continue }
      if (!Array.isArray(blocks)) continue
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'toolRequest') {
          toolReqs++
          const n = b.toolCall?.value?.name
          if (n) names.push(n)
        } else if (b.type === 'text' && typeof b.text === 'string' && TEXT_TOOLCALL_RE.test(b.text)) {
          textCalls++
        }
      }
    }
    return { toolReqs, textCalls, total: rows.length, names }
  } catch { return null }
  finally { try { db.close() } catch {} }
}

const probeName = 'ds-verify-' + Math.abs(hashStr(model + process.pid)).toString(36).slice(0, 6)
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 } return h }

console.log(`[verify] spawning probe '${probeName}' on model '${model}' …`)
const r = sh(SPAWN, ['--fresh', probeName, '--model', model, '--cwd', REPO, '--no-attach'])
const out = (r.stdout || '') + (r.stderr || '')
const m = out.match(/(fleet-[A-Za-z0-9_.-]+)\s+\(fleet:([0-9a-f]+)\)/)
if (!m) {
  console.error(`[verify] ERROR — spawn did not report a fleet id:\n${out.trim()}`)
  process.exit(2)
}
const tmuxSession = m[1]
const hex = m[2]
console.log(`[verify] probe up: ${tmuxSession} (fleet:${hex}); waiting for boot tool-calls …`)

const deadline = Date.now() + BOOT_TIMEOUT_MS
let last = null
let verdict = null
while (Date.now() < deadline) {
  await sleep(POLL_MS)
  const info = readTurn(hex)
  if (info) {
    last = info
    // Decide as soon as we have signal: a structured tool-call, OR a narrated one.
    if (info.toolReqs >= 1 && info.textCalls === 0) { verdict = 'PASS'; break }
    if (info.textCalls >= 1) { verdict = 'FAIL'; break }
  }
}

if (!keep) killSession(tmuxSession)

if (!last) {
  console.error(`[verify] ERROR — '${model}' never produced a goose session within ${BOOT_TIMEOUT_MS / 1000}s (boot failed / bad model id / provider error).`)
  process.exit(2)
}
if (verdict === 'PASS') {
  console.log(`[verify] PASS — '${model}': ${last.toolReqs} structured tool-call(s) [${[...new Set(last.names)].join(', ')}], 0 text-format. Tool-capable through goose.`)
  process.exit(0)
}
if (verdict === 'FAIL') {
  console.log(`[verify] FAIL — '${model}': ${last.textCalls} text-format tool-call(s) detected (narrates instead of invoking). ${last.toolReqs} structured. NOT usable for tool roles.`)
  process.exit(1)
}
console.error(`[verify] INCONCLUSIVE — '${model}': ${last.toolReqs} structured / ${last.textCalls} text over ${last.total} msgs, no clear verdict before timeout.`)
process.exit(2)
