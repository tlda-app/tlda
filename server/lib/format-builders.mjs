/**
 * Format-specific build logic for non-SVG project formats.
 *
 * Each builder: copies source → output, generates page-info.json,
 * updates project metadata, signals reload to viewers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import { join, basename } from 'path'
import { updateProject, sourceDir as getSourceDir, outputDir as getOutputDir, listProjects, aggregateBookToc } from './project-store.mjs'
import { broadcastSignal } from './sync-rooms.mjs'
import { generateSlidesPageInfo } from './slides-parser.mjs'
import { buildMarkdownDocument } from './build-markdown.mjs'

function signalReload(name, pages) {
  broadcastSignal(`doc-${name}`, 'signal:reload', { pages, timestamp: Date.now() })
}

function regenerateBookTocs(name) {
  for (const p of listProjects()) {
    if (p.format === 'book' && Array.isArray(p.members) && p.members.includes(name)) {
      aggregateBookToc(p.name, p.members)
    }
  }
}

export async function buildMarkdown(name) {
  await buildMarkdownDocument(name, (msg) => console.log(msg))
  regenerateBookTocs(name)
}

export async function buildHtml(name) {
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

  // Use existing page-info.json if pushed, otherwise auto-generate from HTML titles
  const pageInfoPath = join(outDir, 'page-info.json')
  let pageInfo
  if (existsSync(pageInfoPath)) {
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

  updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date().toISOString() })
  signalReload(name, pageInfo.length)
  console.log(`[html] ${name}: ${pageInfo.length} pages`)
}

export async function buildSlides(name) {
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)
  mkdirSync(outDir, { recursive: true })

  const htmlFiles = readdirSync(srcDir).filter(f => f.endsWith('.html'))
  for (const f of htmlFiles) {
    cpSync(join(srcDir, f), join(outDir, f))
  }

  if (htmlFiles.length === 0) throw new Error('No HTML file found in source')

  const htmlContent = readFileSync(join(outDir, htmlFiles[0]), 'utf8')
  const pageInfo = generateSlidesPageInfo(htmlContent, htmlFiles[0])
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))

  updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date().toISOString() })
  signalReload(name, pageInfo.length)
  console.log(`[slides] ${name}: ${pageInfo.length} slides from ${htmlFiles[0]}`)
}
