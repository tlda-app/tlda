#!/usr/bin/env node

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { initProjectStore, createProject, writeSourceFile, outputDir } from '../server/lib/project-store.mjs'
import { buildSlides } from '../server/lib/format-builders.mjs'
import { generateSlidesPageInfo } from '../server/lib/slides-parser.mjs'
import { collectHtmlArtifactFiles, htmlArtifactMainForSource } from '../cli/lib/html-artifact-files.mjs'

const DECK_HTML = `<!doctype html>
<html>
<head>
<script>
Reveal.initialize({
  width: 1234,
  height: 777
})
</script>
</head>
<body>
<div id="deck" class='slides deck-root'>
  <section id="title-slide" class="quarto-title-block">
    <h1>Deck Title</h1>
  </section>
  <section>
    <section id='section-title' class='title-slide slide level1'>
      <h1>Group Title</h1>
    </section>
    <section id="first-real" class="slide level2">
      <h2>First Real Slide</h2>
      <img src="deck_files/figure-revealjs/plot.svg">
    </section>
  </section>
</div>
</body>
</html>`

describe('slides format', () => {
  let projectsDir

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'tlda-slides-test-'))
    initProjectStore(projectsDir)
  })

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true })
  })

  it('parses reveal slide containers with extra attributes and single-quoted classes', () => {
    const pageInfo = generateSlidesPageInfo(DECK_HTML, 'deck.html')

    assert.equal(pageInfo.length, 3)
    assert.deepEqual(
      pageInfo.map(p => [p.title, p.indexh, p.indexv, p.width, p.height]),
      [
        ['Deck Title', 0, 0, 1234, 777],
        ['Group Title', 1, 0, 1234, 777],
        ['First Real Slide', 1, 1, 1234, 777],
      ],
    )
  })

  it('copies slide asset directories into output while generating page-info', async () => {
    createProject({ name: 'deck', title: 'Deck', format: 'slides' })
    writeSourceFile('deck', 'deck.html', DECK_HTML)
    writeSourceFile('deck', 'deck_files/figure-revealjs/plot.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeSourceFile('deck', 'images/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await buildSlides('deck')

    const out = outputDir('deck')
    assert.ok(existsSync(join(out, 'deck.html')))
    assert.ok(existsSync(join(out, 'deck_files/figure-revealjs/plot.svg')))
    assert.ok(existsSync(join(out, 'images/photo.png')))

    const pageInfo = JSON.parse(readFileSync(join(out, 'page-info.json'), 'utf8'))
    assert.equal(pageInfo.length, 3)
    assert.equal(pageInfo[2].title, 'First Real Slide')
  })

  it('collects only the rendered slides artifact closure for upload', () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-slides-artifact-'))
    try {
      mkdirSync(join(root, 'site_libs'), { recursive: true })
      mkdirSync(join(root, 'deck_files/figure-revealjs'), { recursive: true })
      mkdirSync(join(root, 'figures'), { recursive: true })
      mkdirSync(join(root, '_extensions/tlda'), { recursive: true })

      writeFileSync(join(root, 'deck.html'), `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="site_libs/reveal.css">
</head>
<body>
  <section data-background-image="deck_files/figure-revealjs/bg.svg">
    <img src="deck_files/figure-revealjs/plot.svg">
  </section>
</body>
</html>`)
      writeFileSync(join(root, 'site_libs/reveal.css'), `
@font-face { src: url("font.woff2"); }
.theme { background-image: url("../deck_files/figure-revealjs/bg.svg"); }
`)
      writeFileSync(join(root, 'site_libs/font.woff2'), 'font')
      writeFileSync(join(root, 'deck_files/figure-revealjs/plot.svg'), '<svg/>')
      writeFileSync(join(root, 'deck_files/figure-revealjs/bg.svg'), '<svg/>')
      writeFileSync(join(root, 'figures/unused.png'), 'unused')
      writeFileSync(join(root, '_extensions/tlda/_extension.yml'), 'unused')

      const artifact = collectHtmlArtifactFiles(root)

      assert.deepEqual(artifact.missing, [])
      assert.deepEqual(
        artifact.paths,
        [
          'deck.html',
          'site_libs/reveal.css',
          'deck_files/figure-revealjs/bg.svg',
          'deck_files/figure-revealjs/plot.svg',
          'site_libs/font.woff2',
        ],
      )
      assert.equal(artifact.files.length, artifact.paths.length)
      assert.ok(!artifact.paths.includes('figures/unused.png'))
      assert.ok(!artifact.paths.includes('_extensions/tlda/_extension.yml'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives rendered HTML entrypoints from Quarto source filenames', () => {
    assert.equal(htmlArtifactMainForSource('talk.qmd'), 'talk.html')
    assert.equal(htmlArtifactMainForSource('slides/deck.ipynb'), 'slides/deck.html')
    assert.equal(htmlArtifactMainForSource('already.html'), 'already.html')
    assert.equal(htmlArtifactMainForSource(null), null)
  })
})
