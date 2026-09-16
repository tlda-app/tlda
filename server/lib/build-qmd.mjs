/**
 * build-qmd.mjs — thin build-service adapter for the Quarto renderer.
 *
 * The render itself lives in the shared incremental engine
 * (`incremental-qmd-build.mjs`), which takes explicit inputs and keeps no
 * project store, no credentials and no publication path. This module is the
 * tlda coupling the engine must not carry: it resolves the project record and
 * the store's source/output directories, derives the document roots and the
 * source scope, records the build-status patch through the reporter, and
 * delegates the render to `buildIncrementalQmd`.
 *
 * Every other export below is a re-export of the engine's helpers, so the
 * existing importers (adapter registry, tests) keep their import path.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildIncrementalQmd,
  qmdDocumentRootPaths,
} from './incremental-qmd-build.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { readProject, sourceDir as getSourceDir, outputDir as getOutputDir, readClientSourceManifest } from './project-store.mjs'

export async function buildQmdDocument(name, addLog = console.log, { changedFiles = [] } = {}) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  const project = await readProject(name)
  const mainFiles = qmdDocumentRootPaths(project)
  const sourceScopeFiles = (await readClientSourceManifest(name))
    .filter((rel) => existsSync(join(srcDir, rel)))

  return buildIncrementalQmd({
    sourceDir: srcDir,
    outputDir: outDir,
    changedFiles,
    mainFiles,
    name,
    log: addLog,
    projectMeta: project,
    sourceScopeFiles,
    onProjectUpdate: (patch) => reporter.updateProject(name, patch),
  })
}

export {
  buildIncrementalQmd,
  setBuildOutputSink,
  getBuildOutputSink,
  streamChildOutput,
  describeChildFailure,
  childFailureDetail,
  measureTree,
  describeTreeSize,
  qmdOutputFileForSource,
  qmdRenderedOutputFileForSource,
  qmdDeclaredOutputFilesForSource,
  qmdRenderedOutputFilesForSource,
  qmdMissingDeclaredOutputFiles,
  qmdDeckPageInfo,
  qmdDocumentRootPaths,
  writeTocJson,
  assembleQuartoBookToc,
  quartoBookRoots,
  resolveQuartoBookPageSources,
  quartoBookToc,
  qmdIncrementalRenderRoots,
  clearQmdFreeze,
  qmdDocumentsStaleByDependency,
  publishIncrementalQmdOutput,
  qmdDeckRenderRoots,
  qmdDeckChapterPairs,
  publishDeckIntoBook,
  renderDeckSet,
  qmdManifest,
  PERSISTENT_FREEZE_DIR,
  stageFreezeIntoRender,
  retainFreezeOutsideRender,
  retainNativeTldaRender,
  writeSourceScopeFile,
} from './incremental-qmd-build.mjs'
