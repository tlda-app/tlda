import assert from 'node:assert/strict'
import { createAgentLauncher } from '../agent-launch/agent-launch.mjs'
import { resolveMintCwd } from '../daemon/mint-cwd.mjs'

const bindings = new Map([
  ['example-project', '/home/user/work/example-project'],
])
const resolve = input => resolveMintCwd({
  ...input,
  getProjectSourceDir: project => bindings.get(project) ?? null,
})

assert.equal(
  resolve({ project: 'example-project' }),
  '/home/user/work/example-project',
  'a named project resolves through the daemon-local source binding',
)
assert.equal(
  resolve({ cwd: '/tmp/explicit', project: 'example-project' }),
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
  await launcher([{ name: 'example-project', sourceDir: null }]).handlers.spawn({
    name: 'example-worker',
    project: 'example-project',
  }),
  { ok: false, error: "project 'example-project' has no working directory on this daemon" },
  'the Agents-panel spawn handler rejects a known project whose working directory is absent',
)
assert.deepEqual(
  await launcher([]).handlers.spawn({ name: 'example-worker' }),
  { ok: false, error: 'spawn requires cwd or project' },
  'the Agents-panel spawn handler rejects a request with neither cwd nor project',
)

console.log('mint project cwd tests passed')
