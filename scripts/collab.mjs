#!/usr/bin/env node
/**
 * Start all services for collaborative editing.
 *
 * Launches sync server, dev server, MCP server, and optionally a file watcher.
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
import { networkInterfaces } from 'os'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

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

const processes = []

function startProcess(name, command, args, options = {}) {
  const proc = spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })

  proc.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`[${name}] ${line}`)
    }
  })

  proc.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`[${name}] ${line}`)
    }
  })

  proc.on('close', (code) => {
    console.log(`[${name}] exited (code ${code})`)
  })

  proc.on('error', (err) => {
    console.error(`[${name}] failed to start: ${err.message}`)
  })

  processes.push(proc)
  return proc
}

// Cleanup on exit
function cleanup() {
  console.log('\nShutting down...')
  for (const proc of processes) {
    proc.kill('SIGTERM')
  }
  setTimeout(() => process.exit(0), 1000)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// Start services
console.log('Starting collaborative session...\n')

startProcess('sync', 'node', ['server/sync-server.js'])
startProcess('dev', 'npx', ['vite'])
startProcess('mcp', 'node', ['mcp-server/index.mjs'])

if (watchTexFile) {
  const watchArgs = [resolve(watchTexFile)]
  if (watchDocName) watchArgs.push(watchDocName)
  startProcess('watch', 'node', ['scripts/watch.mjs', ...watchArgs])
}

// Print connection info after a short delay (wait for servers to start)
setTimeout(() => {
  const addresses = getAddresses()
  const tailscale = addresses.find(a => a.name.includes('utun') || a.address.startsWith('100.'))
  const lan = addresses.find(a => a.address.startsWith('10.') || a.address.startsWith('192.168.') || a.address.startsWith('172.'))

  console.log('\n' + '='.repeat(60))
  console.log('Collaborative session ready!')
  console.log('='.repeat(60))
  console.log()
  console.log('Services:')
  console.log('  Viewer:     http://localhost:5173')
  console.log('  Sync:       ws://localhost:5176')
  console.log('  MCP HTTP:   http://localhost:5174')
  console.log('  MCP WS:     ws://localhost:5175')

  if (tailscale) {
    console.log()
    console.log(`Tailscale (${tailscale.name}):`)
    console.log(`  Viewer:     http://${tailscale.address}:5173`)
    console.log(`  Sync:       ws://${tailscale.address}:5176`)
  }

  if (lan) {
    console.log()
    console.log(`LAN (${lan.name}):`)
    console.log(`  Viewer:     http://${lan.address}:5173`)
    console.log(`  Sync:       ws://${lan.address}:5176`)
  }

  console.log()
  console.log('Collaborators open:')
  const host = tailscale?.address || lan?.address || 'YOUR_IP'
  console.log(`  http://${host}:5173/?doc=DOC_NAME`)
  console.log()

  if (watchTexFile) {
    console.log(`File watcher active: ${watchTexFile}`)
  } else {
    console.log('To start file watching:')
    console.log('  node scripts/watch.mjs /path/to/main.tex doc-name')
  }

  console.log()
  console.log('Press Ctrl+C to stop all services.')
  console.log('='.repeat(60))
}, 2000)
