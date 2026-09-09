import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectRebuildHandler } from './project-rebuild.mjs'

function fixture(overrides = {}) {
  const admitted = []
  const deps = {
    readProject: async () => ({ name: 'submission-week0-homework-qtm285:2696092' }),
    sourceLifecycleStore: async () => ({ gitRepository: async () => ({ gitDir: '/git' }) }),
    listProposalRefs: async () => [{ ref: 'refs/tlda/proposals/x/main/r1', revision: 'r1', branch: 'main', daemonId: 'd' }],
    admitProposal: async (proposal, options) => { admitted.push([proposal, options]) },
    ...overrides,
  }
  return { rebuild: createProjectRebuildHandler(deps), admitted }
}

test('admits the revision already on disk, so an unchanged failed build can re-run', async () => {
  const f = fixture()
  const result = await f.rebuild('submission-week0-homework-qtm285:2696092')

  assert.equal(result.status, 202)
  assert.deepEqual(result.body, { ok: true, status: 'queued', revisions: ['r1'] })
  // The whole point: admission carries the EXISTING revision. Nothing here
  // writes a file, makes a commit, or asks for new bytes -- the source was
  // never the problem, the build environment was.
  //
  // And `retryTerminal: true` is asserted exactly, not loosely. Without it
  // admitBuild short-circuits on the existing `failed` row and returns it
  // unbuilt, which is the no-op a server restart already produced against these
  // projects. A rebuild that quietly does nothing is the bug this route exists
  // to end, so the second argument is part of the contract.
  assert.deepEqual(f.admitted, [[{
    project: 'submission-week0-homework-qtm285:2696092',
    ref: 'refs/tlda/proposals/x/main/r1',
    revision: 'r1',
    branch: 'main',
    daemonId: 'd',
  }, { retryTerminal: true }]])
})

test('admits every proposal the project holds', async () => {
  const f = fixture({
    listProposalRefs: async () => [{ ref: 'a', revision: 'r1' }, { ref: 'b', revision: 'r2' }],
  })
  const result = await f.rebuild('paper')

  assert.deepEqual(result.body.revisions, ['r1', 'r2'])
  assert.deepEqual(f.admitted.map(([proposal]) => proposal.ref), ['a', 'b'])
  // Every one of them, not just the first: a project can hold more than one
  // terminal revision and half a retry is its own silent no-op.
  assert.deepEqual(f.admitted.map(([, options]) => options), [{ retryTerminal: true }, { retryTerminal: true }])
})

test('refuses a project with no revision rather than reporting a build that will never run', async () => {
  const f = fixture({ listProposalRefs: async () => [] })
  const result = await f.rebuild('paper')

  assert.equal(result.status, 409)
  assert.match(result.body.error, /no source revision to rebuild/)
  assert.deepEqual(f.admitted, [])
})

test('a missing project is 404 and admits nothing', async () => {
  const f = fixture({ readProject: async () => null })
  const result = await f.rebuild('gone')

  assert.equal(result.status, 404)
  assert.deepEqual(result.body, { error: 'Not found' })
  assert.deepEqual(f.admitted, [])
})
