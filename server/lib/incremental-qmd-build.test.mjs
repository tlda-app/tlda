import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildIncrementalQmd,
  qmdIncrementalRenderRoots,
  quartoBookRoots,
  writeSourceScopeFile,
} from './incremental-qmd-build.mjs'

// The shared acceptance source both adapters prove against: the bounded
// real-course copy (canonical home + Part 1 + first chapter of Part 2).
const ACCEPTANCE_SOURCE = '/Users/skip/work/qtm285-shared-acceptance'
const hasAcceptanceSource = existsSync(join(ACCEPTANCE_SOURCE, '_quarto.yml'))

const hasQuarto = (() => {
  try { execFileSync('sh', ['-c', 'command -v quarto'], { stdio: 'ignore' }); return true } catch { return false }
})()

// Real renders, minutes long on the 24-document acceptance book. Deliberate
// rather than automatic, following the deck-render control pattern: run with
// TLDA_QUARTO_RENDER_TESTS=1, and this control must pass before any
// build-path change ships.
const RENDER_CONTROL_SKIP = process.env.TLDA_QUARTO_RENDER_TESTS === '1'
  ? (!hasQuarto ? 'quarto not on PATH' : (!hasAcceptanceSource ? `acceptance source missing at ${ACCEPTANCE_SOURCE}` : false))
  : 'set TLDA_QUARTO_RENDER_TESTS=1 to run — real Quarto renders of the acceptance book; this control must pass before any build-path change ships'

test('empty destination is the first incremental run: no manifest means whole-project, not a separate path', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-engine-empty-'))
  try {
    assert.equal(qmdIncrementalRenderRoots(root, ['chapters/a.qmd']), null)
    assert.equal(qmdIncrementalRenderRoots(root, null), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('engine requires explicit inputs', async () => {
  await assert.rejects(
    buildIncrementalQmd({ sourceDir: null, outputDir: null, mainFiles: ['index.qmd'] }),
    /requires sourceDir and outputDir/,
  )
  await assert.rejects(
    buildIncrementalQmd({ sourceDir: '/tmp', outputDir: '/tmp/out', mainFiles: [] }),
    /requires mainFiles/,
  )
})

test('source scope file is written sorted, or skipped on null', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-engine-scope-'))
  try {
    assert.equal(writeSourceScopeFile(root, null), false)
    assert.equal(existsSync(join(root, 'relevant-files.json')), false)
    assert.equal(writeSourceScopeFile(root, ['b.qmd', 'a.qmd']), true)
    const written = JSON.parse(readFileSync(join(root, 'relevant-files.json'), 'utf8'))
    assert.deepEqual(written.files, ['a.qmd', 'b.qmd'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function hashTree(outDir) {
  const entries = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.isSymbolicLink()) continue
      const rel = relative(outDir, full).replace(/\\/g, '/')
      entries[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
    }
  }
  walk(outDir)
  return entries
}

function readJson(outDir, name) {
  return JSON.parse(readFileSync(join(outDir, name), 'utf8'))
}

test('CLI adapter and engine agree byte-for-byte on a clean acceptance build', { timeout: 3_600_000, skip: RENDER_CONTROL_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-engine-agree-'))
  const outCli = join(root, 'cli')
  const outEngine = join(root, 'engine')
  try {
    execFileSync('node', [
      fileURLToPath(new URL('../../bin/build-qmd-standalone.mjs', import.meta.url)),
      '--source', ACCEPTANCE_SOURCE, '--output', outCli,
      '--name', 'agree-cli', '--figure-stamp', '7',
    ], { stdio: 'pipe' })
    await buildIncrementalQmd({
      sourceDir: ACCEPTANCE_SOURCE,
      outputDir: outEngine,
      changedFiles: null,
      mainFiles: quartoBookRoots(ACCEPTANCE_SOURCE),
      name: 'agree-engine',
      log: () => {},
      figureStamp: 7,
      projectMeta: { format: 'qmd', mainFile: 'index.qmd' },
      sourceScopeFiles: null,
      onProjectUpdate: null,
    })
    assert.deepEqual(readJson(outEngine, 'page-info.json'), readJson(outCli, 'page-info.json'))
    assert.deepEqual(readJson(outEngine, 'toc.json'), readJson(outCli, 'toc.json'))
    assert.deepEqual(hashTree(outEngine), hashTree(outCli))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('incremental rebuild changes the edited chapter only; manifest and TOC identical', { timeout: 3_600_000, skip: RENDER_CONTROL_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-engine-incr-'))
  const src = join(root, 'src')
  const out = join(root, 'out')
  const EDITED = 'chapters/chapter-sampling.qmd'
  try {
    cpSync(ACCEPTANCE_SOURCE, src, { recursive: true })
    const first = await buildIncrementalQmd({
      sourceDir: src, outputDir: out, changedFiles: null,
      mainFiles: quartoBookRoots(src), name: 'incr-first', log: () => {},
      figureStamp: 7, projectMeta: { format: 'qmd', mainFile: 'index.qmd' },
      sourceScopeFiles: null, onProjectUpdate: null,
    })
    const beforeHtml = {}
    const beforePageInfo = readJson(out, 'page-info.json')
    for (const page of beforePageInfo) {
      beforeHtml[page.file] = readFileSync(join(out, page.file), 'utf8')
    }
    const beforeToc = readJson(out, 'toc.json')

    const editedPath = join(src, EDITED)
    writeFileSync(editedPath, `${readFileSync(editedPath, 'utf8')}\n\nIncremental probe sentence.\n`)
    const second = await buildIncrementalQmd({
      sourceDir: src, outputDir: out, changedFiles: [EDITED],
      mainFiles: quartoBookRoots(src), name: 'incr-second', log: () => {},
      figureStamp: 7, projectMeta: { format: 'qmd', mainFile: 'index.qmd' },
      sourceScopeFiles: null, onProjectUpdate: null,
    })
    assert.deepEqual(second.manifest, first.manifest)
    assert.deepEqual(readJson(out, 'toc.json'), beforeToc)
    const afterPageInfo = readJson(out, 'page-info.json')
    assert.deepEqual(afterPageInfo, beforePageInfo)
    const changedPages = []
    for (const page of afterPageInfo) {
      if (readFileSync(join(out, page.file), 'utf8') !== beforeHtml[page.file]) changedPages.push(page)
    }
    assert.ok(changedPages.length >= 1, 'the edited chapter must re-render')
    for (const page of changedPages) {
      assert.equal(page.source?.file, EDITED, `only the edited chapter may change, but ${page.file} changed`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
