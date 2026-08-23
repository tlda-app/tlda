import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readProject, sourceDir as getSourceDir, projectPartsRoot } from './project-store.mjs'
import { readProjectPartsManifestAsync } from './project-parts-scanner.mjs'
import { scanMarkdownDependencyClosureAsync } from '../../shared/markdown-deps.mjs'

const DEFAULT_COLUMN_WIDTH = 800
const DEFAULT_COLUMN_HEIGHT = 1200
const TASK_DOC_COLUMN_WIDTH = 2200

export function markdownColumnFileForSource(path, { defaultColumn = false } = {}) {
  if (defaultColumn) return 'index.html'
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.(md|markdown)$/i, '.html')
}

// Any project — regardless of its own top-level format — can have markdown
// parts, and every part always renders through the markdown renderer. This
// is the one place that reads the parts manifest into renderable columns;
// listMarkdownDocumentColumns (main file + parts) and listProjectPartColumns
// (parts only, for a non-markdown project's main doc) both build on it.
export async function listDocumentColumns(name, { project = null, srcDir = getSourceDir(name) } = {}) {
  project ||= await readProject(name)
  if (!project) return []
  if (project.format === 'markdown') return listMarkdownDocumentColumns(name, { project, srcDir })
  return []
}

// Documents available to select from Projects. This is deliberately separate
// from listMarkdownDocumentColumns: reachability makes a file selectable as a
// document, never a page or chapter of the document that links to it.
export async function listMarkdownProjectDocuments(name, { project = null, srcDir = getSourceDir(name) } = {}) {
  project ||= await readProject(name)
  if (!project || project.format !== 'markdown') return []
  const configuredFile = String(project.mainFile || 'index.md').replace(/\\/g, '/').replace(/^\.?\//, '')
  const closure = await scanMarkdownDependencyClosureAsync(configuredFile, srcDir)
  const documents = []
  for (const sourceFile of closure.markdown) {
    await addMarkdownColumn(documents, {
      sourceFile,
      outputFile: markdownColumnFileForSource(sourceFile, { defaultColumn: sourceFile === configuredFile }),
      srcDir,
    })
  }
  for (const part of await listProjectPartColumns(name, { srcDir })) {
    if (!documents.some(existing => existing.sourceFile === part.sourceFile)) documents.push(part)
  }
  return documents
}

// An explicitly linked Markdown root is one document, even when its parent
// project is TeX. Its output identity follows its source path so sibling roots
// cannot collapse onto a shared index.html.
export async function markdownProjectRootColumn(name, sourceFile, { srcDir = getSourceDir(name) } = {}) {
  const normalized = String(sourceFile || '').replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!normalized || normalized.split('/').includes('..') || !/\.(md|markdown)$/i.test(normalized)) return null
  const columns = []
  await addMarkdownColumn(columns, {
    sourceFile: normalized,
    outputFile: markdownColumnFileForSource(normalized),
    srcDir,
  })
  return columns[0] || null
}

// Markdown-part columns for a project whose own main document is NOT
// markdown (e.g. a LaTeX/svg project's scratch/notes parts). Excludes the
// project's own main-document concept entirely — that's rendered by
// whatever pipeline already owns this project's format.
// `srcDir` is accepted for signature compatibility with the other column
// listers and deliberately not used to read a part: a part's `path` is relative
// to the PARTS root, which is no longer the source directory. Reading it against
// `srcDir` is how a part would silently vanish from this list — addMarkdownColumn
// returns on ENOENT rather than throwing.
export async function listProjectPartColumns(name, { srcDir: _srcDir = getSourceDir(name) } = {}) {
  const columns = []
  const manifestRoot = projectPartsRoot(name)
  const manifest = await readProjectPartsManifestAsync(manifestRoot)
  for (const part of manifest.parts || []) {
    const sourceFile = String(part.path || part.storage?.path || '').replace(/\\/g, '/')
    if (!sourceFile || !/\.(md|markdown)$/i.test(sourceFile)) continue
    await addMarkdownColumn(columns, {
      sourceFile,
      outputFile: markdownColumnFileForSource(sourceFile),
      srcDir: manifestRoot,
      title: part.title,
      partId: part.id,
      kind: part.kind,
    })
  }
  return columns
}

// Placement is explicit. This helper describes separate project documents; it
// must not synthesize a side-by-side column group for them.
export function pageInfoFromDocumentColumns(_name, columns) {
  return columns.map(columnPageInfo)
}

async function listMarkdownDocumentColumns(name, { project, srcDir }) {
  const columns = []
  const configuredFile = String(project.mainFile || 'index.md').replace(/\\/g, '/').replace(/^\.?\//, '')
  await addMarkdownColumn(columns, {
    sourceFile: configuredFile,
    outputFile: markdownColumnFileForSource(configuredFile, { defaultColumn: true }),
    srcDir,
  })

  // A markdown project's document is its main file. Documents it links to are
  // other documents — they are not pages of this one, and reachability is not a
  // way of becoming one. Walking the link closure in here is what turned every
  // linked file into a chapter: its own canvas page, and its headings merged
  // into this document's TOC. Skip, 2026-08-13 01:58 EDT, on where chapters can
  // come from at all: "the only way we have of creating a fucking book is
  // fucking, like, quarto fucking book like config yaml files. it's a fucking
  // format... That's the design."
  //
  // Rendering a linked document is a separate question from listing this
  // document's pages, and the docs route answers it from the project source.

  for (const column of await listProjectPartColumns(name, { srcDir })) {
    if (columns.some(existing => existing.sourceFile === column.sourceFile)) continue
    columns.push(column)
  }

  return columns
}

async function addMarkdownColumn(columns, { sourceFile, outputFile, srcDir, title = null, partId = null, kind = null }) {
  const absPath = join(srcDir, sourceFile)
  let source
  try {
    source = await readFile(absPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  columns.push({
    id: partId || sourceFile,
    format: 'markdown',
    sourceFile,
    // The directory `sourceFile` is relative to. Carried on the column because
    // parts and project documents no longer share a root, and a renderer that
    // assumes `source/` reads the wrong file for one of them. Set from the
    // srcDir this column was actually listed against, never inferred.
    sourceRoot: srcDir,
    outputFile,
    file: outputFile,
    width: kind === 'task-doc' ? TASK_DOC_COLUMN_WIDTH : DEFAULT_COLUMN_WIDTH,
    height: DEFAULT_COLUMN_HEIGHT,
    title: title || titleFromMarkdown(source) || sourceFile.replace(/\.(md|markdown)$/i, ''),
    metadata: {
      ...(partId ? { partId } : {}),
      ...(kind ? { kind } : {}),
    },
  })
}

function columnPageInfo(column) {
  return {
    file: column.outputFile,
    width: column.width,
    height: column.height,
    title: column.title,
    format: column.format,
    source: {
      type: 'project-source',
      format: column.format,
      file: column.sourceFile,
    },
    ...(Object.keys(column.metadata || {}).length ? { metadata: column.metadata } : {}),
  }
}

/** The column for a markdown file of this project that is not one of this
 *  document's pages — a document the main file links to. Listing this
 *  document's pages and rendering another document of the same project are
 *  different questions, and only the first one is the page list. Returns null
 *  for anything that does not resolve to a markdown file inside the project's
 *  source, which is the same containment rule every other source path obeys. */
export async function markdownDocumentColumnForOutputFile(name, outputFile, { srcDir = getSourceDir(name) } = {}) {
  const requested = String(outputFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!requested.endsWith('.html') || requested.split('/').includes('..')) return null
  const stem = requested.replace(/\.html$/, '')
  const columns = []
  for (const extension of ['.md', '.markdown']) {
    await addMarkdownColumn(columns, {
      sourceFile: `${stem}${extension}`,
      outputFile: requested,
      srcDir,
    })
    if (columns.length > 0) return columns[0]
  }
  return null
}

function titleFromMarkdown(source) {
  const body = String(source ?? '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  const heading = body.match(/^#\s+(.+?)\s*$/m)
  if (heading) return heading[1].replace(/\s*\{#[\w-]+\}\s*$/, '').trim()
  const first = body.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first ? first.replace(/[*_`~[\]()]/g, '').slice(0, 80) : null
}
