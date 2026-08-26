/**
 * The server answers "what documents does this project have" from its tree.
 *
 * This is the adapter, and it is the half that nearly shipped broken. The graph
 * itself is covered in `document-roots.test.mjs`; what is asserted here is that
 * the server can run it **where the server actually keeps its files**.
 *
 * `projects/<name>/source` is a materialized directory and **not a git work
 * tree** — measured on the live box, `git rev-parse` there reports "not a git
 * repository" and `git ls-files` lists nothing. A first version of this
 * computation shelled out to `ls-files`, which would have answered "this project
 * has no documents" on the one machine that serves them, silently, because an
 * empty list is an ordinary result.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { closeProjectStore, createProject, initProjectStore, projectDocumentRoots, sourceDir } from './project-store.mjs'

async function project(name, files) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-docroots-'))
  await initProjectStore(root)
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  for (const [file, content] of Object.entries(files)) {
    const path = join(sourceDir(name), file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

test('the server computes documents from a materialized tree with no git in it', async () => {
  const root = await project('paper-project', {
    'main.tex': String.raw`\documentclass{article}
\begin{document}
\input{sections/intro}
\includegraphics{figures/plot.png}
\end{document}`,
    'sections/intro.tex': String.raw`\section{Intro}`,
    'figures/plot.png': 'png bytes',
    'notes.md': '# Notes',
  })
  try {
    const roots = await projectDocumentRoots('paper-project')
    assert.deepEqual(roots.map(r => r.path).sort(), ['main.tex', 'notes.md'],
      'the included section and the figure are not documents; the two roots are')
    assert.equal(roots.find(r => r.path === 'main.tex').format, 'svg')
    assert.equal(roots.find(r => r.path === 'notes.md').format, 'markdown')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('adding a document to the tree changes the answer, with nothing re-declared', async () => {
  // The whole point of computing it. The stored field is written once at link
  // time and nothing recomputes it, so a project's idea of its documents was a
  // snapshot of the moment somebody linked it.
  const root = await project('growing', { 'first.tex': String.raw`\documentclass{article}` })
  try {
    assert.deepEqual((await projectDocumentRoots('growing')).map(r => r.path), ['first.tex'])
    writeFileSync(join(sourceDir('growing'), 'second.tex'), String.raw`\documentclass{article}`)
    assert.deepEqual((await projectDocumentRoots('growing')).map(r => r.path).sort(), ['first.tex', 'second.tex'],
      'the new paper is a document immediately, without anyone declaring it')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project whose tree is empty has no documents, and does not throw', async () => {
  const root = await project('empty', {})
  try {
    assert.deepEqual(await projectDocumentRoots('empty'), [])
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
