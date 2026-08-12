export const SOURCE_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.def',
  '.svg', '.png', '.jpg', '.jpeg', '.eps',
  '.tikz', '.pgf', '.dtx', '.ins', '.fd',
  '.md',
])

const MARKDOWN_DEPENDENCY_EXTENSIONS = new Set([
  '.md', '.markdown',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf',
  '.css', '.js', '.json', '.csv', '.txt',
  '.mp4', '.webm', '.mp3', '.wav',
  '.vsix',
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

/**
 * Is this path something a local `quarto render` produced?
 *
 * Only qmd asks. html and slides push a tree that IS a render, so for them
 * these same paths are the document. qmd pushes the input and the server
 * renders, which makes a local render's output a duplicate of what the build
 * is about to write — and `_cache/` is worse than a duplicate, because the
 * build copies the pushed tree and renders inside it, so a stale local knitr
 * cache would be reused server-side and produce output the source does not
 * say.
 *
 * Measured on a three-slide scratch deck with one R chunk: 73 files and 7.4MB
 * pushed, for 300 bytes of source, every time the author ran `make`.
 */
export function isQuartoRenderOutput(path, mainFile = '') {
  const rel = normalizePath(path)
  const segments = rel.split('/')
  const dirs = segments.slice(0, -1)
  if (dirs.some(d => d === '.quarto' || d === '_site' || d === '_book')) return true
  if (dirs.some(d => d.endsWith('_files') || d.endsWith('_cache'))) return true
  // The rendered sibling of the main file — `talk.qmd` renders to `talk.html`.
  const rendered = normalizePath(mainFile).replace(/\.qmd$/i, '.html')
  return !!rendered && rel === rendered
}

/**
 * Paths referenced in chat, project-relative.
 *
 * A file is a member of a project because something refers to it, not because
 * of where it sits or what it is called. Two things seed that: the main file,
 * and anything referenced in chat. `mainFile` above is the first seed; this is
 * the second.
 *
 * The server records the reference when a chat chip is opened as a column, but
 * it records the path on the AUTHOR'S machine, because that is what the chip
 * carried. It cannot turn that into a project coordinate: project-store strips
 * `sourceDir` from every shared project on purpose, so the server does not know
 * where the author keeps the tree. The client does. So the relativizing happens
 * there and arrives here already project-relative.
 */
function referencedRootSet(roots) {
  const values = roots instanceof Set ? [...roots] : roots
  if (!Array.isArray(values)) return new Set()
  return new Set(values.filter(p => typeof p === 'string' && p).map(normalizePath))
}

/**
 * Chat references as project coordinates, given the paths the project already
 * speaks in.
 *
 * The referenced paths may be absolute paths on the author's machine. The
 * caller supplies paths already known to belong to the project, so this is a
 * tail-match lookup rather than a path guess.
 */
export function referencedRootsFromPaths(referenced, known) {
  const candidates = [...new Set([...(known || [])])]
    .filter(p => typeof p === 'string' && p)
    .map(p => p.replace(/\\/g, '/'))
  const roots = new Set()
  for (const abs of referenced || []) {
    if (typeof abs !== 'string' || !abs) continue
    const normalized = abs.replace(/\\/g, '/')
    for (const rel of candidates) {
      if (normalized === rel || normalized.endsWith(`/${rel}`)) roots.add(rel)
    }
  }
  return [...roots]
}

export function sourceManifestContext(project = {}) {
  return {
    format: project?.format || 'svg',
    mainFile: normalizePath(project?.mainFile || ''),
    referencedRoots: referencedRootSet(project?.referencedRoots),
  }
}

export function isSourceFilePath(path, context = {}) {
  const rel = normalizePath(path)
  if (!rel || isBuildJunkPath(rel)) return false
  const ctx = sourceManifestContext(context)
  // A chat reference makes a file a member whatever its extension. This is the
  // route `b4-outline.md` came in by and the one that did not exist: a Markdown
  // outline beside a LaTeX paper failed the extension test below, so it was
  // never pushed, never watched, and the column made from it froze at the
  // moment it was opened — with no build to fail and nothing to report.
  //
  // Above the format branches deliberately: the reference is what decides, and
  // asking the parent project's format about a file referenced into it is the
  // "Markdown is less real than TeX" reading that put this bug here.
  if (ctx.referencedRoots.has(rel)) return true
  // html and slides push a rendered tree; qmd pushes an unrendered one. All
  // three share the same rule for the same reason: what the document needs is
  // whatever sits beside it — site_libs, _quarto.yml, _extensions, data, images
  // — and there is no reference graph that reveals the set. So everything
  // beside the document is source, except what a local render just made, which
  // only qmd can have because only qmd renders on the far side.
  if (ctx.format === 'html' || ctx.format === 'slides') return true
  if (ctx.format === 'qmd') return !isQuartoRenderOutput(rel, ctx.mainFile)
  const ext = extname(rel).toLowerCase()
  if (ctx.format === 'markdown') return MARKDOWN_DEPENDENCY_EXTENSIONS.has(ext)
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
