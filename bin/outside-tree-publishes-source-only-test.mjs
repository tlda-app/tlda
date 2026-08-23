// The wire, not the two ends: forks the REAL build worker and reads the
// messages it sends back, because the relevance decision is made in the worker
// process and the item set it chooses only matters after it crosses IPC.
//
// Both halves run the same fixture and differ in ONE file. A check that only
// ever saw the skipping case could not tell "the filter said outside-tree" from
// "the filter is never consulted and everything skips", which is the failure
// this whole change exists to avoid in the other direction.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore, updateProject } from '../server/lib/project-store.mjs'

const MAIN = '\\documentclass{article}\\begin{document}Hello\\end{document}'

async function runWorker({ changedFile, content }) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-outside-tree-'))
  await initProjectStore(root)
  createProject({ name: 'paper', mainFile: 'main.tex', format: 'svg' })
  // `pages` non-zero, and set through updateProject because createProject does
  // not carry it. A project on 0 pages returns `initial-svg-build` and never
  // reaches the relevant-files test at all — which is what this fixture did on
  // its first run, and it renders exactly like the filter not being wired in.
  await updateProject('paper', { pages: 4 })
  const git = await (await sourceLifecycleStore('paper')).gitRepository()

  // What the last render read. Written by writeRelevantFiles in the real
  // system; hand-written here so the test does not need a LaTeX run to have one.
  mkdirSync(join(root, 'paper', 'output'), { recursive: true })
  writeFileSync(join(root, 'paper', 'output', 'relevant-files.json'),
    JSON.stringify({ files: ['main.tex'] }))

  const base = await git.acceptRevision({
    project: 'paper',
    files: [{ path: 'main.tex', content: MAIN }, { path: 'notes.tex', content: 'notes' }],
    message: 'base',
  })
  await git.advanceHead('paper', base, null)
  const proposal = await git.acceptRevision({
    project: 'paper',
    parent: base,
    files: [
      { path: 'main.tex', content: changedFile === 'main.tex' ? content : MAIN },
      { path: 'notes.tex', content: changedFile === 'notes.tex' ? content : 'notes' },
    ],
    message: `edit ${changedFile}`,
  })
  await closeProjectStore()

  const child = fork(new URL('./build-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const seen = []
  child.on('message', message => {
    if (message?.t !== 'rpc') return
    seen.push({ method: message.m, args: message.a })
    child.send({ t: 'rpc-result', id: message.id, ok: true, result: { published: true } })
  })
  child.send({ t: 'build', name: 'paper', projectsDir: root, kind: 'build', sourceRevision: proposal, acceptSeq: 2 })
  await new Promise(resolve => child.once('exit', resolve))
  return seen
}

// A revision that touches only a file the render never read.
const skipped = await runWorker({ changedFile: 'notes.tex', content: 'edited by voice' })
const publish = skipped.find(entry => entry.method === 'publishBuildInstance')
assert.ok(publish, 'the worker must still publish — suppressing the admission strands the push')
assert.deepEqual(publish.args[5], ['source'],
  'an outside-tree revision publishes source only, leaving the published render in place')
const result = skipped.find(entry => entry.method === 'recordBuildResult')
assert.equal(result?.args?.[3], 'not_required',
  'a revision that did not render must not report itself as built')

// The counterfactual, same fixture, one file different: a revision that touches
// the main file must NOT take the source-only path. This half is what proves
// the filter is consulted rather than always skipping.
const rendered = await runWorker({ changedFile: 'main.tex', content: `${MAIN}% edited` })
const renderedPublish = rendered.find(entry => entry.method === 'publishBuildInstance')
assert.notDeepEqual(renderedPublish?.args?.[5], ['source'],
  'a change to a file the render reads must render, not publish source only')

console.log('outside-tree publishes source only; a relevant change still renders')
