import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  clientOpenKind,
  documentFormatForView,
  documentViewKind,
  pagesForView,
  projectInfoUrl,
  type DocumentManifest,
  type DocumentViewKind,
} from '../src/loaders/documentFormatRouting.ts'

const capabilities = { presentation: false, sourceMapping: false, searchableText: true }
const page = { file: 'page-1.html', width: 800, height: 1200 }
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const bookViewerSource = readFileSync(new URL('../src/BookViewer.tsx', import.meta.url), 'utf8')
const foreignOpenSource = readFileSync(new URL('../src/hooks/useDocAutoOpen.ts', import.meta.url), 'utf8')
function manifest(kind: DocumentViewKind, source = 'html', pages = [page]): DocumentManifest {
  return {
    source: { format: source, renderer: source === 'tex' ? 'latex' : 'identity' },
    document: { format: kind === 'slides' ? 'slides' : kind === 'html-pages' ? 'html' : 'paged' },
    pages,
    view: { kind, capabilities: { ...capabilities, presentation: kind === 'slides' } },
  }
}

test('LaTeX and PDF route through the shared SVG-page view', () => {
  for (const source of ['tex', 'pdf']) {
    assert.equal(documentViewKind(manifest('svg-pages', source)), 'svg-pages')
    assert.equal(documentFormatForView('svg-pages', source), source === 'pdf' ? 'pdf' : 'svg')
  }
})

test('Markdown, Quarto HTML, and identity HTML route through the shared HTML-page view', () => {
  for (const source of ['md', 'qmd', 'html']) {
    assert.equal(documentViewKind(manifest('html-pages', source)), 'html-pages')
    assert.equal(documentFormatForView('html-pages', source), 'html')
  }
})

test('slides and image pages keep their declared views', () => {
  assert.equal(documentViewKind(manifest('slides', 'qmd')), 'slides')
  assert.equal(documentFormatForView('slides', 'qmd'), 'slides')
  assert.equal(documentViewKind(manifest('image-pages', 'png')), 'image-pages')
  assert.equal(documentFormatForView('image-pages', 'png'), 'png')
})

test('the book open decision is part of the same client boundary', () => {
  assert.equal(clientOpenKind({ format: 'book' }), 'book')
  assert.equal(clientOpenKind({ documentFormat: 'book' }), 'book')
  assert.equal(clientOpenKind({ format: 'qmd', documentFormat: 'html' }), 'document')
})

test('a foreign slide view keeps its declared group and excludes the paired chapter', () => {
  const pages = [
    { ...page, file: 'chapter.html', variant: 'chapter' as const, group: 'lesson.qmd' },
    { ...page, file: 'deck.html', variant: 'slides' as const, group: 'lesson.qmd', slides: [] },
  ]
  assert.deepEqual(pagesForView(pages, 'slides').map(item => [item.file, item.group]), [['deck.html', 'lesson.qmd']])
  assert.deepEqual(pagesForView(pages, 'html-pages').map(item => item.file), ['chapter.html'])
})

test('member project metadata uses the configured store origin', () => {
  const url = projectInfoUrl('https://store.example.test', 'notes & slides')
  assert.equal(url, 'https://store.example.test/api/projects/notes%20%26%20slides')
  assert.notEqual(url, '/api/projects/notes%20%26%20slides')
})

test('BookViewer consumes the configured-store project URL', () => {
  assert.match(bookViewerSource, /fetch\(projectInfoUrl\(STORE_HTTP, member\.key\)\)/)
  assert.doesNotMatch(bookViewerSource, /fetch\(`?\/api\/projects\/\$\{encodeURIComponent\(member\.key\)\}/)
})

test('the standalone opener consumes the manifest router', () => {
  const loadDocument = appSource.slice(appSource.indexOf('async function loadDocument('), appSource.indexOf('function AppContent('))
  assert.match(loadDocument, /fetchDocumentManifest\(fullBasePath, signal\)/)
  assert.match(loadDocument, /loadDocumentByFormat\(\{[\s\S]*?manifest,[\s\S]*?targets,[\s\S]*?\}\)/)
})

test('the book opener consumes the manifest router in every document branch', () => {
  const loadMember = bookViewerSource.slice(bookViewerSource.indexOf('const loadMember ='), bookViewerSource.indexOf('useEffect(() =>'))
  assert.match(loadMember, /fetchDocumentManifest\(member\.basePath\)/)
  assert.equal(loadMember.match(/loadDocumentByFormat\(/g)?.length, 3)
})

test('the foreign-document opener consumes the manifest router', () => {
  const handleArrival = foreignOpenSource.slice(foreignOpenSource.indexOf('const handleDocArrived ='), foreignOpenSource.indexOf('// SSE connection'))
  assert.match(handleArrival, /fetchDocumentManifest\(basePath\)/)
  assert.match(handleArrival, /loadDocumentByFormat\(\{ name: event\.name, basePath, manifest, targets \}\)/)
})
