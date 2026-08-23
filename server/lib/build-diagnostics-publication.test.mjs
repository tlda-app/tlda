import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishBuildDiagnostics } from './build-dispatch.mjs'
import { closeProjectStore, createProject, initProjectStore, projectDir } from './project-store.mjs'

// A failed build's instance: it has a log explaining the failure, and it also
// has the half-built source/output that must NOT reach the live project.
function failedInstance(root, name) {
  const project = join(root, name)
  mkdirSync(join(project, 'source'), { recursive: true })
  mkdirSync(join(project, 'output'), { recursive: true })
  mkdirSync(join(project, 'build-cache'), { recursive: true })
  writeFileSync(join(project, 'source', 'main.tex'), 'broken source')
  writeFileSync(join(project, 'output', 'artifact.txt'), 'broken artifact')
  writeFileSync(join(project, 'build-cache', 'cache.txt'), 'broken cache')
  writeFileSync(join(project, 'latex.log'), '! Undefined control sequence.\nl.5 \\undefinedcommand\n')
  writeFileSync(join(project, 'build.log'), '[build] LaTeX produced 1 error(s)\n')
  return project
}

test('a failed build hands over its diagnostics and none of its artifacts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-diag-live-'))
  const instanceRoot = mkdtempSync(join(tmpdir(), 'tlda-diag-instance-'))
  const name = 'paper'
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(instanceRoot, { recursive: true, force: true })
  })
  createProject({ name, mainFile: 'main.tex' })

  // The last GOOD render, already published. A failed build must not touch it.
  const live = projectDir(name)
  mkdirSync(join(live, 'output'), { recursive: true })
  writeFileSync(join(live, 'source', 'main.tex'), 'good source')
  writeFileSync(join(live, 'output', 'artifact.txt'), 'good artifact')

  const instanceProject = failedInstance(instanceRoot, name)
  const { copied } = publishBuildDiagnostics(name, instanceProject)

  // The explanation crossed.
  assert.deepEqual(copied.sort(), ['build.log', 'latex.log'])
  assert.match(readFileSync(join(live, 'latex.log'), 'utf8'), /Undefined control sequence/)
  assert.match(readFileSync(join(live, 'build.log'), 'utf8'), /1 error\(s\)/)

  // The broken render did NOT. This is the property the build transaction
  // exists for: a failed build keeps the last successful render published.
  assert.equal(readFileSync(join(live, 'source', 'main.tex'), 'utf8'), 'good source')
  assert.equal(readFileSync(join(live, 'output', 'artifact.txt'), 'utf8'), 'good artifact')
  assert.equal(existsSync(join(live, 'build-cache')), false)
})

test('a good build afterwards clears the failed build errors and keeps its own render', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-diag-recover-'))
  const instanceRoot = mkdtempSync(join(tmpdir(), 'tlda-diag-recover-instance-'))
  const name = 'paper'
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
    rmSync(instanceRoot, { recursive: true, force: true })
  })
  createProject({ name, mainFile: 'main.tex' })
  const live = projectDir(name)
  mkdirSync(join(live, 'output'), { recursive: true })
  writeFileSync(join(live, 'output', 'artifact.txt'), 'good artifact')

  // Fail first, so the live project is carrying a failure's log.
  publishBuildDiagnostics(name, failedInstance(instanceRoot, name))
  const { extractBuildErrors } = await import('./project-store.mjs')
  const failed = await extractBuildErrors(name)
  assert.equal(failed.logMissing, false)
  assert.equal(failed.errors.length, 1)

  // Then a clean build publishes its own log over it. This is the direction
  // that matters for a user: errors must not survive the build that fixed them.
  const goodInstance = join(instanceRoot, 'good', name)
  mkdirSync(goodInstance, { recursive: true })
  writeFileSync(join(goodInstance, 'latex.log'), 'Output written on main.dvi (1 page).\n')
  writeFileSync(join(goodInstance, 'build.log'), '[build] ok\n')
  publishBuildDiagnostics(name, goodInstance)

  const recovered = await extractBuildErrors(name)
  assert.equal(recovered.logMissing, false)
  assert.deepEqual(recovered.errors, [])
  // ...and the render it had is untouched by any of this.
  assert.equal(readFileSync(join(live, 'output', 'artifact.txt'), 'utf8'), 'good artifact')
})
