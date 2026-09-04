import { runBuild } from './build-runner.mjs'
import { buildMarkdownDocument } from './build-markdown.mjs'
import { buildQmdDocument } from './build-qmd.mjs'
import { buildPdfDocument } from './build-pdf.mjs'
import { buildHtmlDocument, buildSlidesDocument } from './format-builders.mjs'
import { documentAxes } from '../../shared/document-formats.mjs'

const adapters = [
  { id: 'latex-slides', renderer: 'latex', documentFormat: 'slides', view: {
    kind: 'svg-pages', capabilities: { presentation: true, sourceMapping: true, searchableText: false },
  }, build: (context) => runBuild(context.name, { ...context, preambleFormat: false }), relevantFiles: true },
  { id: 'latex', renderer: 'latex', documentFormat: 'paged', view: {
    kind: 'svg-pages', capabilities: { presentation: false, sourceMapping: true, searchableText: false },
  }, build: (context) => runBuild(context.name, context), relevantFiles: true },
  { id: 'markdown', renderer: 'markdown', build: (context) => buildMarkdownDocument(context.name, context.log) },
  { id: 'quarto', renderer: 'quarto', build: (context) => buildQmdDocument(context.name, context.log) },
  { id: 'native-pdf', renderer: 'identity', sourceFormat: 'pdf', build: (context) => buildPdfDocument(context.name, context.log) },
  { id: 'identity-slides', renderer: 'identity', documentFormat: 'slides', build: (context) => buildSlidesDocument(context.name, context.log) },
  { id: 'identity-html', renderer: 'identity', documentFormat: 'html', build: (context) => buildHtmlDocument(context.name, context.log) },
]

export function registeredBuildAdapters() {
  return adapters.map(({ build: _build, ...descriptor }) => ({ ...descriptor }))
}

export function buildAdapterFor(project) {
  const axes = documentAxes(project)
  const adapter = adapters.find(candidate => candidate.renderer === axes.renderer
    && (!candidate.sourceFormat || candidate.sourceFormat === axes.sourceFormat)
    && (!candidate.documentFormat || candidate.documentFormat === axes.documentFormat))
  if (!adapter) throw new Error(`No build adapter registered for ${axes.sourceFormat}/${axes.renderer}/${axes.documentFormat}`)
  return adapter
}

export function buildCapabilities(project) {
  const adapter = buildAdapterFor(project)
  return { eager: true, relevantFiles: adapter.relevantFiles === true }
}
