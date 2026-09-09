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
