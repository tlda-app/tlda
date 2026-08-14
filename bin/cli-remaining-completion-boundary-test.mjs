#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pollLifecycleResumeIdentity,
  waitForMovedAgentRuntime,
} from '../cli/tlda.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cliSource = readFileSync(join(here, '..', 'cli', 'tlda.mjs'), 'utf8')

let identityAttempts = 0
const identity = await pollLifecycleResumeIdentity({
  fleetId: 'fleet:completion-proof',
  tmuxSession: 'fleet-completion-proof',
  harness: 'codex',
}, {
  cwd: here,
  name: 'completion-proof',
  intervalMs: 0,
  resolveIdentity: async () => {
    identityAttempts++
    return identityAttempts === 3 ? { sessionId: 'session-proof', model: 'proof-model' } : null
  },
})
assert.equal(identityAttempts, 3)
assert.equal(identity.identity.sessionId, 'session-proof')

let runtimeAttempts = 0
const moved = await waitForMovedAgentRuntime('fleet:completion-proof', {
  machineId: 'proof-machine',
  envName: 'proof-env',
  pollMs: 0,
  openMintStore: () => ({
    resolve: () => {
      runtimeAttempts++
      return {
        processState: {
          env_name: 'proof-env',
          daemon_key: 'proof-machine:proof-env',
          tmux_session: 'fleet-completion-proof',
        },
      }
    },
    close() {},
  }),
  inspectRuntime: async () => runtimeAttempts === 3 ? {
    runtime: true,
    mcp: true,
    fleetId: 'fleet:completion-proof',
    envName: 'proof-env',
    daemonKey: 'proof-machine:proof-env',
  } : null,
  sleep: async () => {},
})
assert.equal(runtimeAttempts, 3)
assert.equal(moved.ok, true)

const deploy = cliSource.match(/async function cmdDeploy\(\)[\s\S]*?\n\}\n\n\/\/ ---- setup/)?.[0] || ''
assert.doesNotMatch(deploy, /server (?:start|stop)'[^\n]*timeout/)
assert.match(deploy, /execFileSync\(process\.execPath, \[join\(tldaRoot, 'cli', 'tlda\.mjs'\), 'server', 'start'\]/)

const restart = cliSource.match(/async function restartMcpAgents\(rest\)[\s\S]*?\n\}/)?.[0] || ''
assert.match(restart, /while \(pending\.length\)/)
assert.match(restart, /pending\.splice\(i, 1\)/)
assert.match(restart, /retrying in/)

console.log('cli remaining completion boundary: ok')
