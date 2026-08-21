/**
 * The three independent document axes.
 *
 * `format` is accepted only at creation and migration boundaries. Runtime
 * readers use the stored axes.
 */

const LEGACY_AXES = {
  svg:      { sourceFormat: 'tex',  renderer: 'latex',    documentFormat: 'paged' },
  markdown: { sourceFormat: 'md',   renderer: 'markdown', documentFormat: 'html' },
  html:     { sourceFormat: 'html', renderer: 'identity', documentFormat: 'html' },
  slides:   { sourceFormat: 'html', renderer: 'identity', documentFormat: 'slides' },
  qmd:      { sourceFormat: 'qmd',  renderer: 'quarto',   documentFormat: 'html' },
  png:      { sourceFormat: 'png',  renderer: 'identity', documentFormat: 'paged' },
  book:     { sourceFormat: 'book', renderer: 'identity', documentFormat: 'book' },
}

export function legacyDocumentAxes(project = {}) {
  const fallback = LEGACY_AXES[project?.format] || LEGACY_AXES.svg
  return {
    sourceFormat: project?.sourceFormat || fallback.sourceFormat,
    renderer: project?.renderer || fallback.renderer,
    documentFormat: project?.documentFormat
      || (project?.format === 'qmd' && project?.renderedFormat === 'slides' ? 'slides' : fallback.documentFormat),
  }
}

export function documentAxes(project = {}) {
  if (!project.sourceFormat || !project.renderer || !project.documentFormat) {
    throw new Error('Project document axes have not been migrated')
  }
  return {
    sourceFormat: project.sourceFormat,
    renderer: project.renderer,
    documentFormat: project.documentFormat,
  }
}

export const sourceFormat = project => documentAxes(project).sourceFormat
export const renderer = project => documentAxes(project).renderer
export const documentFormat = project => documentAxes(project).documentFormat

/** Compatibility value consumed by the existing viewer and shape code. */
export function viewFormat(project) {
  const format = documentFormat(project)
  if (format === 'html') return sourceFormat(project) === 'md' ? 'markdown' : 'html'
  if (format === 'slides') return 'slides'
  if (sourceFormat(project) === 'png') return 'png'
  if (sourceFormat(project) === 'pdf') return 'pdf'
  return 'svg'
}

/**
 * Compatibility only: formats that still project their manifest pages to
 * page-info.json for existing iframe readers.
 */
export const FORMATS_WITH_OWN_PAGE_INFO = new Set(['markdown', 'html', 'slides', 'qmd'])

/** Existing shape/reload code asks this compatibility question. */
export const HTML_PAGE_FORMATS = new Set(['html', 'markdown', 'qmd'])

export function isHtmlDocument(project) {
  return documentFormat(project) === 'html'
}

export function isSlidesDocument(project) {
  return documentFormat(project) === 'slides'
}

export function hasSourceMapping(project) {
  const axes = documentAxes(project)
  return axes.sourceFormat === 'tex' && axes.renderer === 'latex'
}
