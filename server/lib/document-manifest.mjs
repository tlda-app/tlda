import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { documentAxes } from '../../shared/document-formats.mjs'

export const DOCUMENT_MANIFEST_FILE = 'document-manifest.json'

function viewDescriptor(view) {
  if (!['svg-pages', 'html-pages', 'slides', 'image-pages'].includes(view?.kind)) {
    throw new Error('Document manifest view.kind must be declared by the document builder')
  }
  const capabilities = view?.capabilities
  if (!capabilities || ['presentation', 'sourceMapping', 'searchableText'].some(key => typeof capabilities[key] !== 'boolean')) {
    throw new Error('Document manifest view.capabilities must be declared by the document builder')
  }
  return {
    kind: view.kind,
    capabilities: {
      presentation: capabilities.presentation,
      sourceMapping: capabilities.sourceMapping,
      searchableText: capabilities.searchableText,
    },
  }
}

function relativeArtifact(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty relative path`)
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`${field} must stay inside document output`)
  return normalized
}

export function normalizeDocumentManifest(manifest) {
  if (manifest?.version !== 1 || manifest?.kind !== 'tlda-document' || !Array.isArray(manifest.pages)) {
    throw new Error('Invalid document manifest: expected version 1, kind "tlda-document", and pages')
  }
  const pages = manifest.pages.map((page, index) => {
    if (!page || typeof page !== 'object') throw new Error(`pages[${index}] must be an object`)
    const width = Number(page.width)
    const height = Number(page.height)
    if (!(width > 0) || !(height > 0)) throw new Error(`pages[${index}] must have positive dimensions`)
    return {
      ...page,
      file: relativeArtifact(page.file, `pages[${index}].file`),
      width,
      height,
      ...(page.textGeometry ? { textGeometry: relativeArtifact(page.textGeometry, `pages[${index}].textGeometry`) } : {}),
    }
  })
  const normalized = {
    ...manifest,
    source: { ...(manifest.source || {}) },
    document: { ...(manifest.document || {}) },
    pages,
    assets: Array.isArray(manifest.assets) ? manifest.assets.map((asset, index) => relativeArtifact(asset, `assets[${index}]`)) : [],
    sourceMapping: manifest.sourceMapping || 'none',
  }
  return { ...normalized, view: viewDescriptor(manifest.view) }
}

export function createDocumentManifest(project, pages, options = {}) {
  const axes = documentAxes(project)
  return normalizeDocumentManifest({
    version: 1,
    kind: 'tlda-document',
    source: {
      format: axes.sourceFormat,
      renderer: axes.renderer,
      ...(project?.mainFile ? { root: project.mainFile } : {}),
    },
    document: { format: axes.documentFormat },
    pages,
    assets: options.assets || [],
    sourceMapping: options.sourceMapping || 'none',
    view: options.view,
  })
}

export function writeDocumentManifest(outDir, manifest) {
  const normalized = normalizeDocumentManifest(manifest)
  writeFileSync(join(outDir, DOCUMENT_MANIFEST_FILE), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

export function readDocumentManifest(outDir) {
  const path = join(outDir, DOCUMENT_MANIFEST_FILE)
  if (!existsSync(path)) return null
  return normalizeDocumentManifest(JSON.parse(readFileSync(path, 'utf8')))
}
