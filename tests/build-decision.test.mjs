import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initProjectStore } from '../server/lib/project-store.mjs'
import { shouldBuildOnPush } from '../server/lib/build-decision.mjs'

function initProject(name, { relevantFilesContent } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-build-decision-'))
  initProjectStore(root)
  const projectDir = path.join(root, name)
  fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'output'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({ name, format: 'svg' }))
  if (relevantFilesContent !== undefined) {
    fs.writeFileSync(path.join(projectDir, 'output', 'relevant-files.json'), relevantFilesContent)
  }
  return {
    root,
    project: { name, format: 'svg', buildStatus: 'success' },
    mirrorFile: path.join(root, name, 'source', 'main.tex'),
  }
}

test('missing relevant-files scope lets SVG push mark the build stale', () => {
  const { project } = initProject('missing-scope')

  assert.deepEqual(
    shouldBuildOnPush(project, project.name, { changedFiles: ['main.tex'], anyChanged: true }),
    { build: true, eager: false, reason: 'no-relevant-files-yet' },
  )
})

test('valid relevant-files scope filters changes outside the paper tree', () => {
  const { project } = initProject('valid-scope', {
    relevantFilesContent: JSON.stringify({ files: ['/some/other/file.tex'] }),
  })

  assert.deepEqual(
    shouldBuildOnPush(project, project.name, { changedFiles: ['notes.txt'], anyChanged: true }),
    { build: false, eager: false, reason: 'outside-tree' },
  )
})

test('corrupt relevant-files scope forces rebuild instead of filtering the push', () => {
  const { project } = initProject('corrupt-scope', {
    relevantFilesContent: '{not json',
  })

  const decision = shouldBuildOnPush(project, project.name, { changedFiles: ['main.tex'], anyChanged: true })

  assert.equal(decision.build, true)
  assert.equal(decision.eager, false)
  assert.match(decision.reason, /^relevant-files-parse-failed:/)
})
