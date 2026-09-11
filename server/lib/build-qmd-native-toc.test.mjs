import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildQmdDocument } from './build-qmd.mjs'
import { closeProjectStore, createProject, initProjectStore, outputDir, sourceDir } from './project-store.mjs'

const EXTENSION = fileURLToPath(new URL('../../extensions/tlda/_extensions/tlda', import.meta.url))
const hasQuarto = (() => {
  try { execFileSync('sh', ['-c', 'command -v quarto'], { stdio: 'ignore' }); return true } catch { return false }
})()

// A real whole-project build through `buildQmdDocument`, so the assertion is on
// what the native `type: tlda` branch actually leaves in output/ — not on a
// helper called directly. Deleting that branch's ToC write fails this test.
test('a native tlda project build emits toc.json with the rendered headings', { timeout: 300_000, skip: hasQuarto ? false : 'quarto not on PATH' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-native-toc-build-'))
  const project = 'native-toc-fixture'
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: 'index.qmd', format: 'qmd', documentRoots: ['index.qmd'] })

    const src = sourceDir(project)
    mkdirSync(join(src, '_extensions'), { recursive: true })
    cpSync(EXTENSION, join(src, '_extensions', 'tlda'), { recursive: true })
    writeFileSync(join(src, '_quarto.yml'), [
      'project:',
      '  type: tlda',
      'book:',
      '  title: "Fixture Book"',
      '  chapters:',
      '    - index.qmd',
      '    - chapter.qmd',
      '',
    ].join('\n'))
    writeFileSync(join(src, 'index.qmd'), '# Fixture Book\n\nOpening text.\n')
    writeFileSync(join(src, 'chapter.qmd'), '# Sampling\n\n## Simple random samples\n\nBody.\n')

    const log = []
    await buildQmdDocument(project, (line) => log.push(String(line)))

    const out = outputDir(project)
    const tocPath = join(out, 'toc.json')
    assert.equal(
      existsSync(tocPath),
      true,
      'the native branch must leave toc.json in output/; without it the ToC panel reports "No headings found"',
    )
    const toc = JSON.parse(readFileSync(tocPath, 'utf8'))
    assert.ok(Array.isArray(toc) && toc.length > 0, `toc.json must not be empty, got ${JSON.stringify(toc)}`)
    const titles = toc.map((entry) => entry.title).join(' | ')
    assert.match(titles, /Sampling/, `expected a rendered heading in the toc, got ${titles}`)

    // The fixture really did take the native path, so a pass cannot come from
    // the per-artifact fallback having written the file instead. That branch is
    // the only one that logs this line.
    assert.match(
      log.join('\n'),
      /rendered tlda project with \d+ chapter\(s\) and \d+ deck\(s\)/,
      'fixture must have built through the native tlda-project branch',
    )
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
