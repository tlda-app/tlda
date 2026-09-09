import path from 'node:path'
import { scanMarkdownDeps } from './markdown-deps.mjs'
import { scanTexDeps } from './tex-deps.mjs'

const DOCUMENT_FORMATS = new Set(['svg', 'png', 'html', 'diff', 'slides', 'markdown', 'qmd', 'pdf'])

export function normalizeDocumentRoots(documentRoots, { mainFile = null, format = 'svg' } = {}) {
  const roots = Array.isArray(documentRoots) ? documentRoots : []
  const result = []
  const seen = new Set()
  for (const value of roots) {
    const path = typeof value === 'string' ? value : value?.path
    if (typeof path !== 'string' || !path.trim()) continue
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!normalizedPath || seen.has(normalizedPath)) continue
    const candidateFormat = typeof value === 'object' ? value.format : format
    const rootFormat = DOCUMENT_FORMATS.has(candidateFormat) ? candidateFormat : format
    result.push({ path: normalizedPath, format: rootFormat })
    seen.add(normalizedPath)
  }
  if (result.length === 0 && typeof mainFile === 'string' && mainFile.trim()) {
    result.push({
      path: mainFile.replace(/\\/g, '/').replace(/^\.?\//, ''),
      format: DOCUMENT_FORMATS.has(format) ? format : 'svg',
    })
  }
  return result
}

export function latexDocumentRootPaths(documentRoots, { mainFile = null, format = 'svg', xrSiblings = [] } = {}) {
  const declared = normalizeDocumentRoots(documentRoots, { mainFile, format })
    .filter(root => root.format === 'svg' && /\.tex$/i.test(root.path))
    .map(root => root.path)
  return [...new Set([mainFile, ...declared, ...xrSiblings].filter(Boolean))]
}

/**
 * document-roots.mjs — the documents a project has, COMPUTED from its branch.
 *
 * Skip, 2026-08-26: *"document roots is just a computed property of the git
 * branch"*, and then the rule itself: *"create the directed include graph. roots
 * are roots"*.
 *
 * That replaces a stored `documentRoots` field written once at link time from
 * whatever `--root` arguments the CLI happened to get. Nothing ever recomputed
 * it, so a project's idea of its own documents was a snapshot of the moment
 * somebody linked it: add a paper to the branch and the project still described
 * the old tree. Every failure this file exists to end is the stored copy
 * disagreeing with the branch.
 *
 * **One rule, every format.** A document is a node in the include graph with
 * nothing pointing at it. There is no per-format test, no `\documentclass`
 * check, and no primary — a project has the documents it has, and asking which
 * one is "the" document is the question that produced the bug where a page URL
 * was built from one name and served under another.
 *
 * **`\externaldocument` is deliberately NOT an edge**, and this is the case to
 * protect. Two papers that cross-reference each other with `xr` each read the
 * other's `.aux` and compile separately; they are two documents. If xr were an
 * include edge they would form a cycle with nothing pointing in from outside,
 * the graph would report ZERO roots, and every document in the project would
 * disappear at once. `scanTexDeps` collects eight edge kinds and xr is not among
 * them — verified, not assumed.
 */




/**
 * Extensions that can BE a document. Everything else in the tree -- images,
 * `.sty`, `.bib`, `.cls` -- is only ever something a document points at.
 *
 * Kept as a map rather than a list because the format is the other half of what
 * a caller needs, and deriving it separately is how two places end up
 * disagreeing about what a `.qmd` is.
 */
const DOCUMENT_EXTENSION_FORMATS = new Map([
  ['.tex', 'svg'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.qmd', 'qmd'],
  ['.html', 'html'],
  ['.htm', 'html'],
  // A PDF is a document in its own right, and it is the one entry here whose
  // document needs no toolchain to render -- poppler reads its pages, sizes and
  // word geometry straight out of the file. That is what makes a paper readable
  // on a machine with no TeX.
  //
  // It is NOT in SCANNABLE below: a PDF points at nothing, so it is always a
  // root and never an edge. Note the asymmetry with the source rules -- a `.pdf`
  // sitting beside a `.tex` is that paper's OUTPUT and must not become a
  // document, which `shared/source-manifest.mjs` and `server/lib/shadow-repo.mjs`
  // each decide by their own test. This map only says what a `.pdf` IS once
  // something has already decided it is a document root.
  ['.pdf', 'pdf'],
])

/** Extensions whose contents can point at other files. */
const SCANNABLE = new Set(['.tex', '.md', '.markdown', '.qmd'])

/**
 * The format of a document, from the file itself.
 *
 * Exported so the one place that still *stores* a root does not have to invent
 * its own answer. The chat click-adopt path appended `format: 'markdown'`
 * literally, whatever was clicked, so a `.tex` adopted as a root was recorded as
 * markdown -- which then selected the markdown closure for it and lost its
 * figures by a second route.
 *
 * Null for a path that is not a document at all.
 */
export function formatForDocumentPath(file) {
  return DOCUMENT_EXTENSION_FORMATS.get(path.extname(String(file || '')).toLowerCase()) || null
}

const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')



/**
 * Everything `file` points at, as project-relative paths.
 *
 * Resolved against the file's OWN directory, because an include is written
 * relative to the file that writes it. Resolving against the project root
 * instead would leave a subdirectory's includes unmatched, and an unmatched
 * edge does not merely lose a link -- it promotes the included file to a root,
 * so a chapter shows up as a document of its own.
 */
async function edgesFrom(file, read) {
  const ext = path.extname(file).toLowerCase()
  if (!SCANNABLE.has(ext)) return []
  let content
  try {
    content = await read(file)
    if (content == null) return []
  } catch {
    // Listed on the branch but unreadable here. It contributes no edges, which
    // leaves it a root -- the honest answer, since nothing can be shown to
    // include it.
    return []
  }
  const dir = path.posix.dirname(file)
  const resolve = ref => normalize(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, normalize(ref))))

  if (ext === '.tex') {
    // `implicit` is the extension list TeX would try, so `\input{intro}` reaches
    // `intro.tex`. Emitting both the bare and the extended form costs nothing
    // and misses neither.
    return scanTexDeps(content).flatMap(dep => {
      const base = resolve(dep.ref)
      return [base, ...(dep.implicit || []).map(suffix => base.endsWith(suffix) ? base : `${base}${suffix}`)]
    })
  }
  // `scanMarkdownDeps` takes a base directory only to fill in each dep's
  // absolute path, which is not used here -- the edge is resolved above from
  // `ref`, in posix terms, so the graph does not depend on where the tree is
  // mounted. That independence is the point: the same graph has to answer
  // identically for a checkout and for a materialized directory on the server.
  return scanMarkdownDeps(content, dir).map(dep => resolve(dep.ref))
}

/**
 * The documents in a tree: nodes in the include graph with no incoming edge.
 *
 * Takes the file list rather than discovering it, because WHERE the tree is
 * differs by caller and getting that wrong is silent. The server's
 * `projects/<name>/source` is a materialized directory and **not a git work
 * tree** — `git ls-files` there exits non-zero and lists nothing — so a version
 * of this that only knew how to run `ls-files` would have returned "this
 * project has no documents" on the one machine that serves them. Measured on
 * the live box before this was split.
 *
 * `read(file)` returns the file's text, or null/throws if unreadable.
 *
 * Returns `[{ path, format }]`, in the order the listing gave, so the result is
 * stable between calls rather than dependent on scan order.
 */
export async function documentRootsIn(files, read) {
  const candidates = files.filter(file => DOCUMENT_EXTENSION_FORMATS.has(path.extname(file).toLowerCase()))
  if (candidates.length === 0) return []

  const included = new Set()
  await Promise.all(files.map(async file => {
    for (const target of await edgesFrom(file, read)) {
      // A file that includes ITSELF is not thereby a non-root. Left-recursive
      // input is a broken document, not a chapter of something else, and
      // counting it would make the document vanish from the project.
      if (target && target !== file) included.add(target)
    }
  }))

  return candidates
    .filter(file => !included.has(file))
    .map(file => ({ path: file, format: DOCUMENT_EXTENSION_FORMATS.get(path.extname(file).toLowerCase()) }))
}




/**
 * The document roots a `project link` should DECLARE.
 *
 * Lives here, beside `normalizeDocumentRoots`, because it is the same question:
 * what does this project say its documents are. It was previously inline in the
 * CLI as a two-branch expression, which made it untestable without a running
 * daemon -- the CLI binds to the daemon before it writes the record, so nothing
 * short of a full environment could observe the answer.
 *
 * The rule, and the whole reason it is a named function:
 *
 *   - roots were supplied  -> declare those
 *   - CREATING a project   -> derive from the main file, because a new project
 *                             has no declaration to preserve
 *   - RELINKING an existing project -> **whatever it already declares, including
 *                             nothing**
 *
 * That last case is the one that had no expression before. An existing project
 * declaring no roots is answering the question, not failing to; deriving roots
 * for it writes a declaration on its behalf during what is supposed to be a
 * repair.
 */
export function documentRootsToDeclare({ supplied = [], existing = [], mainFile = null, projectExists = false } = {}) {
  const suppliedRoots = Array.isArray(supplied) ? supplied.filter(Boolean) : []
  if (suppliedRoots.length) return suppliedRoots
  if (projectExists) return Array.isArray(existing) ? existing : []
  return mainFile ? normalizeDocumentRoots([mainFile], { mainFile, format: 'svg' }) : []
}
