import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { closeProjectStore, initProjectStore, createProject, readProject } from './project-store.mjs'

// A project's format used to default to `svg`, and `svg` means "build with
// LaTeX". So "I was not told what this is" resolved to "run pdflatex on it".
//
// That is not hypothetical. Observed end to end through a real server before
// this change: a project whose main file was a .pdf arrived as format:'svg'
// with its own root coerced to svg, went to the LaTeX runner, and died with
// `DVI file not created` — a message about the symptom, never the cause.
//
// The first two tests are the fix. The rest exist to show it changed nothing
// for anybody else, which is the part worth checking.

async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmt-derive-'))
  await initProjectStore(dir)
  // closeProjectStore is not tidiness: the store client holds the event loop
  // open, so without it the runner never exits and the test looks like a hang
  // rather than a pass.
  t.after(async () => {
    await closeProjectStore()
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const formatOf = async name => (await readProject(name)).format

test('a PDF main file makes a PDF project, not a LaTeX one', async t => {
  await store(t)
  createProject({ name: 'a-pdf', mainFile: 'paper.pdf' })
  assert.equal(await formatOf('a-pdf'), 'pdf')
})

test('the derived format agrees with what the document-root map would say', async t => {
  await store(t)
  // These two answers came apart before: the project guessed `svg` while its
  // own root derived correctly, which is how a root ends up coerced to a format
  // its file is not.
  for (const [file, expected] of [
    ['paper.tex', 'svg'], ['notes.md', 'markdown'], ['talk.qmd', 'qmd'],
    ['page.html', 'html'], ['scan.pdf', 'pdf'],
  ]) {
    const name = `derive-${expected}-${file.replace(/\W/g, '')}`
    createProject({ name, mainFile: file })
    assert.equal(await formatOf(name), expected, `${file} should derive ${expected}`)
  }
})

test('an explicit format still wins over the file extension', async t => {
  await store(t)
  // A deck is `.html` on disk and `slides` as a project, and only the caller
  // knows. Derivation must not overrule that.
  createProject({ name: 'a-deck', mainFile: 'index.html', format: 'slides' })
  assert.equal(await formatOf('a-deck'), 'slides')
})

test('a project with no main file is still svg', async t => {
  await store(t)
  // The last resort is unchanged. Several existing callers create a project
  // before they know its main file.
  createProject({ name: 'no-main', title: 'No Main' })
  assert.equal(await formatOf('no-main'), 'svg')
})

test('an unrecognised extension is still svg, not undefined', async t => {
  await store(t)
  // formatForDocumentPath returns null for a non-document. The chain must land
  // on svg rather than writing a project with no format at all, which would
  // read as a missing field to everything downstream.
  createProject({ name: 'odd', mainFile: 'data.csv' })
  assert.equal(await formatOf('odd'), 'svg')
})

test('a LaTeX project created the old way is untouched', async t => {
  await store(t)
  // Every existing caller that omits `format` passes a .tex main file or none.
  // Both must still be svg, or this change is a drive-by behaviour change.
  createProject({ name: 'paper', mainFile: 'main.tex' })
  assert.equal(await formatOf('paper'), 'svg')
})
