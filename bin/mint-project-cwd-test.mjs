import assert from 'node:assert/strict'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { resolveMintCwd } from '../daemon/mint-cwd.mjs'

const bindings = new Map([
  ['synth-combined', '/Users/skip/work/synth-randomization'],
])
const resolve = input => resolveMintCwd({
  ...input,
  getProjectSourceDir: project => bindings.get(project) ?? null,
})

assert.equal(
  resolve({ project: 'synth-combined' }),
  '/Users/skip/work/synth-randomization',
  'a named project resolves through the daemon-local source binding',
)
assert.equal(
  resolve({ cwd: '/tmp/explicit', project: 'synth-combined' }),
  '/tmp/explicit',
  'an explicit cwd remains authoritative',
)
assert.throws(
  () => resolve({ project: 'missing-project' }),
  /has no local source directory on this daemon/,
  'a named project never silently falls back to the daemon checkout',
)
assert.throws(
  () => resolve({}),
  /requires cwd or project/,
  'a mint with no working directory errors instead of pretending the daemon checkout is its project',
)

const launcher = projects => createAgentLauncher({
  activeEnvName: 'testing',
  configDir: '/tmp/tlda-mint-project-cwd-test',
  loadDaemonLaunchConfig: () => ({}),
  log: { info() {}, warn() {} },
  machineId: 'test-machine',
  permissionLedger: {},
  sendMsg() {},
  getProjects: () => projects,
  tmux() {},
})

assert.deepEqual(
  await launcher([{ name: 'synth-combined', sourceDir: null }]).handlers.spawn({
    name: 'synth-intro-framing',
    project: 'synth-combined',
  }),
  { ok: false, error: "project 'synth-combined' has no working directory on this daemon" },
  'the Agents-panel spawn handler rejects a known project whose working directory is absent',
)
assert.deepEqual(
  await launcher([]).handlers.spawn({ name: 'synth-intro-framing' }),
  { ok: false, error: 'spawn requires cwd or project' },
  'the Agents-panel spawn handler rejects a request with neither cwd nor project',
)

console.log('mint project cwd tests passed')
