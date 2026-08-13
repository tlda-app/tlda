#!/usr/bin/env node
// Two people editing a paper that has figures in it, over the real push route.
//
// Every other collaboration story in this suite uses a project made entirely of
// text, and every one of them passed while the clean-rebase path was unreachable
// on any real paper. A figure nobody had touched was classified as unmergeable —
// there is no three-way merge for bytes — and a rebase required every path in
// the project to be a candidate, so one bystander refused a push it had nothing
// to do with.
//
// bin/a-figure-does-not-refuse-a-rebase-test.mjs pins that at the source
// authority, which is where the decision is made. This one goes through
// processProjectPush with participants on their own machines, because the thing
// that was wrong was invisible to every test that used a text-only fixture and
// I would rather the shape of a real paper were in the suite than argued about.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { daemonOn, everyoneArrivesAt } from './lib/source-collaborators.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-figures-'))
await initProjectStore(root)

const PROJECT = 'paper-with-figures'
// A shape closer to a real paper than the rest of this suite uses: chapters, a
// bibliography, and three figures that nobody in these stories ever edits.
const FIGURES = ['fig-one.png', 'fig-two.png', 'plot.svg']
const CHAPTERS = ['main.tex', 'intro.tex', 'method.tex']
const MANIFEST = [...FIGURES, 'refs.bib', ...CHAPTERS].sort()

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4])
// Binary content has to declare its encoding on the way in. Handing the push
// route a Buffer without saying so stores String(buffer) — the bytes read as
// utf8 — and the figure that comes back is not the figure that went in. The
// first run of this story asserted against those mangled bytes and failed on
// them, which is the failure a text-only fixture can never produce.
const opening = path => (path.endsWith('.png')
  ? { content: PNG.toString('base64'), encoding: 'base64' }
  : { content: `${path} as it started\n` })

try {
  createProject({ name: PROJECT, title: PROJECT, mainFile: 'main.tex', format: 'svg' })
  await updateProject(PROJECT, { pages: 1, buildStatus: 'success' })
  mkdirSync(outputDir(PROJECT), { recursive: true })
  writeFileSync(join(outputDir(PROJECT), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))

  const started = await processProjectPush(PROJECT, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: MANIFEST.map(path => ({ path, ...opening(path) })),
  })
  assert.deepEqual({ status: started.status, error: started.error }, { status: 200, error: undefined },
    'the paper — exists with its figures, before anyone edits it')

  // ## Two people edit different chapters of a paper that has figures in it

  // ### Alice and Bob pull the same draft
  const alice = daemonOn('Alice', 'her laptop', PROJECT, MANIFEST)
  const bob = daemonOn('Bob', 'his desktop', PROJECT, MANIFEST)
  await everyoneArrivesAt(alice, bob)
  assert.equal(alice.heldRevision, bob.heldRevision,
    'both machines — start from the same revision; otherwise they are not editing the same draft')

  // ### Alice pushes her chapter
  const hers = await alice.pushes.call(alice.edits('intro.tex', 'alice rewrites the introduction\n'))
  assert.deepEqual({ status: hers.status, error: hers.error }, { status: 200, error: undefined },
    "Alice's laptop — lands her chapter; otherwise she was refused and she pushed first")

  // ### Bob pushes a different chapter, still holding the draft they both pulled
  const his = await bob.pushes.call(bob.edits('method.tex', 'bob rewrites the method\n'))
  assert.deepEqual({ status: his.status, error: his.error }, { status: 200, error: undefined },
    "Bob's desktop — lands his chapter; otherwise he was refused though he touched a file nobody else did, "
    + 'and the only unmergeable files in this paper are figures neither of them opened')

  // ### The paper has both chapters, and the figures are untouched
  const lifecycle = await sourceLifecycleStore(PROJECT)
  const landed = lifecycle.readAuthority().currentRevision
  const text = path => lifecycle.readRevisionFile(landed, path).toString('utf8')
  assert.equal(text('intro.tex'), 'alice rewrites the introduction\n',
    "the paper — kept Alice's chapter through Bob's rebase")
  assert.equal(text('method.tex'), 'bob rewrites the method\n',
    "the paper — has Bob's chapter")
  for (const figure of FIGURES.filter(path => path.endsWith('.png'))) {
    assert.deepEqual([...lifecycle.readRevisionFile(landed, figure)], [...PNG],
      `${figure} — is the bytes it always was, carried across the rebase rather than merged`)
  }

  // ## The same paper, with its chapters and figures in folders
  //
  // Every fixture in this suite is flat, and no real paper is. The figure defect
  // survived every test we had because the fixtures could not represent a paper
  // with figures; a fixture that cannot represent a paper with directories is
  // the same gap one step along, and the only way to know is to write it down.
  //
  // Counterfactual run 2026-08-13, on this exact manifest but standalone —
  // reverting the lifecycle fails the flat story above first, so the nested case
  // has to be run on its own to be isolated. Against the lifecycle as it was
  // before `9657e586a`, the second push is refused 409 stale-base with
  // `figures/plot.png` classified `classification-unavailable` while every other
  // path is a clean-rebase candidate. So this shape can fail, which is the only
  // reason its passing means anything.
  {
    const NESTED = ['main.tex', 'chapters/intro.tex', 'chapters/method.tex', 'figures/plot.png', 'bib/refs.bib'].sort()
    const NESTED_PROJECT = 'paper-with-folders'
    createProject({ name: NESTED_PROJECT, title: NESTED_PROJECT, mainFile: 'main.tex', format: 'svg' })
    await updateProject(NESTED_PROJECT, { pages: 1, buildStatus: 'success' })
    mkdirSync(outputDir(NESTED_PROJECT), { recursive: true })
    writeFileSync(join(outputDir(NESTED_PROJECT), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))

    // ### The paper exists, with its figure a directory away from its chapters
    const begun = await processProjectPush(NESTED_PROJECT, {
      expectedRevision: null,
      sourceManifest: NESTED,
      files: NESTED.map(path => ({ path, ...opening(path) })),
    })
    assert.deepEqual({ status: begun.status, error: begun.error }, { status: 200, error: undefined },
      'the paper — exists with chapters and figures in folders, the shape every real paper has')

    // ### Two people edit different chapters, neither of them touching the figure
    const ada = daemonOn('Ada', 'her laptop', NESTED_PROJECT, NESTED)
    const raj = daemonOn('Raj', 'his desktop', NESTED_PROJECT, NESTED)
    await everyoneArrivesAt(ada, raj)
    const first = await ada.pushes.call(ada.edits('chapters/intro.tex', 'ada rewrites the introduction\n'))
    assert.deepEqual({ status: first.status, error: first.error }, { status: 200, error: undefined },
      "Ada's laptop — lands her chapter from inside a folder")
    const second = await raj.pushes.call(raj.edits('chapters/method.tex', 'raj rewrites the method\n'))
    assert.deepEqual({ status: second.status, error: second.error }, { status: 200, error: undefined },
      "Raj's desktop — lands his chapter too; otherwise a figure one directory away refused a push it has "
      + 'nothing to do with, which is the defect this whole file exists for, wearing a folder')

    // ### The paper has both chapters and the figure is untouched bytes
    const nestedLifecycle = await sourceLifecycleStore(NESTED_PROJECT)
    const at = nestedLifecycle.readAuthority().currentRevision
    assert.equal(nestedLifecycle.readRevisionFile(at, 'chapters/intro.tex').toString('utf8'),
      'ada rewrites the introduction\n', "the paper — kept Ada's chapter through Raj's rebase")
    assert.equal(nestedLifecycle.readRevisionFile(at, 'chapters/method.tex').toString('utf8'),
      'raj rewrites the method\n', "the paper — has Raj's chapter")
    assert.deepEqual([...nestedLifecycle.readRevisionFile(at, 'figures/plot.png')], [...PNG],
      'the figure — is the bytes it always was, carried across a rebase from another directory')
  }

  console.log('a paper with figures in it: two chapters land, the figures are carried, and folders change nothing')
} finally {
  await closeProjectStore?.()
  rmSync(root, { recursive: true, force: true })
}
