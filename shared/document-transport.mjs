import { documentAxes } from './document-formats.mjs'

export function documentTransport(project) {
  return {
    ...documentAxes(project),
    pages: project.pages || 0,
    pageFiles: Array.isArray(project.pageFiles) ? project.pageFiles : [],
  }
}

export function foreignDocumentTransport(project, event = {}) {
  const combined = {
    sourceFormat: project.sourceFormat || event.sourceFormat,
    renderer: project.renderer || event.renderer,
    documentFormat: project.documentFormat || event.documentFormat,
  }
  return {
    ...combined,
    pages: project.pages || event.pages || 0,
    pageFiles: Array.isArray(project.pageFiles) && project.pageFiles.length
      ? project.pageFiles
      : Array.isArray(event.pageFiles) ? event.pageFiles : [],
  }
}
