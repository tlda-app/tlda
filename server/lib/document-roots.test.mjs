/**
 * The documents a project has are computed from its branch, not stored.
 *
 * Skip, 2026-08-26: *"document roots is just a computed property of the git
 * branch"* / *"create the directed include graph. roots are roots"* / *"xr =
 * link"*.
 *
 * Real files in a real git repo rather than a stubbed filesystem, because the
 * subject is `git ls-files` on a branch. Stubbing the listing would test the
 * graph and skip the half that says what is on the branch at all.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { computeDocumentRoots } from './document-roots.mjs'

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docroots-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@tlda'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  return dir
}

const paths = roots => roots.map(root => root.path).sort()

test('an included chapter is not a document', async () => {
  const dir = repo({
    'paper.tex': String.raw`\documentclass{article}\begin{document}\input{intro}\end{document}`,
    'intro.tex': String.raw`\section{Intro}`,
  })
  try {
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['paper.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('xr is a LINK, not an include: two papers that reference each other are two documents', async () => {
  // The case that makes this rule load-bearing. If \externaldocument were an
  // include edge these two would form a cycle with nothing pointing in from
  // outside, the graph would report ZERO roots, and every document in the
  // project would disappear at once.
  const dir = repo({
    'a.tex': String.raw`\documentclass{article}\usepackage{xr}\externaldocument{b}\begin{document}x\end{document}`,
    'b.tex': String.raw`\documentclass{article}\usepackage{xr}\externaldocument{a}\begin{document}y\end{document}`,
  })
  try {
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['a.tex', 'b.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an include is resolved relative to the file that writes it', async () => {
  // An edge resolved against the project root instead would not match, and an
  // unmatched edge does not merely lose a link -- it promotes the included file
  // to a document, so a chapter appears in the project as a paper of its own.
  const dir = repo({
    'book/main.tex': String.raw`\documentclass{book}\begin{document}\input{ch1}\end{document}`,
    'book/ch1.tex': String.raw`\chapter{One}`,
  })
  try {
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['book/main.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('assets are never documents, whoever points at them', async () => {
  const dir = repo({
    'paper.tex': String.raw`\documentclass{article}\usepackage{local}\includegraphics{fig.png}\bibliography{refs}`,
    'local.sty': '% package',
    'fig.png': 'not really a png',
    'refs.bib': '@article{x}',
  })
  try {
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['paper.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('every format takes the same rule, and several documents are several documents', async () => {
  const dir = repo({
    'paper.tex': String.raw`\documentclass{article}\begin{document}x\end{document}`,
    'notes.md': '# Notes\n\n![fig](fig.png)\n',
    'fig.png': 'not really a png',
  })
  try {
    const roots = await computeDocumentRoots(dir)
    assert.deepEqual(paths(roots), ['notes.md', 'paper.tex'])
    assert.equal(roots.find(root => root.path === 'notes.md').format, 'markdown')
    assert.equal(roots.find(root => root.path === 'paper.tex').format, 'svg')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an untracked file is not a document', async () => {
  // The reason this reads the branch rather than walking the directory: a walk
  // reports build output and editor scratch as documents.
  const dir = repo({ 'paper.tex': String.raw`\documentclass{article}` })
  try {
    writeFileSync(join(dir, 'stray.tex'), String.raw`\documentclass{article}`)
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['paper.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a document that includes itself is still a document', async () => {
  // Left-recursive input is a broken document, not a chapter of something else.
  // Counting the self-edge would make it vanish from the project entirely.
  const dir = repo({ 'loop.tex': String.raw`\documentclass{article}\input{loop}` })
  try {
    assert.deepEqual(paths(await computeDocumentRoots(dir)), ['loop.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
