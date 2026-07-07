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

export function listDocumentColumns(name, { project = readProject(name), srcDir = getSourceDir(name) } = {}) {
  if (!project) return []
  if (project.format === 'markdown') return listMarkdownDocumentColumns(name, { project, srcDir })
  return []
}

export function pageInfoFromDocumentColumns(name, columns) {
  if (columns.length <= 1) {
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

  const manifestRoot = projectPartsRoot(name)
  const manifest = readProjectPartsManifest(manifestRoot)
  for (const part of manifest.parts || []) {
    const sourceFile = String(part.path || part.storage?.path || '').replace(/\\/g, '/')
    if (!sourceFile || !/\.(md|markdown)$/i.test(sourceFile)) continue
    if (sourceFile === configuredFile) continue
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
