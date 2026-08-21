// Worker-side project-parts rebuild. Request handlers schedule this work; only
// the live-room signal is relayed back to the server process.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outputDir as getOutputDir } from './project-store.mjs'
import { listProjectPartColumns, pageInfoFromDocumentColumns } from './document-columns.mjs'
import { getBuildReporter } from './build-runner.mjs'

export async function buildProjectPartsView(name) {
  const columns = await listProjectPartColumns(name)
  const pageInfo = pageInfoFromDocumentColumns(name, columns)
  const outDir = getOutputDir(name)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  getBuildReporter().broadcastSignal(`doc-${name}`, 'signal:reload', {
    parts: pageInfo.length,
    timestamp: Date.now(),
  })
}
