/**
 * Format-specific build logic for non-SVG project formats.
 *
 * Each builder: copies source → output, generates page-info.json,
 * updates project metadata, signals reload to viewers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { join, basename } from 'path'
import { sourceDir as getSourceDir, outputDir as getOutputDir, projectDir, readClientSourceManifest } from './project-store.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { buildPerSlideDocuments } from './slides-parser.mjs'
import { buildMarkdownDocument } from './build-markdown.mjs'
import { buildQmdDocument } from './build-qmd.mjs'
import { readTldaManifest } from './tlda-manifest.mjs'

function signalReload(name, pages) {
  getBuildReporter().broadcastSignal(`doc-${name}`, 'signal:reload', { pages, timestamp: Date.now() })
}

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
async function withBuildLog(name, run) {
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

export async function buildMarkdown(name) {
  await withBuildLog(name, (addLog) => buildMarkdownDocument(name, addLog))
  await getBuildReporter().regenerateBookTocs(name)
}

// Takes no options, like its three siblings. The worker passes `changedFiles`
// to every builder and the others have always ignored it: it decides whether to
// build at all (build-decision.mjs), not how much of a project to render.
export async function buildQmd(name) {
  await withBuildLog(name, (addLog) => buildQmdDocument(name, addLog))
  await getBuildReporter().regenerateBookTocs(name)
}

export async function buildHtml(name) {
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
        cpSync(srcPath, destPath)
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
  signalReload(name, pageInfo.length)
  console.log(`[html] ${name}: ${pageInfo.length} pages`)
}

export async function buildSlides(name) {
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
  const slides = buildPerSlideDocuments(htmlContent, htmlFiles[0])
  if (!slides) throw new Error(`${htmlFiles[0]} is not a reveal.js deck`)
  for (const slide of slides) {
    writeFileSync(join(outDir, slide.filename), slide.html)
  }
  const pageInfo = slides.map(slide => slide.pageInfo)
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))

  await writeSourceScope(name, srcDir)
  await reporter.updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date().toISOString() })
  signalReload(name, pageInfo.length)
  console.log(`[slides] ${name}: ${pageInfo.length} slides from ${htmlFiles[0]}`)
}
