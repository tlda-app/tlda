#!/usr/bin/env node
/**
 * tlda — tlda CLI.
 *
 * Commands:
 *   tlda create <name> [--title "Title"] [--dir /path] [--main main.tex]
 *   tlda push [name] [--dir /path]
 *   tlda watch [/path/to/main.tex] [name]
 *   tlda watch-all
 *   tlda open [name]
 *   tlda list
 *   tlda status [name]
 *   tlda config set server <url>
 *
 * Server URL resolution:
 *   TLDA_SERVER env → --server flag → ~/.config/tlda/config.json → http://localhost:5176
 */

import { resolve, basename, dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { collectSourceFiles, collectSourceHashes, collectSpecificFiles } from './lib/source-files.mjs'

// --- Config ---

const CONFIG_DIR = join(homedir(), '.config', 'tlda')
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
  book:    'tlda book <name> --members doc1,doc2,doc3,...\n\n  Create a book that groups existing documents together.\n  Each member keeps its own sync room and annotations.\n  The viewer shows one member at a time with a tab bar to switch.',
  create:  'tlda create <name> [--title "Title"] [--dir /path] [--main main.tex] [--format slides|html|markdown]\n\n  Create a project and push source files. If the project already exists,\n  pushes files and triggers a rebuild.\n\n  Formats:\n    (default)  LaTeX → SVG pipeline (latexmk → dvisvgm)\n    slides     Reveal.js HTML (from Quarto revealjs or manual)\n    html       Multipage HTML chapters (from Quarto book render)\n    markdown   Markdown with KaTeX math → HTML',
  push:    'tlda push [name] [--dir /path]\n\n  Push source files to the server and trigger a rebuild.\n  Project name is inferred from the current directory if omitted.',
  watch:   'tlda watch [/path/to/main.tex] [name] [--debounce ms]\n\n  Watch source files for changes and auto-push to the server.\n  The server handles building — the watcher only uploads.',
  'watch-all': 'tlda watch-all [start|stop|status|log|run]\n\n  Watch all projects that have a sourceDir. Polls for new projects\n  every 30s, so `tlda create` picks them up automatically.\n\n  start   Daemonize and watch in background (default)\n  stop    Stop the background watchers\n  status  Check if watchers are running\n  log     Show recent watcher log\n  run     Run in foreground (for debugging)',
  listen:  'tlda listen <doc> [--timeout <seconds>]\n\n  Block until feedback arrives on the document, then print it as JSON\n  and exit. Designed for `bash(run_in_background)` so an agent can\n  keep working while waiting for annotations, pings, or drawn shapes.\n\n  --timeout <seconds>  Max wait time (default: 300)',
  monitor: 'tlda monitor [add|remove|list|clear] [doc]\n\n  Manage which docs the PostToolUse hook monitors for feedback.\n  The hook runs after every tool call and reports new annotations,\n  pings, and drawn shapes automatically — no polling needed.\n\n  add <doc>     Start monitoring (seeds shape snapshot)\n  remove <doc>  Stop monitoring\n  list          Show monitored docs (default)\n  clear         Stop all monitoring',
  agent:   'tlda agent [start|stop|status|log] --target <name>\n\n  Manage the triage agent (Todd). One agent per target.\n\n  start    Start Todd for the given target\n  stop     Stop Todd (no --target = stop all)\n  status   Show running agents (no --target = show all)\n  log      Show recent agent log for a target\n\n  --target <name>  Required for start/log. Optional for stop/status.',
  'watch-agent': 'tlda watch-agent\n\n  Replaced by `tlda agent start`. The triage agent now\n  covers all documents automatically.',
  open:    'tlda open [name]\n\n  Open the viewer in the default browser (RW token = presenter privilege).',
  share:   'tlda share [name]\n\n  Print a viewer URL with the read-only token.\n  Recipients can annotate but cannot present.',
  status:  'tlda status [name]\n\n  Show build status for a project.',
  errors:  'tlda errors [name] [--wait]\n\n  Extract LaTeX errors and warnings from the last build log.\n  With --wait (-w), blocks until the current build finishes.',
  build:   'tlda build [name]\n\n  Trigger a rebuild without pushing files.\n\n  NOTE: Prefer the watcher pipeline. This command bypasses change\n  detection and should only be used for debugging.',
  delete:  'tlda delete <name>\n\n  Delete a project and all its data.',
  preview: 'tlda preview <name> [page ...]\n\n  Rasterize SVG pages to PNG for visual inspection.\n  Outputs paths to /tmp/tlda-preview-{name}/.',
  server:  'tlda server [start|stop|status|log|install|uninstall] [--agent]\n\n  start      Start the server (auto-restarts via launchd if installed)\n  stop       Stop the server\n  status     Check if server is running\n  log        Show recent server log\n  install    Install launchd service (macOS)\n  uninstall  Remove launchd service\n\n  --agent    Start the triage agent alongside the server.\n             Equivalent to running `tlda agent start` separately.',
  publish: 'tlda publish [--target <name>] [doc ...]\n\n  Publish docs to GitHub Pages (+ optionally Fly).\n\n  With no args, publishes all docs in config.published using the "default" target.\n  With --target, uses the named target config (sync server, repo, etc.).\n  With doc names, publishes those and adds them to the list.\n\n  Config (targets in ~/.config/tlda/config.json):\n    targets.<name>.sync     — sync server WebSocket URL\n    targets.<name>.repo     — git remote for gh-pages (null = same repo)\n    targets.<name>.fly      — deploy to Fly (default: false)\n    targets.<name>.basePath — vite base path (default: /tlda/)',
  config:  'tlda config [set <key> <value> | get [key]]\n\n  Manage persistent configuration.\n  Example: tlda config set server http://myhost:5176',
}

// Flags that take a value (--flag value). All others are boolean.
const VALUE_FLAGS = new Set(['server', 'dir', 'title', 'main', 'debounce', 'token', 'members', 'format', 'session', 'target', 'timeout'])

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
  return process.env.TLDA_SERVER || getFlag('server') || loadConfig().server || 'http://localhost:5176'
}

function getToken() {
  return process.env.TLDA_TOKEN || getFlag('token') || loadConfig().token || null
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
async function incrementalPush(name, dir, extraBody = {}, { forceMetadata = false } = {}) {
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

    if (changedPaths.length === 0 && deletedFiles.length === 0 && !forceMetadata) {
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
    console.error('Usage: tlda book <name> --members doc1,doc2,doc3,...')
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
  if (!name) { console.error('Usage: tlda create <name> [--title "Title"] [--dir /path] [--main main.tex] [--format slides|html]'); process.exit(1) }

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

  // HTML format: push HTML chapters (e.g. from Quarto book render)
  if (format === 'html') {
    console.log(dim(`  Source: ${dir}`))
    console.log(dim(`  Format: html`))

    // Create or update project
    try {
      await api('POST', '/api/projects', { name, title, format: 'html', sourceDir: dir })
      console.log(green(`Created HTML project "${name}".`))
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`Project "${name}" exists, pushing files.`)
      } else {
        throw e
      }
    }

    // Collect all files from the directory (HTML, CSS, JS, fonts, images, site_libs)
    const allFiles = []
    function collectDir(base, prefix = '') {
      for (const entry of readdirSync(join(base, prefix), { withFileTypes: true })) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          collectDir(base, relPath)
        } else {
          const content = readFileSync(join(base, relPath))
          allFiles.push({
            path: relPath,
            content: content.toString('base64'),
            encoding: 'base64',
          })
        }
      }
    }
    collectDir(dir)

    if (allFiles.filter(f => f.path.endsWith('.html')).length === 0) {
      console.error(`No .html files found in ${dir}`)
      process.exit(1)
    }

    console.log(`Pushing ${allFiles.length} file(s)...`)
    await api('POST', `/api/projects/${name}/push`, { files: allFiles, sourceDir: dir })
    console.log(green('HTML project processed.'))

    const server = getServer()
    console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
    return
  }

  // Markdown format: push .md file, server renders to HTML with KaTeX
  if (format === 'markdown') {
    const mainFile = getFlag('main') || readdirSync(dir).find(f => f.endsWith('.md'))
    if (!mainFile) { console.error(`No .md file found in ${dir}`); process.exit(1) }

    console.log(dim(`  Source: ${dir}`))
    console.log(dim(`  Format: markdown`))
    console.log(dim(`  Main file: ${mainFile}`))

    try {
      await api('POST', '/api/projects', { name, title, mainFile, format: 'markdown', sourceDir: dir })
      console.log(green(`Created markdown project "${name}".`))
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`Project "${name}" exists, pushing files.`)
      } else {
        throw e
      }
    }

    // Push .md file (and any images/assets alongside it)
    const allFiles = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const content = readFileSync(join(dir, entry.name))
      allFiles.push({ path: entry.name, content: content.toString('base64'), encoding: 'base64' })
    }

    console.log(`Pushing ${allFiles.length} file(s)...`)
    await api('POST', `/api/projects/${name}/push`, { files: allFiles, sourceDir: dir })
    console.log(green('Markdown project processed.'))

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
  if (!name) { console.error('Usage: tlda push [name] [--dir /path]'); process.exit(1) }

  const dir = resolve(getFlag('dir') || '.')

  // Session tagging: --session <id> or CLAUDE_SESSION_ID env var
  const session = getFlag('session') || process.env.CLAUDE_SESSION_ID || null

  console.log(`Pushing to "${name}"...`)
  const result = await incrementalPush(name, dir, {
    sourceDir: dir,
    ...(session && { session, sessionAt: Date.now() }),
  }, { forceMetadata: !!session })
  if (result.unchanged) {
    console.log(dim('No changes detected (use `tlda build` to force a rebuild).'))
  } else {
    console.log(green('Build triggered.'))
  }

  // Auto-join book group from .tlda-book config in source dir
  const bookConfigPath = join(dir, '.tlda-book')
  if (existsSync(bookConfigPath)) {
    const bookConfig = Object.fromEntries(
      readFileSync(bookConfigPath, 'utf8')
        .split('\n')
        .filter(l => l.includes(':'))
        .map(l => l.split(':').map(s => s.trim()))
    )
    const group = bookConfig.group
    if (group) {
      try {
        await api('PATCH', `/api/projects/${group}/members`, { add: name })
        console.log(dim(`  Joined book "${group}"`))
      } catch (e) {
        console.log(dim(`  Book "${group}": ${e.message}`))
      }
    }
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
    console.error(red(`Project "${name}" not found on server.`))
    console.error(`  Run \`tlda create ${name}\` first, or did you mean \`tlda watch-all start\`?`)
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

const WATCH_ALL_LOGFILE = join(homedir(), '.config', 'tlda', 'watch-all.log')
const WATCH_ALL_PIDFILE = join(homedir(), '.config', 'tlda', 'watch-all.pid')

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

  console.error(`Unknown subcommand: tlda watch-all ${sub}`)
  console.error('Usage: tlda watch-all [start|stop|status|log|run]')
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
  console.log('The per-document watch-agent has been replaced by `tlda agent start`.')
  console.log()
  console.log(`  ${bold('tlda agent start')}                  # against localhost`)
  console.log(`  ${bold('tlda agent start --target <name>')}  # against a named target`)
}

// --- Agent (Todd) management ---

function agentLogFile(target) {
  return join(homedir(), '.config', 'tlda', `agent-${target}.log`)
}
function agentPidFile(target) {
  return join(homedir(), '.config', 'tlda', `agent-${target}.pid`)
}

function readAgentPid(target) {
  const pidFile = agentPidFile(target)
  if (!existsSync(pidFile)) return null
  try {
    const info = JSON.parse(readFileSync(pidFile, 'utf8').trim())
    return { pid: info.pid, target: info.target, serverUrl: info.serverUrl }
  } catch { return null }
}

function allAgentTargets() {
  const dir = join(homedir(), '.config', 'tlda')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.pid'))
    .map(f => f.slice(6, -4)) // extract target name
}

async function cmdMonitor() {
  const sub = getPositional(0) // add, remove, list, clear
  const doc = getPositional(1)
  const watchFile = '/tmp/tlda-listen-docs'
  const stateDir = '/tmp/tlda-listen-state'

  function readDocs() {
    if (!existsSync(watchFile)) return []
    return readFileSync(watchFile, 'utf8').split('\n').filter(Boolean)
  }
  function writeDocs(docs) {
    writeFileSync(watchFile, docs.join('\n') + (docs.length ? '\n' : ''))
  }

  if (!sub || sub === 'list') {
    const docs = readDocs()
    if (docs.length === 0) {
      console.log(dim('No docs being monitored.'))
      console.log(dim('  tlda monitor add <doc>'))
    } else {
      console.log(`Monitoring: ${docs.join(', ')}`)
    }
    return
  }

  if (sub === 'add') {
    if (!doc) { console.error('Usage: tlda monitor add <doc>'); process.exit(1) }
    const docs = readDocs()
    if (!docs.includes(doc)) {
      docs.push(doc)
      writeDocs(docs)
    }
    // Seed the snapshot so the hook doesn't fire on existing shapes
    mkdirSync(stateDir, { recursive: true })
    try {
      const server = getServer()
      const token = getToken()
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
      const res = await fetch(`${server}/api/projects/${doc}/shapes`, { headers })
      if (res.ok) {
        const shapes = await res.json()
        writeFileSync(join(stateDir, `shapes-${doc}.json`), JSON.stringify(shapes))
      }
      // Seed ping timestamp
      const pingRes = await fetch(`${server}/api/projects/${doc}/signal/signal:ping`, { headers })
      if (pingRes.ok) {
        const ping = await pingRes.json()
        if (ping?.timestamp) writeFileSync(join(stateDir, `signal-ts-${doc}`), String(ping.timestamp))
      }
    } catch {}
    console.log(green(`Monitoring ${doc}`) + dim(' (hook will check between tool calls)'))
    console.log(dim(`  When idle, call wait_for_feedback("${doc}") to block until feedback arrives.`))
    return
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!doc) { console.error('Usage: tlda monitor remove <doc>'); process.exit(1) }
    const docs = readDocs().filter(d => d !== doc)
    writeDocs(docs)
    // Clean up state
    try { unlinkSync(join(stateDir, `shapes-${doc}.json`)) } catch {}
    try { unlinkSync(join(stateDir, `signal-ts-${doc}`)) } catch {}
    console.log(dim(`Stopped monitoring ${doc}`))
    return
  }

  if (sub === 'clear') {
    writeDocs([])
    try { unlinkSync(join(stateDir, 'last-check')) } catch {}
    console.log(dim('Cleared all monitored docs'))
    return
  }

  console.error(`Unknown subcommand: ${sub}\nUsage: tlda monitor [add|remove|list|clear] [doc]`)
  process.exit(1)
}

async function cmdListen() {
  const doc = getPositional(0)
  if (!doc) {
    console.error('Usage: tlda listen <doc> [--timeout <seconds>]')
    process.exit(1)
  }
  const timeout = parseInt(getFlag('timeout', '300')) || 300
  const { listen } = await import('./lib/listener.mjs')
  try {
    const result = await listen(doc, { timeout })
    console.log(JSON.stringify(result))
  } catch (e) {
    if (e.message === 'timeout') {
      console.error(`[listen] No feedback within ${timeout}s`)
      process.exit(1)
    }
    console.error(`[listen] Error: ${e.message}`)
    process.exit(1)
  }
}

async function cmdAgent() {
  const sub = getPositional(0) || 'status'
  const targetFlag = getFlag('target')

  // status with no --target shows all agents
  if (sub === 'status' && !targetFlag) {
    const targets = allAgentTargets()
    if (targets.length === 0) {
      console.log(red('No agents running.'))
      return
    }
    for (const t of targets) {
      const info = readAgentPid(t)
      if (!info) continue
      try {
        process.kill(info.pid, 0)
        console.log(green(`${t}`) + dim(` — pid ${info.pid}, ${info.serverUrl || '?'}`))
      } catch {
        try { unlinkSync(agentPidFile(t)) } catch {}
      }
    }
    return
  }

  // stop with no --target stops all agents
  if (sub === 'stop' && !targetFlag) {
    const targets = allAgentTargets()
    for (const t of targets) {
      const info = readAgentPid(t)
      if (info) {
        try { process.kill(info.pid, 'SIGTERM') } catch {}
        try { unlinkSync(agentPidFile(t)) } catch {}
        console.log(green(`Stopped ${t}`) + dim(` (pid ${info.pid})`))
      }
    }
    if (targets.length === 0) console.log('No agents running.')
    return
  }

  // All other commands require --target
  if (!targetFlag) {
    console.error(red('--target is required.'))
    console.error(dim('Usage: tlda agent start --target <name>'))
    console.error(dim('       tlda agent status  (no --target shows all)'))
    process.exit(1)
  }

  if (sub === 'stop') {
    const info = readAgentPid(targetFlag)
    if (info) {
      try { process.kill(info.pid, 'SIGTERM') } catch {}
      try { unlinkSync(agentPidFile(targetFlag)) } catch {}
    }
    console.log(green(`Agent stopped (${targetFlag}).`))
    return
  }

  if (sub === 'status') {
    const info = readAgentPid(targetFlag)
    if (info) {
      try {
        process.kill(info.pid, 0)
        console.log(green(`Agent running (${targetFlag})`) + dim(` — pid ${info.pid}, ${info.serverUrl}`))
        return
      } catch {}
    }
    console.log(red(`Agent not running (${targetFlag}).`))
    return
  }

  if (sub === 'log' || sub === 'logs') {
    const logFile = agentLogFile(targetFlag)
    if (existsSync(logFile)) {
      const { execSync } = await import('child_process')
      execSync(`tail -50 "${logFile}"`, { stdio: 'inherit' })
    } else {
      console.log(`No agent log for ${targetFlag}.`)
    }
    return
  }

  if (sub === 'start') {
    const existing = readAgentPid(targetFlag)
    if (existing) {
      try {
        process.kill(existing.pid, 0)
        console.log('Agent already running' + dim(` (${targetFlag}, pid ${existing.pid})`))
        return
      } catch {
        // Stale PID file
      }
    }

    const config = loadConfig()
    const targets = config.targets || {}
    const target = targets[targetFlag]
    if (!target) {
      console.error(red(`No target "${targetFlag}" configured.`))
      console.error(dim('Configure targets in ~/.config/tlda/config.json'))
      process.exit(1)
    }

    const syncUrl = target.sync
    const serverUrl = syncUrl ? syncUrl.replace(/^ws(s?):\/\//, 'http$1://') : getServer()
    const syncServerUrl = syncUrl || null

    const token = getToken()
    const agentScript = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'triage-agent.mjs')

    if (!existsSync(agentScript)) {
      console.error(red('Triage agent not found: ' + agentScript))
      process.exit(1)
    }

    const { spawn: cpSpawn } = await import('child_process')
    const { openSync: fsOpenSync } = await import('fs')

    const logFile = agentLogFile(targetFlag)
    if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })
    const logFd = fsOpenSync(logFile, 'a')

    // Build env: strip CLAUDECODE to avoid nested-session rejection from agent SDK
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    env.TLDA_SERVER = serverUrl
    if (syncServerUrl) env.TLDA_SYNC_SERVER = syncServerUrl
    if (token) env.TLDA_TOKEN = token

    const child = cpSpawn('node', [agentScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    })
    child.unref()

    writeFileSync(agentPidFile(targetFlag), JSON.stringify({ pid: child.pid, target: targetFlag, serverUrl }))

    // Wait briefly to confirm it started
    await new Promise(r => setTimeout(r, 2000))
    try {
      process.kill(child.pid, 0)
      console.log(green(`Agent started (${targetFlag})`) + dim(` — pid ${child.pid}`))
      console.log(dim(`  Server: ${serverUrl}`))
      console.log(dim(`  Log: ${logFile}`))
    } catch {
      console.error(red(`Agent failed to start (${targetFlag})`))
      console.error(dim(`Check log: ${logFile}`))
      try { unlinkSync(agentPidFile(targetFlag)) } catch {}
      process.exit(1)
    }
    return
  }

  console.error(`Unknown subcommand: tlda agent ${sub}`)
  console.error('Usage: tlda agent [start|stop|status|log] --target <name>')
  process.exit(1)
}

async function cmdOpen() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: tlda open [name]'); process.exit(1) }

  const server = getServer()
  const token = getToken()
  const url = `${server}/?doc=${name}` + (token ? `&token=${token}` : '')
  console.log(`Opening ${url}`)

  const { execFile } = await import('child_process')
  execFile('open', [url])
}

async function cmdShare() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: tlda share [name]'); process.exit(1) }

  const server = getServer()
  const config = loadConfig()
  const readToken = config.tokenRead || null

  if (!readToken) {
    console.error('No read token configured. Run `tlda config init` to generate tokens.')
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
  if (!name) { console.error('Usage: tlda status [name]'); process.exit(1) }

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
  if (!name) { console.error('Usage: tlda errors [name]'); process.exit(1) }

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
  if (!name) { console.error('Usage: tlda build <name>'); process.exit(1) }

  console.log(dim('Note: prefer the watcher pipeline. tlda build bypasses change detection.'))
  console.log(`Triggering rebuild for "${name}"...`)
  await api('POST', `/api/projects/${name}/build`)
  console.log(green('Build triggered.'))
}

async function cmdDelete() {
  const name = getPositional(0)
  if (!name) { console.error('Usage: tlda delete <name>'); process.exit(1) }

  await api('DELETE', `/api/projects/${name}`)
  console.log(green(`Project "${name}" deleted.`))
}

async function cmdPreview() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: tlda preview <name> [page ...]'); process.exit(1) }

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
  const outDir = `/tmp/tlda-preview-${name}`
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

async function cmdPublish() {
  const { execSync: exec } = await import('child_process')
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'publish-snapshot.mjs')
  const passthrough = args.slice(1) // pass --target and doc names through
  exec(`node ${scriptPath} ${passthrough.join(' ')}`, { stdio: 'inherit' })
}

async function cmdConfig() {
  const sub = getPositional(0)
  if (sub === 'set') {
    const key = getPositional(1)
    const value = getPositional(2)
    if (!key || !value) { console.error('Usage: tlda config set <key> <value>'); process.exit(1) }
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

  console.log('Usage: tlda auth [init|show]')
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

  console.log(`#compdef tlda
# Install: tlda completions > ~/.zsh/completions/_tlda && fpath=(~/.zsh/completions $fpath)
# Then restart your shell or run: autoload -Uz compinit && compinit

_ctd_projects() {
  local -a projects
  projects=(\${(f)"$(tlda list 2>/dev/null | sed 's/^ *//' | cut -d: -f1)"})
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
    'agent:Manage the triage agent (Todd)'
    'publish:Publish docs to GitHub Pages + Fly'
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

_tlda "$@"`)
}

const LOGFILE = join(homedir(), '.config', 'tlda', 'server.log')

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
  const oldPidFile = join(homedir(), '.config', 'tlda', 'server.pid')
  try { const fs = await import('fs'); fs.unlinkSync(oldPidFile) } catch {}

  const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.tlda.server.plist')
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
    if (config.tokenRw) tokenEnvLines.push(`        <key>TLDA_TOKEN_RW</key>\n        <string>${config.tokenRw}</string>`)
    if (config.tokenRead) tokenEnvLines.push(`        <key>TLDA_TOKEN_READ</key>\n        <string>${config.tokenRead}</string>`)

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tlda.server</string>
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
    console.log('Run `tlda server start` to start now.')
    return
  }

  if (sub === 'uninstall') {
    if (hasLaunchd) {
      try { execSync('launchctl bootout gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
      try { const fs = await import('fs'); fs.unlinkSync(PLIST) } catch {}
      console.log('Uninstalled launchd service.')
    } else {
      console.log('No launchd service installed.')
    }
    return
  }

  if (sub === 'stop') {
    if (hasLaunchd) {
      try { execSync('launchctl bootout gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
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
      try { execSync('launchctl kickstart -k gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
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

  console.error(`Unknown subcommand: tlda server ${sub}`)
  console.error('Usage: tlda server [start|stop|status|log|install|uninstall]')
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
      case 'agent': await cmdAgent(); break
      case 'watch-agent': await cmdWatchAgent(); break
      case 'listen': await ensureServer(); await cmdListen(); break
      case 'monitor': await ensureServer(); await cmdMonitor(); break
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
      case 'publish': await cmdPublish(); break
      case 'completions': cmdCompletions(); break
      case 'auth': await cmdAuth(); break
      case 'config': await cmdConfig(); break
      default:
        console.log(`tlda — tlda CLI

Commands:
  server [start|stop|status|log|install|uninstall]  Manage the server
  create <name>  Create project (or update existing), upload files, build
  book <name>    Create a book grouping existing docs (--members doc1,doc2,...)
  push [name]    Push source files, trigger rebuild
  watch [path]   Watch for changes, auto-push to server
  watch-all      Watch all projects (auto-detects new ones)
  listen <doc>   Block until feedback arrives, print JSON, exit
  monitor        Manage hook-based doc monitoring [add|remove|list|clear]
  agent          Manage the triage agent (Todd) [start|stop|status|log]
  open [name]    Open viewer in browser
  list           List projects
  status [name]  Show build status
  errors [name]  Show LaTeX errors/warnings from last build
  logs           Show server log (alias: tlda server logs)
  delete <name>  Delete a project (alias: rm)
  preview <name> [page ...]  Rasterize SVG pages to PNG
  publish [doc ...]  Publish docs to GitHub Pages + Fly
  completions    Output zsh completion script

The server auto-starts on first use. Explicit control: tlda server start/stop.

Options:
  --server <url>   Server URL (default: http://localhost:5176)
  --dir <path>     Source directory (default: .)
  --title "Title"  Document title (create only)
  --main file.tex  Main tex file (create only)

Config:
  tlda config set server <url>
  TLDA_SERVER=<url>`)
    }
  } catch (e) {
    console.error(red(`Error: ${e.message}`))
    process.exit(1)
  }
}

main()
