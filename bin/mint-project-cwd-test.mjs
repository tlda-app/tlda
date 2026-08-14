import assert from 'node:assert/strict'
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

console.log('mint project cwd tests passed')
