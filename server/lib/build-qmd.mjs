/**
 * build-qmd.mjs — render a Quarto (.qmd) project into output/.
 *
 * Quarto is the FIRST render stage tlda has ever run itself. Slides and html
 * already arrive rendered: the author runs `quarto render` on their own machine
 * and pushes the output, so the server only copies, parses, and injects. This
 * format exists because a bot cannot do that — it has no machine of its own to
 * render on, so the render has to happen where the build happens.
 *
 * The output contract is the one every other format already meets: HTML files
 * plus a page-info.json listing them. src/loaders/htmlLoader.ts does not care
 * how the HTML was produced, which is why this is a new builder rather than a
 * new rendering path inside an existing one.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { parse as parseYaml } from 'yaml'

import { readProject, sourceDir as getSourceDir, outputDir as getOutputDir, readClientSourceManifest } from './project-store.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { getBuildReporter, streamChildOutput } from './build-runner.mjs'
import { deckPageInfo } from './slides-parser.mjs'
import { extractHtmlToc } from './html-toc-extractor.mjs'
import { readTldaManifest } from './tlda-manifest.mjs'

const execFileAsync = promisify(execFile)

// A .qmd render can run R, Python, or Julia chunks. Skip, 2026-07-31, on the
// cost: "I know a quarto render, especially if it's doing significant R shit,
// is gonna be significant computationally ... that's just how the format
// works." Generous on purpose — a timeout here presents as a broken document
// rather than a slow one, which is the more expensive failure to diagnose.
const RENDER_TIMEOUT_MS = 15 * 60 * 1000

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 1200

/**
 * Resolve the quarto binary, or throw naming the install command.
 *
 * PATH is the only source. There is deliberately no configured path and no
 * bundled-location fallback: a second place to look is a second thing that can
 * be wrong, and "which quarto did it pick?" is a worse failure than the one a
 * fallback would prevent. A machine that renders .qmd has quarto on PATH.
 */
async function resolveQuarto() {
  const found = await execFileAsync('sh', ['-c', 'command -v quarto'])
    .then(({ stdout }) => stdout.trim())
    // `command -v` exits non-zero for "not found". That is the answer to the
    // question, not an error to report, so it becomes an empty result and the
    // single throw below is the only way this function fails.
    .catch(() => '')
  if (found) return found
  throw new Error(
    'quarto is not on PATH — a .qmd project cannot be built without it. Install it with `brew install --cask quarto`.',
  )
}

/** Resolve Rscript the same way, for the same reason. */
async function resolveRscript() {
  const found = await execFileAsync('sh', ['-c', 'command -v Rscript'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
  if (found) return found
  throw new Error(
    'Rscript is not on PATH — a .qmd project with an renv.lock cannot be built without R. Install it with `brew install r`.',
  )
}

/**
 * Restore the project's R library from its lockfile before rendering.
 *
 * An renv project pushes `renv.lock`, `.Rprofile` and `renv/activate.R`. It
 * does NOT push `renv/library` — renv gitignores it, because the library is
 * symlinks into a machine-global package cache and copying it somewhere else
 * is meaningless. So every render on a server starts from metadata alone.
 *
 * What the author's `.Rprofile` does on the way in is the part that makes this
 * mandatory rather than merely helpful: sourcing `renv/activate.R` repoints
 * the R library paths at the project library and AWAY from the system library.
 * The autoloader then bootstraps renv into that empty library and stops — it
 * installs renv and nothing else. So a machine with knitr and rmarkdown
 * installed system-wide renders with them out of reach and reports
 *
 *   The knitr package is not available in this R installation.
 *
 * which reads as a missing R installation and is not one. Installing packages
 * system-wide does not fix it; only filling the project library does.
 *
 * `renv::restore()` is what fills it, and it is the documented answer on every
 * side: quarto.org's Virtual Environments page ("To reproduce the environment
 * on another machine use the renv::restore() function"), renv's own Dockerfile
 * recipe — copy the metadata files, `R -s -e "renv::restore()"`, then copy the
 * tree — and the `make setup` target in the deck this was measured against. It
 * is transactional, and with a warm cache it links rather than reinstalls, so
 * confirming an already-matching library costs ~10s.
 *
 * Restoring in outDir rather than the source mirror is the choice
 * renderInOutput already makes, and renv's Docker recipe restores into a
 * copied tree for the same reason. One consequence is worth knowing: when a
 * project repoints `RENV_PATHS_LIBRARY_ROOT`, renv disambiguates libraries by
 * a hash of the project's absolute path, so the build gets its own library and
 * the author's interactive one is untouched. outDir is stable per project, so
 * that library is filled once and warm on every later build.
 */
async function restoreRenv(outDir, addLog) {
  if (!existsSync(join(outDir, 'renv.lock'))) return

  const rscript = await resolveRscript()
  addLog('[qmd] renv::restore() from renv.lock')
  let result
  try {
    result = await execFileAsync(
      rscript,
      ['-e', 'renv::restore(prompt = FALSE)'],
      { cwd: outDir, timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    )
  } catch (e) {
    // Same reasoning as the render: renv names the package it could not get on
    // stderr, and "Command failed" names nothing anyone can act on.
    const detail = String(e.stderr || e.stdout || e.message || '').trim()
    throw new Error(`renv::restore() failed in ${outDir}:\n${detail}`)
  }
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of String(stream || '').split('\n')) {
      if (line.trim()) addLog(`[renv] ${line}`)
    }
  }
}

/** The .html a given .qmd renders to, as a project-relative path. */
export function qmdOutputFileForSource(sourceFile) {
  return String(sourceFile || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\.qmd$/i, '.html')
}

export function qmdRenderedOutputFileForSource(outDir, sourceFile) {
  return qmdRenderedOutputFilesForSource(outDir, sourceFile)[0] || null
}

export function qmdDeclaredOutputFilesForSource(outDir, sourceFile) {
  const normalizedSource = String(sourceFile || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  const sourcePath = join(outDir, normalizedSource)
  const candidates = []
  if (existsSync(sourcePath)) {
    const source = readFileSync(sourcePath, 'utf8')
    const frontMatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (frontMatter) {
      const format = parseYaml(frontMatter[1])?.format
      if (format && typeof format === 'object' && !Array.isArray(format)) {
        for (const options of Object.values(format)) {
          if (!options || typeof options !== 'object' || Array.isArray(options)) continue
          const outputFile = options['output-file']
          if (typeof outputFile !== 'string' || !outputFile.trim()) continue
          candidates.push(join(dirname(normalizedSource), outputFile).replace(/\\/g, '/'))
        }
      }
    }
  }
  if (candidates.length === 0) candidates.push(qmdOutputFileForSource(normalizedSource))
  return [...new Set(candidates)]
}

export function qmdRenderedOutputFilesForSource(outDir, sourceFile) {
  const rendered = []
  for (const candidate of qmdDeclaredOutputFilesForSource(outDir, sourceFile)) {
    for (const path of [candidate, `_book/${candidate}`]) {
      if (existsSync(join(outDir, path))) rendered.push(path)
    }
  }
  return [...new Set(rendered)]
}

export function qmdMissingDeclaredOutputFiles(outDir, sourceFile) {
  return qmdDeclaredOutputFilesForSource(outDir, sourceFile).filter((candidate) => (
    !existsSync(join(outDir, candidate)) && !existsSync(join(outDir, `_book/${candidate}`))
  ))
}

/**
 * The page-info entry for a deck built from a .qmd root.
 *
 * One entry, not one per slide. `deck.slides` carries the address space the
 * window manager lays out; `variant`/`group` are what pair a deck with its
 * chapter as alternate renderings of one source, and both are unchanged by
 * there now being a single entry — nothing downstream keys on slide count.
 */
export function qmdDeckPageInfo(root, deck, variant) {
  return {
    ...deck,
    group: root,
    ...(variant && { variant }),
    source: { type: 'project-source', format: 'qmd', file: root },
  }
}

export function qmdDocumentRootPaths(project) {
  const declared = Array.isArray(project?.documentRoots)
    ? project.documentRoots
        .map((root) => typeof root === 'string' ? root : root?.path)
        .map((path) => String(path || '').replace(/\\/g, '/').replace(/^\.?\/+/, ''))
        .filter((path) => path.toLowerCase().endsWith('.qmd'))
    : []
  const fallback = String(project?.mainFile || 'index.qmd').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  return [...new Set(declared.length > 0 ? declared : [fallback])]
}

/**
 * Did this render produce a reveal.js deck?
 *
 * The same test slides-parser uses to find the container it walks, so a file
 * this says yes about is one it can enumerate slides from. Anything else — a
 * scrolling document, a deck in some other slide framework — is one page.
 */
function isRevealDeck(html) {
  return /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bslides\b)[^>]*>/i.test(html)
}

function titleFromRenderedHtml(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return fallback
  const title = match[1].replace(/\s+/g, ' ').trim()
  return title || fallback
}

/**
 * Give every knitr figure a URL that changes when the figure does.
 *
 * knitr names figures after the chunk, so a re-render writes new bytes to the
 * SAME path — `report_files/figure-html/unnamed-chunk-1-1.svg` every time. The
 * viewer reloads a changed document by re-pointing the iframe at a
 * cache-busted page URL, which reloads the DOCUMENT; the `<img>` inside it
 * still names an unchanged URL, so the browser reuses the copy it already has
 * and the plot on screen stays on the previous render.
 *
 * That is what "the R plot isn't updating as I change the file" was: the build
 * was correct, the server was serving new bytes, a plain fetch of that exact
 * URL returned new bytes, and the picture was old. Stamping the reference is
 * what makes the reload reach the figure.
 *
 * Only figure directories are stamped. `site_libs` and the OJS runtime are
 * byte-identical across renders, so busting them would re-download ~900KB on
 * every build to fix nothing.
 */
function stampFigureUrls(html, stamp = Date.now()) {
  return html.replace(
    /(\ssrc=")([^"]*_files\/figure-[^"?]+)(")/g,
    (_m, before, url, after) => `${before}${url}?v=${stamp}${after}`,
  )
}

/**
 * Render in the OUTPUT tree, not the source tree.
 *
 * Quarto writes its sidecar `<doc>_files/` directory next to the input and
 * maintains freeze/cache state there. Pointing it at the source mirror would
 * make a build mutate the tree the version is taken from, so the whole tree is
 * copied first and the render runs against the copy.
 */
// `project` is carried only to label the output stream. It is separate from
// `mainFile` on purpose: a project renders several roots, and a stream labelled
// by the root would report the same build under changing names.
async function renderInOutput(quarto, outDir, mainFile, addLog, { wholeProject = false, project = null } = {}) {
  const target = wholeProject ? [] : [mainFile]
  addLog(`[qmd] quarto render${wholeProject ? '' : ` ${mainFile}`}`)
  let result
  try {
    // No `--to`. The document's own `format:` decides what it renders to, and
    // quarto's default when it declares none is already html — so passing
    // `--to html` changed nothing for a plain document and silently overrode a
    // deck. That is what made a `format: revealjs` talk render as a scrolling
    // page with no <div class="reveal"> in it at all.
    // The longest single command in this codebase, and until now the quietest:
    // a large render runs for minutes with quarto narrating to a buffer nobody
    // reads until it finishes. Streaming it is what tells the build queue this
    // is a slow build rather than a stalled one.
    const running = execFileAsync(
      quarto,
      ['render', ...target],
      { cwd: outDir, timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    )
    const detachOutput = streamChildOutput(running.child, project || mainFile)
    try {
      result = await running
    } finally {
      detachOutput()
    }
  } catch (e) {
    // Quarto reports the actual chunk/YAML error on stderr. The exec error
    // message alone is "Command failed", which names nothing an author can act
    // on, so the captured output is what gets raised.
    const detail = String(e.stderr || e.stdout || e.message || '').trim()
    throw new Error(`quarto render failed for ${mainFile}:\n${detail}`)
  }
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of String(stream || '').split('\n')) {
      if (line.trim()) addLog(`[qmd] ${line}`)
    }
  }
}

function isNativeTldaProject(dir) {
  for (const name of ['_quarto.yml', '_quarto.yaml']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const config = parseYaml(readFileSync(path, 'utf8'))
    return config?.project?.type === 'tlda'
  }
  return false
}

async function writeSourceScope(name, srcDir, outDir) {
  const files = (await readClientSourceManifest(name))
    .filter((rel) => existsSync(join(srcDir, rel)))
    .sort()
  writeFileSync(
    join(outDir, 'relevant-files.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 2),
  )
}

/**
 * A Quarto build's manifest.
 *
 * Quarto is the one renderer whose view is not a property of its adapter. The
 * registry declares a `view` for `latex`, `latex-slides` and the identity
 * adapters, and deliberately none for `quarto` — because quarto renders a .qmd
 * to a scrolling document or to a reveal deck depending on the `format:` its
 * author wrote, and only the build knows which it produced. That is the same
 * fact `renderedFormat` exists to carry and `viewFormat()` exists to read.
 *
 * So this derives the view from what was rendered rather than from a constant
 * or from the adapter. Getting it from the adapter would mean guessing before
 * quarto ran.
 *
 * Pages come from `pageInfo` unchanged — the same entries written to
 * `page-info.json`, so the manifest and the viewer cannot describe different
 * documents.
 */
function qmdManifest(project, pageInfo, renderedFormat) {
  const isDeck = renderedFormat === 'slides'
  return createDocumentManifest(project, pageInfo, {
    sourceMapping: 'none',
    view: {
      kind: isDeck ? 'slides' : 'html-pages',
      capabilities: { presentation: isDeck, sourceMapping: false, searchableText: true },
    },
  })
}

export async function buildQmdDocument(name, addLog = console.log) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  const project = await readProject(name)
  const mainFiles = qmdDocumentRootPaths(project)
  const mainFile = mainFiles[0]

  // Throw, don't return. A normal return is how a builder says it BUILT, and
  // the worker reads it that way: it publishes the instance, whose `output/` is
  // created empty by materializeBuildInstance and never seeded from the live
  // one. So a build that rendered nothing swapped an empty directory over the
  // last good render and took the whole document down. The existence guard in
  // publishBuildInstance cannot catch it — the directory IS there, it is just
  // empty, which is the state nobody thought to distinguish.
  //
  // The worker's catch is the path that already does the right thing here:
  // diagnostics out, nothing published, `build_failed` recorded.
  for (const root of mainFiles) {
    if (!existsSync(join(srcDir, root))) {
      throw new Error(`[qmd] document root not found: ${root}`)
    }
  }

  const quarto = await resolveQuarto()

  mkdirSync(outDir, { recursive: true })
  // The whole tree, for the reason `buildSlidesDocument` copies it: a .qmd depends on
  // sibling data files, figures, _quarto.yml, and any _extensions/ it uses, and
  // a render that cannot see them fails in a way that reads as bad source.
  cpSync(srcDir, outDir, { recursive: true })

  await restoreRenv(outDir, addLog)
  const nativeTldaProject = isNativeTldaProject(outDir)
  // EVERY root, every build. Rendering only the roots a revision touched left
  // the others with no HTML at all: the build instance's `output/` is created
  // empty and never seeded from the live project, so there is no previous
  // render here to carry forward, whatever the live project still holds.
  //
  // Publishing swaps `output/` WHOLESALE, so a partial tree is not a
  // publishable one -- and the check below then failed the whole build on the
  // roots that were never asked to render. That is what made an outage
  // permanent instead of momentary: a project whose output was gone could not
  // rebuild itself from its own source however many times it was pushed, and
  // the only way out was a push touching a file outside every root's closure,
  // which forced a full render by accident.
  //
  // LaTeX already builds all its targets each time. This makes qmd match it
  // rather than diverge. A genuinely incremental render is a real design --
  // it needs the previous output in the instance to build on -- and is not
  // this accident, which was only ever cheaper by leaving the job unfinished.
  if (nativeTldaProject) {
    await renderInOutput(quarto, outDir, mainFile, addLog, { wholeProject: true, project: name })
  } else {
    for (const root of mainFiles) await renderInOutput(quarto, outDir, root, addLog, { project: name })
  }

  if (nativeTldaProject) {
    const renderedProject = readTldaManifest(outDir)
    if (!renderedProject) {
      throw new Error('tlda Quarto project rendered without producing tlda-manifest.json')
    }
    for (const page of renderedProject.pageInfo) {
      const path = join(outDir, page.file)
      writeFileSync(path, stampFigureUrls(readFileSync(path, 'utf8')))
    }
    writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(renderedProject.pageInfo, null, 2))
    await writeSourceScope(name, srcDir, outDir)
    await reporter.updateProject(name, {
      buildStatus: 'success',
      pages: renderedProject.pageInfo.length,
      renderedFormat: 'html',
      lastBuild: new Date().toISOString(),
    })
    addLog(`[qmd] ${name}: rendered tlda project with ${renderedProject.pageInfo.length} pages`)
    // A tlda Quarto project is always the scrolling document, which is why the
    // patch above hardcodes renderedFormat 'html'. Both return paths describe
    // themselves or the cutover would work for one kind of qmd and not the
    // other — and this one returns early, so it is the one easy to miss.
    return { manifest: qmdManifest(await readProject(name), renderedProject.pageInfo, 'html'), regenerateBookTocs: true }
  }

  const pageInfo = []
  let anyDeck = false
  for (const root of mainFiles) {
    const sourceOutputFile = qmdOutputFileForSource(root)
    const declaredOutputFiles = qmdDeclaredOutputFilesForSource(outDir, root)
    const outputFiles = qmdRenderedOutputFilesForSource(outDir, root)
    // Throws for the reason the root check above throws: a render that produced
    // no document is a failed build, and returning normally publishes the empty
    // instance over the last good render.
    if (outputFiles.length === 0) {
      throw new Error(`[qmd] render produced neither ${sourceOutputFile} nor _book/${sourceOutputFile}`)
    }
    const missingOutputFiles = qmdMissingDeclaredOutputFiles(outDir, root)
    if (missingOutputFiles.length > 0) {
      throw new Error(`[qmd] render did not produce declared output(s): ${missingOutputFiles.join(', ')}`)
    }
    const hasAlternates = declaredOutputFiles.length > 1
    for (const outputFile of outputFiles) {
      const renderedPath = join(outDir, outputFile)
      const rendered = stampFigureUrls(readFileSync(renderedPath, 'utf8'))
      writeFileSync(renderedPath, rendered)

      const isDeck = isRevealDeck(rendered)
      anyDeck ||= isDeck
      const variant = hasAlternates ? (isDeck ? 'slides' : 'chapter') : undefined
      if (isDeck) {
        const deck = deckPageInfo(rendered, outputFile)
        pageInfo.push(qmdDeckPageInfo(root, deck, variant))
        addLog(`[qmd] ${root}: one deck document, ${deck.slides.length} slides`)
      } else {
        pageInfo.push({
          file: outputFile,
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          title: titleFromRenderedHtml(rendered, root.replace(/\.qmd$/i, '')),
          format: 'qmd',
          ...(variant && { variant }),
          source: { type: 'project-source', format: 'qmd', file: root },
        })
      }
    }
  }
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  const chapterPages = pageInfo.filter((entry) => entry.variant !== 'slides')
  const toc = extractHtmlToc(outDir, chapterPages)
  if (pageInfo.some((entry) => entry.variant === 'slides') && chapterPages.length > 0) {
    toc.push({ title: 'Slides', level: 'section', page: 1, variant: 'slides' })
  }
  writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))

  await writeSourceScope(name, srcDir, outDir)
  // Computed once and used twice, deliberately. This condition decides both
  // what the project records and what the manifest's view says, and two copies
  // of it would be two answers to "is this a deck" that can drift apart —
  // exactly the split `renderedFormat` was added to stop.
  const renderedFormat = mainFiles.length === 1 && anyDeck && pageInfo.every((entry) => entry.variant !== 'chapter') ? 'slides' : 'html'
  await reporter.updateProject(name, {
    buildStatus: 'success',
    pages: pageInfo.length,
    renderedFormat,
    lastBuild: new Date().toISOString(),
  })
  addLog(`[qmd] ${name}: rendered ${mainFiles.length} document root(s)`)

  return { manifest: qmdManifest(await readProject(name), pageInfo, renderedFormat), regenerateBookTocs: true }
}
