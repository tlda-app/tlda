import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { copyBuildOutputToPreview } from './publish-copy.mjs'

const TLDA = new URL('../..', import.meta.url).pathname
const CONFIG = join(TLDA, 'config/deployments/preview-store')

function anOutputDir() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-output-'))
  mkdirSync(join(dir, 'book'), { recursive: true })
  mkdirSync(join(dir, 'app', 'book'), { recursive: true })
  mkdirSync(join(dir, 'static', 'book'), { recursive: true })
  writeFileSync(join(dir, 'book', 'index.html'), '<html><head></head><body>a page</body></html>')
  writeFileSync(join(dir, 'app', 'book', 'index.html'), '<html><head></head><body>canvas page</body></html>')
  writeFileSync(join(dir, 'static', 'book', 'index.html'), '<html><head></head><body>static page</body></html>')
  writeFileSync(join(dir, 'page-info.json'), JSON.stringify([{ file: 'app/book/index.html', width: 800, height: 1000, title: 'A page' }]))
  writeFileSync(join(dir, 'document-manifest.json'), JSON.stringify({ version: 1, kind: 'tlda-document', pages: [{ file: 'app/book/index.html', width: 800, height: 1000 }] }))
  return dir
}

test('the copy carries the build, the app, and this destination’s config', async () => {
  const outputDir = anOutputDir()
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-served-')), 'site')
  const result = await copyBuildOutputToPreview({
    outputDir, staticDir, distDir: join(TLDA, 'dist'), configDir: CONFIG,
    document: { name: 'a-book', record: { name: 'a-book', pages: 1, format: 'qmd' } },
  })

  // The build's own files, at the root, where the loader asks for them.
  assert.ok(existsSync(join(staticDir, 'book', 'index.html')))
  assert.ok(existsSync(join(staticDir, 'page-info.json')))
  assert.ok(existsSync(join(staticDir, 'document-manifest.json')))
  // The application, and one shell that names this destination.
  assert.ok(existsSync(join(staticDir, 'app.html')))
  assert.match(readFileSync(join(staticDir, 'app.html'), 'utf8'), /window\.__TLDA_CONFIG__=/)
  const staticPage = readFileSync(join(staticDir, 'static', 'book', 'index.html'), 'utf8')
  assert.match(staticPage, /static page/)
  assert.match(staticPage, /class="presentation-mode-switch" href="\/app\/book\/index\.html"[^>]*>App<\/a>/)
  assert.match(result.store, /^wss:\/\//)
  // The manifest, because a file server has no API to ask for the document.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(staticDir, 'manifest.json'), 'utf8')).documents), ['a-book'])
})

test('a second copy replaces the first rather than merging into it', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-served-')), 'site')
  const document = { name: 'a-book', record: { name: 'a-book', pages: 1, format: 'qmd' } }
  const first = anOutputDir()
  writeFileSync(join(first, 'withdrawn.html'), 'a page that goes away')
  await copyBuildOutputToPreview({ outputDir: first, staticDir, distDir: join(TLDA, 'dist'), configDir: CONFIG, document })
  assert.ok(existsSync(join(staticDir, 'withdrawn.html')))

  await copyBuildOutputToPreview({ outputDir: anOutputDir(), staticDir, distDir: join(TLDA, 'dist'), configDir: CONFIG, document })
  assert.equal(existsSync(join(staticDir, 'withdrawn.html')), false, 'a withdrawn page must not survive in the copy')
  assert.ok(existsSync(join(staticDir, 'book', 'index.html')))
})

test('no build output is refused, and the copy that is serving is left alone', async () => {
  const staticDir = join(mkdtempSync(join(tmpdir(), 'preview-served-')), 'site')
  const document = { name: 'a-book', record: { name: 'a-book', pages: 1, format: 'qmd' } }
  await copyBuildOutputToPreview({ outputDir: anOutputDir(), staticDir, distDir: join(TLDA, 'dist'), configDir: CONFIG, document })

  await assert.rejects(
    () => copyBuildOutputToPreview({ outputDir: join(tmpdir(), 'not-a-build-output-dir'), staticDir, distDir: join(TLDA, 'dist'), configDir: CONFIG, document }),
    /no build output/,
  )
  assert.ok(existsSync(join(staticDir, 'book', 'index.html')), 'the previous copy must keep serving')
})
