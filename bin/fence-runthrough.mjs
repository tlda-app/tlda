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
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
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

// 4) App-role browser path — the REAL workflow. A fenced app agent does NOT
// launch its own Chromium (that Mach-fails in-fence and is the wrong path); it
// drives the SHARED, out-of-fence browser through `tlda-dev pw`, which talks to
// the playwright-cli daemon over a UNIX socket. The macOS sandbox denies AF_UNIX
// connect even with allowLocalOutbound, so the lease must whitelist that socket
// dir via network.allowUnixSockets. Assert the lease carries that whitelist —
// without it a fenced `tlda-dev pw` reads the live session as "closed" and kills
// the real browser. (Structural gate; the live drive is proven manually with a
// shared browser up.)
{
  const appLease = JSON.parse(readFileSync(leaseSettings('cwd', 'workspace-write+net'), 'utf8'))
  const unix = appLease?.network?.allowUnixSockets || []
  const ok = unix.some(p => /tlda-pw-sockets/.test(p))
  check('app lease whitelists the pw daemon socket (AF_UNIX connect)', ok,
    ok ? `allowUnixSockets: ${unix.join(', ')}`
      : 'MISSING — a fenced tlda-dev pw cannot reach the out-of-fence browser')
}

// 5) Fenced MCP reaches the fleet over WSS. The tlda server host is a Tailscale
// MagicDNS name the sandbox can't getaddrinfo, so a fenced agent's fleet WS dies
// ("fleet WS: ✘", my_task fails) unless the node DNS-alias preload is injected.
// Assert build_claude_cmd injects it (claude passes process env to its MCP).
{
  const py = `
import importlib.util, types, sys
sys.modules['websocket'] = types.SimpleNamespace(create_connection=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location('fs', 'bin/fleet-spawn.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.build_claude_cmd('fleet:gate','fleet-gate','opus48',name='gate'))
`
  const r = spawnSync('python3', ['-c', py], { cwd: REPO, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  const ok = r.status === 0 && /NODE_OPTIONS/.test(r.stdout) && /TLDA_NODE_DNS_ALIAS_HOST/.test(r.stdout)
  check('claude cmd injects the fleet-WS DNS alias preload', ok,
    ok ? 'NODE_OPTIONS + TLDA_NODE_DNS_ALIAS_HOST present'
      : 'MISSING — fenced fleet WSS will fail getaddrinfo (my_task/chat dead)')
}

// 6) Browser-in-fence in-process launch (optional) — the WRONG path, kept only to
// document that it Mach-fails. The real path is checks (4)/(5) above + the shared
// out-of-fence browser. Never gated.
if (wantBrowser) {
  const appLease = leaseSettings('cwd', 'workspace-write+net')
  const r = throughFence(appLease, ['node', '-e',
    "const{chromium}=require('playwright');(async()=>{try{const b=await chromium.launch({headless:true});await b.close();console.log('PW_OK')}catch(e){console.log('PW_FAIL:'+e.message.split('\\n')[0])}})()"])
  const ok = r.out.includes('PW_OK')
  console.log(`ℹ in-process browser-in-fence: ${ok ? 'launched' : 'Mach-blocked (expected — fenced agents drive the shared out-of-fence browser, not their own)'}`)
}

const hardFails = results.filter(r => !r.ok)
console.log('')
if (hardFails.length) {
  fail(`run-through FAILED (${hardFails.length}): ${hardFails.map(r => r.name).join(', ')} — do NOT flip the fence on.`)
  process.exit(1)
}
console.log('✔ run-through PASSED — a fenced agent boots, authenticates, and reads its creds. Safe to flip FENCE_GLOBALLY_DISABLED.')
