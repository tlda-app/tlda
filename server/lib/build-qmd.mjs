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

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  buildIncrementalQmd,
  qmdDocumentRootPaths,
  qmdManifest,
} from './incremental-qmd-build.mjs'
import { buildCoursePublication } from './course-publication-build.mjs'
import { deriveCourseAppSpec } from './course-app-build.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { readProject, sourceDir as getSourceDir, outputDir as getOutputDir, readClientSourceManifest } from './project-store.mjs'

const execFileAsync = promisify(execFile)

export function coursePublicationGenerator(name, raw = process.env.TLDA_COURSE_PUBLICATION_GENERATORS) {
  if (!raw) return null
  let configured
  try {
    configured = JSON.parse(raw)
  } catch {
    throw new Error('TLDA_COURSE_PUBLICATION_GENERATORS must be a JSON object')
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('TLDA_COURSE_PUBLICATION_GENERATORS must be a JSON object')
  }
  const entry = configured[name]
  if (entry === undefined) return null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`TLDA_COURSE_PUBLICATION_GENERATORS[${JSON.stringify(name)}] must be an object`)
  }
  if (typeof entry.repository !== 'string' || !/^https:\/\//.test(entry.repository)) {
    throw new Error(`course publication generator for ${name} requires an HTTPS repository`)
  }
  if (typeof entry.revision !== 'string' || !/^[0-9a-f]{40}$/i.test(entry.revision)) {
    throw new Error(`course publication generator for ${name} requires an exact 40-character Git revision`)
  }
  return {
    repository: entry.repository,
    revision: entry.revision.toLowerCase(),
    builder: typeof entry.builder === 'string' && entry.builder ? entry.builder : 'build-site.py',
    requirements: typeof entry.requirements === 'string' && entry.requirements ? entry.requirements : 'requirements.txt',
  }
}

async function withCoursePublicationGenerator(config, run) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-course-publication-generator-'))
  const checkout = join(root, 'checkout')
  const venv = join(root, 'venv')
  try {
    await execFileAsync('git', ['clone', '--quiet', '--no-checkout', config.repository, checkout])
    await execFileAsync('git', ['-C', checkout, 'checkout', '--quiet', '--detach', config.revision])
    const { stdout } = await execFileAsync('git', ['-C', checkout, 'rev-parse', 'HEAD'])
    if (stdout.trim().toLowerCase() !== config.revision) throw new Error('course publication generator checkout did not resolve the configured revision')
    await execFileAsync('python3', ['-m', 'venv', venv])
    await execFileAsync(join(venv, 'bin', 'pip'), ['install', '--quiet', '-r', join(checkout, config.requirements)])
    return await run({
      builder: join(checkout, config.builder),
      python: join(venv, 'bin', 'python3'),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export async function buildQmdDocument(name, addLog = console.log, { changedFiles = [] } = {}) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  const project = await readProject(name)
  const mainFiles = qmdDocumentRootPaths(project)
  const sourceScopeFiles = (await readClientSourceManifest(name))
    .filter((rel) => existsSync(join(srcDir, rel)))

  const publicationGenerator = coursePublicationGenerator(name)
  if (publicationGenerator) {
    const indexFile = project.mainFile || 'index.qmd'
    const spec = deriveCourseAppSpec(srcDir, indexFile)
    return withCoursePublicationGenerator(publicationGenerator, async ({ builder, python }) => {
      const result = await buildCoursePublication({
        courseDir: srcDir,
        indexFile,
        outputDir: outDir,
        render: renderedDir => buildIncrementalQmd({
          sourceDir: srcDir,
          outputDir: renderedDir,
          changedFiles: null,
          mainFiles: qmdDocumentRootPaths(project),
          name,
          log: addLog,
          projectMeta: project,
          sourceScopeFiles,
          onProjectUpdate: null,
        }),
        assembleStatic: async ({ renderedDir, outputDir }) => {
          await execFileAsync(python, [
            builder,
            '--course-dir', srcDir,
            '--book-dir', join(renderedDir, '_book'),
            '--site-dir', outputDir,
          ], {
            cwd: dirname(builder),
            env: { ...process.env, PYTHONPATH: join(dirname(builder), 'python') },
            maxBuffer: 16 * 1024 * 1024,
          })
        },
      })
      const pages = result.app.pages.map(page => ({ ...page, file: `app/${page.file}` }))
      writeFileSync(join(outDir, 'page-info.json'), `${JSON.stringify(pages, null, 2)}\n`)
      writeFileSync(join(outDir, 'toc.json'), readFileSync(join(outDir, 'app', 'toc.json')))
      writeFileSync(join(outDir, 'relevant-files.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), files: sourceScopeFiles }, null, 2)}\n`)
      await reporter.updateProject(name, {
        buildStatus: 'success',
        pages: pages.length,
        renderedFormat: 'html',
        lastBuild: new Date().toISOString(),
      })
      addLog(`[qmd] ${name}: published one course render as static/ and app/ (${spec.documents.length} documents, ${spec.decks.length} decks)`)
      return { manifest: qmdManifest(project, pages, 'html'), regenerateBookTocs: true }
    })
  }

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
