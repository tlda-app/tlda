import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeBuildInstance } from './build-instance.mjs'
import { finalizeBuildVersion, setBuildReporter } from './build-runner.mjs'
import { closeProjectStore, createProject, initProjectStore, setProjectPathOverride, sourceLifecycleStore } from './project-store.mjs'

function stubReporter(calls) {
  setBuildReporter({
    broadcastSignal: (...args) => { calls.push(['broadcastSignal', ...args]) },
    writeSentinel: (...args) => { calls.push(['writeSentinel', ...args]); return {} },
    emitGlobalEvent: (...args) => { calls.push(['emitGlobalEvent', ...args]) },
    updateProject: (...args) => { calls.push(['updateProject', ...args]) },
    recordRevisionPhase: (...args) => { calls.push(['recordRevisionPhase', ...args]); return null },
  })
}

// A successful QMD-only edit commits a shadow version whose diff carries no
// `*.tex` change, so the summary is null and no lint runs. The success card
// must still be emitted — exactly once, with truthful identity and no
// fabricated summary or lint fields.
test('committed qmd-only build version emits one truthful success build-card', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-success-card-'))
  const name = 'course'
  let first
  let second
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'index.qmd', format: 'qmd' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const base = await git.acceptRevision({
      project: name,
      files: [
        { path: 'index.qmd', content: '---\ntitle: Course\n---\n\n# Home\n' },
        { path: 'lectures/lecture.qmd', content: '# Lecture\n\nFirst words.\n' },
      ],
      message: 'qmd base',
    })
    const edited = await git.acceptRevision({
      project: name,
      parent: base,
      files: [
        { path: 'index.qmd', content: '---\ntitle: Course\n---\n\n# Home\n' },
        { path: 'lectures/lecture.qmd', content: '# Lecture\n\nFirst words with an added sentence.\n' },
      ],
      message: 'qmd-only edit',
    })

    // Seed the shadow with the base commit so the edited build commits a
    // second shadow version whose tex diff is empty.
    first = await materializeBuildInstance({ name, sourceRevision: base, lifecycle, temporaryRoot: root })
    setProjectPathOverride(name, first.project)
    const seeded = (await import('./shadow-repo.mjs')).commitSnapshot
    assert.equal((await seeded(name, base)).status, 'committed')

    second = await materializeBuildInstance({ name, sourceRevision: edited, lifecycle, temporaryRoot: root })
    setProjectPathOverride(name, second.project)
    mkdirSync(join(second.project, 'output'), { recursive: true })
    writeFileSync(join(second.project, 'output', 'relevant-files.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      files: ['index.qmd', 'lectures/lecture.qmd'],
    }))

    const calls = []
    stubReporter(calls)
    const recorded = await finalizeBuildVersion({
      name,
      projDir: second.project,
      expectedPages: 2,
      buildErrSnapshot: [],
      buildWarnSnapshot: [],
      sourceRevision: edited,
      acceptSeq: 2,
      lastBuildSuccess: null,
    })

    assert.equal(recorded.committed, true)
    const cards = calls.filter(call => call[0] === 'emitGlobalEvent' && call[1] === 'build-card')
    assert.equal(cards.length, 1)
    const card = cards[0][2]
    assert.equal(card.name, name)
    assert.match(card.hash, /^[0-9a-f]{7}$/)
    assert.equal(card.summary, null)
    assert.deepEqual(card.lintFindings, [])
    assert.equal(card.buildFailed, undefined)
    assert.deepEqual(card.buildFiles, ['index.qmd', 'lectures/lecture.qmd'])
  } finally {
    setBuildReporter(null)
    setProjectPathOverride(name, null)
    await closeProjectStore()
    if (first) rmSync(first.root, { recursive: true, force: true })
    if (second) rmSync(second.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// Neighbor: a build that versions nothing must stay quiet — the repair may
// not become an unconditional emit.
test('unchanged qmd build version emits no build-card', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-success-card-quiet-'))
  const name = 'course'
  let first
  let second
  try {
    await initProjectStore(root)
    createProject({ name, mainFile: 'index.qmd', format: 'qmd' })
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const base = await git.acceptRevision({
      project: name,
      files: [{ path: 'index.qmd', content: '# Home\n' }],
      message: 'qmd base',
    })

    first = await materializeBuildInstance({ name, sourceRevision: base, lifecycle, temporaryRoot: root })
    setProjectPathOverride(name, first.project)
    const seeded = (await import('./shadow-repo.mjs')).commitSnapshot
    assert.equal((await seeded(name, base)).status, 'committed')

    second = await materializeBuildInstance({ name, sourceRevision: base, lifecycle, temporaryRoot: root })
    setProjectPathOverride(name, second.project)

    const calls = []
    stubReporter(calls)
    const recorded = await finalizeBuildVersion({
      name,
      projDir: second.project,
      expectedPages: 1,
      buildErrSnapshot: [],
      buildWarnSnapshot: [],
      sourceRevision: base,
      acceptSeq: 2,
      lastBuildSuccess: null,
    })

    assert.equal(recorded.committed, false)
    const cards = calls.filter(call => call[0] === 'emitGlobalEvent' && call[1] === 'build-card')
    assert.equal(cards.length, 0)
  } finally {
    setBuildReporter(null)
    setProjectPathOverride(name, null)
    await closeProjectStore()
    if (first) rmSync(first.root, { recursive: true, force: true })
    if (second) rmSync(second.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
