#!/usr/bin/env node

// Claude resume launches where its session lives. A resume id owned by the
// default base while the project configures a lane bundle launches WITHOUT
// the bundle isolation (and says so in the result); a resume id in no base
// fails permanent before anything spawns.

import assert from 'node:assert/strict'

import { launchMintProcess } from '../agent-launch/index.mjs'

const SID = '4477355f-52da-4342-9dca-e345fec801db'
const CONFIGURED_DIR = '/fake/.tlda/configs/app'
const CONFIGURED_BASE = '/fake/.tlda/configs/app/claude/projects'
const DEFAULT_BASE = '/fake/.claude/projects'

function launchParams({ found, searched }, overrides = {}) {
  let spawned = null
  const params = {
    mintId: 'mint-resume-base-test',
    fleetId: 'fleet:resume-base-test',
    name: 'resume-base-test',
    requestedKind: 'claude',
    kind: 'claude',
    modelSpec: overrides.modelSpec || { alias: 'test-claude', id: 'test-claude', harness: 'claude', provider: 'test' },
    cwd: process.cwd(),
    resumeId: SID,
    tmuxSession: 'fleet-resume-base-test',
    exactTmuxSession: true,
    permissionGrant: { profile: 'test' },
    permissionSet: {
      name: 'test',
      operations: {
        read: { allow: ['cwd'], deny: [] },
        write: { allow: ['cwd'], deny: [] },
        spawn: { allow: [], deny: [] },
      },
    },
    acknowledgeNoSecurity: true,
    config: {
      agentConfigDir: CONFIGURED_DIR,
      modelSpecs: overrides.modelSpecs || { 'test-claude': { alias: 'test-claude', id: 'test-claude', harness: 'claude' } },
    },
    activeEnvName: 'testing',
    machineId: 'mini',
    recordPreSpawnSession: async () => {},
    _deps: {
      resolveApi: () => ({ base: 'https://example.invalid' }),
      resolveDnsAlias: async () => null,
      resolveClaudeSessionBase: () => ({ found, searched }),
      spawnTmux: async (tmuxSession, cwd, cmd, options) => {
        spawned = { tmuxSession, cwd, cmd, options }
        return true
      },
    },
  }
  return { params, spawned: () => spawned }
}

// Case 1: session owned by the default base while a bundle is configured.
{
  const { params, spawned } = launchParams({
    found: { kind: 'default', name: null, agentConfigDir: null, projectsBase: DEFAULT_BASE, sessionPath: `${DEFAULT_BASE}/x/${SID}.jsonl` },
    searched: [CONFIGURED_BASE, DEFAULT_BASE],
  })
  const result = await launchMintProcess(params)
  assert.equal(result.session_base, DEFAULT_BASE)
  assert.equal(result.session_base_kind, 'default')
  assert.equal(result.session_base_configured, CONFIGURED_BASE)
  assert.equal(result.session_base_mismatch, true)
  assert.ok(spawned(), 'expected a spawn')
  assert.match(spawned().cmd, new RegExp(`--resume '${SID}'`))
  assert.doesNotMatch(spawned().cmd, /CLAUDE_CONFIG_DIR=/)
}

// Case 2: session owned by the configured bundle. Unchanged behavior.
{
  const { params, spawned } = launchParams({
    found: { kind: 'bundle', name: 'app', agentConfigDir: CONFIGURED_DIR, projectsBase: CONFIGURED_BASE, sessionPath: `${CONFIGURED_BASE}/x/${SID}.jsonl` },
    searched: [CONFIGURED_BASE],
  })
  const result = await launchMintProcess(params)
  assert.equal(result.session_base_mismatch, false)
  assert.ok(spawned(), 'expected a spawn')
  assert.match(spawned().cmd, new RegExp(`CLAUDE_CONFIG_DIR='${CONFIGURED_DIR}/claude'`))
}

// Case 3: session in no base. Loud permanent failure, nothing spawns.
{
  const { params, spawned } = launchParams({ found: null, searched: [CONFIGURED_BASE, DEFAULT_BASE] })
  const error = await launchMintProcess(params).then(
    () => { throw new Error('launch should have thrown') },
    e => e,
  )
  assert.equal(error.code, 'stale-session')
  assert.equal(error.permanent, true)
  assert.match(error.message, new RegExp(SID))
  assert.match(error.message, new RegExp(CONFIGURED_BASE.replace(/[./]/g, c => `\\${c}`)))
  assert.equal(spawned(), null)
}

// Case 4: recorded claude spec whose alias the current catalog repurposed
// onto another harness. The recorded launch conditions win; the catalog is
// not consulted.
{
  const { params, spawned } = launchParams(
    {
      found: { kind: 'bundle', name: 'app', agentConfigDir: CONFIGURED_DIR, projectsBase: CONFIGURED_BASE, sessionPath: `${CONFIGURED_BASE}/x/${SID}.jsonl` },
      searched: [CONFIGURED_BASE],
    },
    {
      modelSpec: { alias: 'muse', id: 'meta/muse-spark-1.3-contributor', harness: 'claude', provider: 'claude' },
      modelSpecs: { muse: { alias: 'muse', id: 'muse-spark-native', harness: 'muse', provider: 'muse' } },
    },
  )
  const result = await launchMintProcess(params)
  assert.ok(spawned(), 'expected a spawn')
  assert.match(spawned().cmd, /--model 'meta\/muse-spark-1\.3-contributor'/)
  assert.equal(result.model, 'meta/muse-spark-1.3-contributor')
}

// Case 5: recorded spec naming a different harness than requested fails
// loud, never silently substituted.
{
  const { params, spawned } = launchParams(
    {
      found: { kind: 'bundle', name: 'app', agentConfigDir: CONFIGURED_DIR, projectsBase: CONFIGURED_BASE, sessionPath: `${CONFIGURED_BASE}/x/${SID}.jsonl` },
      searched: [CONFIGURED_BASE],
    },
    {
      modelSpec: { alias: 'muse', id: 'muse-spark-native', harness: 'muse', provider: 'muse' },
      modelSpecs: { muse: { alias: 'muse', id: 'muse-spark-native', harness: 'muse', provider: 'muse' } },
    },
  )
  const error = await launchMintProcess(params).then(
    () => { throw new Error('launch should have thrown') },
    e => e,
  )
  assert.equal(error.code, 'model-harness-mismatch')
  assert.match(error.message, /muse/)
  assert.match(error.message, /claude/)
  assert.equal(spawned(), null)
}

console.log('claude-resume-base ok')
