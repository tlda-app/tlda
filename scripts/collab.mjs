#!/usr/bin/env node
/**
 * Start all services for collaborative editing.
 *
 * Launches sync server, dev server, MCP server, and optionally a file watcher.
 * Auto-restarts crashed services with backoff.
 * Prints connection URLs for collaborators (Tailscale IP or LAN).
 *
 * Usage:
 *   node scripts/collab.mjs [--watch /path/to/main.tex doc-name]
 *
 * Examples:
 *   node scripts/collab.mjs
 *   node scripts/collab.mjs --watch ~/papers/main.tex my-paper
 */

import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import qrcode from 'qrcode-terminal'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// Parse args
let watchTexFile = null
let watchDocName = null
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--watch' && args[i + 1]) {
    watchTexFile = args[i + 1]
    watchDocName = args[i + 2] || undefined
    break
  }
}

// Detect network addresses
function getAddresses() {
  const addresses = []
  const ifaces = networkInterfaces()
  for (const [name, nets] of Object.entries(ifaces)) {
    if (!nets) continue
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ name, address: net.address })
      }
    }
  }
  return addresses
}

let shuttingDown = false
const managed = [] // { name, command, args, options, proc, restarts, lastStart }

function startManaged(name, command, cmdArgs, options = {}) {
  const entry = { name, command, args: cmdArgs, options, proc: null, restarts: 0, lastStart: 0 }
  managed.push(entry)
  launchProcess(entry)
  return entry
}

function launchProcess(entry) {
  if (shuttingDown) return

  entry.lastStart = Date.now()
  const proc = spawn(entry.command, entry.args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...entry.options,
  })
  entry.proc = proc

  proc.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`[${entry.name}] ${line}`)
    }
  })

  proc.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`[${entry.name}] ${line}`)
    }
  })

  proc.on('close', (code) => {
    if (shuttingDown) return
    const uptime = Date.now() - entry.lastStart
    console.log(`[${entry.name}] exited (code ${code}, uptime ${Math.round(uptime / 1000)}s)`)

    // Respawn with backoff
    entry.restarts++
    // Reset restart count if process ran for > 30s (healthy)
    if (uptime > 30000) entry.restarts = 1

    const delay = Math.min(1000 * Math.pow(2, entry.restarts - 1), 30000)
    console.log(`[${entry.name}] restarting in ${Math.round(delay / 1000)}s (attempt ${entry.restarts})`)
    setTimeout(() => launchProcess(entry), delay)
  })

  proc.on('error', (err) => {
    console.error(`[${entry.name}] failed to start: ${err.message}`)
  })
}

// Cleanup on exit
function cleanup() {
  shuttingDown = true
  console.log('\nShutting down...')
  for (const entry of managed) {
    if (entry.proc) entry.proc.kill('SIGTERM')
  }
  setTimeout(() => process.exit(0), 1000)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// Start services
console.log('Starting collaborative session...\n')

startManaged('sync', 'node', ['server/sync-server.js'])
startManaged('dev', 'npx', ['vite'])
startManaged('mcp', 'node', ['mcp-server/index.mjs'])

if (watchTexFile) {
  const watchArgs = [resolve(watchTexFile)]
  if (watchDocName) watchArgs.push(watchDocName)
  startManaged('watch', 'node', ['scripts/watch.mjs', ...watchArgs])
}

// Read manifest to list available docs
function readManifest() {
  try {
    const manifestPath = resolve(PROJECT_ROOT, 'public', 'docs', 'manifest.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).documents || {}
  } catch {
    return {}
  }
}

// Print connection info after a short delay (wait for servers to start)
setTimeout(() => {
  const addresses = getAddresses()
  const tailscale = addresses.find(a => a.name.includes('utun') || a.address.startsWith('100.'))
  const lan = addresses.find(a => a.address.startsWith('10.') || a.address.startsWith('192.168.') || a.address.startsWith('172.'))

  const host = tailscale?.address || lan?.address || 'localhost'
  const docs = readManifest()
  const docNames = Object.keys(docs)

  // Pick doc for URL: explicit watch doc > single manifest doc > omit
  const docParam = watchDocName || (docNames.length === 1 ? docNames[0] : null)
  const viewerUrl = docParam
    ? `http://${host}:5173/?doc=${docParam}`
    : `http://${host}:5173/`

  console.log('\n' + '='.repeat(60))
  console.log('Collaborative session ready!')
  console.log('='.repeat(60))
  console.log()
  console.log(`  ${viewerUrl}`)
  console.log()
  if (docNames.length > 0) {
    console.log('Available docs:')
    for (const [name, config] of Object.entries(docs)) {
      console.log(`  - ${name}: ${config.name || name} (${config.pages} pages)`)
    }
    console.log()
  }
  if (watchTexFile) {
    console.log(`Watching: ${watchTexFile}`)
  }
  console.log('Press Ctrl+C to stop.')
  console.log('='.repeat(60))

  // QR code in terminal — scan with iPad camera
  qrcode.generate(viewerUrl, { small: true })
}, 2000)
