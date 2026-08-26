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

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { scanMarkdownDeps } from '../../shared/markdown-deps.mjs'
import { scanTexDeps } from '../../shared/tex-deps.mjs'

const execFileAsync = promisify(execFile)

/**
 * Extensions that can BE a document. Everything else in the tree -- images,
 * `.sty`, `.bib`, `.cls` -- is only ever something a document points at.
 *
 * Kept as a map rather than a list because the format is the other half of what
 * a caller needs, and deriving it separately is how two places end up
 * disagreeing about what a `.qmd` is.
 */
const DOCUMENT_FORMATS = new Map([
  ['.tex', 'svg'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.qmd', 'qmd'],
  ['.html', 'html'],
  ['.htm', 'html'],
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
  return DOCUMENT_FORMATS.get(path.extname(String(file || '')).toLowerCase()) || null
}

const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')

/**
 * Files tracked on the branch, as project-relative paths.
 *
 * `git ls-files` rather than a filesystem walk, because the subject is the
 * BRANCH. A walk would also see build output, editor scratch files and
 * `node_modules`, and would report a document for anything untracked that
 * happened to be sitting in the directory.
 */
async function trackedFiles(sourceDir) {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: sourceDir, maxBuffer: 32 * 1024 * 1024 })
  return stdout.split('\0').map(normalize).filter(Boolean)
}

/**
 * Everything `file` points at, as project-relative paths.
 *
 * Resolved against the file's OWN directory, because an include is written
 * relative to the file that writes it. Resolving against the project root
 * instead would leave a subdirectory's includes unmatched, and an unmatched
 * edge does not merely lose a link -- it promotes the included file to a root,
 * so a chapter shows up as a document of its own.
 */
async function edgesFrom(sourceDir, file) {
  const ext = path.extname(file).toLowerCase()
  if (!SCANNABLE.has(ext)) return []
  let content
  try {
    content = await readFile(path.join(sourceDir, file), 'utf8')
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
  return scanMarkdownDeps(content, path.join(sourceDir, dir)).map(dep => resolve(dep.ref))
}

/**
 * The project's documents: nodes in the include graph with no incoming edge.
 *
 * Returns `[{ path, format }]`, ordered as the branch lists them so the result
 * is stable between calls rather than dependent on scan order.
 */
export async function computeDocumentRoots(sourceDir) {
  const files = await trackedFiles(sourceDir)
  const candidates = files.filter(file => DOCUMENT_FORMATS.has(path.extname(file).toLowerCase()))
  if (candidates.length === 0) return []

  const included = new Set()
  await Promise.all(files.map(async file => {
    for (const target of await edgesFrom(sourceDir, file)) {
      // A file that includes ITSELF is not thereby a non-root. Left-recursive
      // input is a broken document, not a chapter of something else, and
      // counting it would make the document vanish from the project.
      if (target && target !== file) included.add(target)
    }
  }))

  return candidates
    .filter(file => !included.has(file))
    .map(file => ({ path: file, format: DOCUMENT_FORMATS.get(path.extname(file).toLowerCase()) }))
}
