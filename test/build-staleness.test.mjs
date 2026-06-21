import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isSvgBuildStale } from '../server/lib/build-decision.mjs'
import { initProjectStore } from '../server/lib/project-store.mjs'

function makeProject(name) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-stale-'))
  const projectDir = join(root, name)
  const outputDir = join(projectDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ name, format: 'svg' }))
  initProjectStore(root)
  return { projectDir, outputDir }
}

test('SVG staleness compares current source stamp to the build-start source version', () => {
  const { projectDir, outputDir } = makeProject('paper')
  const sourceStamp = join(projectDir, 'source.stamp')
  const buildStamp = join(outputDir, 'build.stamp')

  writeFileSync(sourceStamp, 'source changed during build')
  writeFileSync(buildStamp, '1000')

  // The source edit landed after build start (1000 ms) but before build end.
  // build.stamp's own mtime is later, which used to hide this stale state.
  utimesSync(sourceStamp, new Date(2000), new Date(2000))
  utimesSync(buildStamp, new Date(3000), new Date(3000))

  assert.equal(isSvgBuildStale('paper'), true)
})

test('SVG staleness is false when source stamp is not newer than covered source version', () => {
  const { projectDir, outputDir } = makeProject('paper')
  const sourceStamp = join(projectDir, 'source.stamp')
  const buildStamp = join(outputDir, 'build.stamp')

  writeFileSync(sourceStamp, 'source covered by build')
  writeFileSync(buildStamp, '2000')
  utimesSync(sourceStamp, new Date(2000), new Date(2000))
  utimesSync(buildStamp, new Date(3000), new Date(3000))

  assert.equal(isSvgBuildStale('paper'), false)
})
