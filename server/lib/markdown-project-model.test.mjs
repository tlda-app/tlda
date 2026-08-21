import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scanMarkdownDependencyClosure } from '../../shared/markdown-deps.mjs'
import { renderMarkdownColumnHtml } from './build-markdown.mjs'
import { listDocumentColumns, listMarkdownProjectDocuments, markdownProjectRootColumn } from './document-columns.mjs'
import { closeProjectStore, initProjectStore } from './project-store.mjs'

test('A markdown project document is its main file; the closure is its file scope', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-markdown-project-'))
  const projects = join(root, 'projects')
  const source = join(projects, 'notes', 'source')
  mkdirSync(join(source, 'chapters'), { recursive: true })
  mkdirSync(join(source, 'assets'), { recursive: true })
  writeFileSync(join(source, 'README.md'), [
    '# Main',
    '[Chapter](chapters/one.md)',
    '![Plot](assets/plot.png)',
    '[External](https://example.com/outside.md)',
  ].join('\n'))
  writeFileSync(join(source, 'chapters', 'one.md'), [
    '# One',
    '[Main](../README.md#main)',
    '[Appendix](appendix.markdown)',
    '[Data](../assets/data.json)',
    '[Generated PDF](../assets/generated.pdf)',
    '[Positron extension](../assets/classroom.vsix)',
    '[Unsupported](../assets/unsupported.bin)',
  ].join('\n'))
  writeFileSync(join(source, 'chapters', 'appendix.markdown'), '# Appendix\n[Cycle](one.md)\n')
  writeFileSync(join(source, 'assets', 'plot.png'), Buffer.from([0, 1, 2]))
  writeFileSync(join(source, 'assets', 'data.json'), '{"ok":true}\n')
  writeFileSync(join(source, 'assets', 'generated.pdf'), Buffer.from([3, 4, 5]))
  writeFileSync(join(source, 'assets', 'classroom.vsix'), Buffer.from([9, 10, 11]))
  writeFileSync(join(source, 'assets', 'unsupported.bin'), Buffer.from([6, 7, 8]))

  await initProjectStore(projects)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })

  const closure = scanMarkdownDependencyClosure('README.md', source)
  assert.deepEqual(closure.markdown, ['README.md', 'chapters/appendix.markdown', 'chapters/one.md'])
  assert.deepEqual(closure.assets, ['assets/classroom.vsix', 'assets/data.json', 'assets/plot.png'])

  const columns = await listDocumentColumns('notes', {
    project: { name: 'notes', format: 'markdown', mainFile: 'README.md' },
    srcDir: source,
  })
  // The closure is the project's asset and file scope. It is NOT this document's
  // page list: a linked document is another document, and being reachable from
  // the main file is not how something becomes a page of it. Chapters come from
  // a declared book format and from nowhere else.
  assert.deepEqual(
    columns.map(({ sourceFile, outputFile }) => ({ sourceFile, outputFile })),
    [{ sourceFile: 'README.md', outputFile: 'index.html' }],
  )

  const documents = await listMarkdownProjectDocuments('notes', {
    project: { name: 'notes', format: 'markdown', mainFile: 'README.md' },
    srcDir: source,
  })
  assert.deepEqual(
    documents.map(({ sourceFile, outputFile }) => ({ sourceFile, outputFile })),
    [
      { sourceFile: 'README.md', outputFile: 'index.html' },
      { sourceFile: 'chapters/appendix.markdown', outputFile: 'chapters/appendix.html' },
      { sourceFile: 'chapters/one.md', outputFile: 'chapters/one.html' },
    ],
  )
})

test('mixed-project Markdown roots retain distinct render identities', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-mixed-markdown-roots-'))
  const source = join(root, 'source')
  mkdirSync(join(source, 'reviews'), { recursive: true })
  writeFileSync(join(source, 'reviews', 'editor.md'), '# Editor response\n\nEditor body.\n')
  writeFileSync(join(source, 'reviews', 'referee.md'), '# Referee response\n\nReferee body.\n')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const editor = await markdownProjectRootColumn('paper', 'reviews/editor.md', { srcDir: source })
  const referee = await markdownProjectRootColumn('paper', 'reviews/referee.md', { srcDir: source })
  assert.equal(editor.outputFile, 'reviews/editor.html')
  assert.equal(referee.outputFile, 'reviews/referee.html')
  assert.notEqual(editor.outputFile, referee.outputFile)

  const editorHtml = renderMarkdownColumnHtml({
    source: '# Editor response\n\nEditor body.\n',
    title: editor.title,
    projectName: 'paper',
    sourceFile: editor.sourceFile,
    mainFile: 'main.tex',
  })
  const refereeHtml = renderMarkdownColumnHtml({
    source: '# Referee response\n\nReferee body.\n',
    title: referee.title,
    projectName: 'paper',
    sourceFile: referee.sourceFile,
    mainFile: 'main.tex',
  })
  assert.match(editorHtml, /Editor body\./)
  assert.doesNotMatch(editorHtml, /Referee body\./)
  assert.match(refereeHtml, /Referee body\./)
})

test('Markdown member links target project routes while external URLs stay external', () => {
  const html = renderMarkdownColumnHtml({
    source: [
      '[Main](../README.md#main)',
      '[Sibling](appendix.markdown?view=full#appendix)',
      '[External](https://example.com/outside.md)',
    ].join('\n'),
    title: 'Chapter',
    sourceFile: 'chapters/one.md',
    mainFile: 'README.md',
    projectName: 'my notes',
  })

  assert.match(html, /href="\/docs\/my%20notes\/index\.html#main"/)
  assert.match(html, /href="\/docs\/my%20notes\/chapters\/appendix\.html\?view=full#appendix"/)
  assert.match(html, /href="https:\/\/example\.com\/outside\.md"/)
})

test('Markdown headings retain explicit ids and their source-line anchors', () => {
  const html = renderMarkdownColumnHtml({
    source: '# Course start {#sec-course-start}\n\nRead this first.',
    title: 'Course',
  })

  assert.match(html, /<span id="line-1"><\/span><h1 id="sec-course-start"/)
  assert.doesNotMatch(html, /<h1 id="line-1"/)
  assert.doesNotMatch(html, />Course start \{#sec-course-start\}<\/h1>/)
})

test('Markdown columns render with the parent project macros', () => {
  const html = renderMarkdownColumnHtml({
    source: 'The fitted value is $\\hmu$ with error $\\abs{x}$.',
    title: 'Scratch note',
    macros: { '\\hmu': '\\widehat{\\mu}' },
  })

  assert.match(html, /class="katex"/)
  assert.doesNotMatch(html, /class="math-error"/)
  assert.match(html, /<mover accent="true">/)
  assert.match(html, /<mo fence="true">∣<\/mo><mi>x<\/mi><mo fence="true">∣<\/mo>/)

  const overridden = renderMarkdownColumnHtml({
    source: '$$\\newcommand{\\hmu}{\\operatorname{LOCAL}}$$\n\n$\\hmu$',
    title: 'Scratch note',
    macros: { '\\hmu': '\\widehat{\\mu}' },
  })
  assert.match(overridden, /<mi mathvariant="normal">LOCAL<\/mi>/)
  assert.doesNotMatch(overridden, /<mover accent="true">/)
})
