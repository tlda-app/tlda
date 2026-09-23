import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  updateProject,
} from './project-store.mjs'
import {
  AUTHORING_EXPORT_VERSION,
  applyMeasuredLines,
  authoringExport,
  linearizeChapterHtml,
  linearizeDeckHtml,
  markRenderedLines,
  resolveAuthoringExportTarget,
} from './authoring-export.mjs'

const DECK_HTML = `<html><body><div class="reveal"><div class="slides">
<section id="s1" class="slide level2"><h2>First</h2><p>plain text</p></section>
<section id="s2" class="slide level2"><h2>Visual</h2>
<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>
<div class="r-stack"><div><p>frame one</p></div><div><p>frame two</p></div></div>
</section>
<section id="s3" class="slide level2"><h2>Single</h2><img src="fig.svg" alt="a figure"></section>
</div></div></body></html>`

const CHAPTER_HTML = `<html><body><main><h2>Title</h2><p>before</p>
<figure><img src="fig-1.svg" alt="computed plot"><figcaption>Figure 1</figcaption></figure>
<p>after</p></main></body></html>`

test('deck linearization selects per-frame text with frame image refs', () => {
  const deck = linearizeDeckHtml(DECK_HTML, 'deck.html')
  assert.equal(deck.kind, 'deck')
  assert.equal(deck.slides.length, 3)
  // A non-visual slide carries text with no image ref: the canonical
  // capturer never screenshots it.
  const plainTexts = deck.slides[0].frames.map((frame) => frame.text)
  assert.equal(plainTexts.length, 1)
  assert.ok(plainTexts[0].includes('First') && plainTexts[0].includes('plain text'), plainTexts[0])
  assert.equal(deck.slides[0].frames[0].image, null)
  const visual = deck.slides[1]
  assert.equal(visual.frames.length, 2)
  assert.equal(visual.frames[0].text, 'frame one')
  assert.equal(visual.frames[1].text, 'frame two')
  assert.equal(visual.frames[1].image, 'frames/s2-frame-2.png')
  // A single-frame visual slide gets a bare `${id}.png`, matching the
  // capturer's non-fragmented suffix.
  assert.equal(deck.slides[2].frames[0].image, 'frames/s3.png')
})

test('chapter linearization keeps document order with figures inline', () => {
  const chapter = linearizeChapterHtml(CHAPTER_HTML)
  assert.equal(chapter.kind, 'chapter')
  const order = chapter.markdown
  assert.ok(order.indexOf('Title') < order.indexOf('before'))
  assert.ok(order.indexOf('before') < order.indexOf('![computed plot](fig-1.svg)'))
  assert.ok(order.indexOf('![computed plot](fig-1.svg)') < order.indexOf('after'))
  assert.deepEqual(chapter.images, [{ src: 'fig-1.svg', alt: 'computed plot' }])
})

test('rendered line markers distinguish wraps from hard breaks', () => {
  const marked = markRenderedLines('a long bullet\ncontinued here', 'a long bullet continued here')
  assert.ok(marked.includes('[wrap]'), marked)
  const hard = markRenderedLines('first line\nsecond line', 'first line\nsecond line')
  assert.ok(hard.includes('[hard break]'), hard)
})

test('settled-DOM measurement inserts [wrap] at each exact browser boundary', () => {
  // The counterexample: offline text is two blocks with no internal breaks,
  // but the settled browser split the first block across 4 rendered rows and
  // kept the second on 1. The sidecar names the precise word partition, so
  // each boundary names the words on both sides; block boundaries stay hard
  // breaks.
  const frameText = 'The sampling distribution estimate we used was Binomial for n=625 and theta hat. On the left, we have the population.'
  const measured = [
    {
      tag: 'li',
      lines: [
        'The sampling distribution estimate we’ve used was',
        'for n=625 and theta hat. On the left, we have',
        'the population and theta hat again here',
        'for the fourth rendered row of this bullet',
      ],
      text: 'The sampling distribution estimate we used was Binomial for n=625 and theta hat.',
    },
    { tag: 'li', lines: ['On the left, we have the population.'], text: 'On the left, we have the population.' },
  ]
  const marked = applyMeasuredLines(frameText, measured)
  assert.equal((marked.match(/\[wrap\]/g) || []).length, 3, marked)
  assert.ok(marked.includes('was [wrap]\nfor n=625'), marked)
  assert.ok(marked.includes('\n[hard break]\nOn the left'), marked)
  // A missing sidecar degrades to the offline text unchanged.
  assert.equal(applyMeasuredLines(frameText, null), frameText)
  assert.equal(applyMeasuredLines(frameText, []), frameText)
  // A legacy count-only sidecar degrades to the count marker, not a failure.
  assert.ok(applyMeasuredLines(frameText, [{ tag: 'li', lines: 4, text: frameText }]).includes('[wrap ×4]'))
})

test('export resolves the built revision, caches, and refuses a stale one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-authoring-export-'))
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'expo', mainFile: 'main.qmd' })
  writeFileSync(
    join(root, 'expo', 'output', 'page-info.json'),
    JSON.stringify([{ file: 'app/book/chapters/ch.html', source: { file: 'chapters/ch.qmd' } }]),
  )
  mkdirSync(join(root, 'expo', 'output', 'app', 'book', 'chapters'), { recursive: true })
  writeFileSync(join(root, 'expo', 'output', 'app', 'book', 'chapters', 'ch.html'), CHAPTER_HTML, { flag: 'w' })
  await updateProject('expo', { sourceRevision: 'abc123' })

  const resolved = await resolveAuthoringExportTarget('expo', { document: 'chapters/ch.qmd' })
  assert.equal(resolved.builtRevision, 'abc123')
  assert.equal(resolved.page.file, 'app/book/chapters/ch.html')

  const first = await authoringExport('expo', { document: 'chapters/ch.qmd' })
  assert.equal(first.cache, 'miss')
  assert.equal(first.exporter.version, AUTHORING_EXPORT_VERSION)
  assert.ok(first.markdown.includes('before'))
  const second = await authoringExport('expo', { document: 'chapters/ch.qmd' })
  assert.equal(second.cache, 'hit')
  assert.equal(second.generatedAt, first.generatedAt)
  // A hit must not re-parse: replace the stored artifact's markdown with a
  // sentinel and confirm the hit returns the sentinel without touching the
  // (now rewritten) built HTML.
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { authoringExportCacheDir } = await import('./authoring-export.mjs')
  const hitCacheDir = authoringExportCacheDir('expo', 'abc123', 'chapters/ch.qmd')
  const exportPath = join(hitCacheDir, 'export.json')
  const stored = JSON.parse(readFileSync(exportPath, 'utf8'))
  stored.markdown = 'SENTINEL'
  stored.exporter.version = AUTHORING_EXPORT_VERSION
  writeFileSync(exportPath, JSON.stringify(stored))
  writeFileSync(join(root, 'expo', 'output', 'app', 'book', 'chapters', 'ch.html'), '<html><body><main><p>changed</p></main></body></html>')
  const third = await authoringExport('expo', { document: 'chapters/ch.qmd' })
  assert.equal(third.cache, 'hit')
  assert.equal(third.markdown, 'SENTINEL')

  await assert.rejects(
    authoringExport('expo', { document: 'chapters/ch.qmd', revision: 'stale-rev' }),
    /not .*stale-rev|refusing to export/i,
  )
  await assert.rejects(authoringExport('expo', { document: 'nope.qmd' }), /not a built document/)
})

test('a miss-time failure is stored inline with its evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-authoring-export-fail-'))
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'expofail', mainFile: 'main.qmd' })
  mkdirSync(join(root, 'expofail', 'output', 'app', 'book', 'decks'), { recursive: true })
  writeFileSync(
    join(root, 'expofail', 'output', 'page-info.json'),
    JSON.stringify([{ file: 'app/book/decks/d.html', source: { file: 'decks/d-slides.qmd' } }]),
  )
  writeFileSync(join(root, 'expofail', 'output', 'app', 'book', 'decks', 'd.html'), DECK_HTML)
  await updateProject('expofail', { sourceRevision: 'rev1' })

  // An explicit but absent path is a hard failure (stored inline): the
  // deployment claimed a linearizer exists and it does not.
  await assert.rejects(
    authoringExport('expofail', { document: 'decks/d-slides.qmd', linearizerPath: '/nonexistent/linearize.mjs' }),
    /frame capture failed/,
  )
  // With no explicit path and no _extensions copy in the project source, a
  // deck FAILS loudly: text-only cannot satisfy "every visual state". This is
  // the real QTM285 shape — its _extensions/tlda/ holds only the book project
  // extension, not linearize.mjs — so the deployment-owned path is delivery.
  await assert.rejects(
    authoringExport('expofail', { document: 'decks/d-slides.qmd' }),
    /no canonical linearizer/,
  )
  // A linearize.mjs in the project's own source _extensions tree resolves
  // without any explicit path — the installed-extension delivery (the working
  // talks consumer carries exactly such a copy via `quarto add`), no registry.
  mkdirSync(join(root, 'expofail', 'source', '_extensions', 'tlda'), { recursive: true })
  writeFileSync(join(root, 'expofail', 'source', '_extensions', 'tlda', 'linearize.mjs'), '// canonical')
  const { resolveLinearizerPath } = await import('./authoring-export.mjs')
  assert.equal(
    resolveLinearizerPath('expofail'),
    join(root, 'expofail', 'source', '_extensions', 'tlda', 'linearize.mjs'),
  )
  // Explicit wins when present; absent-explicit still resolves from source.
  assert.equal(resolveLinearizerPath('expofail', '/explicit/linearize.mjs'), '/explicit/linearize.mjs')
})
