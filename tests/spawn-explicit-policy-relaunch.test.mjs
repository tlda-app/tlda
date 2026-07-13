import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from '../agent-launch/index.mjs'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-explicit-relaunch-'))
const tmpClaudeProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-reused-seat-claude-'))
const agent = {
  id: 'fleet:explicit-relaunch',
  friendly_name: 'explicit-relaunch',
  kind: 'codex',
  cwd,
  tmux_session: 'fleet-explicit-relaunch',
  metadata: {
    kind: 'codex',
    model: 'gpt-5.5',
  },
}
const permissionSet = {
  operations: {
    read: { allow: ['machine'], deny: [] },
    write: { allow: ['machine'], deny: [] },
  },
}
const config = {
  modelSpecs: {
    gpt: {
      alias: 'gpt',
      id: 'gpt-5.5',
      provider: 'codex',
      harness: 'codex',
      harnessOptions: {
        required: ['--ask-for-approval', 'never', '--sandbox', 'danger-full-access'],
        preferences: [],
        controls: true,
      },
    },
    claude: {
      alias: 'claude',
      id: 'claude-sonnet',
      provider: 'claude',
      harness: 'claude',
      harnessOptions: {
        required: ['--dangerously-load-development-channels', 'server:tlda'],
        preferences: [],
        controls: true,
      },
    },
  },
}

try {
  let spawned = false
  const alreadyAlive = await spawn({
    spawnMode: 'respawn',
    name: 'explicit-relaunch',
    model: 'gpt-5.5',
    config,
    _deps: {
      resolveApi: () => 'http://127.0.0.1:5176',
      ensureServer: async () => true,
      findAgent: async () => agent,
      sessionHasRuntime: async () => true,
      spawnTmux: async () => {
        spawned = true
        return true
      },
    },
  })
  assert.equal(alreadyAlive.alreadyAlive, true)
  assert.equal(spawned, false, 'ordinary wake should keep a live runtime')

  const reusedSeat = {
    ...agent,
    id: 'fleet:reused-seat',
    friendly_name: 'reused-seat',
    tmux_session: 'fleet-reused-seat',
    session_id: '22222222-2222-4333-8444-555555555555',
    session_ids: ['22222222-2222-4333-8444-555555555555'],
    metadata: {
      kind: 'claude',
      model: 'gpt',
    },
  }
  const claudeJsonl = path.join(tmpClaudeProjects, '-tmp-tlda-resume-test', `${reusedSeat.session_id}.jsonl`)
  fs.mkdirSync(path.dirname(claudeJsonl), { recursive: true })
  fs.writeFileSync(claudeJsonl, '{}\n')
  let codexResolverCalled = false
  const reusedWake = await spawn({
    spawnMode: 'respawn',
    name: reusedSeat.id,
    config,
    claudeProjectsBase: tmpClaudeProjects,
    _deps: {
      resolveApi: () => 'http://127.0.0.1:5176',
      ensureServer: async () => true,
      findAgent: async () => reusedSeat,
      sessionHasRuntime: async () => true,
      resolveCodexResumeHandle: async () => {
        codexResolverCalled = true
        return { ok: false }
      },
    },
  })
  assert.equal(reusedWake.harness, 'claude')
  assert.equal(codexResolverCalled, false, 'recorded current harness must beat stale model alias')
  assert.equal(reusedWake.alreadyAlive, true)

  let spawnCall = null
  const relaunched = await spawn({
    spawnMode: 'respawn',
    name: 'explicit-relaunch',
    model: 'gpt-5.5',
    config,
    spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
    permissionSet,
    explicitPolicy: true,
    _deps: {
      resolveApi: () => 'http://127.0.0.1:5176',
      ensureServer: async () => true,
      findAgent: async () => agent,
      sessionHasRuntime: async () => true,
      resolveCodexResumeHandle: async () => ({
        ok: true,
        resumeId: '019f-test-resume',
        jsonlPath: path.join(cwd, 'rollout.jsonl'),
        cwd,
        source: 'test',
      }),
      resolveDnsAlias: async () => null,
      wsReserveShell: async () => {},
      spawnTmux: async (session, dir, cmd, options) => {
        spawnCall = { session, dir, cmd, options }
        return true
      },
      injectCodexPrompt: async () => true,
    },
  })

  assert.equal(relaunched.alreadyAlive, undefined)
  assert.equal(spawnCall?.session, 'fleet-explicit-relaunch')
  assert.equal(spawnCall?.options?.killExisting, true, 'explicit permission wake must replace the stale runtime')
  assert.match(spawnCall.cmd, /--ask-for-approval\s+never/)
  assert.match(spawnCall.cmd, /--sandbox\s+danger-full-access/)

  await assert.rejects(
    spawn({
      spawnMode: 'respawn',
      name: 'explicit-relaunch',
      model: 'gpt-5.5',
      config,
      spawnPolicy: { name: 'ops', policy: 'unsandboxed' },
      permissionSet,
      explicitPolicy: true,
      _deps: {
        resolveApi: () => 'http://127.0.0.1:5176',
        ensureServer: async () => true,
        findAgent: async () => agent,
        sessionHasRuntime: async () => false,
        resolveCodexResumeHandle: async () => ({
          ok: true,
          resumeId: '11111111-2222-4333-8444-555555555555',
          jsonlPath: path.join(cwd, 'rollout.jsonl'),
          cwd,
          source: 'test',
        }),
        resolveDnsAlias: async () => null,
        wsReserveShell: async () => {},
        spawnTmux: async () => true,
        injectCodexPrompt: async () => false,
      },
    }),
    /codex prompt injection did not reach/,
  )
} finally {
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(tmpClaudeProjects, { recursive: true, force: true })
}

console.log('spawn explicit-policy relaunch ok')
