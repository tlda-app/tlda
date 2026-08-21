import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { closeProjectStore, createProject, initProjectStore, readProject, sourceDir } from './project-store.mjs'
import { initSyncRooms } from './sync-rooms.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { buildAdapterFor } from './build-adapter-registry.mjs'
import { buildDocument } from './build-document.mjs'

test('real Beamer uses the LaTeX adapter and produces a slides manifest over SVG artifacts', { timeout: 120000 }, async () => {
  const fleetId = process.env.FLEET_ID
  delete process.env.FLEET_ID
  const root = mkdtempSync(join(tmpdir(), 'tlda-beamer-adapter-'))
  const projects = join(root, 'projects')
  mkdirSync(projects, { recursive: true })
  try {
    await initProjectStore(projects)
    initSyncRooms(projects)
    const project = createProject({
      name: 'beamer', mainFile: 'main.tex',
      sourceFormat: 'tex', renderer: 'latex', documentFormat: 'slides',
    })
    assert.equal(buildAdapterFor(project).id, 'latex-slides')
    writeFileSync(join(sourceDir('beamer'), 'main.tex'), String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{One}First slide\end{frame}
\begin{frame}{Two}Second slide\end{frame}
\end{document}
`)
    let versioned = false
    const result = await buildDocument(project, { name: 'beamer', reporter: getBuildReporter() }, {
      versioner: async () => { versioned = true },
    })
    assert.equal(result.adapter, 'latex-slides')
    assert.equal(versioned, true)
    assert.equal(result.manifest.document.format, 'slides')
    assert.equal(result.manifest.view.kind, 'svg-pages')
    assert.equal(result.manifest.view.capabilities.presentation, true)
    assert.equal(result.manifest.pages.length, 2)
    assert.equal(existsSync(join(projects, 'beamer', 'output', 'main.dvi')), true)
    assert.equal(existsSync(join(projects, 'beamer', 'output', 'document-manifest.json')), true)
    assert.equal((await readProject('beamer')).buildStatus, 'success')
  } finally {
    if (fleetId) process.env.FLEET_ID = fleetId
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
