#!/usr/bin/env node
/**
 * Publish a static snapshot to GitHub Pages.
 *
 * Copies built SVGs and metadata from the server project directory,
 * exports current annotations from the shapes API, builds the viewer,
 * and deploys to GitHub Pages.
 *
 * The static viewer loads annotations from baked JSON in read-only mode
 * when no sync server is available.
 *
 * Usage:
 *   node scripts/publish-snapshot.mjs [doc-name]
 *   npm run publish-snapshot -- spinoff3
 *
 * Environment:
 *   CTD_SERVER - Server URL (default: http://localhost:5176)
 */

import { writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const DOC_NAME = process.argv[2]
if (!DOC_NAME) {
  console.error('Usage: node scripts/publish-snapshot.mjs <doc-name>')
  console.error('Example: node scripts/publish-snapshot.mjs spinoff3')
  process.exit(1)
}

const CTD_SERVER = process.env.CTD_SERVER || 'http://localhost:5176'
const projectDir = join(PROJECT_ROOT, 'server', 'projects', DOC_NAME)
const outputDir = join(projectDir, 'output')
const targetDir = join(PROJECT_ROOT, 'public', 'docs', DOC_NAME)

// Check project exists
if (!existsSync(projectDir)) {
  console.error(`[publish] Project "${DOC_NAME}" not found at ${projectDir}`)
  process.exit(1)
}

const projectJson = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
console.log(`[publish] Publishing ${DOC_NAME}: ${projectJson.pages} pages, last build ${projectJson.lastBuild}`)

// Detect Tailscale or LAN IP for live URL
function detectLiveHost() {
  const ifaces = networkInterfaces()
  for (const [name, nets] of Object.entries(ifaces)) {
    if (!nets) continue
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (name.includes('utun') || net.address.startsWith('100.'))
        return net.address
    }
  }
  for (const nets of Object.values(ifaces)) {
    if (!nets) continue
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('10.') || net.address.startsWith('192.168.') || net.address.startsWith('172.'))
        return net.address
    }
  }
  return null
}

try {
  // Step 1: Copy build output to public/docs/{name}/
  console.log(`[publish] Copying build output...`)
  mkdirSync(targetDir, { recursive: true })
  cpSync(outputDir, targetDir, { recursive: true })

  // Step 2: Export annotations from shapes API
  console.log(`[publish] Exporting annotations from ${CTD_SERVER}...`)
  let annotations = {}
  try {
    const resp = await fetch(`${CTD_SERVER}/api/projects/${DOC_NAME}/shapes`)
    if (resp.ok) {
      const shapes = await resp.json()
      for (const s of shapes) {
        if (s.typeName === 'shape') annotations[s.id] = s
      }
    }
  } catch (e) {
    // Server might not be running — try sync-snapshot.json directly
    const snapshotPath = join(projectDir, 'sync-snapshot.json')
    if (existsSync(snapshotPath)) {
      console.log(`[publish] Server not available, reading sync-snapshot.json`)
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
      const records = snapshot.documents?.[0]?.state?.records || snapshot.records || []
      for (const r of records) {
        if (r.typeName === 'shape') annotations[r.id] = r
      }
    }
  }
  const annotationCount = Object.keys(annotations).length
  console.log(`[publish] Exported ${annotationCount} annotation shapes`)

  // Step 3: Write static annotations + manifest
  const liveHost = detectLiveHost()
  const liveUrl = liveHost ? `http://${liveHost}:5176/?doc=${DOC_NAME}` : null
  if (liveUrl) console.log(`[publish] Live session URL: ${liveUrl}`)

  writeFileSync(join(targetDir, 'annotations.json'), JSON.stringify({
    room: `doc-${DOC_NAME}`,
    doc: DOC_NAME,
    exportedAt: new Date().toISOString(),
    liveUrl,
    records: annotations,
  }, null, 2))

  // Update manifest
  const manifestPath = join(PROJECT_ROOT, 'public', 'docs', 'manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { documents: {} }
  manifest.documents[DOC_NAME] = {
    title: projectJson.title || DOC_NAME,
    pages: projectJson.pages,
    format: projectJson.format || 'svg',
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`[publish] Updated manifest`)

  // Step 4: Build the static site
  console.log('[publish] Building static site...')
  execSync('npx vite build', { cwd: PROJECT_ROOT, stdio: 'inherit' })

  // Step 5: Deploy to GitHub Pages
  console.log('[publish] Deploying to GitHub Pages...')
  execSync('npx gh-pages -d dist', { cwd: PROJECT_ROOT, stdio: 'inherit' })

  console.log('[publish] Done! Snapshot published to GitHub Pages.')
  console.log(`[publish] https://qtm285.github.io/claude-tldraw/?doc=${DOC_NAME}`)

} catch (e) {
  console.error(`[publish] Error: ${e.message}`)
  process.exit(1)
}
