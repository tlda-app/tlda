/**
 * The HTML and slides builders, and the build-log wrapper every non-LaTeX
 * adapter runs inside.
 *
 * Each builder copies source → output, generates page-info.json, and returns a
 * document manifest. It does NOT update the project record, publish the
 * manifest or signal a reload: `buildDocument()` owns those, and this file said
 * otherwise until the cutover moved them.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { join, basename } from 'path'
import { sourceDir as getSourceDir, outputDir as getOutputDir, projectDir, readProject, readClientSourceManifest } from './project-store.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { deckPageInfo } from './slides-parser.mjs'
import { readTldaManifest } from './tlda-manifest.mjs'

/**
 * Declare paper scope for the formats whose project IS a rendered document.
 *
 * LaTeX learns its scope from the .fls and markdown from the refs its columns
 * name, because for those the project holds authored input. Slides and HTML
 * hold no input at all — the .qmd/.Rmd is never pushed, only what it rendered
 * to. So the pushed manifest is the whole document, and the scope is all of it.
 *
 * Nothing is excluded, deliberately. Dropping the render's `*_files/` tree was
 * considered and rejected: it would drop the deck itself (which lives at the
 * same level), and it would drop knitr-generated figures, which have no sibling
 * carrying their record the way a LaTeX .pdf has its .svg — so an old version
 * would render with a hole where the figure was. The bulk it would have saved
 * is vendored library code that is byte-identical every render, and git
 * content-addresses blobs, so it costs one copy across all versions rather than
 * one per version. What actually churns is the small part.
 */
async function writeSourceScope(name, srcDir) {
  const files = (await readClientSourceManifest(name))
    .filter((rel) => existsSync(join(srcDir, rel)))
    .sort()
  writeFileSync(
    join(getOutputDir(name), 'relevant-files.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 2),
  )
}

/**
 * Run a format builder with its log captured to `build.log`.
 *
 * `publishBuildDiagnostics` already carries `build.log` out of a failed build's
 * instance before the instance is removed — but only if something wrote one,
 * and nothing did. These builders logged to `console.log` alone, so a failed
 * markdown or .qmd build left no log, no errors and no recorded reason: the
 * `logMissing` that made an outage undiagnosable. The wire existed and had
 * nothing on it.
 *
 * `projectDir` is the build INSTANCE while a build runs, which is where both
 * the diagnostics path (on failure) and the publish swap (on success) read it
 * from. Written in a `finally` because the failure is the case that needs it.
 */
export async function withBuildLog(name, run) {
  const lines = []
  const addLog = (message) => {
    lines.push(String(message))
    console.log(message)
  }
  try {
    return await run(addLog)
  } catch (e) {
    lines.push(`[build] ${e?.message || String(e)}`)
    throw e
  } finally {
    try {
      writeFileSync(join(projectDir(name), 'build.log'), `${lines.join('\n')}\n`)
    } catch (writeError) {
      // Never let recording the reason replace the thing being recorded.
      console.error(`[build] could not write build.log for ${name}: ${writeError?.message || writeError}`)
    }
  }
}

/**
 * Describe what an HTML build produced, from what the build already knows.
 *
 * The one fact worth deriving rather than declaring is source mapping. An HTML
 * project usually holds a rendered document and nothing that produced it, so
 * there is no source to map back to. But a tlda-aware Quarto render ships a
 * `tlda-manifest.json`, and `pageInfoFromTldaManifest` requires every page in it
 * to name its `.qmd` — so when that manifest is present each page DOES carry a
 * source coordinate, and when it is absent none does.
 *
 * That is why this reads `renderedProject` rather than declaring a constant:
 * the same builder produces both kinds of document, and only the build knows
 * which one it just handled. Declaring `false` would tell every reader that a
 * tlda render cannot map back to its source, which is the one case where it can.
 *
 * Pages are `pageInfo` unchanged — the same entries written to `page-info.json`,
 * so the manifest and the viewer cannot describe different documents.
 */
function htmlManifest(project, pageInfo, mapsToSource) {
  return createDocumentManifest(project, pageInfo, {
    sourceMapping: mapsToSource ? 'page-source' : 'none',
    view: {
      kind: 'html-pages',
      capabilities: { presentation: false, sourceMapping: mapsToSource, searchableText: true },
    },
  })
}

export async function buildHtmlDocument(name, addLog = console.log) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)
  mkdirSync(outDir, { recursive: true })

  // Copy all source files to output (preserving directory structure)
  const copyRecursive = (src, dest) => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true })
        copyRecursive(srcPath, destPath)
      } else {
        cpSync(srcPath, destPath, { dereference: true, recursive: true })
      }
    }
  }
  copyRecursive(srcDir, outDir)

  // A tlda-aware Quarto render declares its page order and source coordinates.
  const renderedProject = readTldaManifest(outDir)
  const pageInfoPath = join(outDir, 'page-info.json')
  let pageInfo
  if (renderedProject) {
    pageInfo = renderedProject.pageInfo
    writeFileSync(pageInfoPath, JSON.stringify(pageInfo, null, 2))
  } else if (existsSync(pageInfoPath)) {
    pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  } else {
    const htmlFiles = readdirSync(outDir).filter(f => f.endsWith('.html') && !f.startsWith('_'))
    pageInfo = htmlFiles.map(f => {
      const html = readFileSync(join(outDir, f), 'utf8')
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
      const title = titleMatch ? titleMatch[1].replace(/\s*[-–|].*$/, '').trim() : basename(f, '.html')
      return { file: f, width: 800, height: 1000, title }
    })
    writeFileSync(pageInfoPath, JSON.stringify(pageInfo, null, 2))
  }

  await writeSourceScope(name, srcDir)
  await reporter.updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date().toISOString() })
  addLog(`[html] ${name}: ${pageInfo.length} pages`)
  return { manifest: htmlManifest(await readProject(name), pageInfo, Boolean(renderedProject)) }
}

/**
 * Describe what a slides build produced.
 *
 * A deck is ONE page carrying N slide coordinates, not N pages. That is the
 * shape `buildSlidesDocument` already writes to `page-info.json` — `[deck]`,
 * where `deck.slides` is the address space — and it is a product decision
 * rather than an artifact of the parser: the deck keeps a single webR session,
 * so a name defined on one slide is visible on the rest, and splitting it into
 * a page per slide would split the session with it.
 *
 * So the manifest reports `pages.length === 1` for a deck of any size, and the
 * slide count lives in `pages[0].slides`. A manifest that reported one page per
 * slide would describe a different document from the one the viewer loads.
 *
 * `presentation: true` is the whole point of the view, and it is declared here
 * rather than derived because — unlike quarto, which only learns what it made
 * after rendering — this builder has already refused anything that is not a
 * reveal.js deck by the time it gets here.
 */
function slidesManifest(project, pageInfo) {
  return createDocumentManifest(project, pageInfo, {
    sourceMapping: 'none',
    view: {
      kind: 'slides',
      capabilities: { presentation: true, sourceMapping: false, searchableText: true },
    },
  })
}

export async function buildSlidesDocument(name, addLog = console.log) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)
  mkdirSync(outDir, { recursive: true })

  // Reveal/Quarto decks depend on sibling asset directories such as site_libs,
  // figures, fonts, and generated support JS. Copy the full source tree so a
  // deck that works raw also has the same assets inside tlda.
  cpSync(srcDir, outDir, { recursive: true })

  const htmlFiles = readdirSync(srcDir).filter(f => f.endsWith('.html'))
  if (htmlFiles.length === 0) throw new Error('No HTML file found in source')

  const htmlContent = readFileSync(join(outDir, htmlFiles[0]), 'utf8')
  const deck = deckPageInfo(htmlContent, htmlFiles[0])
  if (!deck.slides.length) throw new Error(`${htmlFiles[0]} is not a reveal.js deck`)
  // One document, not one per slide: the deck keeps a single webR session, so a
  // name defined on one slide is visible on the rest. Placement is the window
  // manager's job and reads `slides` for the address space.
  const pageInfo = [deck]
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))

  await writeSourceScope(name, srcDir)
  await reporter.updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date().toISOString() })
  addLog(`[slides] ${name}: deck of ${deck.slides.length} slides from ${htmlFiles[0]}`)
  return { manifest: slidesManifest(await readProject(name), pageInfo) }
}
