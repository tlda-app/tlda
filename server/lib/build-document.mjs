import { completeBuildSuccess, finalizeBuildVersion } from './build-runner.mjs'
import { finalizeDocumentBuild } from './document-build-finalizer.mjs'
import { buildAdapterFor } from './build-adapter-registry.mjs'

/** The one success boundary for every renderer adapter. */
export async function buildDocument(project, context, services = {}) {
  const startedAt = Date.now()
  const adapter = services.adapter || buildAdapterFor(project)
  const versioner = services.versioner || finalizeBuildVersion
  const finalizer = services.finalizer || finalizeDocumentBuild
  const completer = services.completer || completeBuildSuccess
  const result = await adapter.build(context)
  if (result?.disposition === 'superseded') return { adapter: adapter.id, disposition: 'superseded' }
  if (!result?.manifest) throw new Error(`Build adapter ${adapter.id} returned no manifest`)
  await versioner({
    name: context.name,
    sourceRevision: context.sourceRevision,
    acceptSeq: context.acceptSeq,
    ...(result.version || {}),
  })
  await finalizer(context.name, { ...result, recordLastBuildSuccess: true }, context.reporter)
  completer(context.name, result.completion || {
    elapsed: ((Date.now() - startedAt) / 1000).toFixed(1),
    pages: result.manifest.pages.length,
  })
  return { adapter: adapter.id, manifest: result.manifest }
}
