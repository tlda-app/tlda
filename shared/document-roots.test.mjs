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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { documentRootsIn, formatForDocumentPath } from './document-roots.mjs'

test('the graph works on a listing with no git anywhere', async () => {
  // The case that nearly shipped broken. The server's projects/<name>/source is
  // a MATERIALIZED DIRECTORY, not a git work tree -- measured on the live box,
  // `git ls-files` there exits non-zero and lists nothing. A version that only
  // knew how to run `ls-files` would have answered "this project has no
  // documents" on the one machine that serves them, and answered it silently.
  //
  // So the graph takes the listing and a reader, and this drives it with
  // neither a repo nor a filesystem.
  const tree = {
    'main.tex': String.raw`\documentclass{article}\begin{document}\input{ch1}\includegraphics{fig.png}\end{document}`,
    'ch1.tex': String.raw`\section{One}`,
    'fig.png': 'png bytes',
    'notes.md': '# Notes',
  }
  const roots = await documentRootsIn(Object.keys(tree), file => tree[file] ?? null)
  assert.deepEqual(roots.map(root => root.path).sort(), ['main.tex', 'notes.md'])
})

test('a document\'s format comes from the file, not from a literal', () => {
  // The chat click-adopt path appended `format: 'markdown'` for whatever was
  // clicked, so a .tex adopted as a root was recorded as markdown -- which then
  // selected the markdown closure for it and lost its figures by a second route.
  assert.equal(formatForDocumentPath('paper.tex'), 'svg')
  assert.equal(formatForDocumentPath('notes.md'), 'markdown')
  assert.equal(formatForDocumentPath('lecture.qmd'), 'qmd')
  assert.equal(formatForDocumentPath('deck.html'), 'html')
  assert.equal(formatForDocumentPath('sub/dir/Paper.TEX'), 'svg', 'case and directory do not change the answer')
  // Not a document at all, so not adoptable as one.
  assert.equal(formatForDocumentPath('figures/plot.png'), null)
  assert.equal(formatForDocumentPath(''), null)
})


// The listing is an input to the graph, so the test supplies one. This walks the
// real files it just wrote -- the point is to exercise the graph over a real
// tree, not to stub it.
function listing(dir) {
  const out = []
  const walk = (sub) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const rel = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk('')
  return out
}

const rootsIn = dir => documentRootsIn(listing(dir), file => readFileSync(join(dir, file), 'utf8'))

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
    assert.deepEqual(paths(await rootsIn(dir)), ['paper.tex'])
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
    assert.deepEqual(paths(await rootsIn(dir)), ['a.tex', 'b.tex'])
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
    assert.deepEqual(paths(await rootsIn(dir)), ['book/main.tex'])
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
    assert.deepEqual(paths(await rootsIn(dir)), ['paper.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('every format takes the same rule, and several documents are several documents', async () => {
  const dir = repo({
    'paper.tex': String.raw`\documentclass{article}\begin{document}x\end{document}`,
    'notes.md': '# Notes\n\n![fig](fig.png)\n',
    'fig.png': 'not really a png',
  })
  try {
    const roots = await rootsIn(dir)
    assert.deepEqual(paths(roots), ['notes.md', 'paper.tex'])
    assert.equal(roots.find(root => root.path === 'notes.md').format, 'markdown')
    assert.equal(roots.find(root => root.path === 'paper.tex').format, 'svg')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file outside the listing is not a document, whatever is on disk', async () => {
  // The listing is the caller's answer to "what is on the branch", and it is
  // what decides. The daemon passes `git ls-tree` of the tree it is publishing,
  // so untracked build output and editor scratch are not documents; the server
  // passes a walk of the materialized tree, which is that tree by construction.
  //
  // Asserted through the contract rather than through git, because a version of
  // this that shelled out to `ls-files` could not run on the server at all --
  // that directory is not a work tree.
  const dir = repo({ 'paper.tex': String.raw`\documentclass{article}` })
  try {
    writeFileSync(join(dir, 'stray.tex'), String.raw`\documentclass{article}`)
    const declared = await documentRootsIn(['paper.tex'], file => readFileSync(join(dir, file), 'utf8'))
    assert.deepEqual(paths(declared), ['paper.tex'], 'a file the listing omits is not a document')
    assert.deepEqual(paths(await rootsIn(dir)), ['paper.tex', 'stray.tex'],
      'and a listing that includes it makes it one -- the listing decides, not the extension')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a document that includes itself is still a document', async () => {
  // Left-recursive input is a broken document, not a chapter of something else.
  // Counting the self-edge would make it vanish from the project entirely.
  const dir = repo({ 'loop.tex': String.raw`\documentclass{article}\input{loop}` })
  try {
    assert.deepEqual(paths(await rootsIn(dir)), ['loop.tex'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
