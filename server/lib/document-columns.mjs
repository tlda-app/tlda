import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readProject, sourceDir as getSourceDir, projectPartsRoot } from './project-store.mjs'
import { readProjectPartsManifest } from './project-parts-scanner.mjs'

const DEFAULT_COLUMN_WIDTH = 800
const DEFAULT_COLUMN_HEIGHT = 1200

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
export function listDocumentColumns(name, { project = readProject(name), srcDir = getSourceDir(name) } = {}) {
  if (!project) return []
  if (project.format === 'markdown') return listMarkdownDocumentColumns(name, { project, srcDir })
  return []
}

// Markdown-part columns for a project whose own main document is NOT
// markdown (e.g. a LaTeX/svg project's scratch/notes parts). Excludes the
// project's own main-document concept entirely — that's rendered by
// whatever pipeline already owns this project's format.
export function listProjectPartColumns(name, { srcDir = getSourceDir(name) } = {}) {
  const columns = []
  const manifestRoot = projectPartsRoot(name)
  const manifest = readProjectPartsManifest(manifestRoot)
  for (const part of manifest.parts || []) {
    const sourceFile = String(part.path || part.storage?.path || '').replace(/\\/g, '/')
    if (!sourceFile || !/\.(md|markdown)$/i.test(sourceFile)) continue
    addMarkdownColumn(columns, {
      sourceFile,
      outputFile: markdownColumnFileForSource(sourceFile),
      srcDir,
      title: part.title,
      partId: part.id,
      kind: part.kind,
    })
  }
  return columns
}

// forceGroup: for parts attached to a non-markdown project, always group —
// even a single part — so the client never reuses the default TLDraw page
// (that page belongs to the project's own main document in this case).
export function pageInfoFromDocumentColumns(name, columns, { forceGroup = false } = {}) {
  if (columns.length <= 1 && !forceGroup) {
    return columns.map(columnPageInfo)
  }
  return columns.map((column, idx) => ({
    ...columnPageInfo(column),
    group: `${name}-world`,
    groupIndex: idx,
    tabLabel: column.title,
  }))
}

function listMarkdownDocumentColumns(name, { project, srcDir }) {
  const columns = []
  const configuredFile = project.mainFile || 'index.md'
  addMarkdownColumn(columns, {
    sourceFile: configuredFile,
    outputFile: markdownColumnFileForSource(configuredFile, { defaultColumn: true }),
    srcDir,
  })

  for (const column of listProjectPartColumns(name, { srcDir })) {
    if (column.sourceFile === configuredFile) continue
    columns.push(column)
  }

  return columns
}

function addMarkdownColumn(columns, { sourceFile, outputFile, srcDir, title = null, partId = null, kind = null }) {
  const absPath = join(srcDir, sourceFile)
  if (!existsSync(absPath)) return
  const source = readFileSync(absPath, 'utf8')
  columns.push({
    id: partId || sourceFile,
    format: 'markdown',
    sourceFile,
    outputFile,
    file: outputFile,
    width: DEFAULT_COLUMN_WIDTH,
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

function titleFromMarkdown(source) {
  const body = String(source ?? '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  const heading = body.match(/^#\s+(.+?)\s*$/m)
  if (heading) return heading[1].replace(/\s*\{#[\w-]+\}\s*$/, '').trim()
  const first = body.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first ? first.replace(/[*_`~[\]()]/g, '').slice(0, 80) : null
}
