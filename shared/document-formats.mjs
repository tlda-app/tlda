/**
 * The three independent document axes.
 *
 * Runtime and wire records contain these axes and no legacy `format` field.
 */

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
