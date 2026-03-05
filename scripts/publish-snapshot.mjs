#!/usr/bin/env node
/**
 * Publish docs to GitHub Pages + Fly.
 *
 * Syncs the working copy to a published clone at ~/work/published/tlda/,
 * copies build output for all published docs, builds the viewer, and deploys.
 *
 * Usage:
 *   tlda publish                    # publish all docs in config.published
 *   tlda publish foo bar            # publish specific docs (adds to list)
 *   node scripts/publish-snapshot.mjs foo bar
 *
 * Config (via tlda config):
 *   published  — comma-separated list of doc names to publish
 *   remote     — remote server URL (used for sync WebSocket in viewer build)
 *
 * Environment:
 *   TLDA_SERVER - Server URL for fetching annotations (default: http://localhost:5176)
 */

import { writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const PUBLISHED_ROOT = join(homedir(), 'work', 'published', 'tlda')
const CONFIG_FILE = join(homedir(), '.config', 'tlda', 'config.json')

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {}
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function saveConfig(config) {
  const dir = dirname(CONFIG_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// --- Resolve doc list ---

const config = loadConfig()
const argDocs = process.argv.slice(2).filter(a => !a.startsWith('-'))
let publishedList = config.published ? config.published.split(',').map(s => s.trim()).filter(Boolean) : []

if (argDocs.length > 0) {
  // Add any new docs to the published list
  for (const d of argDocs) {
    if (!publishedList.includes(d)) publishedList.push(d)
  }
  config.published = publishedList.join(',')
  saveConfig(config)
}

if (publishedList.length === 0) {
  console.error('[publish] No docs to publish.')
  console.error('  tlda publish doc1 doc2       # publish specific docs')
  console.error('  tlda config set published doc1,doc2   # set the list')
  process.exit(1)
}

const TLDA_SERVER = process.env.TLDA_SERVER || 'http://localhost:5176'
const remoteUrl = config.remote
const syncWsUrl = remoteUrl ? remoteUrl.replace(/^http/, 'ws') : null

// Validate all docs exist before starting
const docs = []
for (const name of publishedList) {
  const projectDir = join(PROJECT_ROOT, 'server', 'projects', name)
  if (!existsSync(projectDir)) {
    console.error(`[publish] Project "${name}" not found at ${projectDir} — skipping`)
    continue
  }
  const projectJson = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
  docs.push({ name, projectDir, outputDir: join(projectDir, 'output'), projectJson })
}

if (docs.length === 0) {
  console.error('[publish] No valid projects found.')
  process.exit(1)
}

console.log(`[publish] Publishing ${docs.length} doc${docs.length > 1 ? 's' : ''}: ${docs.map(d => d.name).join(', ')}`)
if (remoteUrl) console.log(`[publish] Remote: ${remoteUrl}`)

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
  console.log(`[publish] Syncing code to ${PUBLISHED_ROOT}...`)
  if (!existsSync(PUBLISHED_ROOT)) {
    mkdirSync(dirname(PUBLISHED_ROOT), { recursive: true })
    const gitRemote = execSync('git remote get-url origin', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim()
    execSync(`git clone ${gitRemote} ${PUBLISHED_ROOT}`, { stdio: 'inherit' })
  }
  execSync('git fetch origin && git reset --hard origin/main', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
  for (const dir of ['src', 'shared', 'server/lib', 'server/routes', 'cli/lib']) {
    const src = join(PROJECT_ROOT, dir) + '/'
    const dest = join(PUBLISHED_ROOT, dir) + '/'
    mkdirSync(dest, { recursive: true })
    execSync(`rsync -a --delete ${src} ${dest}`, { stdio: 'inherit' })
  }
  for (const f of ['package.json', 'vite.config.ts', 'index.html', 'server/unified-server.mjs',
                    'server/package.json', 'Dockerfile', 'fly.toml', 'scripts/fly-entrypoint.sh',
                    'cli/tlda.mjs']) {
    const src = join(PROJECT_ROOT, f)
    const dest = join(PUBLISHED_ROOT, f)
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest)
    }
  }

  // Step 2: Copy build output for all docs
  const manifestPath = join(PUBLISHED_ROOT, 'public', 'docs', 'manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { documents: {} }
  const liveHost = detectLiveHost()

  for (const doc of docs) {
    const pubDocsDir = join(PUBLISHED_ROOT, 'public', 'docs', doc.name)
    const pubProjectDir = join(PUBLISHED_ROOT, 'server', 'projects', doc.name)

    console.log(`[publish] ${doc.name}: ${doc.projectJson.pages} pages (${doc.projectJson.format || 'svg'})`)
    mkdirSync(pubDocsDir, { recursive: true })
    cpSync(doc.outputDir, pubDocsDir, { recursive: true })
    mkdirSync(join(pubProjectDir, 'output'), { recursive: true })
    cpSync(doc.outputDir, join(pubProjectDir, 'output'), { recursive: true })
    // Write project.json without archived/sourceDir (archived hides from manifest; sourceDir is local)
    const pubProject = { ...doc.projectJson }
    delete pubProject.archived
    delete pubProject.sourceDir
    writeFileSync(join(pubProjectDir, 'project.json'), JSON.stringify(pubProject, null, 2))

    // Export annotations
    let annotations = {}
    try {
      const resp = await fetch(`${TLDA_SERVER}/api/projects/${doc.name}/shapes`)
      if (resp.ok) {
        const shapes = await resp.json()
        for (const s of shapes) { if (s.typeName === 'shape') annotations[s.id] = s }
      }
    } catch {
      const snapshotPath = join(doc.projectDir, 'sync-snapshot.json')
      if (existsSync(snapshotPath)) {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
        const records = snapshot.documents?.[0]?.state?.records || snapshot.records || []
        for (const r of records) { if (r.typeName === 'shape') annotations[r.id] = r }
      }
    }

    const liveUrl = liveHost ? `http://${liveHost}:5176/?doc=${doc.name}` : null
    writeFileSync(join(pubDocsDir, 'annotations.json'), JSON.stringify({
      room: `doc-${doc.name}`, doc: doc.name,
      exportedAt: new Date().toISOString(), liveUrl,
      records: annotations,
    }, null, 2))

    manifest.documents[doc.name] = {
      title: doc.projectJson.title || doc.name,
      pages: doc.projectJson.pages,
      format: doc.projectJson.format || 'svg',
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`[publish] Manifest: ${Object.keys(manifest.documents).join(', ')}`)

  // Step 3: Build viewer
  console.log('[publish] Installing dependencies...')
  execSync('npm install --ignore-scripts', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
  console.log('[publish] Building viewer...')
  const buildEnv = { ...process.env, VITE_BASE_PATH: '/tlda/', VITE_BUILD_ID: Date.now().toString() }
  if (syncWsUrl) buildEnv.VITE_SYNC_SERVER = syncWsUrl
  execSync('npx vite build', { cwd: PUBLISHED_ROOT, stdio: 'inherit', env: buildEnv })

  // Step 4: Deploy to GitHub Pages
  console.log('[publish] Deploying to GitHub Pages...')
  execSync('npx gh-pages -d dist', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })

  // Step 5: Deploy to Fly
  console.log('[publish] Deploying to Fly...')
  try {
    execSync('fly deploy --remote-only', { cwd: PUBLISHED_ROOT, stdio: 'inherit' })
    console.log('[publish] Fly deployment complete')
  } catch (e) {
    console.warn(`[publish] Warning: Fly deploy failed: ${e.message}`)
  }

  // Done
  console.log()
  console.log('[publish] Done!')
  for (const doc of docs) {
    console.log(`  https://qtm285.github.io/tlda/?doc=${doc.name}`)
  }
  if (remoteUrl) {
    console.log()
    console.log(`  Todd: tlda agent start --remote`)
  }

} catch (e) {
  console.error(`[publish] Error: ${e.message}`)
  process.exit(1)
}
