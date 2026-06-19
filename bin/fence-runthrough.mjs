#!/usr/bin/env node
//
// fence-runthrough — the LIVE half of the fence run-through gate.
//
// Skip's fence rule: the fence must NEVER block an agent from doing its job, and
// it must NEVER be flipped on until a REAL agent has been booted THROUGH it and
// shown to work. The offline half (lease structure) is asserted by
// test/fence-lease-runthrough.test.mjs. THIS is the live half: it builds the
// exact fence settings bin/fleet-spawn.py produces for each role and runs a real
// auth/job check through `fence` -- so "does a fenced Claude actually start and
// authenticate" is answered by evidence, not assumption.
//
// It does NOT flip the global fence or spawn fleet agents. It runs bounded local
// checks through the fence binary and prints PASS/FAIL. Run it before flipping
// FENCE_GLOBALLY_DISABLED to False.
//
// Background: the 2026-06-19 lockout shipped because the gate was unit-only and
// never booted a real Claude. A fenced Claude failed with "Not logged in"
// because its OAuth token lives in the macOS login Keychain (read via
// `security find-generic-password`), which the fence denied. This harness would
// have caught it.
//
// Usage:  node bin/fence-runthrough.mjs            # auth checks (claude + codex + keychain)
//         node bin/fence-runthrough.mjs --browser  # also probe browser-in-fence (known caveat)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const wantBrowser = process.argv.includes('--browser')
const tmp = mkdtempSync(join(tmpdir(), 'fence-runthrough-'))

function fail(msg) { console.error(`✖ ${msg}`) }

// Emit the real fence settings fleet-spawn.py builds for a (policy, capability).
function leaseSettings(policyName, capability) {
  const py = `
import importlib.util, types, sys, json, os
sys.modules['websocket'] = types.SimpleNamespace(create_connection=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location('fs', 'bin/fleet-spawn.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
CWD = os.path.expanduser('~/work/tlda')
pn, dev, wr, matched, policy = m.resolve_harness_sandbox('claude', 'opus48', CWD, explicit_policy=${JSON.stringify(policyName)})
policy = m.apply_spawn_capability_to_policy(policy, ${JSON.stringify(capability)}, CWD)
print(json.dumps(m._fence_settings(policy)))
`
  const r = spawnSync('python3', ['-c', py], { cwd: REPO, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  if (r.status !== 0) throw new Error(`settings emit failed: ${r.stderr || r.stdout}`)
  const file = join(tmp, `lease-${policyName}-${capability}.json`)
  writeFileSync(file, r.stdout.trim())
  return file
}

// Run a command THROUGH the fence with the given settings; return {ok, out}.
function throughFence(settingsFile, argv) {
  const r = spawnSync('fence', ['--settings', settingsFile, '--', ...argv],
    { cwd: REPO, encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- the read-permissive lease (cwd) used for auth checks ---------------------
const authLease = leaseSettings('cwd', 'workspace-write+net')

// 1) Claude OAuth token is in the macOS Keychain — fence must allow that read.
{
  const r = throughFence(authLease, ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  check('keychain read (Claude OAuth token)', r.ok && r.out.includes('claudeAiOauth'),
    r.ok ? 'token readable through fence' : 'DENIED — fence blocks the keychain')
}

// 2) A real headless Claude must boot AND authenticate through the fence.
{
  const r = throughFence(authLease, ['claude', '-p', 'Reply with exactly the token FENCE_OK and nothing else.'])
  const notLoggedIn = /not logged in/i.test(r.out)
  check('claude -p boots + authenticates', r.ok && r.out.includes('FENCE_OK') && !notLoggedIn,
    notLoggedIn ? 'FENCE BLOCKS AUTH ("Not logged in") — the lockout is back'
      : (r.out.includes('FENCE_OK') ? 'authenticated, replied FENCE_OK' : `unexpected: ${r.out.slice(0, 120)}`))
}

// 3) Codex reads its auth from ~/.codex/auth.json (a file) — permissive reads.
{
  const r = throughFence(authLease, ['node', '-e',
    "const fs=require('fs');const p=require('os').homedir()+'/.codex/auth.json';try{JSON.parse(fs.readFileSync(p,'utf8'));console.log('CODEX_AUTH_OK')}catch(e){console.log('CODEX_AUTH_FAIL:'+e.message)}"])
  check('codex auth file readable', r.ok && r.out.includes('CODEX_AUTH_OK'),
    r.out.includes('CODEX_AUTH_OK') ? 'auth.json readable through fence' : 'NOT readable')
}

// 4) Browser-in-fence (optional) — known fence-tool Mach caveat, reported not gated.
if (wantBrowser) {
  const appLease = leaseSettings('cwd', 'workspace-write+net')
  const r = throughFence(appLease, ['node', '-e',
    "const{chromium}=require('playwright');(async()=>{try{const b=await chromium.launch({headless:true});await b.close();console.log('PW_OK')}catch(e){console.log('PW_FAIL:'+e.message.split('\\n')[0])}})()"])
  const ok = r.out.includes('PW_OK')
  console.log(`${ok ? '✔' : 'ℹ'} browser-in-fence${ok ? ' — launched'
    : ' — blocked by fence-tool Mach limit (expected; app agents use the shared out-of-fence browser)'}`)
  // not counted as a hard failure: the real workflow drives the shared browser
}

const hardFails = results.filter(r => !r.ok)
console.log('')
if (hardFails.length) {
  fail(`run-through FAILED (${hardFails.length}): ${hardFails.map(r => r.name).join(', ')} — do NOT flip the fence on.`)
  process.exit(1)
}
console.log('✔ run-through PASSED — a fenced agent boots, authenticates, and reads its creds. Safe to flip FENCE_GLOBALLY_DISABLED.')
