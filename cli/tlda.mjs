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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs'
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
  scratch: 'tlda scratch <file.md> [--title "Title"] [--book fleet-workspace]\n\n  Publish a scratch markdown file as a page in a book.\n  Creates a markdown project, pushes the file, and auto-joins the book.\n  Subsequent edits are auto-pushed by watch-all.\n\n  --title    Display title (default: first heading or filename)\n  --book     Book to join (default: fleet-workspace)',
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
  remotes: 'tlda remotes [doc]\n\n  Show remote access URLs (Tailscale, Funnel) with QR codes.\n  Checks server reachability, firewall status, and prints scannable URLs.\n\n  Optionally pass a doc name to include ?doc=NAME in the URLs.',
  server:  'tlda server [start|stop|status|log|install|uninstall] [--agent]\n\n  start      Start the server (auto-restarts via launchd if installed)\n  stop       Stop the server\n  status     Check if server is running\n  log        Show recent server log\n  install    Install launchd service (macOS)\n  uninstall  Remove launchd service\n\n  --agent    Start the triage agent alongside the server.\n             Equivalent to running `tlda agent start` separately.',
  publish: 'tlda publish [--target <name>] [doc ...]\n\n  Publish docs to GitHub Pages (+ optionally Fly).\n\n  With no args, publishes all docs in config.published using the "default" target.\n  With --target, uses the named target config (sync server, repo, etc.).\n  With doc names, publishes those and adds them to the list.\n\n  Config (targets in ~/.config/tlda/config.json):\n    targets.<name>.sync     — sync server WebSocket URL\n    targets.<name>.repo     — git remote for gh-pages (null = same repo)\n    targets.<name>.fly      — deploy to Fly (default: false)\n    targets.<name>.basePath — vite base path (default: /tlda/)',
  config:  'tlda config [set <key> <value> | get [key]]\n\n  Manage persistent configuration.\n  Example: tlda config set server http://myhost:5176',
}

// Flags that take a value (--flag value). All others are boolean.
const VALUE_FLAGS = new Set(['server', 'dir', 'title', 'main', 'debounce', 'token', 'members', 'format', 'session', 'target', 'timeout', 'id', 'book', 'worktree', 'port'])

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
const green  = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s
const red    = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s
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

async function cmdScratch() {
  const filePath = getPositional(0)
  if (!filePath) {
    console.error('Usage: tlda scratch <file.md> [--title "Title"] [--book fleet-workspace]')
    process.exit(1)
  }

  const absPath = resolve(filePath)
  if (!existsSync(absPath)) {
    console.error(red(`File not found: ${absPath}`))
    process.exit(1)
  }

  const fileName = basename(absPath)
  if (!fileName.endsWith('.md')) {
    console.error(red('File must be a .md markdown file.'))
    process.exit(1)
  }

  const dir = dirname(absPath)
  const stem = fileName.replace(/\.md$/, '')
  const name = `scratch-${stem}`
  const bookName = getFlag('book') || 'fleet-workspace'

  // Extract title from first heading if not provided
  let title = getFlag('title')
  if (!title) {
    const content = readFileSync(absPath, 'utf8')
    const headingMatch = content.match(/^#\s+(.+)$/m)
    title = headingMatch ? headingMatch[1].trim() : stem
  }

  console.log(dim(`  File: ${absPath}`))
  console.log(dim(`  Project: ${name}`))
  console.log(dim(`  Title: ${title}`))

  // Create or update markdown project
  try {
    await api('POST', '/api/projects', { name, title, mainFile: fileName, format: 'markdown', sourceDir: dir })
    console.log(green(`Created scratch project "${name}".`))
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`Project "${name}" exists, pushing update.`)
    } else {
      throw e
    }
  }

  // Push the file
  const content = readFileSync(absPath)
  const files = [{ path: fileName, content: content.toString('base64'), encoding: 'base64' }]
  await api('POST', `/api/projects/${name}/push`, { files, sourceDir: dir })
  console.log(green('Pushed.'))

  // Auto-join book
  try {
    await api('PATCH', `/api/projects/${bookName}/members`, { add: name })
    console.log(dim(`  Joined book "${bookName}"`))
  } catch (e) {
    console.log(dim(`  Book "${bookName}": ${e.message}`))
  }

  const server = getServer()
  console.log(`\nViewer: ${cyan(`${server}/?doc=${bookName}`)}`)
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

  const { startWatcher, installProcessHandlers } = await import('./lib/watcher.mjs')
  installProcessHandlers()
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
  const { startWatcher, installProcessHandlers } = await import('./lib/watcher.mjs')
  installProcessHandlers()

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
      if (p.archived) continue
      if (!p.sourceDir || !p.mainFile) continue
      if (!existsSync(p.sourceDir)) {
        console.log(`[watch-all] Skipping ${p.name}: ${p.sourceDir} not found`)
        continue
      }

      console.log(`[watch-all] Watching ${p.sourceDir} → ${p.name}`)
      const watcher = await startWatcher({
        dir: p.sourceDir, name: p.name, debounceMs, getServer, getToken,
        onFatalError: (err) => {
          console.error(`[watch-all] Dropping ${p.name}: ${err.message}`)
          watchers.delete(p.name)
        }
      })
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
  const agentId = getFlag('id') || process.env.AGENT_WIN || process.env.KITTY_WINDOW_ID
  if (!agentId) {
    console.error('No agent ID. Pass --id <name> (or set $AGENT_WIN).')
    process.exit(1)
  }
  const agentDir = `/tmp/tlda-listen-${agentId}`
  const watchFile = join(agentDir, 'docs')
  const stateDir = join(agentDir, 'state')

  function readDocs() {
    if (!existsSync(watchFile)) return []
    return readFileSync(watchFile, 'utf8').split('\n').filter(Boolean)
  }
  function writeDocs(docs) {
    mkdirSync(agentDir, { recursive: true })
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
    mkdirSync(agentDir, { recursive: true })
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
    console.log(dim(`Cleared all monitored docs (agent ${agentId})`))
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

async function cmdRemotes() {
  const { execSync } = await import('child_process')
  const config = loadConfig()
  const port = getPort()
  const readToken = config.tokenRead || null
  const doc = getPositional(0) || null

  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim() }
    catch { return null }
  }

  const check = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch { return false }
  }

  // Server running?
  const localOk = await check(`http://127.0.0.1:${port}/health`)
  if (!localOk) {
    console.error(red(`Server not responding on localhost:${port}`))
    console.error(dim('Run: tlda server start'))
    process.exit(1)
  }
  console.log(green(`Server running on port ${port}`))
  console.log()

  // Firewall check (macOS)
  if (process.platform === 'darwin') {
    const fwState = run('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate')
    if (fwState?.includes('State = 1')) {
      const nodePath = run('which node')
      if (nodePath) {
        const fwApps = run('/usr/libexec/ApplicationFirewall/socketfilterfw --listapps')
        if (fwApps?.includes(nodePath) && fwApps?.includes('Block incoming connections')) {
          // Find the block line that follows the node path
          const lines = fwApps.split('\n')
          const nodeIdx = lines.findIndex(l => l.includes(nodePath))
          if (nodeIdx >= 0 && lines[nodeIdx + 1]?.includes('Block incoming')) {
            console.log(red('macOS firewall is blocking Node.js incoming connections!'))
            console.log(dim(`Run: sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${nodePath}`))
            console.log()
          }
        }
      }
    }
  }

  const buildLoginUrl = (base) => {
    const redirect = doc ? `/?doc=${doc}` : '/'
    if (readToken) {
      return `${base}/auth/login?token=${readToken}&redirect=${encodeURIComponent(redirect)}`
    }
    return `${base}${redirect}`
  }

  const printQr = async (url) => {
    try {
      const qr = await import('qrcode-terminal')
      qr.default.generate(url, { small: true })
    } catch {
      console.log(dim('  (qrcode-terminal not available)'))
    }
  }

  const entries = []

  // Tailscale
  const tsIp = run('tailscale ip -4')
  if (tsIp) {
    const base = `http://${tsIp}:${port}`
    const url = buildLoginUrl(base)
    const ok = await check(`${base}/health`)
    entries.push({ label: 'Tailscale', url, ok })
  }

  // Funnel
  const funnelStatus = run('tailscale funnel status 2>&1')
  if (funnelStatus) {
    const urlMatch = funnelStatus.match(/https:\/\/\S+\.ts\.net/)
    if (urlMatch) {
      const base = urlMatch[0]
      const url = buildLoginUrl(base)
      const ok = await check(`${base}/health`)
      entries.push({ label: 'Funnel', url, ok })
    }
  }

  if (entries.length === 0) {
    console.log(dim('No remote access methods found.'))
    console.log(dim('Install Tailscale: https://tailscale.com'))
    return
  }

  for (const { label, url, ok } of entries) {
    const status = ok ? green('reachable') : red('unreachable')
    console.log(`${bold(label)} ${dim('—')} ${status}`)
    if (readToken) {
      console.log(dim('  Login URL (sets cookie, then redirects):'))
    }
    console.log(`  ${cyan(url)}`)
    console.log()
    if (ok) await printQr(url)
    console.log()
  }
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

async function cmdDoctor() {
  const { execSync, spawnSync } = await import('child_process')
  const ok  = (msg) => console.log(green('✓') + ' ' + msg)
  const fail = (msg, fix) => {
    console.log(red('✗') + ' ' + msg)
    if (fix) console.log('  ' + dim(fix))
  }
  const warn = (msg, fix) => {
    const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s
    console.log(yellow('!') + ' ' + msg)
    if (fix) console.log('  ' + dim(fix))
  }

  let issues = 0

  // 1. Node version
  const nodeVer = process.versions.node
  const [major] = nodeVer.split('.').map(Number)
  if (major >= 18) {
    ok(`Node ${nodeVer}`)
  } else {
    fail(`Node ${nodeVer} (need ≥18)`, 'brew install node')
    issues++
  }

  // 2. LaTeX tools
  const checkBin = (bin) => {
    try { execSync(`which ${bin}`, { stdio: 'pipe' }); return true } catch { return false }
  }
  if (checkBin('latexmk')) {
    ok('latexmk found')
  } else {
    fail('latexmk not found', 'brew install --cask mactex-no-gui  (or: brew install basictex)')
    issues++
  }
  if (checkBin('dvisvgm')) {
    ok('dvisvgm found')
  } else {
    fail('dvisvgm not found', 'Included in MacTeX. If using BasicTeX: tlmgr install dvisvgm')
    issues++
  }

  // 3. Server
  const serverUrl = getServer()
  let serverRunning = false
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) })
    serverRunning = res.ok
  } catch {}

  if (serverRunning) {
    ok(`Server running at ${serverUrl}`)
  } else {
    console.log(red('✗') + ' Server not running — starting it...')
    try {
      // Check launchd
      const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.tlda.server.plist')
      const hasLaunchd = process.platform === 'darwin' && existsSync(PLIST)
      if (hasLaunchd) {
        try { execSync('launchctl bootstrap gui/$(id -u) ' + PLIST, { stdio: 'pipe' }) } catch {}
        try { execSync('launchctl kickstart -k gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
      } else {
        const ctdRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
        const serverScript = join(ctdRoot, 'server', 'unified-server.mjs')
        const { spawn: cpSpawn } = await import('child_process')
        const { openSync: fsOpenSync } = await import('fs')
        const logFd = fsOpenSync(LOGFILE, 'a')
        const child = cpSpawn(process.execPath, [serverScript], {
          detached: true, stdio: ['ignore', logFd, logFd],
          env: { ...process.env, PORT: getPort() }
        })
        child.unref()
      }
      // Wait for it
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 500))
        try {
          const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1000) })
          if (res.ok) { serverRunning = true; break }
        } catch {}
      }
      if (serverRunning) {
        ok(`Server started at ${serverUrl}`)
      } else {
        fail('Server failed to start', `Check log: tlda server log`)
        issues++
      }
    } catch (e) {
      fail(`Server failed to start: ${e.message}`, 'tlda server log')
      issues++
    }
  }

  // 3b. SPA serves pages (not just health endpoint)
  if (serverRunning) {
    const token = getToken()
    const tokenParam = token ? `?token=${token}` : ''
    try {
      const res = await fetch(`${serverUrl}/${tokenParam}`, { signal: AbortSignal.timeout(5000) })
      const body = await res.text()
      if (res.ok && body.includes('<div id="root">')) {
        ok('SPA serves pages')
      } else if (res.status === 404 || !body.includes('<div id="root">')) {
        fail('SPA not serving — bundle may be missing or stale', 'npm run build')
        issues++
      } else {
        fail(`SPA returned ${res.status}`)
        issues++
      }
    } catch (e) {
      fail(`SPA check failed: ${e.message}`)
      issues++
    }
  }

  // 3c. Bundle freshness — is dist/ newer than latest source commit?
  {
    const ctdRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const distIndex = join(ctdRoot, 'dist', 'index.html')
    if (existsSync(distIndex)) {
      const distMtime = statSync(distIndex).mtimeMs
      try {
        const { execSync: ex } = await import('child_process')
        const commitTs = parseInt(ex('git log -1 --format=%ct -- src/ vite.config.ts index.html package.json', { cwd: ctdRoot, stdio: 'pipe' }).toString().trim(), 10) * 1000
        if (distMtime >= commitTs) {
          ok('Bundle is current')
        } else {
          const agoMin = Math.round((Date.now() - distMtime) / 60000)
          warn(`Bundle is stale (built ${agoMin}m ago, source changed since)`, 'npm run build')
        }
      } catch {
        ok('Bundle exists (freshness check skipped — no git)')
      }
    } else {
      fail('No built bundle (dist/index.html missing)', 'npm run build')
      issues++
    }
  }

  // 4. launchd (auto-restart on login)
  {
    const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.tlda.server.plist')
    if (existsSync(PLIST)) {
      ok('launchd service installed (server auto-restarts)')
    } else {
      warn('launchd service not installed (server won\'t restart after a crash or login)', 'tlda server install')
    }
  }

  // 5. Watch-all
  let watchRunning = false
  if (existsSync(WATCH_ALL_PIDFILE)) {
    const pid = parseInt(readFileSync(WATCH_ALL_PIDFILE, 'utf8').trim(), 10)
    try { process.kill(pid, 0); watchRunning = true } catch {}
  }
  if (watchRunning) {
    ok('watch-all running')
  } else {
    console.log(red('✗') + ' watch-all not running — starting it...')
    try {
      const ctdScript = fileURLToPath(import.meta.url)
      const { spawn: cpSpawn } = await import('child_process')
      const { openSync: fsOpenSync } = await import('fs')
      if (!existsSync(dirname(WATCH_ALL_LOGFILE))) mkdirSync(dirname(WATCH_ALL_LOGFILE), { recursive: true })
      const logFd = fsOpenSync(WATCH_ALL_LOGFILE, 'a')
      const child = cpSpawn(process.execPath, [ctdScript, 'watch-all', 'run'], {
        detached: true, stdio: ['ignore', logFd, logFd]
      })
      child.unref()
      await new Promise(r => setTimeout(r, 1000))
      if (existsSync(WATCH_ALL_PIDFILE)) {
        ok('watch-all started')
      } else {
        fail('watch-all failed to start', `Check log: tlda watch-all log`)
        issues++
      }
    } catch (e) {
      fail(`watch-all failed to start: ${e.message}`, 'tlda watch-all log')
      issues++
    }
  }

  // 6. MCP server configured
  {
    const mcpConfigs = [
      join(homedir(), '.claude', 'settings.json'),
      join(homedir(), '.config', 'claude', 'settings.json'),
      // project-level .mcp.json — look up from cwd
      join(process.cwd(), '.mcp.json'),
    ]
    const ctdRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const mcpEntry = join(ctdRoot, 'mcp-server', 'index.mjs')

    let mcpFound = false
    for (const cfgPath of mcpConfigs) {
      if (!existsSync(cfgPath)) continue
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
        const servers = cfg.mcpServers || {}
        for (const s of Object.values(servers)) {
          const args = s.args || []
          if (args.some(a => String(a).includes('mcp-server'))) {
            mcpFound = true; break
          }
        }
      } catch {}
      if (mcpFound) break
    }

    if (mcpFound) {
      ok('MCP server configured in Claude settings')
    } else {
      fail('MCP server not found in Claude settings')
      console.log()
      console.log('  Add this to your project .mcp.json or ~/.claude/settings.json:')
      console.log()
      console.log('  ' + cyan(JSON.stringify({
        mcpServers: {
          'tldraw-feedback': {
            type: 'stdio',
            command: process.execPath,
            args: [mcpEntry],
            env: { TLDA_SERVER: serverUrl }
          }
        }
      }, null, 2).split('\n').join('\n  ')))
      console.log()
      issues++
    }
  }

  // 7. Projects with build errors (only if server is running)
  if (serverRunning) {
    try {
      const data = await api('GET', '/api/projects', null, { timeoutMs: 5000 })
      const errored = (data.projects || []).filter(p => p.buildStatus === 'error')
      if (errored.length === 0) {
        ok('No projects with build errors')
      } else {
        for (const p of errored) {
          fail(`Project "${p.name}" has build errors`, `tlda errors ${p.name}`)
          issues++
        }
      }
    } catch {}
  }

  // 8. Fleet server
  {
    const fleetUrl = process.env.FLEET_SERVER || 'http://localhost:5199'
    try {
      const res = await fetch(`${fleetUrl}/api/state`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const data = await res.json()
        const agentCount = (data.agents || []).filter(a => !a.dead && !a.human).length
        ok(`Fleet server running at ${fleetUrl} (${agentCount} active agents)`)
      } else {
        fail(`Fleet server returned ${res.status}`, 'Check fleet server logs')
        issues++
      }
    } catch {
      fail(`Fleet server not reachable at ${fleetUrl}`)
      issues++
    }
  }

  // 9. Sync health (docs with broken sync stores)
  if (serverRunning) {
    try {
      const health = await api('GET', '/api/projects/health', null, { timeoutMs: 5000 })
      const broken = Object.entries(health).filter(([, v]) => !v.ok)
      if (broken.length === 0) {
        ok('All doc sync stores healthy')
      } else {
        for (const [name, info] of broken) {
          fail(`Doc "${name}" sync broken: ${info.error}`, `POST /api/projects/${name}/sync/clear`)
          issues++
        }
      }
    } catch {}
  }

  console.log()
  if (issues === 0) {
    console.log(green(bold('All checks passed.')))
  } else {
    console.log(red(bold(`${issues} issue${issues === 1 ? '' : 's'} found.`)))
    process.exit(1)
  }
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

// --- Whisper server management ---

const WHISPER_PID_FILE = join(homedir(), '.config', 'tlda', 'whisper.pid')
const WHISPER_LOG_FILE = join(homedir(), '.config', 'tlda', 'whisper.log')
const WHISPER_MODEL = join(homedir(), '.local', 'share', 'whisper-cpp', 'models', 'ggml-small.en.bin')
const WHISPER_PORT = 8178

async function cmdWhisper() {
  const sub = getPositional(0) || 'start'
  const { execSync, spawn } = await import('child_process')

  function readWhisperPid() {
    try { return parseInt(readFileSync(WHISPER_PID_FILE, 'utf8').trim()) } catch { return null }
  }

  function isWhisperRunning() {
    const pid = readWhisperPid()
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  if (sub === 'start') {
    if (isWhisperRunning()) {
      console.log(green('Whisper server already running') + ` (pid ${readWhisperPid()}, port ${WHISPER_PORT})`)
      return
    }

    // Check binary
    let whisperBin
    try { whisperBin = execSync('which whisper-server', { stdio: 'pipe' }).toString().trim() } catch {
      console.error(red('whisper-server not found. Install with: brew install whisper-cpp'))
      process.exit(1)
    }

    // Check model
    if (!existsSync(WHISPER_MODEL)) {
      console.error(red(`Model not found: ${WHISPER_MODEL}`))
      console.error('Download with:')
      console.error(`  mkdir -p ~/.local/share/whisper-cpp/models`)
      console.error(`  curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" -o "${WHISPER_MODEL}"`)
      process.exit(1)
    }

    const logFd = (await import('fs')).openSync(WHISPER_LOG_FILE, 'a')
    const child = spawn(whisperBin, [
      '-m', WHISPER_MODEL,
      '--port', String(WHISPER_PORT),
      '--convert',
    ], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    writeFileSync(WHISPER_PID_FILE, String(child.pid))
    // Wait for server to be ready
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          console.log(green('Whisper server started') + ` (pid ${child.pid}, port ${WHISPER_PORT}, model: small.en)`)
          return
        }
      } catch {}
    }
    console.log(yellow('Whisper server spawned') + ` (pid ${child.pid}) — model loading may take a moment`)
  } else if (sub === 'stop') {
    const pid = readWhisperPid()
    if (pid && isWhisperRunning()) {
      process.kill(pid, 'SIGTERM')
      try { unlinkSync(WHISPER_PID_FILE) } catch {}
      console.log(green('Whisper server stopped'))
    } else {
      console.log('Whisper server not running')
      try { unlinkSync(WHISPER_PID_FILE) } catch {}
    }
  } else if (sub === 'status') {
    if (isWhisperRunning()) {
      console.log(green('running') + ` (pid ${readWhisperPid()}, port ${WHISPER_PORT})`)
    } else {
      console.log('not running')
    }
  } else if (sub === 'log') {
    if (existsSync(WHISPER_LOG_FILE)) {
      const { execSync: exec } = await import('child_process')
      process.stdout.write(exec(`tail -30 "${WHISPER_LOG_FILE}"`, { encoding: 'utf8' }))
    } else {
      console.log('No whisper log file')
    }
  } else {
    console.log('Usage: tlda whisper [start|stop|status|log]')
  }
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

// --- Fleet dev setup ---

async function cmdFleetDev() {
  const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'projects', 'fleet-dev', 'sync-snapshot.json')
  const projectPath = join(dirname(snapshotPath), 'project.json')

  if (!existsSync(projectPath)) {
    console.error('fleet-dev project not found. Run from the tlda repo root.')
    process.exit(1)
  }

  // Reset sync snapshot to known-good test state
  const snapshot = {
    tombstoneHistoryStartsAtClock: 0,
    documentClock: 100,
    documents: [
      // Blank page (800x1035, standard SVG page size)
      rec('shape:fleet-dev-page-0', 'svg-page', 0, 0, { w: 800, h: 1035, pageIndex: 0 }, 'a1', true),
      // Agents panel — right of page
      rec('shape:fleet-dev-agents', 'fleet-agents', 860, 0, { w: 340, h: 400 }, 'a2'),
      // Chat with multi-clause filter: (to:alice AND from:bob) OR (to:carol)
      rec('shape:fleet-dev-chat-filtered', 'fleet-chat', 860, 420, {
        w: 400, h: 600,
        filter: [[['to', 'fleet:alice'], ['from', 'fleet:bob']], [['to', 'fleet:carol']]],
      }, 'a3'),
      // Chat with no filter
      rec('shape:fleet-dev-chat-empty', 'fleet-chat', 1280, 420, { w: 400, h: 600, filter: [] }, 'a4'),
      // Search
      rec('shape:fleet-dev-search', 'fleet-search', 1280, 0, { w: 380, h: 400 }, 'a5'),
    ],
  }
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
  console.log(green('Reset fleet-dev sync snapshot.'))

  // Restart server so it loads the fresh snapshot
  console.log(dim('  Restarting server...'))
  try {
    await api('POST', '/api/admin/restart', {})
  } catch {
    // Server may not have this endpoint — manual restart
  }
  console.log(dim('  If shapes look stale: tlda server stop && tlda server start'))

  const server = getServer()
  console.log(`\n  ${server}/?doc=fleet-dev\n`)
  console.log(dim('  Click the page in TOC to zoom to the fleet shapes area.'))

  function rec(id, type, x, y, props, index, locked = false) {
    return {
      state: { id, type, typeName: 'shape', x, y, rotation: 0, isLocked: locked, opacity: 1, meta: {}, props, parentId: 'page:page', index },
      lastChangedClock: parseInt(id.replace(/\D/g, '').slice(-1)) || 1,
    }
  }
}

// --- Dev worktree setup ---

async function findFreePort(startPort) {
  const net = await import('net')
  return new Promise((resolve) => {
    const server = net.default.createServer()
    server.listen(startPort, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', () => resolve(findFreePort(startPort + 1)))
  })
}

async function cmdDev() {
  const { execSync, spawn } = await import('child_process')
  const { openSync: fsOpenSync } = await import('fs')

  const worktreeName = getFlag('worktree')
  const portArg = getFlag('port')

  // Find main repo root (works whether we're in a worktree or the main repo).
  // git rev-parse --git-common-dir returns the shared .git dir — parent is the main repo.
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  let repoRoot
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd: scriptDir, stdio: 'pipe' }).toString().trim()
    // In main repo: '.git' (relative). In worktree: absolute path like /path/to/repo/.git
    repoRoot = gitCommonDir === '.git'
      ? join(scriptDir, '..')
      : dirname(gitCommonDir)
  } catch {
    repoRoot = join(scriptDir, '..')
  }

  let worktreeDir = repoRoot  // default: current repo if no --worktree
  if (worktreeName) {
    worktreeDir = join(repoRoot, '.worktrees', worktreeName)

    if (!existsSync(worktreeDir)) {
      console.log(dim(`Creating worktree .worktrees/${worktreeName}...`))
      try {
        execSync(`git worktree add -b "${worktreeName}" ".worktrees/${worktreeName}"`, {
          cwd: repoRoot,
          stdio: 'pipe',
        })
      } catch (e1) {
        // Branch already exists — check it out without -b
        try {
          execSync(`git worktree add ".worktrees/${worktreeName}" "${worktreeName}"`, {
            cwd: repoRoot,
            stdio: 'pipe',
          })
        } catch (e2) {
          throw new Error(`Failed to create worktree: ${e2.message}`)
        }
      }
      console.log(green(`Worktree created: ${worktreeDir}`))
    } else {
      console.log(dim(`Using existing worktree: ${worktreeDir}`))
    }
  }

  // npm install if needed (--ignore-scripts skips `prepare` vite build)
  if (!existsSync(join(worktreeDir, 'node_modules'))) {
    console.log(dim('Running npm install...'))
    execSync('npm install --ignore-scripts', { cwd: worktreeDir, stdio: 'inherit' })
  }

  // Pick port
  const port = portArg ? parseInt(portArg) : await findFreePort(5180)

  // Start Vite in background
  const viteLogFile = join(worktreeDir, '.dev-vite.log')
  const logFd = fsOpenSync(viteLogFile, 'a')

  const viteChild = spawn('npx', ['vite', '--port', String(port)], {
    cwd: worktreeDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  viteChild.unref()

  console.log(dim(`Vite starting on port ${port} (pid ${viteChild.pid})...`))

  // Wait for Vite to be ready (poll up to 30s)
  let ready = false
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) })
      if (res.ok || res.status === 404) { ready = true; break }
    } catch {}
  }

  if (!ready) {
    throw new Error(`Vite failed to start on port ${port} within 30s. Check log: ${viteLogFile}`)
  }

  // Write .dev-url
  const token = getToken()
  const url = token
    ? `http://localhost:${port}/?token=${token}`
    : `http://localhost:${port}/`
  const devUrlPath = join(worktreeDir, '.dev-url')
  writeFileSync(devUrlPath, url)

  // Print summary
  console.log(green(`\nVite dev server ready`))
  if (worktreeName) console.log(`  Worktree: ${worktreeDir}`)
  console.log(`  Port:     ${port}`)
  console.log(`  PID:      ${viteChild.pid}`)
  console.log(`  Log:      ${viteLogFile}`)
  console.log(bold(`\n  ${url}\n`))
}

async function cmdDevUrl() {
  const portArg = getFlag('port')
  const port = portArg ? parseInt(portArg) : 5180
  const token = getToken()
  const url = token
    ? `http://localhost:${port}/?token=${token}`
    : `http://localhost:${port}/`
  console.log(url)
}

// --- Main ---

async function main() {
  try {
    switch (command) {
      case 'server': await cmdServer(); break
      case 'scratch': await ensureServer(); await cmdScratch(); break
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
      case 'remotes': await cmdRemotes(); break
      case 'config': await cmdConfig(); break
      case 'fleet-dev': await ensureServer(); await cmdFleetDev(); break
      case 'dev': await cmdDev(); break
      case 'dev-url': await cmdDevUrl(); break
      case 'whisper': await cmdWhisper(); break
      case 'doctor': await cmdDoctor(); break
      default:
        console.log(`tlda — tlda CLI

Commands:
  server [start|stop|status|log|install|uninstall]  Manage the server
  create <name>  Create project (or update existing), upload files, build
  scratch <file> Publish scratch .md to fleet-workspace book
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
  remotes [doc]    Show Tailscale/Funnel URLs with QR codes
  publish [doc ...]  Publish docs to GitHub Pages + Fly
  whisper        Manage local whisper speech server [start|stop|status|log]
  doctor         Check and fix common setup issues
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
