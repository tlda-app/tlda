#!/usr/bin/env node
/**
 * ctd — Claude TLDraw CLI.
 *
 * Commands:
 *   ctd create <name> [--title "Title"] [--dir /path] [--main main.tex]
 *   ctd push [name] [--dir /path]
 *   ctd watch [/path/to/main.tex] [name]
 *   ctd open [name]
 *   ctd list
 *   ctd status [name]
 *   ctd config set server <url>
 *
 * Server URL resolution:
 *   CTD_SERVER env → --server flag → ~/.config/ctd/config.json → http://localhost:5176
 */

import { resolve, basename, dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { collectSourceFiles } from './lib/source-files.mjs'

// --- Config ---

const CONFIG_DIR = join(homedir(), '.config', 'ctd')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {}
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// --- Argument parsing ---

const args = process.argv.slice(2)
const command = args[0]

function getFlag(name, defaultVal = null) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return defaultVal
  return args[idx + 1] || defaultVal
}

function hasFlag(name) {
  return args.includes(`--${name}`)
}

function getPositional(index) {
  // Skip flags and their values
  let pos = 0
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue } // skip --flag value
    if (pos === index) return args[i]
    pos++
  }
  return null
}

function getServer() {
  return process.env.CTD_SERVER || getFlag('server') || loadConfig().server || 'http://localhost:5176'
}

// --- HTTP helpers ---

async function api(method, path, body = null, { timeoutMs = 30000 } = {}) {
  const server = getServer()
  const url = `${server}${path}`
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body) opts.body = JSON.stringify(body)

  const res = await fetch(url, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }

  if (!res.ok) {
    const msg = data?.error || text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

// --- Source file collection ---

function findMainTex(dir) {
  // Prefer a .tex file matching the directory name
  const dirName = basename(dir)
  if (existsSync(join(dir, `${dirName}.tex`))) return `${dirName}.tex`

  // Find the file with \documentclass
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tex')) continue
    const content = readFileSync(join(dir, f), 'utf8')
    if (content.includes('\\documentclass')) return f
  }
  return null
}

// --- Commands ---

async function cmdCreate() {
  const name = getPositional(0)
  if (!name) { console.error('Usage: ctd create <name> [--title "Title"] [--dir /path] [--main main.tex]'); process.exit(1) }

  const dir = resolve(getFlag('dir') || '.')
  const title = getFlag('title') || name
  const mainFile = getFlag('main') || findMainTex(dir)
  if (!mainFile) { console.error(`No .tex file with \\documentclass found in ${dir}`); process.exit(1) }

  console.log(`Creating project "${name}"...`)
  console.log(`  Source: ${dir}`)
  console.log(`  Main file: ${mainFile}`)

  // Create project on server
  await api('POST', '/api/projects', { name, title, mainFile })
  console.log('  Project created.')

  // Collect and push source files
  const files = collectSourceFiles(dir)
  console.log(`  Pushing ${files.length} source files...`)
  await api('POST', `/api/projects/${name}/push`, { files })
  console.log('  Build triggered.')

  const server = getServer()
  console.log(`\nViewer: ${server}/?doc=${name}`)
}

async function cmdPush() {
  const name = getPositional(0) || inferProjectName()
  if (!name) { console.error('Usage: ctd push [name] [--dir /path]'); process.exit(1) }

  const dir = resolve(getFlag('dir') || '.')

  const files = collectSourceFiles(dir)
  console.log(`Pushing ${files.length} files to "${name}"...`)
  await api('POST', `/api/projects/${name}/push`, { files })
  console.log('Build triggered.')
}

async function cmdWatch() {
  const arg1 = getPositional(0)
  let texPath, name, dir

  if (arg1 && existsSync(arg1) && arg1.endsWith('.tex')) {
    texPath = resolve(arg1)
    dir = dirname(texPath)
    name = getPositional(1) || basename(texPath, '.tex')
  } else if (arg1) {
    name = arg1
    dir = resolve(getFlag('dir') || '.')
  } else {
    dir = resolve('.')
    const mainFile = findMainTex(dir)
    if (!mainFile) { console.error('No .tex file found in current directory'); process.exit(1) }
    texPath = join(dir, mainFile)
    name = basename(mainFile, '.tex')
  }

  const debounceMs = parseInt(getFlag('debounce') || '200', 10)

  console.log(`Watching ${dir} → "${name}"`)
  console.log(`  Server: ${getServer()}`)
  console.log(`  Debounce: ${debounceMs}ms`)
  console.log()

  const { startWatcher } = await import('./lib/watcher.mjs')
  await startWatcher({ dir, name, debounceMs, getServer })
}

async function cmdOpen() {
  const name = getPositional(0) || inferProjectName()
  if (!name) { console.error('Usage: ctd open [name]'); process.exit(1) }

  const server = getServer()
  const url = `${server}/?doc=${name}`
  console.log(`Opening ${url}`)

  const { exec } = await import('child_process')
  exec(`open "${url}"`)
}

async function cmdList() {
  const data = await api('GET', '/api/projects')
  if (data.projects.length === 0) {
    console.log('No projects.')
    return
  }
  for (const p of data.projects) {
    const status = p.buildStatus === 'success' ? '' : ` [${p.buildStatus}]`
    console.log(`  ${p.name}: ${p.title || p.name} (${p.pages} pages)${status}`)
  }
}

async function cmdStatus() {
  const name = getPositional(0) || inferProjectName()
  if (!name) { console.error('Usage: ctd status [name]'); process.exit(1) }

  const data = await api('GET', `/api/projects/${name}/build/status`)
  console.log(`Project: ${name}`)
  console.log(`  Status: ${data.status}`)
  if (data.phase) console.log(`  Phase: ${data.phase}`)
  if (data.lastBuild) console.log(`  Last build: ${data.lastBuild}`)
  if (data.log) {
    console.log('\nBuild log:')
    console.log(data.log)
  }
}

async function cmdConfig() {
  const sub = getPositional(0)
  if (sub === 'set') {
    const key = getPositional(1)
    const value = getPositional(2)
    if (!key || !value) { console.error('Usage: ctd config set <key> <value>'); process.exit(1) }
    const config = loadConfig()
    config[key] = value
    saveConfig(config)
    console.log(`Set ${key} = ${value}`)
  } else if (sub === 'get') {
    const key = getPositional(1)
    const config = loadConfig()
    console.log(key ? (config[key] || '') : JSON.stringify(config, null, 2))
  } else {
    console.log(`Server: ${getServer()}`)
    console.log(`Config: ${CONFIG_FILE}`)
  }
}

const PIDFILE = join(homedir(), '.config', 'ctd', 'server.pid')
const LOGFILE = join(homedir(), '.config', 'ctd', 'server.log')

function readPid() {
  try {
    const pid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10)
    if (isNaN(pid)) return null
    // Check if process is alive
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch { return null }
}

function writePid(pid) {
  if (!existsSync(dirname(PIDFILE))) mkdirSync(dirname(PIDFILE), { recursive: true })
  writeFileSync(PIDFILE, String(pid))
}

async function cmdServer() {
  const sub = getPositional(0) || 'start'

  // Find the unified server script relative to this file's location
  const ctdRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const serverScript = join(ctdRoot, 'server', 'unified-server.mjs')

  if (sub === 'stop') {
    const pid = readPid()
    if (pid) {
      process.kill(pid, 'SIGTERM')
      // Wait for it to die
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250))
        try { process.kill(pid, 0) } catch { break }
      }
      try { const fs = await import('fs'); fs.unlinkSync(PIDFILE) } catch {}
      console.log('Server stopped.')
    } else {
      console.log('No server running.')
    }
    return
  }

  if (sub === 'status') {
    try {
      const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
      const data = await res.json()
      const pid = readPid()
      console.log(`Server running (uptime: ${Math.floor(data.uptime)}s${pid ? `, pid ${pid}` : ''})`)
    } catch {
      console.log('Server not running.')
    }
    return
  }

  if (sub === 'log' || sub === 'logs') {
    if (existsSync(LOGFILE)) {
      const { execSync } = await import('child_process')
      execSync(`tail -50 "${LOGFILE}"`, { stdio: 'inherit' })
    } else {
      console.log('No server log.')
    }
    return
  }

  if (sub === 'start') {
    // Check if already running
    try {
      const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        console.log('Server already running.')
        return
      }
    } catch {
      // Not running, good
    }

    if (!existsSync(serverScript)) {
      console.error(`Server script not found: ${serverScript}`)
      process.exit(1)
    }

    // Ensure log directory exists
    if (!existsSync(dirname(LOGFILE))) mkdirSync(dirname(LOGFILE), { recursive: true })

    const { spawn } = await import('child_process')
    const { openSync: fsOpenSync } = await import('fs')
    const logFd = fsOpenSync(LOGFILE, 'a')

    const child = spawn('node', [serverScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PORT: new URL(getServer()).port || '5176' },
    })
    child.unref()
    writePid(child.pid)

    // Wait for it to come up
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        const res = await fetch(`${getServer()}/health`)
        if (res.ok) {
          console.log(`Server running at ${getServer()} (pid ${child.pid})`)
          console.log(`  Log: ${LOGFILE}`)
          return
        }
      } catch {}
    }
    console.error('Server failed to start within 5s')
    console.error(`Check log: ${LOGFILE}`)
    process.exit(1)
  }

  console.error(`Unknown subcommand: ctd server ${sub}`)
  console.error('Usage: ctd server [start|stop|status|log]')
  process.exit(1)
}

function inferProjectName() {
  const dir = resolve(getFlag('dir') || '.')
  return basename(dir)
}

// --- Ensure server is running ---

async function ensureServer() {
  try {
    const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) return
  } catch {}

  // Auto-start
  console.log('Server not running, starting...')
  await cmdServer()  // calls 'start' by default
}

// --- Main ---

async function main() {
  try {
    switch (command) {
      case 'server': await cmdServer(); break
      case 'create': await ensureServer(); await cmdCreate(); break
      case 'push':   await ensureServer(); await cmdPush(); break
      case 'watch':  await ensureServer(); await cmdWatch(); break
      case 'open':   await ensureServer(); await cmdOpen(); break
      case 'list':   await ensureServer(); await cmdList(); break
      case 'ls':     await ensureServer(); await cmdList(); break
      case 'status': await ensureServer(); await cmdStatus(); break
      case 'config': await cmdConfig(); break
      default:
        console.log(`ctd — Claude TLDraw CLI

Commands:
  server [start|stop|status|log]  Manage the unified server
  create <name>  Create project, upload files, trigger build
  push [name]    Push source files, trigger rebuild
  watch [path]   Watch for changes, auto-push to server
  open [name]    Open viewer in browser
  list           List projects
  status [name]  Show build status

The server auto-starts on first use. Explicit control: ctd server start/stop.

Options:
  --server <url>   Server URL (default: http://localhost:5176)
  --dir <path>     Source directory (default: .)
  --title "Title"  Document title (create only)
  --main file.tex  Main tex file (create only)

Config:
  ctd config set server <url>
  CTD_SERVER=<url>`)
    }
  } catch (e) {
    console.error(`Error: ${e.message}`)
    process.exit(1)
  }
}

main()
