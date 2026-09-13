import assert from 'node:assert/strict'
import test from 'node:test'

import { rebuildLinkedProject } from './project-rebuild.mjs'

test('the daemon rebuilds an unchanged linked project through forced source submission', async () => {
  const calls = []
  const sourceSync = {
    getSourceDir: project => project === 'disposable' ? '/tmp/disposable' : null,
    submit: async (project, options) => {
      calls.push({ project, options })
      return { revision: 'same-revision', forceRebuild: options.forceRebuild }
    },
  }

  const result = await rebuildLinkedProject(sourceSync, 'disposable')
  assert.deepEqual(calls, [{ project: 'disposable', options: { forceRebuild: true } }])
  assert.deepEqual(result, { revision: 'same-revision', forceRebuild: true })
})

test('the daemon refuses to claim a rebuild for a project it does not own', async () => {
  await assert.rejects(
    rebuildLinkedProject({ getSourceDir: () => null }, 'unlinked'),
    /not linked on this daemon/,
  )
})

// The refusal used to say only "not linked on this daemon". The obvious way to
// find a project name is `tlda project list`, which lists the SERVER's
// projects -- a different set from what is bound here -- so the bare message
// told a person no and left them to work out which half of the system was
// wrong. Measured cost before this changed: two wrong projects and a read of
// the daemon source.
test('the refusal names what IS bound here, so the next command can succeed', async () => {
  await assert.rejects(
    rebuildLinkedProject({
      getSourceDir: () => null,
      boundProjectNames: () => ['alpha', 'beta'],
    }, 'unlinked'),
    error => /Bound here: alpha, beta/.test(error.message)
      && /tlda project list. shows the server's projects/.test(error.message),
  )
})

test('with nothing bound it says so and names the command that binds one', async () => {
  await assert.rejects(
    rebuildLinkedProject({ getSourceDir: () => null, boundProjectNames: () => [] }, 'unlinked'),
    /Nothing is bound here; `tlda project link` binds a checkout/,
  )
})
