/**
 * Identity-renderer adapter implementations.
 *
 * Each function returns a BuildResult. Publication and all success side
 * effects belong to buildDocument().
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { join, basename } from 'path'
import { sourceDir as getSourceDir, outputDir as getOutputDir, readClientSourceManifest } from './project-store.mjs'
import { generateSlidesPageInfo } from './slides-parser.mjs'
import { readTldaManifest } from './tlda-manifest.mjs'
import { createDocumentManifest } from './document-manifest.mjs'

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

export async function buildHtmlDocument(name) {
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
  let pageInfo
  if (renderedProject) {
    pageInfo = renderedProject.pageInfo
  } else {
    const htmlFiles = readdirSync(outDir).filter(f => f.endsWith('.html') && !f.startsWith('_'))
    pageInfo = htmlFiles.map(f => {
      const html = readFileSync(join(outDir, f), 'utf8')
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
      const title = titleMatch ? titleMatch[1].replace(/\s*[-–|].*$/, '').trim() : basename(f, '.html')
      return { file: f, width: 800, height: 1000, title }
    })
  }

  const manifest = createDocumentManifest({
    format: 'html', sourceFormat: 'html', renderer: 'identity', documentFormat: 'html',
  }, pageInfo, { sourceMapping: pageInfo.some(page => page.source) ? 'page-source' : 'none', view: {
    kind: 'html-pages', capabilities: { presentation: false, sourceMapping: pageInfo.some(page => page.source), searchableText: false },
  } })

  await writeSourceScope(name, srcDir)
  console.log(`[html] ${name}: ${pageInfo.length} pages`)
  return { manifest }
}

export async function buildSlidesDocument(name) {
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
  const pageInfo = generateSlidesPageInfo(htmlContent, htmlFiles[0])
  const manifest = createDocumentManifest({
    format: 'slides', sourceFormat: 'html', renderer: 'identity', documentFormat: 'slides',
    mainFile: htmlFiles[0],
  }, pageInfo, { sourceMapping: 'none', view: {
    kind: 'slides', capabilities: { presentation: true, sourceMapping: false, searchableText: false },
  } })

  await writeSourceScope(name, srcDir)
  console.log(`[slides] ${name}: ${pageInfo.length} slides from ${htmlFiles[0]}`)
  return { manifest }
}
