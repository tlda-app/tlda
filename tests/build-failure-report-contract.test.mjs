import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('a stale render with a failed newest build reports through the shape-error event', () => {
  assert.match(app, /config\.buildStatus === 'error'[\s\S]*dispatchBuildFailureReport\(/)
  assert.match(app, /fetchBuildFailureReason\(projectName\)\.then/)
})

test('the app boundary records build-failure reports without taking the screen', () => {
  assert.match(app, /isBuildFailureReport\(\(event as CustomEvent\)\.detail\)/)
  assert.match(app, /log\.error\('build-failure'/)
})

test('no bespoke banner surface for build failures', () => {
  assert.doesNotMatch(app, /BuildFailureBanner|staleBuildNotice/)
})
