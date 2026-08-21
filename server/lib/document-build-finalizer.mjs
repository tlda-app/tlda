import { outputDir } from './project-store.mjs'
import { writeDocumentManifest } from './document-manifest.mjs'

export async function finalizeDocumentBuild(name, result, reporter) {
  if (!result?.manifest) throw new Error(`Document builder for ${name} returned no manifest`)
  if (!reporter) throw new Error('Document build finalizer requires a reporter')
  const manifest = writeDocumentManifest(outputDir(name), result.manifest, { writePageInfo: result.writePageInfo === true })
  const builtAt = new Date().toISOString()
  await reporter.updateProject(name, {
    sourceFormat: manifest.source.format,
    renderer: manifest.source.renderer,
    documentFormat: manifest.document.format,
    buildStatus: 'success',
    pages: manifest.pages.length,
    pageFiles: manifest.pages.map(page => page.file),
    lastBuild: builtAt,
    ...(result.recordLastBuildSuccess && { lastBuildSuccess: builtAt }),
    ...(result.renderedFormat && { renderedFormat: result.renderedFormat }),
    ...(result.targets && { targets: result.targets }),
  })
  reporter.broadcastSignal(`doc-${name}`, 'signal:reload', { pages: manifest.pages.length, timestamp: Date.parse(builtAt) })
  if (result.regenerateBookTocs) await reporter.regenerateBookTocs(name)
  return manifest
}
