#!/usr/bin/env node
/**
 * ctd — Claude TLDraw CLI.
 *
 * Commands:
 *   ctd create <name> [--title "Title"] [--dir /path] [--main main.tex]
 *   ctd push [name] [--dir /path]
 *   ctd watch [/path/to/main.tex] [name]
 *   ctd watch-all
 *   ctd open [name]
 *   ctd list
 *   ctd status [name]
 *   ctd config set server <url>
 *
 * Server URL resolution:
 *   CTD_SERVER env → --server flag → ~/.config/ctd/config.json → http://localhost:5176
 */

import { resolve, basename, dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { collectSourceFiles, collectSourceHashes, collectSpecificFiles } from './lib/source-files.mjs'

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

// Per-command help (shown with --help)
const COMMAND_HELP = {
  book:    'ctd book <name> --members doc1,doc2,doc3,...\n\n  Create a book that groups existing documents together.\n  Each member keeps its own sync room and annotations.\n  The viewer shows one member at a time with a tab bar to switch.',
  create:  'ctd create <name> [--title "Title"] [--dir /path] [--main main.tex]\n\n  Create a project and push source files. If the project already exists,\n  pushes files and triggers a rebuild.',
  push:    'ctd push [name] [--dir /path]\n\n  Push source files to the server and trigger a rebuild.\n  Project name is inferred from the current directory if omitted.',
  watch:   'ctd watch [/path/to/main.tex] [name] [--debounce ms]\n\n  Watch source files for changes and auto-push to the server.\n  The server handles building — the watcher only uploads.',
  'watch-all': 'ctd watch-all [start|stop|status|log|run]\n\n  Watch all projects that have a sourceDir. Polls for new projects\n  every 30s, so `ctd create` picks them up automatically.\n\n  start   Daemonize and watch in background (default)\n  stop    Stop the background watchers\n  status  Check if watchers are running\n  log     Show recent watcher log\n  run     Run in foreground (for debugging)',
  'watch-agent': 'ctd watch-agent\n\n  Replaced by `ctd server start --agent`. The triage agent now\n  covers all documents automatically and runs alongside the server.',
  open:    'ctd open [name]\n\n  Open the viewer in the default browser (RW token = presenter privilege).',
  share:   'ctd share [name]\n\n  Print a viewer URL with the read-only token.\n  Recipients can annotate but cannot present.',
  status:  'ctd status [name]\n\n  Show build status for a project.',
  errors:  'ctd errors [name] [--wait]\n\n  Extract LaTeX errors and warnings from the last build log.\n  With --wait (-w), blocks until the current build finishes.',
  build:   'ctd build [name]\n\n  Trigger a rebuild without pushing files.\n\n  NOTE: Prefer the watcher pipeline. This command bypasses change\n  detection and should only be used for debugging.',
  delete:  'ctd delete <name>\n\n  Delete a project and all its data.',
  preview: 'ctd preview <name> [page ...]\n\n  Rasterize SVG pages to PNG for visual inspection.\n  Outputs paths to /tmp/ctd-preview-{name}/.',
  server:  'ctd server [start|stop|status|log|install|uninstall] [--agent]\n\n  start      Start the server (auto-restarts via launchd if installed)\n  stop       Stop the server\n  status     Check if server is running\n  log        Show recent server log\n  install    Install launchd service (macOS)\n  uninstall  Remove launchd service\n\n  --agent    Start the triage agent alongside the server.\n             Always-on agent that listens for feedback on all documents\n             and handles lightweight responses (notes, acknowledgments).',
  config:  'ctd config [set <key> <value> | get [key]]\n\n  Manage persistent configuration.\n  Example: ctd config set server http://myhost:5176',
}

// Flags that take a value (--flag value). All others are boolean.
const VALUE_FLAGS = new Set(['server', 'dir', 'title', 'main', 'debounce', 'token', 'members', 'format'])

function getFlag(name, defaultVal = null) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return defaultVal
  if (!VALUE_FLAGS.has(name)) return true  // boolean flag
  const next = args[idx + 1]
  if (!next || next.startsWith('--')) return defaultVal  // missing value
  return next
}

function hasFlag(name) {
  return args.includes(`--${name}`)
}

function getPositional(index) {
  // Skip flags and their values
  let pos = 0
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (VALUE_FLAGS.has(args[i].slice(2))) i++  // skip value only for value flags
      continue
    }
    if (pos === index) return args[i]
    pos++
  }
  return null
}

// Per-command --help
if (command && hasFlag('help') && COMMAND_HELP[command]) {
  console.log(COMMAND_HELP[command])
  process.exit(0)
}

function getServer() {
  return process.env.CTD_SERVER || getFlag('server') || loadConfig().server || 'http://localhost:5176'
}

function getToken() {
  return process.env.CTD_TOKEN || getFlag('token') || loadConfig().token || null
}

// --- Output helpers ---

const isTTY = process.stderr.isTTY
const dim   = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s
const red   = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s
const bold  = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s
const cyan  = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s

// --- HTTP helpers ---

async function api(method, path, body = null, { timeoutMs = 30000 } = {}) {
  const server = getServer()
  const token = getToken()
  const url = `${server}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const opts = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body) opts.body = JSON.stringify(body)

  let res
  try {
    res = await fetch(url, opts)
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`Request timed out: ${method} ${path}`)
    throw new Error(`Server not reachable at ${server} (${e.cause?.code || e.message})`)
  }
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

/**
 * Incremental push: compute local hashes, fetch server hashes, diff, send only changed files.
 * Falls back to full push if the hashes endpoint isn't available.
 * Returns the push API response.
 */
async function incrementalPush(name, dir, extraBody = {}) {
  // Compute local hashes (fast — just reads + MD5, no encoding)
  const localHashes = collectSourceHashes(dir)
  const localPaths = Object.keys(localHashes)

  // Try to get server hashes
  let serverHashes = null
  try {
    const data = await api('GET', `/api/projects/${name}/hashes`)
    serverHashes = data.hashes
  } catch {
    // Endpoint not available (old server?) — fall back to full push
  }

  let files, deletedFiles
  if (serverHashes) {
    // Diff: find changed/new files
    const changedPaths = localPaths.filter(p => localHashes[p] !== serverHashes[p])
    // Find files on server that aren't local
    deletedFiles = Object.keys(serverHashes).filter(p => !(p in localHashes))

    if (changedPaths.length === 0 && deletedFiles.length === 0) {
      return { unchanged: true }
    }

    files = collectSpecificFiles(dir, changedPaths)
    const total = localPaths.length
    const skipped = total - changedPaths.length
    if (skipped > 0) {
      console.log(dim(`  ${skipped}/${total} files unchanged, sending ${changedPaths.length} changed`))
    }
    if (deletedFiles.length > 0) {
      console.log(dim(`  ${deletedFiles.length} files deleted on server`))
    }
  } else {
    // Full push fallback
    files = collectSourceFiles(dir)
    deletedFiles = undefined
  }

  return await api('POST', `/api/projects/${name}/push`, {
    files,
    ...(deletedFiles?.length > 0 && { deletedFiles }),
    ...extraBody,
  })
}

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

async function cmdBook() {
  const name = getPositional(0)
  const membersArg = getFlag('members')
  if (!name || !membersArg) {
    console.error('Usage: ctd book <name> --members doc1,doc2,doc3,...')
    process.exit(1)
  }

  const members = membersArg.split(',').map(s => s.trim()).filter(Boolean)
  if (members.length === 0) {
    console.error('At least one member is required.')
    process.exit(1)
  }

  const title = getFlag('title') || name

  // Verify all members exist on the server
  for (const member of members) {
    try {
      await api('GET', `/api/projects/${member}`)
    } catch {
      console.error(red(`Member "${member}" not found on server.`))
      process.exit(1)
    }
  }

  // Create the book project
  try {
    await api('POST', '/api/projects', { name, title, format: 'book', members })
    console.log(green(`Created book "${name}" with ${members.length} members.`))
  } catch (e) {
    if (e.message.includes('already exists')) {
      // Update members on existing book
      await api('POST', `/api/projects/${name}/push`, { files: [], members })
      console.log(`Updated book "${name}" with ${members.length} members.`)
    } else {
      throw e
    }
  }

  for (const m of members) console.log(dim(`  ${m}`))

  const server = getServer()
  console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
}

async function cmdCreate() {
  const name = getPositional(0)
  if (!name) { console.error('Usage: ctd create <name> [--title "Title"] [--dir /path] [--main main.tex] [--format slides]'); process.exit(1) }

  const format = getFlag('format') || null
  const dir = resolve(getFlag('dir') || '.')
  const title = getFlag('title') || name

  // Slides format: push HTML files, no TeX
  if (format === 'slides') {
    console.log(dim(`  Source: ${dir}`))
    console.log(dim(`  Format: slides`))

    // Create or update project
    try {
      await api('POST', '/api/projects', { name, title, format: 'slides', sourceDir: dir })
      console.log(green(`Created slides project "${name}".`))
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`Project "${name}" exists, pushing files.`)
      } else {
        throw e
      }
    }

    // Push HTML files from the directory
    const htmlFiles = readdirSync(dir).filter(f => f.endsWith('.html'))
    if (htmlFiles.length === 0) {
      console.error(`No .html files found in ${dir}`)
      process.exit(1)
    }
    const files = htmlFiles.map(f => ({
      path: f,
      content: readFileSync(join(dir, f), 'utf8'),
    }))
    console.log(`Pushing ${files.length} HTML file(s)...`)
    await api('POST', `/api/projects/${name}/push`, { files, sourceDir: dir })
    console.log(green('Slides processed.'))

    const server = getServer()
    console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
    return
  }

  const mainFile = getFlag('main') || findMainTex(dir)
  if (!mainFile) { console.error(`No .tex file with \\documentclass found in ${dir}`); process.exit(1) }

  console.log(dim(`  Source: ${dir}`))
  console.log(dim(`  Main file: ${mainFile}`))

  // Create or update project on server
  try {
    await api('POST', '/api/projects', { name, title, mainFile, sourceDir: dir })
    console.log(green(`Created project "${name}".`))
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`Project "${name}" exists, pushing files.`)
    } else {
      throw e
    }
  }

  // Push source files (incremental)
  console.log(`Pushing source files...`)
  const result = await incrementalPush(name, dir, { sourceDir: dir })
  if (result.unchanged) {
    console.log(dim('No changes detected.'))
  } else {
    console.log(green('Build triggered.'))
  }

  const server = getServer()
  console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
}

async function cmdPush() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd push [name] [--dir /path]'); process.exit(1) }

  const dir = resolve(getFlag('dir') || '.')

  console.log(`Pushing to "${name}"...`)
  const result = await incrementalPush(name, dir, { sourceDir: dir })
  if (result.unchanged) {
    console.log(dim('No changes detected (use `ctd build` to force a rebuild).'))
  } else {
    console.log(green('Build triggered.'))
  }
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

  // Verify project exists on server
  try {
    await api('GET', `/api/projects/${name}`)
  } catch {
    console.error(red(`Project "${name}" not found on server. Run \`ctd create ${name}\` first.`))
    process.exit(1)
  }

  const debounceMs = parseInt(getFlag('debounce') || '200', 10)

  console.log(`Watching ${dir} → ${bold(name)}`)
  console.log(dim(`  Server: ${getServer()}`))
  console.log(dim(`  Debounce: ${debounceMs}ms`))
  console.log()

  const { startWatcher } = await import('./lib/watcher.mjs')
  await startWatcher({ dir, name, debounceMs, getServer, getToken })
}

const WATCH_ALL_LOGFILE = join(homedir(), '.config', 'ctd', 'watch-all.log')
const WATCH_ALL_PIDFILE = join(homedir(), '.config', 'ctd', 'watch-all.pid')

async function cmdWatchAll() {
  const sub = getPositional(0) || 'start'

  if (sub === 'stop') {
    if (existsSync(WATCH_ALL_PIDFILE)) {
      const pid = parseInt(readFileSync(WATCH_ALL_PIDFILE, 'utf8').trim(), 10)
      try { process.kill(pid, 'SIGTERM') } catch {}
      try { const fs = await import('fs'); fs.unlinkSync(WATCH_ALL_PIDFILE) } catch {}
    }
    console.log(green('Watchers stopped.'))
    return
  }

  if (sub === 'status') {
    if (existsSync(WATCH_ALL_PIDFILE)) {
      const pid = parseInt(readFileSync(WATCH_ALL_PIDFILE, 'utf8').trim(), 10)
      try {
        process.kill(pid, 0) // test if alive
        console.log(green('Watchers running') + dim(` (pid ${pid})`))
        return
      } catch {}
    }
    console.log(red('Watchers not running.'))
    return
  }

  if (sub === 'log' || sub === 'logs') {
    if (existsSync(WATCH_ALL_LOGFILE)) {
      const { execSync } = await import('child_process')
      execSync(`tail -50 "${WATCH_ALL_LOGFILE}"`, { stdio: 'inherit' })
    } else {
      console.log('No watcher log.')
    }
    return
  }

  if (sub === 'run') {
    // Foreground mode — actually run the watchers (used by daemon spawn)
    await watchAllRun()
    return
  }

  if (sub === 'start') {
    // Check if already running
    if (existsSync(WATCH_ALL_PIDFILE)) {
      const pid = parseInt(readFileSync(WATCH_ALL_PIDFILE, 'utf8').trim(), 10)
      try {
        process.kill(pid, 0)
        console.log('Watchers already running' + dim(` (pid ${pid})`))
        return
      } catch {
        // Stale PID file
      }
    }

    // Daemonize: spawn ourselves with 'run' subcommand
    const { spawn: cpSpawn } = await import('child_process')
    const { openSync: fsOpenSync } = await import('fs')

    if (!existsSync(dirname(WATCH_ALL_LOGFILE))) mkdirSync(dirname(WATCH_ALL_LOGFILE), { recursive: true })
    const logFd = fsOpenSync(WATCH_ALL_LOGFILE, 'a')

    const child = cpSpawn('node', [fileURLToPath(import.meta.url), 'watch-all', 'run'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    })
    child.unref()

    // Wait briefly to confirm it started
    await new Promise(r => setTimeout(r, 1000))
    if (existsSync(WATCH_ALL_PIDFILE)) {
      const pid = readFileSync(WATCH_ALL_PIDFILE, 'utf8').trim()
      console.log(green(`Watchers started`) + dim(` (pid ${pid})`))
      console.log(dim(`  Log: ${WATCH_ALL_LOGFILE}`))
    } else {
      console.error(red('Watchers failed to start'))
      console.error(dim(`Check log: ${WATCH_ALL_LOGFILE}`))
      process.exit(1)
    }
    return
  }

  console.error(`Unknown subcommand: ctd watch-all ${sub}`)
  console.error('Usage: ctd watch-all [start|stop|status|log|run]')
  process.exit(1)
}

async function watchAllRun() {
  // Write PID file
  writeFileSync(WATCH_ALL_PIDFILE, String(process.pid))

  const debounceMs = parseInt(getFlag('debounce') || '200', 10)
  const pollInterval = 30_000 // check for new projects every 30s
  const { startWatcher } = await import('./lib/watcher.mjs')

  const watchers = new Map()

  async function syncWatchers() {
    let projects
    try {
      const data = await api('GET', '/api/projects')
      projects = data.projects
    } catch (e) {
      console.error(`[watch-all] Failed to fetch projects: ${e.message}`)
      return
    }

    for (const p of projects) {
      if (watchers.has(p.name)) continue
      if (!p.sourceDir || !p.mainFile) continue
      if (!existsSync(p.sourceDir)) {
        console.log(`[watch-all] Skipping ${p.name}: ${p.sourceDir} not found`)
        continue
      }

      console.log(`[watch-all] Watching ${p.sourceDir} → ${p.name}`)
      const watcher = await startWatcher({ dir: p.sourceDir, name: p.name, debounceMs, getServer, getToken })
      watchers.set(p.name, watcher)
    }
  }

  console.log(`[watch-all] Started (pid ${process.pid})`)
  console.log(`[watch-all] Server: ${getServer()}`)
  console.log(`[watch-all] Polling for new projects every ${pollInterval / 1000}s`)

  await syncWatchers()

  if (watchers.size === 0) {
    console.log('[watch-all] No watchable projects yet — will poll for new ones.')
  }

  const timer = setInterval(syncWatchers, pollInterval)

  // Clean shutdown — override watcher SIGTERM handlers that ignore the signal
  const shutdown = () => {
    clearInterval(timer)
    try { unlinkSync(WATCH_ALL_PIDFILE) } catch {}
    console.log('[watch-all] Stopped.')
    process.exit(0)
  }
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep alive
  await new Promise(() => {})
}

async function cmdWatchAgent() {
  console.log('The per-document watch-agent has been replaced by the triage agent.')
  console.log('The triage agent covers all documents and runs alongside the server:')
  console.log()
  console.log(`  ${bold('ctd server start --agent')}`)
  console.log()
  console.log('It listens for feedback on all active projects, handles lightweight')
  console.log('responses, and yields to terminal Claude Code sessions for heavy work.')
}

async function cmdOpen() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd open [name]'); process.exit(1) }

  const server = getServer()
  const token = getToken()
  const url = `${server}/?doc=${name}` + (token ? `&token=${token}` : '')
  console.log(`Opening ${url}`)

  const { execFile } = await import('child_process')
  execFile('open', [url])
}

async function cmdShare() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd share [name]'); process.exit(1) }

  const server = getServer()
  const config = loadConfig()
  const readToken = config.tokenRead || null

  if (!readToken) {
    console.error('No read token configured. Run `ctd config init` to generate tokens.')
    process.exit(1)
  }

  const url = `${server}/?doc=${name}&token=${readToken}`
  console.log(url)
}

async function cmdList() {
  const data = await api('GET', '/api/projects')
  if (data.projects.length === 0) {
    console.log('No projects.')
    return
  }
  for (const p of data.projects) {
    const statusColor = p.buildStatus === 'success' ? green : p.buildStatus === 'error' ? red : dim
    const status = p.buildStatus === 'success' ? '' : ` ${statusColor(`[${p.buildStatus}]`)}`
    console.log(`  ${bold(p.name)}: ${p.title || p.name} ${dim(`(${p.pages} pages)`)}${status}`)
  }
}

async function cmdStatus() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd status [name]'); process.exit(1) }

  const data = await api('GET', `/api/projects/${name}/build/status`)
  const statusColor = data.status === 'success' ? green : data.status === 'error' ? red : dim
  console.log(`Project: ${bold(name)}`)
  console.log(`  Status: ${statusColor(data.status)}`)
  if (data.phase) console.log(`  Phase: ${data.phase}`)
  if (data.lastBuild) console.log(`  Last build: ${data.lastBuild}`)
  if (data.log) {
    console.log('\nBuild log:')
    console.log(data.log)
  }
}

async function cmdErrors() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd errors [name]'); process.exit(1) }

  const wait = hasFlag('wait') || hasFlag('w')

  let data = await api('GET', `/api/projects/${name}/build/errors`)

  if (data.building && wait) {
    const phaseLabel = p => p ? ` (${p})` : ''
    process.stderr.write(`Waiting for build${phaseLabel(data.phase)}...`)
    let lastPhase = data.phase
    while (data.building) {
      await new Promise(r => setTimeout(r, 2000))
      data = await api('GET', `/api/projects/${name}/build/errors`)
      if (data.phase !== lastPhase) {
        process.stderr.write(`\rWaiting for build${phaseLabel(data.phase)}...`)
        lastPhase = data.phase
      }
    }
    process.stderr.write('\n')
  }

  if (data.building) {
    const phase = data.phase ? ` (${data.phase})` : ''
    console.log(`[building${phase}...]`)
  } else if (data.lastBuild) {
    const ago = Math.round((Date.now() - new Date(data.lastBuild).getTime()) / 1000)
    const stamp = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`
    console.log(`Last build: ${stamp} (${data.status})`)
  }
  if (data.errors?.length > 0) {
    console.log(red(`${data.errors.length} error(s):`))
    for (const e of data.errors) console.log(red(`  ${e}`))
  }
  if (data.warnings?.length > 0) {
    console.log(`${data.warnings.length} warning(s):`)
    for (const w of data.warnings) console.log(dim(`  ${typeof w === 'string' ? w : w.message}`))
  }
  if (data.pipelineWarnings?.length > 0) {
    console.log(`${data.pipelineWarnings.length} pipeline issue(s):`)
    for (const w of data.pipelineWarnings) console.log(dim(`  ${w}`))
  }
  if (!data.errors?.length && !data.warnings?.length && !data.pipelineWarnings?.length && !data.building) {
    console.log(green('Clean.'))
  }
}

async function cmdBuild() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd build <name>'); process.exit(1) }

  console.log(dim('Note: prefer the watcher pipeline. ctd build bypasses change detection.'))
  console.log(`Triggering rebuild for "${name}"...`)
  await api('POST', `/api/projects/${name}/build`)
  console.log(green('Build triggered.'))
}

async function cmdDelete() {
  const name = getPositional(0)
  if (!name) { console.error('Usage: ctd delete <name>'); process.exit(1) }

  await api('DELETE', `/api/projects/${name}`)
  console.log(green(`Project "${name}" deleted.`))
}

async function cmdPreview() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: ctd preview <name> [page ...]'); process.exit(1) }

  // Collect page numbers from remaining positional args
  const requestedPages = []
  for (let i = 1; ; i++) {
    const p = getPositional(i)
    if (p === null) break
    const n = parseInt(p, 10)
    if (isNaN(n) || n < 1) { console.error(`Invalid page number: ${p}`); process.exit(1) }
    requestedPages.push(n)
  }

  // Get project info to find output dir and page count
  const data = await api('GET', `/api/projects/${name}`)
  const totalPages = data.pages || 0
  if (totalPages === 0) { console.error(`Project "${name}" has no pages (not built yet?)`); process.exit(1) }

  const pages = requestedPages.length > 0 ? requestedPages : Array.from({ length: totalPages }, (_, i) => i + 1)

  // Resolve SVG source directory
  const server = getServer()
  const outDir = `/tmp/ctd-preview-${name}`
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const { execFileSync } = await import('child_process')

  // Convert pages in parallel (up to 8 at a time)
  const CONCURRENCY = 8
  const results = []

  const token = getToken()
  const previewHeaders = token ? { 'Authorization': `Bearer ${token}` } : {}

  async function convertPage(page) {
    const svgUrl = `${server}/docs/${name}/page-${page}.svg`
    const pngPath = join(outDir, `page-${page}.png`)
    try {
      const svgRes = await fetch(svgUrl, { headers: previewHeaders, signal: AbortSignal.timeout(10000) })
      if (!svgRes.ok) { console.error(`  page ${page}: not found`); return null }
      const svgBuf = Buffer.from(await svgRes.arrayBuffer())
      execFileSync('rsvg-convert', ['-f', 'png', '-o', pngPath], { input: svgBuf, timeout: 30000 })
      return pngPath
    } catch (e) {
      console.error(`  page ${page}: ${e.message}`)
      return null
    }
  }

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(convertPage))
    for (const r of batchResults) if (r) results.push(r)
  }

  if (results.length === 0) {
    console.error('No pages rendered.')
    process.exit(1)
  }

  for (const p of results) console.log(p)
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

async function cmdAuth() {
  const sub = getPositional(0)

  if (sub === 'init') {
    const config = loadConfig()
    const tokenRw = randomBytes(24).toString('base64url')
    const tokenRead = randomBytes(24).toString('base64url')
    config.tokenRw = tokenRw
    config.tokenRead = tokenRead
    config.token = tokenRw  // CLI uses the RW token
    saveConfig(config)

    console.log(green('Tokens generated and saved to config.'))
    console.log()
    console.log(`  RW token:   ${bold(tokenRw)}`)
    console.log(`  Read token: ${bold(tokenRead)}`)
    console.log()
    console.log(dim(`Config: ${CONFIG_FILE}`))
    console.log(dim(`Restart the server for tokens to take effect.`))
    return
  }

  if (sub === 'show') {
    const config = loadConfig()
    console.log(`  RW token:   ${config.tokenRw || dim('(not set)')}`)
    console.log(`  Read token: ${config.tokenRead || dim('(not set)')}`)
    console.log(`  CLI token:  ${config.token || dim('(not set)')}`)
    return
  }

  console.log('Usage: ctd auth [init|show]')
  console.log('  init   Generate and save new tokens')
  console.log('  show   Show current tokens')
}

function cmdCompletions() {
  // Fetch project names at completion time via a helper function in the script
  const commands = [
    'server', 'create', 'push', 'watch', 'watch-all', 'watch-agent', 'open', 'list', 'ls',
    'status', 'errors', 'delete', 'rm', 'preview',
    'logs', 'log', 'config', 'completions',
  ]
  const serverSubs = ['start', 'stop', 'status', 'log', 'logs', 'install', 'uninstall']

  console.log(`#compdef ctd
# Install: ctd completions > ~/.zsh/completions/_ctd && fpath=(~/.zsh/completions $fpath)
# Then restart your shell or run: autoload -Uz compinit && compinit

_ctd_projects() {
  local -a projects
  projects=(\${(f)"$(ctd list 2>/dev/null | sed 's/^ *//' | cut -d: -f1)"})
  _describe 'project' projects
}

_ctd() {
  local -a commands
  commands=(
    'server:Manage the server'
    'create:Create project and upload files'
    'push:Push source files and rebuild'
    'watch:Watch for changes and auto-push'
    'watch-all:Watch all projects'
    'watch-agent:Run triage agent (use server --agent)'
    'open:Open viewer in browser'
    'list:List projects'
    'status:Show build status'
    'errors:Show LaTeX errors/warnings'
    'logs:Show server log'
    'delete:Delete a project'
    'preview:Rasterize SVG pages to PNG'
    'config:Manage configuration'
    'completions:Output zsh completion script'
  )

  _arguments -C '1:command:->cmd' '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        server)
          local -a subs=(${serverSubs.map(s => `'${s}'`).join(' ')})
          _describe 'subcommand' subs
          ;;
        create|push|open|status|errors|build|delete|rm|preview|watch-agent)
          _ctd_projects
          ;;
      esac
      ;;
  esac
}

_ctd "$@"`)
}

const LOGFILE = join(homedir(), '.config', 'ctd', 'server.log')

function getPort() {
  try { return new URL(getServer()).port || '5176' } catch { return '5176' }
}



async function cmdServer(action) {
  const sub = action || getPositional(0) || 'start'

  // Find the unified server script relative to this file's location
  const ctdRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const serverScript = join(ctdRoot, 'server', 'unified-server.mjs')

  const port = getPort()
  const { execSync } = await import('child_process')

  // Clean up stale PID file from old versions
  const oldPidFile = join(homedir(), '.config', 'ctd', 'server.pid')
  try { const fs = await import('fs'); fs.unlinkSync(oldPidFile) } catch {}

  const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.ctd.server.plist')
  const hasLaunchd = process.platform === 'darwin' && existsSync(PLIST)

  if (sub === 'install') {
    if (process.platform !== 'darwin') {
      console.error('launchd is macOS-only.')
      process.exit(1)
    }

    // Find node binary
    let nodePath
    try { nodePath = execSync('which node', { stdio: 'pipe' }).toString().trim() } catch {
      nodePath = '/opt/homebrew/bin/node'
    }

    const config = loadConfig()
    const tokenEnvLines = []
    if (config.tokenRw) tokenEnvLines.push(`        <key>CTD_TOKEN_RW</key>\n        <string>${config.tokenRw}</string>`)
    if (config.tokenRead) tokenEnvLines.push(`        <key>CTD_TOKEN_READ</key>\n        <string>${config.tokenRead}</string>`)

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ctd.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverScript}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${port}</string>
        <key>PATH</key>
        <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
${tokenEnvLines.join('\n')}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOGFILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOGFILE}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
    const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents')
    if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true })
    writeFileSync(PLIST, plistContent)
    console.log(`Installed ${PLIST}`)
    console.log(`  Node: ${nodePath}`)
    console.log(`  Server: ${serverScript}`)
    console.log(`  Port: ${port}`)
    console.log(`  Log: ${LOGFILE}`)
    console.log('\nThe server will auto-restart on crash and start on login.')
    console.log('Run `ctd server start` to start now.')
    return
  }

  if (sub === 'uninstall') {
    if (hasLaunchd) {
      try { execSync('launchctl bootout gui/$(id -u)/com.ctd.server', { stdio: 'pipe' }) } catch {}
      try { const fs = await import('fs'); fs.unlinkSync(PLIST) } catch {}
      console.log('Uninstalled launchd service.')
    } else {
      console.log('No launchd service installed.')
    }
    return
  }

  if (sub === 'stop') {
    if (hasLaunchd) {
      try { execSync('launchctl bootout gui/$(id -u)/com.ctd.server', { stdio: 'pipe' }) } catch {}
    }

    // Get the server's actual PID from /health so we only kill the server,
    // not watchers or other processes connected to the same port
    let serverPid = null
    try {
      const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
      const data = await res.json()
      serverPid = data.pid
    } catch {}

    if (serverPid) {
      try { process.kill(serverPid, 'SIGTERM') } catch {}
    } else {
      // Fallback: kill by port (catches zombies that don't respond to /health)
      try {
        const pids = execSync(`lsof -ti:${port}`, { stdio: 'pipe' }).toString().trim()
        if (pids) {
          for (const pid of pids.split('\n')) {
            try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
          }
        }
      } catch {}
    }

    // Wait for the server to actually stop
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(1000) })
      } catch { break } // connection refused = stopped
    }

    console.log(green('Server stopped.'))
    return
  }

  if (sub === 'status') {
    try {
      const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
      const data = await res.json()
      const pid = data.pid ? `, pid ${data.pid}` : ''
      console.log(green(`Server running`) + dim(` (uptime: ${Math.floor(data.uptime)}s${pid})`))
    } catch {
      console.log(red('Server not running.'))
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
      // Not running — kill any zombie holding the port
      try {
        const stale = execSync(`lsof -ti:${port}`, { stdio: 'pipe' }).toString().trim()
        if (stale) {
          for (const pid of stale.split('\n')) {
            try { process.kill(parseInt(pid), 'SIGKILL') } catch {}
          }
          await new Promise(r => setTimeout(r, 500))
        }
      } catch {}
    }

    if (!existsSync(serverScript)) {
      console.error(`Server script not found: ${serverScript}`)
      process.exit(1)
    }

    // Ensure log directory exists
    if (!existsSync(dirname(LOGFILE))) mkdirSync(dirname(LOGFILE), { recursive: true })

    if (hasLaunchd) {
      // Use launchd — auto-restarts on crash, persists across login
      try { execSync('launchctl bootstrap gui/$(id -u) ' + PLIST, { stdio: 'pipe' }) } catch {}
      try { execSync('launchctl kickstart -k gui/$(id -u)/com.ctd.server', { stdio: 'pipe' }) } catch {}
    } else {
      const { spawn } = await import('child_process')
      const { openSync: fsOpenSync } = await import('fs')
      const logFd = fsOpenSync(LOGFILE, 'a')

      const serverArgs = [serverScript]
      if (hasFlag('agent')) serverArgs.push('--agent')
      const child = spawn('node', serverArgs, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PORT: port },
      })
      child.unref()
    }

    // Wait for it to come up
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        const res = await fetch(`${getServer()}/health`)
        if (res.ok) {
          const data = await res.json()
          console.log(green(`Server running at ${getServer()}`) + dim(` (pid ${data.pid})`))
          console.log(dim(`  Log: ${LOGFILE}`))
          if (hasLaunchd) console.log(dim('  Managed by launchd (auto-restarts)'))
          return
        }
      } catch {}
    }
    console.error(red('Server failed to start within 5s'))
    console.error(dim(`Check log: ${LOGFILE}`))
    process.exit(1)
  }

  console.error(`Unknown subcommand: ctd server ${sub}`)
  console.error('Usage: ctd server [start|stop|status|log|install|uninstall]')
  process.exit(1)
}

async function inferProjectName() {
  const dir = resolve(getFlag('dir') || '.')

  // Try to match by sourceDir from the server
  try {
    const data = await api('GET', '/api/projects')
    for (const p of data.projects) {
      if (p.sourceDir && resolve(p.sourceDir) === dir) return p.name
    }
  } catch {}

  // Fall back to basename
  return basename(dir)
}

// --- Ensure server is running ---

async function ensureServer() {
  try {
    const res = await fetch(`${getServer()}/health`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) return
  } catch {}

  // Check if something is on the port (could be busy with a build)
  const port = getPort()
  try {
    const { execSync } = await import('child_process')
    const pids = execSync(`lsof -ti:${port}`, { stdio: 'pipe' }).toString().trim()
    if (pids) {
      // Process exists on port but health check failed — probably busy building
      console.log('Server busy (likely building), proceeding...')
      return
    }
  } catch {}

  // Nothing on the port — auto-start
  console.log('Server not running, starting...')
  await cmdServer('start')
}

// --- Main ---

async function main() {
  try {
    switch (command) {
      case 'server': await cmdServer(); break
      case 'book':   await ensureServer(); await cmdBook(); break
      case 'create': await ensureServer(); await cmdCreate(); break
      case 'push':   await ensureServer(); await cmdPush(); break
      case 'watch':  await ensureServer(); await cmdWatch(); break
      case 'watch-all': await ensureServer(); await cmdWatchAll(); break
      case 'watch-agent': await ensureServer(); await cmdWatchAgent(); break
      case 'open':   await ensureServer(); await cmdOpen(); break
      case 'share':  await cmdShare(); break
      case 'list':   await ensureServer(); await cmdList(); break
      case 'ls':     await ensureServer(); await cmdList(); break
      case 'status': await ensureServer(); await cmdStatus(); break
      case 'errors': await ensureServer(); await cmdErrors(); break
      case 'build':   await ensureServer(); await cmdBuild(); break
      case 'preview': await ensureServer(); await cmdPreview(); break
      case 'delete':  await ensureServer(); await cmdDelete(); break
      case 'rm':      await ensureServer(); await cmdDelete(); break
      case 'logs':    await cmdServer('logs'); break
      case 'log':     await cmdServer('logs'); break
      case 'completions': cmdCompletions(); break
      case 'auth': await cmdAuth(); break
      case 'config': await cmdConfig(); break
      default:
        console.log(`ctd — Claude TLDraw CLI

Commands:
  server [start|stop|status|log|install|uninstall]  Manage the server
  create <name>  Create project (or update existing), upload files, build
  book <name>    Create a book grouping existing docs (--members doc1,doc2,...)
  push [name]    Push source files, trigger rebuild
  watch [path]   Watch for changes, auto-push to server
  watch-all      Watch all projects (auto-detects new ones)
  watch-agent    (use: ctd server start --agent)
  open [name]    Open viewer in browser
  list           List projects
  status [name]  Show build status
  errors [name]  Show LaTeX errors/warnings from last build
  logs           Show server log (alias: ctd server logs)
  delete <name>  Delete a project (alias: rm)
  preview <name> [page ...]  Rasterize SVG pages to PNG
  completions    Output zsh completion script

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
    console.error(red(`Error: ${e.message}`))
    process.exit(1)
  }
}

main()
