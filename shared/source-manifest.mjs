export const SOURCE_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.def',
  '.svg', '.png', '.jpg', '.jpeg', '.eps',
  '.tikz', '.pgf', '.dtx', '.ins', '.fd',
  '.md',
])

export const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.def', '.bbl',
  '.tikz', '.pgf', '.dtx', '.ins', '.fd',
  '.md',
])

export const IGNORED_SOURCE_DIRS = new Set(['node_modules', '_site', '.git'])

export const BUILD_JUNK_SUFFIXES = [
  '.aux', '.log', '.out', '.synctex', '.synctex.gz', '.fls', '.fdb', '.fdb_latexmk',
  '.bbl', '.blg', '.bcf', '.run.xml', '.toc', '.lof', '.lot',
  '.nav', '.snm', '.vrb', '.dvi', '.pdf', '.fmt',
]

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function extname(path) {
  const name = normalizePath(path).split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function isIgnoredSourceDir(name) {
  return IGNORED_SOURCE_DIRS.has(name)
}

export function isBuildJunkPath(path) {
  const rel = normalizePath(path).toLowerCase()
  return BUILD_JUNK_SUFFIXES.some(suffix => rel.endsWith(suffix) || rel.includes('_fmt.'))
}

export function sourceManifestContext(project = {}) {
  return {
    format: project?.format || 'svg',
    mainFile: normalizePath(project?.mainFile || ''),
  }
}

export function isSourceFilePath(path, context = {}) {
  const rel = normalizePath(path)
  if (!rel || isBuildJunkPath(rel)) return false
  const ctx = sourceManifestContext(context)
  if (ctx.format === 'html' || ctx.format === 'slides') return true
  const ext = extname(rel).toLowerCase()
  if (!SOURCE_EXTENSIONS.has(ext)) return false

  if (ext === '.md') {
    return ctx.format === 'markdown' || rel === ctx.mainFile
  }

  return true
}

export function isTextSourcePath(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase())
}

export function diffSourceHashes(localHashes, serverHashes) {
  const local = localHashes || {}
  const server = serverHashes || {}
  const changedPaths = Object.keys(local).filter(p => local[p] !== server[p])
  const deletedFiles = Object.keys(server).filter(p => !(p in local))
  return { changedPaths, deletedFiles }
}

export function normalizeSourceManifest(paths, context = {}) {
  return [...new Set((paths || []).filter(p => typeof p === 'string').filter(p => isSourceFilePath(p, context)))].sort()
}

export function sourceFilesFromApiResponse(response) {
  if (!response || !Array.isArray(response.files) || !response.files.every(p => typeof p === 'string')) {
    throw new Error('Project files response did not include a string files array')
  }
  return response.files
}
