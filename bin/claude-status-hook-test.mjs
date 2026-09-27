#!/usr/bin/env node
// The status hook script never fails: a hook that errors would surface hook
// noise in the agent's turn. Every failure mode below must exit 0 with empty
// stdout. Hermetic: no case reaches the network (unknown env or absent input
// ends the run before the POST, and the POST's own errors resolve silently).
// Needs node_modules resolvable from the tree (the script imports
// shared/config.mjs, like its sibling notification hook) — symlink it in a
// bare worktree.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-status-hook.mjs')

function run({ env = {}, stdin = '' }) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  })
}

const baseEnv = { FLEET_ID: 'fleet:hook-smoke', FLEET_DAEMON_KEY: 'bogus:nosuchenv' }

// 1. No identity: silent, before stdin is even read.
{
  const env = { ...process.env }
  delete env.FLEET_ID
  const r = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8', env, timeout: 15000 })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
}

// 2. Unparseable stdin: silent.
{
  const r = run({ env: baseEnv, stdin: 'not json' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
}

// 3. Unknown event and permission events (pane owns them): silent.
for (const name of ['Whatever', 'PermissionDenied', 'PermissionRequest', 'SessionStart']) {
  const r = run({ env: baseEnv, stdin: JSON.stringify({ hook_event_name: name }) })
  assert.equal(r.status, 0, name)
  assert.equal(r.stdout, '', name)
}

// 4. A real edge with an unresolvable environment: URL resolution throws,
//    caught, silent. (Proves the run reaches past the mapping without touching
//    any server.)
{
  const r = run({ env: baseEnv, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }) })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
}

console.log('claude status hook never fails: ok')
