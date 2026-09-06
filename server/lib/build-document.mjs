import { outputDir } from './project-store.mjs'
import { completeBuildSuccess, finalizeBuildVersion } from './build-runner.mjs'
import { writeDocumentManifest } from './document-manifest.mjs'
import { finalizeDocumentBuild } from './document-build-finalizer.mjs'
import { withBuildLog } from './format-builders.mjs'
import { buildAdapterFor } from './build-adapter-registry.mjs'

/**
 * The one success boundary for every renderer adapter.
 *
 * Two shapes of adapter reach here and the difference is not cosmetic:
 *
 * **Adapters that own their completion** — the two `latex` ones, whose build
 * IS `runBuild`. That function has always ended with its own project update,
 * reload signal, `build.log`, version finalization and build-complete webhook.
 * Running the common tail over the top would version twice, complete twice and
 * reload the viewer twice, which is exactly what "exactly once" forbids. So for
 * those, this boundary does the one thing `runBuild` does NOT do: put the
 * manifest on disk.
 *
 * **Every other adapter** — markdown, Quarto, HTML, slides, native PDF. Their
 * builders now return a manifest and nothing else; this owns the log, the
 * version, the manifest publication, the project record, the reload and the
 * completion. That consolidation is the point of the boundary, and each of
 * those behaviours previously lived in a private tail inside each builder,
 * where four of the five had drifted apart.
 */
export async function buildDocument(project, context, services = {}) {
  const startedAt = Date.now()
  const adapter = services.adapter || buildAdapterFor(project)
  const versioner = services.versioner || finalizeBuildVersion
  const finalizer = services.finalizer || finalizeDocumentBuild
  const completer = services.completer || completeBuildSuccess

  // The build log, for every adapter that does not write its own. `withBuildLog`
  // captures the builder's output and writes `build.log` into the build
  // INSTANCE in a `finally`, so a build that throws still leaves the reason --
  // the `logMissing` outage that made a failed markdown or .qmd build
  // undiagnosable. Binding the builders through the registry bypassed the
  // wrappers that used to do this, so it moved here rather than being lost.
  const run = () => adapter.build({ ...context, view: adapter.view })
  const result = adapter.ownsCompletion ? await run() : await withBuildLog(context.name, run)

  if (result?.disposition === 'superseded') return { adapter: adapter.id, disposition: 'superseded' }
  if (!result?.manifest) throw new Error(`Build adapter ${adapter.id} returned no manifest`)

  if (adapter.ownsCompletion) {
    writeDocumentManifest(outputDir(context.name), result.manifest)
    return { adapter: adapter.id, manifest: result.manifest }
  }

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
