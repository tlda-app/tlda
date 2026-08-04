import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 1200

function normalizedRelativePath(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid tlda-manifest.json: ${field} must be a non-empty relative path`)
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Invalid tlda-manifest.json: ${field} must stay inside the project`)
  }
  return normalized
}

export function pageInfoFromTldaManifest(manifest, { prefix = '' } = {}) {
  if (manifest?.version !== 1 || manifest?.kind !== 'tlda' || !Array.isArray(manifest.pages)) {
    throw new Error('Invalid tlda-manifest.json: expected version 1, kind "tlda", and a pages array')
  }
  return manifest.pages.map((page, index) => {
    if (!page || typeof page !== 'object') {
      throw new Error(`Invalid tlda-manifest.json: pages[${index}] must be an object`)
    }
    const file = normalizedRelativePath(page.file, `pages[${index}].file`)
    if (!/\.html?$/i.test(file)) {
      throw new Error(`Invalid tlda-manifest.json: pages[${index}].file must be HTML`)
    }
    if (typeof page.title !== 'string' || !page.title.trim()) {
      throw new Error(`Invalid tlda-manifest.json: pages[${index}].title must be non-empty`)
    }
    const sourceFile = normalizedRelativePath(page.source?.file, `pages[${index}].source.file`)
    if (page.source?.type !== 'project-source' || page.source?.format !== 'qmd') {
      throw new Error(`Invalid tlda-manifest.json: pages[${index}].source must identify project qmd source`)
    }
    return {
      file: prefix ? `${prefix}/${file}` : file,
      width: Number.isFinite(page.width) && page.width > 0 ? page.width : DEFAULT_WIDTH,
      height: Number.isFinite(page.height) && page.height > 0 ? page.height : DEFAULT_HEIGHT,
      title: page.title.trim(),
      format: 'qmd',
      source: { type: 'project-source', format: 'qmd', file: sourceFile },
    }
  })
}

export function findTldaManifest(root) {
  const found = []
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'tlda-manifest.json') found.push(path)
    }
  }
  visit(root)
  if (found.length > 1) {
    throw new Error(`Multiple tlda-manifest.json files found: ${found.map(path => relative(root, path)).join(', ')}`)
  }
  return found[0] || null
}

export function readTldaManifest(root) {
  const path = findTldaManifest(root)
  if (!path) return null
  const manifestDir = dirname(path)
  const prefix = relative(root, manifestDir).replace(/\\/g, '/')
  const pageInfo = pageInfoFromTldaManifest(JSON.parse(readFileSync(path, 'utf8')), { prefix })
  for (const page of pageInfo) {
    const pagePath = resolve(root, page.file)
    if (!existsSync(pagePath) || !pagePath.startsWith(`${resolve(root)}/`)) {
      throw new Error(`Invalid tlda-manifest.json: rendered page not found: ${page.file}`)
    }
  }
  return { path, pageInfo }
}

