// Worker-side project-parts rebuild. Request handlers schedule this work; only
// the live-room signal is relayed back to the server process.
import { listProjectPartColumns, pageInfoFromDocumentColumns } from './document-columns.mjs'
import { getBuildReporter } from './build-runner.mjs'

export async function buildProjectPartsView(name) {
  const columns = await listProjectPartColumns(name)
  const pageInfo = pageInfoFromDocumentColumns(name, columns)
  getBuildReporter().broadcastSignal(`doc-${name}`, 'signal:reload', {
    parts: pageInfo.length,
    timestamp: Date.now(),
  })
}
