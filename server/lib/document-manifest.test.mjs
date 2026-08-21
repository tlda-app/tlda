import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractPdfArtifacts } from './build-pdf.mjs'
import { createDocumentManifest, normalizeDocumentManifest, writeDocumentManifest } from './document-manifest.mjs'
import { ProjectFilesStoreClient } from './project-files-store-client.mjs'

function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

test('common manifest validates artifact paths and projects page-info for compatibility', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tlda-document-manifest-'))
  const manifest = createDocumentManifest(
    { sourceFormat: 'md', renderer: 'markdown', documentFormat: 'html', mainFile: 'notes.md' },
    [{ file: 'notes.html', width: 800, height: 1000 }],
    { sourceMapping: 'page-source' },
  )
  writeDocumentManifest(outDir, manifest, { writePageInfo: true })
  assert.equal(existsSync(join(outDir, 'document-manifest.json')), true)
  assert.equal(JSON.parse(readFileSync(join(outDir, 'page-info.json')))[0].file, 'notes.html')
  assert.throws(() => normalizeDocumentManifest({
    version: 1, kind: 'tlda-document', pages: [{ file: '../outside', width: 1, height: 1 }],
  }), /stay inside document output/)
})

test('native PDF extraction preserves the PDF and creates display and searchable-text artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-pdf-extraction-'))
  const pdfPath = join(root, 'book.pdf')
  const outDir = join(root, 'output')
  writeFileSync(pdfPath, minimalPdf('Canonical PDF text'))

  const manifest = await extractPdfArtifacts({
    pdfPath, outDir, target: 'book', outputPdf: 'book.pdf',
    project: { format: 'pdf', sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged', mainFile: 'book.pdf' },
  })

  assert.equal(manifest.pages.length, 1)
  assert.deepEqual(manifest.document, { format: 'paged' })
  assert.equal(existsSync(join(outDir, 'book.pdf')), true)
  assert.equal(existsSync(join(outDir, manifest.pages[0].file)), true)
  assert.equal(existsSync(join(outDir, 'document-manifest.json')), false, 'the adapter must not publish common build state')
  const geometry = JSON.parse(readFileSync(join(outDir, manifest.pages[0].textGeometry), 'utf8'))
  assert.match(geometry.text, /Canonical PDF text/)
})

test('project search reads native PDF text geometry from the common manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-pdf-search-'))
  const projectsDir = join(root, 'projects')
  const projectDir = join(projectsDir, 'book')
  const outDir = join(projectDir, 'output')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    name: 'book', title: 'Searchable PDF', mainFile: 'book.pdf', format: 'pdf',
    sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged',
  }))
  const pdfPath = join(root, 'book.pdf')
  writeFileSync(pdfPath, minimalPdf('Geometry search needle'))
  const manifest = await extractPdfArtifacts({
    pdfPath, outDir, target: 'book', outputPdf: 'book.pdf',
    project: { format: 'pdf', sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged', mainFile: 'book.pdf' },
  })
  writeDocumentManifest(outDir, manifest)

  const client = new ProjectFilesStoreClient(projectsDir)
  try {
    await client.ready()
    const results = await client.searchContent('geometry search needle')
    assert.equal(results.length, 1)
    assert.equal(results[0].sourceKind, 'rendered')
    assert.equal(results[0].page, 1)
  } finally {
    await client.close()
  }
})
