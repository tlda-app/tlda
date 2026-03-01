#!/usr/bin/env node
/**
 * Publish a snapshot to GitHub Pages + Fly.
 *
 * Syncs the working copy to a published clone at ~/work/published/claude-tldraw/,
 * copies build output and annotations there, builds the viewer, and deploys.
 * The published clone is a stable snapshot that Todd can read from without
 * being affected by ongoing changes to the working copy.
 *
 * Usage:
 *   node scripts/publish-snapshot.mjs [doc-name]
 *   npm run publish-snapshot -- qtm285
 *
 * Environment:
 *   CTD_SERVER - Server URL (default: http://localhost:5176)
 */

import { writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const PUBLISHED_ROOT = join(homedir(), 'work', 'published', 'claude-tldraw')

const DOC_NAME = process.argv[2]
if (!DOC_NAME) {
  console.error('Usage: node scripts/publish-snapshot.mjs <doc-name>')
  console.error('Example: node scripts/publish-snapshot.mjs qtm285')
  process.exit(1)
}

const CTD_SERVER = process.env.CTD_SERVER || 'http://localhost:5176'
const projectDir = join(PROJECT_ROOT, 'server', 'projects', DOC_NAME)
const outputDir = join(projectDir, 'output')

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
  // Step 1: Sync working copy to published clone
  console.log(`[publish] Syncing to ${PUBLISHED_ROOT}...`)
  if (!existsSync(PUBLISHED_ROOT)) {
    mkdirSync(dirname(PUBLISHED_ROOT), { recursive: true })
    const remoteUrl = execSync('git remote get-url origin', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim()
    execSync(`git clone ${remoteUrl} ${PUBLISHED_ROOT}`, { stdio: 'inherit' })
  }
  // Pull latest and sync working tree (uncommitted changes included via rsync)
  execSync('git fetch origin && git reset --hard origin/main', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
  // Sync source code (for vite build) and server code (for Fly deploy)
  for (const dir of ['src', 'shared', 'server/lib', 'server/routes']) {
    const src = join(PROJECT_ROOT, dir) + '/'
    const dest = join(PUBLISHED_ROOT, dir) + '/'
    mkdirSync(dest, { recursive: true })
    execSync(`rsync -a --delete ${src} ${dest}`, { stdio: 'inherit' })
  }
  // Sync individual files that may have changed
  for (const f of ['package.json', 'vite.config.ts', 'index.html', 'server/unified-server.mjs',
                    'server/package.json', 'Dockerfile', 'fly.toml', 'scripts/fly-entrypoint.sh']) {
    const src = join(PROJECT_ROOT, f)
    const dest = join(PUBLISHED_ROOT, f)
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest)
    }
  }

  // Step 2: Copy build output to published clone
  const pubTargetDir = join(PUBLISHED_ROOT, 'public', 'docs', DOC_NAME)
  const pubProjectDir = join(PUBLISHED_ROOT, 'server', 'projects', DOC_NAME)
  console.log(`[publish] Copying build output...`)
  mkdirSync(pubTargetDir, { recursive: true })
  cpSync(outputDir, pubTargetDir, { recursive: true })
  mkdirSync(join(pubProjectDir, 'output'), { recursive: true })
  cpSync(outputDir, join(pubProjectDir, 'output'), { recursive: true })
  cpSync(join(projectDir, 'project.json'), join(pubProjectDir, 'project.json'))

  // Step 3: Export annotations from shapes API
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

  // Step 4: Write static annotations + manifest
  const liveHost = detectLiveHost()
  const liveUrl = liveHost ? `http://${liveHost}:5176/?doc=${DOC_NAME}` : null
  if (liveUrl) console.log(`[publish] Live session URL: ${liveUrl}`)

  writeFileSync(join(pubTargetDir, 'annotations.json'), JSON.stringify({
    room: `doc-${DOC_NAME}`,
    doc: DOC_NAME,
    exportedAt: new Date().toISOString(),
    liveUrl,
    records: annotations,
  }, null, 2))

  // Update manifest in published clone
  const manifestPath = join(PUBLISHED_ROOT, 'public', 'docs', 'manifest.json')
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

  // Step 5: Install deps + build the static site in published clone
  console.log('[publish] Installing dependencies...')
  execSync('npm install --ignore-scripts', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
  console.log('[publish] Building static site...')
  execSync('npx vite build', { cwd: PUBLISHED_ROOT, stdio: 'inherit', env: {
    ...process.env,
    VITE_BASE_PATH: '/claude-tldraw/',
    VITE_SYNC_SERVER: 'wss://tldraw-sync-skip.fly.dev',
  } })

  // Step 6: Deploy to GitHub Pages from published clone
  console.log('[publish] Deploying to GitHub Pages...')
  execSync('npx gh-pages -d dist', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })

  // Step 7: Deploy to Fly from published clone
  // Sync snapshots persist on the Fly volume — student annotations survive deploys.
  // The viewer's migration logic handles structural changes (e.g. new chapters).
  console.log('[publish] Deploying to Fly...')
  try {
    execSync('fly deploy --remote-only', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
    console.log('[publish] Fly deployment complete')
  } catch (e) {
    console.warn(`[publish] Warning: Fly deploy failed: ${e.message}`)
    console.warn('[publish] Students will see stale content until Fly is redeployed')
  }

  console.log('[publish] Done! Published to GitHub Pages + Fly.')
  console.log(`[publish] https://qtm285.github.io/claude-tldraw/?doc=${DOC_NAME}`)
  console.log(`[publish] Todd: CTD_SYNC_SERVER=https://tldraw-sync-skip.fly.dev node cli/lib/triage-agent.mjs`)
  console.log(`[publish]   (run from ${PUBLISHED_ROOT})`)

} catch (e) {
  console.error(`[publish] Error: ${e.message}`)
  process.exit(1)
}
