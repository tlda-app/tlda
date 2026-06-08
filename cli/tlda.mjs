#!/usr/bin/env node
/**
 * tlda — tlda CLI.
 *
 * Commands:
 *   tlda doc create <name> [--title "Title"] [--dir /path] [--main main.tex]
 *   tlda doc push [name] [--dir /path]
 *   tlda daemon [/path/to/main.tex] [name]
 *   tlda daemon
 *   tlda doc open [name]
 *   tlda doc list
 *   tlda doc status [name]
 *   tlda config set server <url>
 *
 * Server URL resolution:
 *   TLDA_SERVER env → --server flag → ~/.config/tlda/config.json → <proto>://localhost:5176
 *   (<proto> = https when the mkcert certs exist, else http — see getServerUrl in shared/config.mjs)
 */

import { resolve, basename, dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { collectSourceFiles, collectSourceHashes, collectSpecificFiles } from './lib/source-files.mjs'
import {
  loadConfig, saveConfig, getServerUrl, getRwToken, DEFAULT_PORT,
  CONFIG_DIR, CONFIG_FILE, hasTls, TLS_CA_PATH, getManagedBots,
} from '../shared/config.mjs'
import { tldaFetch } from '../shared/http-client.mjs'
import { cmdLogs } from './lib/unified-logs.mjs'

// --- Argument parsing ---

// Noun routing. The CLI is organized under nouns (server / doc / agent / config).
// `tlda doc <sub> …` and `tlda config <sub> …` forward transparently to the
// sub's handler by splicing the noun out of argv, so every existing handler runs
// unchanged. (server/agent self-dispatch and aren't spliced; `doctor` and `logs`
// are their own top-level commands.) Flat forms still work for now so the
// feedback hook etc. don't break, but `--help` only advertises the nouns.
const DOC_SUBS = new Set([
  'create', 'open', 'push', 'list', 'ls', 'status', 'errors', 'preview',
  'delete', 'rm', 'share', 'publish', 'scratch', 'book',
  'repo-doctor', 'init-shadow',
])
const CONFIG_SUBS = new Set(['setup', 'mcp-setup', 'auth'])  // config subs that map to existing handlers
let _nounUsed = null
{
  const noun = process.argv[2]
  const sub = process.argv[3]
  if (noun === 'doc' && sub && DOC_SUBS.has(sub)) { process.argv.splice(2, 1); _nounUsed = 'doc' }
  else if (noun === 'config' && sub && CONFIG_SUBS.has(sub)) { process.argv.splice(2, 1); _nounUsed = 'config' }
}

const args = process.argv.slice(2)
const command = args[0]

// Noun-only: a command lives under its noun, not flat. No back-compat aliases —
// reject the bare form and point at the noun. (Docs/callers use the noun forms.)
{
  const REDIRECT = { watch: 'daemon', 'watch-all': 'daemon', spawn: 'agent spawn', attach: 'agent attach' }
  if (!_nounUsed && command) {
    if (DOC_SUBS.has(command)) { console.error(`\`tlda ${command}\` moved — use: tlda doc ${command}`); process.exit(1) }
    if (CONFIG_SUBS.has(command)) { console.error(`\`tlda ${command}\` moved — use: tlda config ${command}`); process.exit(1) }
    if (REDIRECT[command]) { console.error(`\`tlda ${command}\` moved — use: tlda ${REDIRECT[command]}`); process.exit(1) }
  }
}

// Per-command help (shown with --help)
const COMMAND_HELP = {
  scratch: 'tlda doc scratch <file.md> [--title "Title"] [--book fleet-workspace]\n\n  Publish a scratch markdown file as a page in a book.\n  Creates a markdown project, pushes the file, and auto-joins the book.\n  Subsequent edits are auto-pushed by watch-all.\n\n  --title    Display title (default: first heading or filename)\n  --book     Book to join (default: fleet-workspace)',
  book:    'tlda doc book <name> --members doc1,doc2,doc3,...\n\n  Create a book that groups existing documents together.\n  Each member keeps its own sync room and annotations.\n  The viewer shows one member at a time with a tab bar to switch.',
  create:  'tlda doc create <name> [--title "Title"] [--dir /path] [--main main.tex] [--format slides|html|markdown]\n\n  Create a project and push source files. If the project already exists,\n  pushes files and triggers a rebuild.\n\n  Formats:\n    (default)  LaTeX → SVG pipeline (latexmk → dvisvgm)\n    slides     Reveal.js HTML (from Quarto revealjs or manual)\n    html       Multipage HTML chapters (from Quarto book render)\n    markdown   Markdown with KaTeX math → HTML',
  push:    'tlda doc push [name] [--dir /path]\n\n  Push source files to the server and trigger a rebuild.\n  Project name is inferred from the current directory if omitted.',
  watch:   'tlda daemon [start|stop|status|log|run]\n\n  Control the per-machine fleet-daemon (bin/fleet-daemon.mjs).\n  The daemon watches Claude Code session JSONLs and project source\n  dirs locally, pushing events to the tlda server over WebSocket.',
  'watch-all': 'tlda daemon [start|stop|status|log|run]\n\n  Alias for `tlda daemon start/stop/status/log/run` — runs the\n  per-machine fleet-daemon (bin/fleet-daemon.mjs), which watches\n  every project source dir AND every Claude Code session JSONL\n  on this machine and pushes events to the tlda server over WebSocket.',
  open:    'tlda doc open [name]\n\n  Open the viewer in the default browser (RW token = presenter privilege).',
  share:   'tlda doc share [name]\n\n  Print a viewer URL with the read-only token.\n  Recipients can annotate but cannot present.',
  status:  'tlda doc status [name]\n\n  Show build status for a project.',
  errors:  'tlda doc errors [name] [--wait]\n\n  Extract LaTeX errors and warnings from the last build log.\n  With --wait (-w), blocks until the current build finishes.',
  build:   'tlda build [name]\n\n  Trigger a rebuild without pushing files.\n\n  NOTE: Prefer the watcher pipeline. This command bypasses change\n  detection and should only be used for debugging.',
  delete:  'tlda doc delete <name>\n\n  Delete a project and all its data.',
  preview: 'tlda doc preview <name> [page ...]\n\n  Rasterize SVG pages to PNG for visual inspection.\n  Outputs paths to /tmp/tlda-preview-{name}/.',
  logs:    'tlda logs [agent] [--since 1h|2026-05-23] [--type chat,register] [-n 50] [-f] [--daemon] [--all]\n\n  Unified chronological log across all sources (DB events, daemon log, dead-letters).\n\n  agent      Filter by agent name (fuzzy match)\n  --since    Time range (e.g. 1h, 30m, 2d, or ISO date)\n  --type     Filter by event type (comma-separated)\n  -n N       Number of events (default: 50, or 10000 with --since)\n  -f         Follow mode (tail -f style)\n  --daemon   Include daemon log lines (heartbeats, WS, terminal exits)\n  --all      Include activity and client_error events (excluded by default)',
  server:  'tlda server [start|stop|status|log|install|uninstall]\n\n  start      Start the server (auto-restarts via launchd if installed)\n  stop       Stop the server\n  status     Check if server is running\n  log        Show recent server log\n  install    Install launchd service (macOS)\n  uninstall  Remove launchd service',
  publish: 'tlda publish [--target <name>] [doc ...]\n\n  Publish docs to GitHub Pages (+ optionally Fly).\n\n  With no args, publishes all docs in config.published using the "default" target.\n  With --target, uses the named target config (sync server, repo, etc.).\n  With doc names, publishes those and adds them to the list.\n\n  Config (targets in ~/.config/tlda/config.json):\n    targets.<name>.sync     — sync server WebSocket URL\n    targets.<name>.repo     — git remote for gh-pages (null = same repo)\n    targets.<name>.fly      — deploy to Fly (default: false)\n    targets.<name>.basePath — vite base path (default: /tlda/)',
  config:  'tlda config [set <key> <value> | get [key]]\n\n  Manage persistent configuration.\n  Example: tlda config set server http://myhost:5176',
}

// Flags that take a value (--flag value). All others are boolean.
const VALUE_FLAGS = new Set(['server', 'dir', 'title', 'main', 'debounce', 'token', 'members', 'format', 'session', 'target', 'timeout', 'id', 'book', 'worktree', 'port', 'browser'])

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
  return getFlag('server') || getServerUrl()
}

function getToken() {
  return getFlag('token') || getRwToken()
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
  return tldaFetch(path, {
    method, body, timeoutMs,
    server: getServer(),
    token: getToken(),
  })
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
    console.error('Usage: tlda doc book <name> --members doc1,doc2,doc3,...')
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
    console.error('Usage: tlda doc scratch <file.md> [--title "Title"] [--book fleet-workspace]')
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
  if (!name) { console.error('Usage: tlda doc create <name> [--title "Title"] [--dir /path] [--main main.tex] [--format slides|html]'); process.exit(1) }

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

    // Push just the main file as a build trigger — the server reads from
    // sourceDir directly, so we don't need to send the whole directory.
    const content = readFileSync(join(dir, mainFile))
    const files = [{ path: mainFile, content: content.toString('base64'), encoding: 'base64' }]

    console.log(`Pushing ${mainFile}...`)
    await api('POST', `/api/projects/${name}/push`, { files, sourceDir: dir })
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
  if (!name) { console.error('Usage: tlda doc push [name] [--dir /path]'); process.exit(1) }

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

// Fleet-daemon control: `tlda daemon start | stop | status | log | run`
//
// The fleet-daemon is the per-machine local agent that owns JSONL
// watching, terminal-chat extraction, and document source watching for
// the tlda hub server. See bin/fleet-daemon.mjs and the spec at
// scratch/fleet-daemon-spec.md for the full picture.
//
// This command coexists with the older `tlda daemon <path>` per-project
// shorthand and `tlda daemon start` — Phase 1 doesn't deprecate
// either. If the first positional is start/stop/status/log/run we
// route here, otherwise we fall through to the existing watcher.
const FLEET_DAEMON_LOGFILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.log')
const FLEET_DAEMON_PIDFILE = join(homedir(), '.config', 'tlda', 'fleet-daemon.pid')
const _cliDir = dirname(fileURLToPath(import.meta.url))
const _cliWorktreeMatch = _cliDir.match(/^(.+?)\/\.claude\/worktrees\//)
const FLEET_DAEMON_SCRIPT = _cliWorktreeMatch
  ? join(_cliWorktreeMatch[1], 'bin', 'fleet-daemon.mjs')
  : join(_cliDir, '..', 'bin', 'fleet-daemon.mjs')
const _cliRepoRoot = _cliWorktreeMatch ? _cliWorktreeMatch[1] : join(_cliDir, '..')
function resolveBotScript(script) {
  return script.startsWith('/') ? script : join(_cliRepoRoot, script)
}

// Idempotent daemon start — no-op if already running, spawns if not.
// Used by `tlda server start` to make sure the daemon comes up alongside
// the server. The daemon dying silently was a recurring source of pain.
async function ensureFleetDaemonRunning() {
  // Already running?
  if (existsSync(FLEET_DAEMON_PIDFILE)) {
    const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
    try { process.kill(pid, 0); return } catch {} // stale pid → fall through
  }
  const daemonScript = FLEET_DAEMON_SCRIPT
  if (!existsSync(daemonScript)) return // not installed; silently skip
  const { spawn: cpSpawn } = await import('child_process')
  const { openSync: fsOpenSync } = await import('fs')
  if (!existsSync(dirname(FLEET_DAEMON_LOGFILE))) mkdirSync(dirname(FLEET_DAEMON_LOGFILE), { recursive: true })
  const logFd = fsOpenSync(FLEET_DAEMON_LOGFILE, 'a')
  const child = cpSpawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(hasTls && !process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: TLS_CA_PATH } : {}) },
  })
  child.unref()
  await new Promise(r => setTimeout(r, 800))
  if (existsSync(FLEET_DAEMON_PIDFILE)) {
    const pid = readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim()
    console.log(green('Fleet daemon started') + dim(` (pid ${pid})`))
  } else {
    console.log(dim('Fleet daemon failed to start — see ' + FLEET_DAEMON_LOGFILE))
  }
}

// Start each configured bot (the shipped example is Todd). Mirrors the server's
// managed-bot supervisor; the server keeps them alive thereafter. The supervisor
// owns the pidfile/log location and passes them to the bot via env.
async function ensureManagedBotsRunning() {
  const { spawn: cpSpawn } = await import('child_process')
  const { openSync: fsOpenSync } = await import('fs')
  for (const spec of getManagedBots()) {
    if (!spec?.name || !spec.script) continue
    const pidFile = join(homedir(), '.config', 'tlda', `${spec.name}.pid`)
    const logFile = join(homedir(), '.config', 'tlda', `${spec.name}.log`)
    const scriptPath = resolveBotScript(spec.script)
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      try { process.kill(pid, 0); continue } catch {} // stale pid → fall through
    }
    if (!existsSync(scriptPath)) continue // not installed; silently skip
    if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })
    const logFd = fsOpenSync(logFile, 'a')
    const child = cpSpawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, TLDA_BOT_NAME: spec.name, TLDA_BOT_PIDFILE: pidFile },
    })
    child.unref()
    await new Promise(r => setTimeout(r, 800))
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim()
      console.log(green(`${spec.name} started`) + dim(` (pid ${pid})`))
    } else {
      console.log(dim(`${spec.name} failed to start — see ` + logFile))
    }
  }
}

async function cmdFleetWatch(sub) {
  const daemonScript = FLEET_DAEMON_SCRIPT

  if (sub === 'stop') {
    if (existsSync(FLEET_DAEMON_PIDFILE)) {
      const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
      try { process.kill(pid, 'SIGTERM') } catch {}
      try { unlinkSync(FLEET_DAEMON_PIDFILE) } catch {}
    }
    console.log(green('Fleet daemon stopped.'))
    return
  }

  if (sub === 'status') {
    if (existsSync(FLEET_DAEMON_PIDFILE)) {
      const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
      try {
        process.kill(pid, 0)
        console.log(green('Fleet daemon running') + dim(` (pid ${pid})`))
        console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
        return
      } catch {}
    }
    console.log(red('Fleet daemon not running.'))
    return
  }

  if (sub === 'log' || sub === 'logs') {
    if (existsSync(FLEET_DAEMON_LOGFILE)) {
      const { execSync } = await import('child_process')
      execSync(`tail -50 "${FLEET_DAEMON_LOGFILE}"`, { stdio: 'inherit' })
    } else {
      console.log('No fleet daemon log.')
    }
    return
  }

  if (sub === 'run') {
    // Foreground — exec the daemon directly so SIGINT etc. work normally.
    const { spawn: cpSpawn } = await import('child_process')
    const child = cpSpawn(process.execPath, [daemonScript], { stdio: 'inherit', env: { ...process.env, ...(hasTls && !process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: TLS_CA_PATH } : {}) } })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  if (sub === 'start') {
    // Already running?
    if (existsSync(FLEET_DAEMON_PIDFILE)) {
      const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
      try {
        process.kill(pid, 0)
        console.log('Fleet daemon already running' + dim(` (pid ${pid})`))
        return
      } catch {} // stale pid
    }

    if (!existsSync(daemonScript)) {
      console.error(red(`Daemon script not found: ${daemonScript}`))
      process.exit(1)
    }

    const { spawn: cpSpawn } = await import('child_process')
    const { openSync: fsOpenSync } = await import('fs')

    if (!existsSync(dirname(FLEET_DAEMON_LOGFILE))) mkdirSync(dirname(FLEET_DAEMON_LOGFILE), { recursive: true })
    const logFd = fsOpenSync(FLEET_DAEMON_LOGFILE, 'a')

    const child = cpSpawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    })
    child.unref()

    // Daemon writes its own PID file. Wait briefly to confirm.
    await new Promise(r => setTimeout(r, 800))
    if (existsSync(FLEET_DAEMON_PIDFILE)) {
      const pid = readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim()
      console.log(green(`Fleet daemon started`) + dim(` (pid ${pid})`))
      console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
    } else {
      console.error(red('Fleet daemon failed to start within 800ms'))
      console.error(dim(`Check log: ${FLEET_DAEMON_LOGFILE}`))
      process.exit(1)
    }
    return
  }

  console.error(`Unknown subcommand: tlda daemon ${sub}`)
  console.error('Usage: tlda daemon [start|stop|status|log|run]')
  process.exit(1)
}

async function cmdWatch() {
  const arg1 = getPositional(0)

  // Fleet-daemon dispatch — `tlda daemon start/stop/status/log/run`
  if (arg1 === 'start' || arg1 === 'stop' || arg1 === 'status' || arg1 === 'log' || arg1 === 'logs' || arg1 === 'run') {
    return cmdFleetWatch(arg1)
  }

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
    console.error(`  Run \`tlda doc create ${name}\` first, or did you mean \`tlda daemon start\`?`)
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

// `tlda daemon` is now an alias for `tlda daemon start/stop/status` —
// the per-machine fleet-daemon watches every project's source dir AND
// every Claude Code session JSONL. The legacy multi-watcher process
// (one Node per project, HTTP push, no JSONL handling) is gone.
async function cmdWatchAll() {
  const sub = getPositional(0) || 'start'
  return cmdFleetWatch(sub)
}


async function cmdOpen() {
  const name = getPositional(0) || await inferProjectName()
  const server = getServer()
  const token = getToken()
  const browser = getFlag('browser') || loadConfig().browser || null
  const redirect = name ? `/?doc=${name}` : '/'
  const url = token
    ? `${server}/auth/login?token=${token}&redirect=${encodeURIComponent(redirect)}`
    : `${server}${redirect}`
  console.log(`Opening ${server}${redirect}`)

  const { execFile } = await import('child_process')
  if (browser) {
    execFile('open', ['-a', browser, url])
  } else {
    execFile('open', [url])
  }
}

async function cmdShare() {
  const { execSync } = await import('child_process')
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: tlda doc share [name]'); process.exit(1) }

  const config = loadConfig()
  const port = getPort()
  const readToken = config.tokenRead || null

  if (!readToken) {
    console.error('No read token configured. Run `tlda config auth init` to generate tokens.')
    process.exit(1)
  }

  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim() }
    catch { return null }
  }

  const makeUrl = (base) => {
    const redirect = `/?doc=${name}`
    return `${base}/auth/login?token=${readToken}&redirect=${encodeURIComponent(redirect)}`
  }

  const printQr = async (url) => {
    try {
      const qr = await import('qrcode-terminal')
      qr.default.generate(url, { small: true })
    } catch {}
  }

  // Try Funnel (public HTTPS) first, then Tailscale, then localhost
  const funnelStatus = run('tailscale funnel status 2>&1')
  const funnelMatch = funnelStatus?.match(/https:\/\/\S+\.ts\.net/)
  if (funnelMatch) {
    const url = makeUrl(funnelMatch[0])
    console.log(`${bold('Funnel')} (public)`)
    console.log(`  ${cyan(url)}`)
    console.log()
    await printQr(url)
    return
  }

  const tsIp = run('tailscale ip -4')
  if (tsIp) {
    const url = makeUrl(`http://${tsIp}:${port}`)
    console.log(`${bold('Tailscale')}`)
    console.log(`  ${cyan(url)}`)
    console.log()
    await printQr(url)
    return
  }

  // Localhost fallback
  const proto = hasTls ? 'https' : 'http'
  const url = `${proto}://localhost:${port}/?doc=${name}&token=${readToken}`
  console.log(`${bold('Local')} ${dim('(not reachable from other devices)')}`)
  console.log(`  ${cyan(url)}`)
  console.log()
  console.log(dim('To share over the network: install Tailscale, or run `tailscale funnel start`'))
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
  if (!name) { console.error('Usage: tlda doc status [name]'); process.exit(1) }

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
  if (!name) { console.error('Usage: tlda doc errors [name]'); process.exit(1) }

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

async function cmdDelete() {
  const name = getPositional(0)
  if (!name) { console.error('Usage: tlda doc delete <name>'); process.exit(1) }

  await api('DELETE', `/api/projects/${name}`)
  console.log(green(`Project "${name}" deleted.`))
}

async function cmdPreview() {
  const name = getPositional(0) || await inferProjectName()
  if (!name) { console.error('Usage: tlda doc preview <name> [page ...]'); process.exit(1) }

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

  const texBase = data.mainFile ? data.mainFile.replace(/^.*\//, '').replace(/\.tex$/, '') : name
  async function convertPage(page) {
    const svgUrl = `${server}/docs/${name}/${texBase}-page-${page}.svg`
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

async function cmdMcpSetup() {
  const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const nodePath = process.execPath
  const serverUrl = getServer()
  const outPath = join(process.cwd(), '.mcp.json')

  let existing = {}
  try { existing = JSON.parse(readFileSync(outPath, 'utf8')) } catch {}

  const config = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      tlda: {
        type: 'stdio',
        command: nodePath,
        args: [join(tldaRoot, 'mcp-server', 'index.mjs')],
        env: { TLDA_SERVER: serverUrl }
      },
      fleet: {
        type: 'stdio',
        command: nodePath,
        args: [join(tldaRoot, 'mcp-server', 'fleet.mjs')],
        cwd: tldaRoot
      }
    }
  }

  writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n')
  console.log(`Wrote ${outPath}`)
  console.log(`  tlda MCP:  ${join(tldaRoot, 'mcp-server', 'index.mjs')}`)
  console.log(`  fleet MCP: ${join(tldaRoot, 'mcp-server', 'fleet.mjs')}`)
  console.log(`  server:    ${serverUrl}`)
  console.log()
  console.log(`Open Claude Code in this directory and the tlda + fleet tools will be available.`)
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
    'server', 'agent', 'create', 'push', 'watch', 'watch-all', 'open', 'list', 'ls',
    'status', 'errors', 'delete', 'rm', 'preview', 'revert',
    'logs', 'log', 'config', 'completions',
  ]
  const serverSubs = ['start', 'stop', 'status', 'log', 'logs', 'install', 'uninstall']

  console.log(`#compdef tlda
# Install: tlda completions > ~/.zsh/completions/_tlda && fpath=(~/.zsh/completions $fpath)
# Then restart your shell or run: autoload -Uz compinit && compinit

_tlda_projects() {
  local -a projects
  projects=(\${(f)"$(tlda doc list 2>/dev/null | sed 's/^ *//' | cut -d: -f1)"})
  _describe 'project' projects
}

_tlda() {
  local -a commands
  commands=(
    'server:Manage the server'
    'create:Create project and upload files'
    'push:Push source files and rebuild'
    'watch:Watch for changes and auto-push'
    'watch-all:Watch all projects'
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
        create|push|open|status|errors|build|delete|rm|preview)
          _tlda_projects
          ;;
      esac
      ;;
  esac
}

_tlda "$@"`)
}

const LOGFILE = join(homedir(), '.config', 'tlda', 'server.log')

function getPort() {
  try { return new URL(getServer()).port || String(DEFAULT_PORT) } catch { return String(DEFAULT_PORT) }
}

async function cmdDeploy() {
  const { execSync } = await import('child_process')
  const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const distIndex = join(tldaRoot, 'dist', 'index.html')
  const token = getToken()

  const step = (label) => process.stdout.write(dim(`  ${label}... `))
  const pass = (msg) => console.log(green('✓') + (msg ? ' ' + msg : ''))
  const die = (msg) => { console.log(red('✗') + ' ' + msg); process.exit(1) }

  console.log(bold('tlda deploy'))
  console.log()

  // 1. Build
  step('Building SPA (npm run build)')
  try {
    execSync('npm run build', { cwd: tldaRoot, stdio: 'pipe', timeout: 180_000 })
  } catch (e) {
    die('Build failed: ' + (e.stderr?.toString().trim().split('\n').pop() || e.message))
  }
  pass()

  // 2. Verify bundle
  step('Verifying dist/index.html')
  if (!existsSync(distIndex)) die('dist/index.html not found after build')
  const distSize = statSync(distIndex).size
  if (distSize < 100) die(`dist/index.html is suspiciously small (${distSize} bytes)`)
  pass(`${Math.round(distSize / 1024)}KB`)

  // 3. Restart server
  step('Stopping server')
  try { execSync('node ' + JSON.stringify(join(tldaRoot, 'cli', 'tlda.mjs')) + ' server stop', { stdio: 'pipe', timeout: 10_000 }) } catch {}
  pass()

  step('Starting server')
  try {
    execSync('node ' + JSON.stringify(join(tldaRoot, 'cli', 'tlda.mjs')) + ' server start', { stdio: 'pipe', timeout: 15_000 })
  } catch (e) {
    die('Server failed to start: ' + e.message)
  }
  pass()

  // 4. Wait for server ready
  step('Waiting for server')
  const serverUrl = getServer()
  let serverReady = false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) { serverReady = true; break }
    } catch {}
  }
  if (!serverReady) die(`Server not responding at ${serverUrl}/health after 10s`)
  pass(serverUrl)

  // 5. Verify SPA renders
  step('Verifying SPA serves pages')
  const tokenParam = token ? `?token=${token}` : ''
  try {
    const res = await fetch(`${serverUrl}/${tokenParam}`, { signal: AbortSignal.timeout(5000) })
    const body = await res.text()
    if (!res.ok) die(`SPA returned ${res.status}`)
    if (!body.includes('<div id="root">')) die('SPA response missing app root')
    pass()
  } catch (e) {
    die(`SPA check failed: ${e.message}`)
  }

  // 6. Verify a doc page loads (find first available project)
  step('Verifying doc page loads')
  try {
    const projRes = await fetch(`${serverUrl}/api/projects${tokenParam}`, { signal: AbortSignal.timeout(5000) })
    if (projRes.ok) {
      const data = await projRes.json()
      const projects = data.projects || data || []
      const first = projects[0]
      if (first?.name) {
        const docRes = await fetch(`${serverUrl}/?doc=${first.name}${token ? '&token=' + token : ''}`, { signal: AbortSignal.timeout(5000) })
        const docBody = await docRes.text()
        if (docRes.ok && docBody.includes('<div id="root">')) {
          pass(first.name)
        } else {
          die(`Doc page for "${first.name}" returned ${docRes.status}`)
        }
      } else {
        pass('(no projects to test)')
      }
    } else {
      pass('(projects API unavailable)')
    }
  } catch (e) {
    die(`Doc page check failed: ${e.message}`)
  }

  console.log()
  console.log(green(bold('Deploy complete.')))
}

// ---- setup: one-time setup tasks ----
async function cmdSetup() {
  const sub = process.argv[3]
  if (!sub || sub === '--help') {
    console.log(`tlda setup — one-time setup tasks

Subcommands:
  editor [--editor CMD]   Install the texsync:// URL handler so Cmd-click
                          opens source in your editor (default: zed)
                          Supported: zed, code, cursor, codium, nvim, vim, sublime

Example:
  tlda setup editor                # set up for Zed
  tlda setup editor --editor code  # set up for VS Code
`)
    return
  }

  if (sub === 'editor') {
    const { spawn: cpSpawn } = await import('child_process')
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-texsync.sh')
    if (!existsSync(script)) {
      console.error(red(`install-texsync.sh not found: ${script}`))
      process.exit(1)
    }
    const args = process.argv.slice(4) // everything after "tlda setup editor"
    const child = cpSpawn('bash', [script, ...args], { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 0))
    await new Promise(() => {})
  } else {
    console.error(red(`Unknown setup subcommand: ${sub}`))
    console.error('Run "tlda setup" for available options.')
    process.exit(1)
  }
}

// ---- agent commands (local: they act on this machine's tmux sessions) ----
// tmux is local to the box, so agent manipulation never routes through the
// daemon — you run these where the agent lives.

function agentSessionName(name) {
  return name.startsWith('fleet-') ? name : `fleet-${name}`
}

function tmuxBase() {
  const sock = loadConfig().tmuxSocket || null
  return sock ? ['-L', sock] : []
}

async function attachToAgent(name) {
  if (!name) {
    console.error('Usage: tlda agent attach <name>')
    process.exit(1)
  }
  const { spawnSync } = await import('child_process')
  const result = spawnSync('tmux', [...tmuxBase(), 'attach-session', '-t', agentSessionName(name)], { stdio: 'inherit' })
  process.exit(result.status ?? 0)
}

async function runFleetSpawn(spawnArgs) {
  const { spawn: cpSpawn } = await import('child_process')
  const spawnScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet-spawn.py')
  if (!existsSync(spawnScript)) {
    console.error(red(`fleet-spawn script not found: ${spawnScript}`))
    process.exit(1)
  }
  const child = cpSpawn('python3', [spawnScript, ...spawnArgs], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
  await new Promise(() => {}) // keep alive until child exits
}

async function listLocalAgents() {
  const { spawnSync } = await import('child_process')
  const res = spawnSync('tmux', [...tmuxBase(), 'list-sessions', '-F', '#{session_name}\t#{session_attached}'], { encoding: 'utf8' })
  // tmux exits non-zero when there are zero sessions.
  const rows = (res.status === 0 ? res.stdout.trim().split('\n') : [])
    .map(l => l.split('\t'))
    .filter(([n]) => n && n.startsWith('fleet-'))
  if (rows.length === 0) {
    console.log('No agent sessions on this machine.')
    process.exit(0)
  }
  console.log(`Agents on this machine (${rows.length}):`)
  for (const [name, attached] of rows) {
    const mark = attached !== '0' ? ' (attached)' : ''
    console.log(`  ${name.replace(/^fleet-/, '')}${mark}`)
  }
  process.exit(0)
}

async function hibernateAgent(name) {
  if (!name) {
    console.error('Usage: tlda agent hibernate <name>')
    process.exit(1)
  }
  const { spawnSync } = await import('child_process')
  const sess = agentSessionName(name)
  const has = spawnSync('tmux', [...tmuxBase(), 'has-session', '-t', sess], { stdio: 'ignore' })
  if (has.status !== 0) {
    console.error(`No live session "${sess}" on this machine — already hibernating, or it lives on another box.`)
    process.exit(1)
  }
  const res = spawnSync('tmux', [...tmuxBase(), 'kill-session', '-t', sess], { stdio: 'inherit' })
  const short = name.replace(/^fleet-/, '')
  if (res.status === 0) {
    console.log(`Hibernated ${short} — its thread is intact; \`tlda agent spawn ${short}\` brings it back.`)
  }
  process.exit(res.status ?? 0)
}

async function cmdAgent() {
  const sub = getPositional(0)
  switch (sub) {
    case 'list':
    case 'ls':        await listLocalAgents(); break
    case 'spawn':     await ensureServer(); await runFleetSpawn(process.argv.slice(4)); break // after "tlda agent spawn"
    case 'attach':    await attachToAgent(getPositional(1)); break
    case 'hibernate': await hibernateAgent(getPositional(1)); break
    default:
      console.error('Usage: tlda agent <list|spawn|attach|hibernate> [name]')
      process.exit(1)
  }
}

// Restart the fleet MCP for agents by driving Claude Code's /mcp menu via the
// bin/fleet-mcp-restart script (path resolved here, not relying on PATH).
// Dev-only — surfaced as `tlda-dev restart-mcp`, kept out of `tlda --help`.
//   tlda-dev restart-mcp                  → your own MCP (current tmux session)
//   tlda-dev restart-mcp foo bar          → those agents
//   tlda-dev restart-mcp --all [--except foo bar]
async function restartMcpAgents(rest) {
  const { spawnSync } = await import('child_process')
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet-mcp-restart')
  if (!existsSync(script)) { console.error(red(`fleet-mcp-restart not found: ${script}`)); process.exit(1) }

  // No args → restart own MCP (script defaults the session to the current tmux session).
  if (rest.length === 0) {
    const r = spawnSync('bash', [script, '--skip-preflight'], { stdio: 'inherit' })
    process.exit(r.status ?? 0)
  }

  let targets
  if (rest.includes('--all')) {
    const ei = rest.indexOf('--except')
    const except = new Set((ei >= 0 ? rest.slice(ei + 1) : []).map(n => n.replace(/^fleet-/, '')))
    const res = spawnSync('tmux', [...tmuxBase(), 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    const all = (res.status === 0 ? res.stdout.trim().split('\n') : [])
      .filter(n => n.startsWith('fleet-')).map(n => n.replace(/^fleet-/, ''))
    targets = all.filter(n => !except.has(n))
  } else {
    targets = rest.filter(a => !a.startsWith('--'))
  }

  if (targets.length === 0) { console.log('No agents to restart.'); process.exit(0) }
  let ok = 0, fail = 0
  for (const name of targets) {
    process.stdout.write(`restart-mcp ${name} … `)
    const r = spawnSync('bash', [script, agentSessionName(name)], { encoding: 'utf8' })
    if (r.status === 0) { console.log('ok'); ok++ }
    else { console.log(`FAILED: ${((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean).pop() || 'error'}`); fail++ }
  }
  console.log(`Done: ${ok} ok${fail ? `, ${fail} failed` : ''}.`)
  process.exit(fail ? 1 : 0)
}

// Top-level spawn/attach kept working so the existing spawn path isn't broken;
// `tlda agent …` is the canonical form.
async function cmdAttach() { await attachToAgent(getPositional(0)) }
async function cmdSpawn() { await runFleetSpawn(process.argv.slice(3)) }

async function cmdRepoDoctor() {
  const name = getPositional(0)
  const wantRescue = process.argv.includes('--rescue')
  const wantApply = process.argv.includes('--apply')
  if (!name) {
    console.error('Usage:')
    console.error('  tlda repo-doctor <project>             Diagnose only (read-only)')
    console.error('  tlda repo-doctor <project> --rescue    Compute a rescue plan (DRY RUN)')
    console.error('  tlda repo-doctor <project> --apply     Execute the rescue plan')
    console.error('')
    console.error('Inspects a project\'s source repo for tlda-induced damage.')
    console.error('Without flags: prints diagnosis only.')
    console.error('--rescue: finds the content-fork point with upstream and dry-runs a')
    console.error('  3-way merge. Read-only.')
    console.error('--apply: executes the rescue. Creates a backup branch, opens a new')
    console.error('  rescue branch at the content-fork on origin\'s chain, replays your')
    console.error('  working tree, merges origin/master. Stops in conflict state for you')
    console.error('  to resolve. Never touches your master branch directly.')
    process.exit(1)
  }
  if (process.argv.includes('--rollback')) {
    const { rollbackRescue } = await import('./lib/repo-doctor.mjs')
    const deleteRefs = process.argv.includes('--delete-refs')
    const result = await rollbackRescue(name, { deleteRefs })
    if (!result.ok) { console.error(`rollback: ${result.error}`); process.exit(1) }
    console.log(`Rolled back: HEAD ${result.rolledBackFrom} → ${result.rolledBackTo}`)
    console.log(`Working tree untouched. ${result.deletedRefs.length ? 'Deleted refs: ' + result.deletedRefs.join(', ') : '(Use --delete-refs to also delete the rescue/backup branches.)'}`)
    process.exit(0)
  }
  if (process.argv.includes('--cleanup')) {
    const { cleanupApplyState } = await import('./lib/repo-doctor.mjs')
    const deleteRescueBranches = process.argv.includes('--delete-rescue-branches')
    const result = await cleanupApplyState(name, { deleteRescueBranches })
    if (!result.ok) { console.error(`cleanup: ${result.error}`); process.exit(1) }
    console.log(`Cleanup in ${result.sourceDir}:`)
    for (const d of result.did) console.log(`  ✓ ${d}`)
    if (!result.did.length) console.log('  (nothing to clean)')
    console.log('Working tree untouched.')
    process.exit(0)
  }
  if (wantApply) {
    const { applyRescue, formatRescueResult } = await import('./lib/repo-doctor.mjs')
    const result = await applyRescue(name)
    console.log(formatRescueResult(result))
    process.exit(result.ok ? 0 : 1)
  }
  if (wantRescue) {
    const { rescuePlan, formatRescuePlan } = await import('./lib/repo-doctor.mjs')
    const result = await rescuePlan(name)
    console.log(formatRescuePlan(result))
    process.exit(result.ok ? 0 : 1)
  }
  const { diagnose, formatDiagnose } = await import('./lib/repo-doctor.mjs')
  const result = await diagnose(name)
  console.log(formatDiagnose(result))
  process.exit(result.ok ? 0 : 1)
}

async function cmdInitShadow() {
  const name = getPositional(0)
  if (!name) {
    console.error('Usage: tlda init-shadow <project>')
    console.error('  Initialize (or re-initialize) the shadow repo from the project\'s')
    console.error('  working-copy git history, filtered to paper-scope paths only.')
    console.error('  Existing shadow is renamed to shadow-repo-dirty-<timestamp>.')
    process.exit(1)
  }
  const { spawn } = await import('child_process')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const script = join(root, 'bin', 'tlda-init-shadow.mjs')
  const child = spawn('node', [script, name], { stdio: 'inherit' })
  await new Promise((resolve) => child.on('exit', (code) => {
    process.exit(code ?? 0)
  }))
}

async function cmdDoctor() {
  const { execSync, spawnSync } = await import('child_process')
  const autoFix = process.argv.includes('--fix')
  const fixes = []  // { label, fn } — accumulated during checks, run at end if --fix
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

  // 2. LaTeX tools + git
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
  if (checkBin('git')) {
    ok('git found')
  } else {
    fail('git not found — change review and history features will not work', 'brew install git')
    issues++
  }

  // 3. Server
  const serverUrl = getServer()
  const probeHealth = async (timeoutMs = 2000) => {
    try {
      const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch { return false }
  }
  // A single slow /health probe false-negatives when the server is busy (build,
  // GC, heavy sync), and the old code reacted by force-restarting (kickstart -k)
  // a server that was actually alive — that's the restart-stampede. Retry before
  // concluding it's dead, and never force-kill below.
  let serverRunning = await probeHealth()
  for (let i = 0; i < 3 && !serverRunning; i++) {
    await new Promise(r => setTimeout(r, 1000))
    serverRunning = await probeHealth(4000)
  }

  if (serverRunning) {
    ok(`Server running at ${serverUrl}`)
  } else {
    console.log(red('✗') + ' Server not running — starting it...')
    try {
      // Check launchd
      const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.tlda.server.plist')
      const hasLaunchd = process.platform === 'darwin' && existsSync(PLIST)
      if (hasLaunchd) {
        // kickstart WITHOUT -k: starts the job only if it's stopped. Never -k —
        // a forced restart on a live-but-slow server is what caused the flapping.
        // launchd (KeepAlive) handles genuine crash-restarts on its own.
        try { execSync('launchctl bootstrap gui/$(id -u) ' + PLIST, { stdio: 'pipe' }) } catch {}
        try { execSync('launchctl kickstart gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
      } else {
        const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
        const serverScript = join(tldaRoot, 'server', 'unified-server.mjs')
        const { spawn: cpSpawn } = await import('child_process')
        const { openSync: fsOpenSync } = await import('fs')
        const logFd = fsOpenSync(LOGFILE, 'a')
        const child = cpSpawn(process.execPath, [serverScript, '--i-am-tlda-cli'], {
          detached: true, stdio: ['ignore', logFd, logFd],
          env: { ...process.env, PORT: getPort(), TMUX: undefined, TMUX_PANE: undefined }
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
  let needsRebuild = false
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
        needsRebuild = true
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
    const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const distIndex = join(tldaRoot, 'dist', 'index.html')
    if (existsSync(distIndex)) {
      const distMtime = statSync(distIndex).mtimeMs
      try {
        const { execSync: ex } = await import('child_process')
        const commitTs = parseInt(ex('git log -1 --format=%ct -- src/ vite.config.ts index.html package.json', { cwd: tldaRoot, stdio: 'pipe' }).toString().trim(), 10) * 1000
        if (distMtime >= commitTs) {
          ok('Bundle is current')
        } else {
          const agoMin = Math.round((Date.now() - distMtime) / 60000)
          warn(`Bundle is stale (built ${agoMin}m ago, source changed since)`, 'npm run build')
          needsRebuild = true
        }
      } catch {
        ok('Bundle exists (freshness check skipped — no git)')
      }
    } else {
      fail('No built bundle (dist/index.html missing)', 'npm run build')
      needsRebuild = true
      issues++
    }
  }

  if (needsRebuild) {
    const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    fixes.push({
      label: 'Rebuild SPA bundle',
      fn: () => {
        console.log(dim('  Running npm run build...'))
        execSync('npm run build', { cwd: tldaRoot, stdio: 'inherit', timeout: 120000 })
      }
    })
    fixes.push({
      label: 'Restart server',
      fn: () => {
        const tldaCmd = JSON.stringify(join(tldaRoot, 'cli', 'tlda.mjs'))
        console.log(dim('  Stopping server...'))
        try { execSync(`node ${tldaCmd} server stop`, { stdio: 'pipe', timeout: 10000 }) } catch {}
        console.log(dim('  Starting server...'))
        execSync(`node ${tldaCmd} server start`, { stdio: 'pipe', timeout: 15000 })
      }
    })
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

  // 5. Fleet daemon (formerly "watch-all" — same control surface, different
  //    implementation: one process per machine watches every project source
  //    dir AND every Claude Code session JSONL, pushing events to the tlda
  //    server over WebSocket).
  let watchRunning = false
  if (existsSync(FLEET_DAEMON_PIDFILE)) {
    const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
    try { process.kill(pid, 0); watchRunning = true } catch {}
  }
  if (watchRunning) {
    ok('fleet daemon running')
  } else {
    console.log(red('✗') + ' fleet daemon not running — starting it...')
    try {
      await cmdFleetWatch('start')
      if (existsSync(FLEET_DAEMON_PIDFILE)) {
        ok('fleet daemon started')
      } else {
        fail('fleet daemon failed to start', `Check log: tlda daemon log`)
        issues++
      }
    } catch (e) {
      fail(`fleet daemon failed to start: ${e.message}`, 'tlda daemon log')
      issues++
    }
  }

  // 6. MCP servers configured (tlda + fleet)
  {
    const mcpConfigs = [
      join(homedir(), '.claude', 'settings.json'),
      join(homedir(), '.config', 'claude', 'settings.json'),
      // project-level .mcp.json — look up from cwd
      join(process.cwd(), '.mcp.json'),
    ]
    const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const tldaMcpEntry = join(tldaRoot, 'mcp-server', 'index.mjs')
    const fleetMcpEntry = join(tldaRoot, 'mcp-server', 'fleet.mjs')

    let tldaFound = false
    let fleetFound = false
    for (const cfgPath of mcpConfigs) {
      if (!existsSync(cfgPath)) continue
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
        const servers = cfg.mcpServers || {}
        for (const s of Object.values(servers)) {
          const args = s.args || []
          if (args.some(a => String(a).includes('mcp-server/index.mjs'))) tldaFound = true
          if (args.some(a => String(a).includes('mcp-server/fleet.mjs'))) fleetFound = true
        }
      } catch {}
    }

    if (tldaFound) {
      ok('tlda MCP configured')
    } else {
      fail('tlda MCP not found in Claude settings')
      console.log()
      console.log('  Add to ~/.config/claude/settings.json:')
      console.log()
      console.log('  ' + cyan(JSON.stringify({
        mcpServers: {
          'tlda': {
            type: 'stdio',
            command: process.execPath,
            args: [tldaMcpEntry],
            env: { TLDA_SERVER: serverUrl }
          }
        }
      }, null, 2).split('\n').join('\n  ')))
      console.log()
      issues++
    }

    if (fleetFound) {
      ok('fleet MCP configured')
    } else {
      fail('fleet MCP not found in Claude settings')
      console.log()
      console.log('  Add to ~/.config/claude/settings.json:')
      console.log()
      console.log('  ' + cyan(JSON.stringify({
        mcpServers: {
          'fleet': {
            type: 'stdio',
            command: process.execPath,
            args: [fleetMcpEntry],
            cwd: tldaRoot
          }
        }
      }, null, 2).split('\n').join('\n  ')))
      console.log()
      issues++
    }
  }

  // 7. Project state — build errors, stuck pipelines, dangling mainFile.
  // Catches the silent failure modes where a project stops being built but
  // nothing surfaces it: mainFile pointing to a deleted source file,
  // buildStatus stuck at "failed" for weeks, lastBuild far behind source mtime.
  if (serverRunning) {
    try {
      const data = await api('GET', '/api/projects', null, { timeoutMs: 5000 })
      const projects = data.projects || []
      const projectIssues = []
      for (const p of projects) {
        if (p.buildStatus === 'error' || p.buildStatus === 'failed') {
          projectIssues.push({ p, kind: 'build-broken', detail: p.buildStatus })
          continue
        }
        if (p.sourceDir && p.mainFile) {
          const mainPath = join(p.sourceDir, p.mainFile)
          if (!existsSync(mainPath)) {
            projectIssues.push({ p, kind: 'main-missing', detail: p.mainFile })
            continue
          }
          // Stale: source touched after lastBuild by 7+ days. Cheap heuristic
          // for "edits aren't being captured."
          if (p.lastBuild) {
            try {
              const lastBuildMs = Date.parse(p.lastBuild)
              const mainMtime = statSync(mainPath).mtimeMs
              const stale = mainMtime - lastBuildMs > 7 * 24 * 60 * 60 * 1000
              if (stale) {
                const days = Math.round((mainMtime - lastBuildMs) / (24 * 60 * 60 * 1000))
                projectIssues.push({ p, kind: 'stale', detail: `mainFile edited ${days}d after last build` })
              }
            } catch {}
          }
        }
      }
      if (projectIssues.length === 0) {
        ok('All projects healthy (builds, mainFile, freshness)')
      } else {
        for (const { p, kind, detail } of projectIssues) {
          if (kind === 'build-broken') {
            fail(`Project "${p.name}" build ${detail}`, `tlda doc errors ${p.name}`)
          } else if (kind === 'main-missing') {
            fail(`Project "${p.name}" mainFile missing: ${detail}`, `edit ${p.sourceDir.replace(homedir(), '~')}/project.json or recreate project`)
          } else if (kind === 'stale') {
            fail(`Project "${p.name}" stale: ${detail}`, `tlda doc push ${p.name} --dir ${p.sourceDir} && tlda build ${p.name}`)
          }
          issues++
        }
      }
    } catch {}
  }

  // 8. Sync health (docs with broken sync stores)
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

  // --- Auto-fix ---
  if (autoFix && fixes.length > 0) {
    console.log()
    console.log(bold(`Fixing ${fixes.length} issue${fixes.length === 1 ? '' : 's'}...`))
    for (const fix of fixes) {
      console.log(cyan(`→ ${fix.label}`))
      try {
        fix.fn()
        ok(fix.label)
      } catch (e) {
        fail(`${fix.label}: ${e.message}`)
      }
    }
  }

  console.log()
  if (issues === 0 && fixes.length === 0) {
    console.log(green(bold('All checks passed.')))
  } else if (autoFix && fixes.length > 0) {
    console.log(green(bold('Fixes applied. Re-run `tlda doctor` to verify.')))
  } else {
    console.log(red(bold(`${issues} issue${issues === 1 ? '' : 's'} found.`)))
    if (fixes.length > 0) console.log(dim(`Run \`tlda doctor --fix\` to auto-fix.`))
    process.exit(1)
  }
}



async function cmdServer(action) {
  const sub = action || getPositional(0) || 'start'

  // Find the unified server script relative to this file's location
  const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const serverScript = join(tldaRoot, 'server', 'unified-server.mjs')

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
        <string>--i-am-tlda-cli</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${port}</string>
        <key>PATH</key>
        <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
${tokenEnvLines.join('\n')}
${hasTls ? `        <key>NODE_EXTRA_CA_CERTS</key>\n        <string>${TLS_CA_PATH}</string>` : ''}
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
    // Diagnostic: record who's stopping the server. The server flaps because
    // something keeps issuing graceful stops; this kill-log names the caller
    // (parent command + argv) so we can trace it instead of guessing.
    try {
      const killLog = join(homedir(), '.config', 'tlda', 'server-kills.log')
      let parent = ''
      try { parent = execSync(`ps -o command= -p ${process.ppid}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim() } catch {}
      appendFileSync(killLog, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ppid: process.ppid, parent, argv: process.argv.slice(1) }) + '\n')
    } catch {}

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
    }
    // Also kill any zombie server processes that aren't bound to the port
    // (e.g., old servers from worktrees that failed to bind but are still running
    // their daemon-supervisor loops). pkill is safe here — unified-server.mjs is unique.
    try { execSync('pkill -f "server/unified-server.mjs"', { stdio: 'pipe' }) } catch {}
    // No other fallback — if /health doesn't respond, the server is already dead.

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
      // /health didn't answer in 3s. That is NOT proof the server is down — a
      // blocked event loop (slow query) times out the same way a dead process
      // does. If the port is still held the process IS alive; reporting "not
      // running" here is exactly what makes callers (agents, fleet-spawn) try
      // to restart a live server, which flaps fleet chat. Only report down when
      // nothing holds the port.
      let held = ''
      try { held = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim() } catch { held = '' } // lsof exits non-zero when nothing is listening → port not held
      if (held) {
        console.log(yellow('Server running') + dim(` but not responding (event loop busy, pid ${held.split('\n')[0]})`))
      } else {
        console.log(red('Server not running.'))
      }
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
      // Health check failed — fall through to (re)start below.
    }

    if (!existsSync(serverScript)) {
      console.error(`Server script not found: ${serverScript}`)
      process.exit(1)
    }

    // Ensure log directory exists
    if (!existsSync(dirname(LOGFILE))) mkdirSync(dirname(LOGFILE), { recursive: true })

    if (hasLaunchd) {
      // launchd owns the single instance (KeepAlive). NEVER kill the
      // port-holder — a slow-to-respond server is still alive, and killing it
      // is exactly what caused the restart-stampede. Just ensure the job is
      // loaded and running; launchd handles crash-restart. kickstart WITHOUT
      // -k starts it only if stopped, so concurrent callers can't force
      // competing restarts.
      try { execSync('launchctl bootstrap gui/$(id -u) ' + PLIST, { stdio: 'pipe' }) } catch {}
      try { execSync('launchctl kickstart gui/$(id -u)/com.tlda.server', { stdio: 'pipe' }) } catch {}
    } else {
      // No supervisor: reclaim a genuinely-dead port, then spawn directly.
      try {
        const stale = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim()
        if (stale) {
          for (const pid of stale.split('\n')) {
            try { process.kill(parseInt(pid), 'SIGKILL') } catch {}
          }
          await new Promise(r => setTimeout(r, 500))
        }
      } catch {}
      const { spawn } = await import('child_process')
      const { openSync: fsOpenSync } = await import('fs')
      const logFd = fsOpenSync(LOGFILE, 'a')

      const serverArgs = [serverScript, '--i-am-tlda-cli']
      const child = spawn('node', serverArgs, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PORT: port, TMUX: undefined, TMUX_PANE: undefined, ...(hasTls && !process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: TLS_CA_PATH } : {}) },
      })
      child.unref()
    }

    // Wait for it to come up. The server can boot slowly (large fleet-DB query
    // on a big roster), so give it ~30s before declaring failure — a too-short
    // wait made agents falsely think they'd killed prod fleet chat.
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        const res = await fetch(`${getServer()}/health`)
        if (res.ok) {
          const data = await res.json()
          console.log(green(`Server running at ${getServer()}`) + dim(` (pid ${data.pid})`))
          console.log(dim(`  Log: ${LOGFILE}`))
          if (hasLaunchd) console.log(dim('  Managed by launchd (auto-restarts)'))
          // Also ensure the fleet daemon and configured bots are up.
          await ensureFleetDaemonRunning()
          await ensureManagedBotsRunning()
          return
        }
      } catch {}
    }
    // The wait expired without a 200 from /health. Before declaring failure
    // (and exiting non-zero, which makes callers retry → restart stampede),
    // check whether the process is actually up but slow: launchd may have
    // started it and its event loop may just be busy on a big boot query. A
    // held port means it's alive — report success, don't trigger a retry.
    let held = ''
    try { held = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim() } catch { held = '' } // lsof exits non-zero when nothing is listening → port not held
    if (held) {
      console.log(green(`Server running at ${getServer()}`) + dim(` (pid ${held.split('\n')[0]}, slow to respond — still booting)`))
      console.log(dim(`  Log: ${LOGFILE}`))
      if (hasLaunchd) console.log(dim('  Managed by launchd (auto-restarts)'))
      await ensureFleetDaemonRunning()
      await ensureManagedBotsRunning()
      return
    }
    console.error(red('Server failed to start within 30s'))
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

  // Start Vite in background. Call the vite binary DIRECTLY — `npx vite` adds a
  // wrapper process that gets reaped when the spawning shell exits, so the dev
  // server "dies" between commands. Prefer the worktree's install, fall back to
  // the main repo's binary.
  const viteLogFile = join(worktreeDir, '.dev-vite.log')
  const logFd = fsOpenSync(viteLogFile, 'a')

  const mainRepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const viteBin = [
    join(worktreeDir, 'node_modules', '.bin', 'vite'),
    join(mainRepoRoot, 'node_modules', '.bin', 'vite'),
  ].find(p => existsSync(p))
  if (!viteBin) throw new Error('vite binary not found (worktree or main repo node_modules)')

  // Bind IPv4 explicitly — without --host, vite binds IPv6 [::1] only, so a
  // browser hitting `localhost` (which resolves to 127.0.0.1) gets "can't be
  // found." 127.0.0.1 makes the printed localhost URL actually load.
  const viteChild = spawn(viteBin, ['--port', String(port), '--host', '127.0.0.1'], {
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
      case 'daemon': await ensureServer(); await cmdWatch(); break
      case 'open':   await ensureServer(); await cmdOpen(); break
      case 'share':  await cmdShare(); break
      case 'list':   await ensureServer(); await cmdList(); break
      case 'ls':     await ensureServer(); await cmdList(); break
      case 'status': await ensureServer(); await cmdStatus(); break
      case 'errors': await ensureServer(); await cmdErrors(); break
      case 'preview': await ensureServer(); await cmdPreview(); break
      case 'delete':  await ensureServer(); await cmdDelete(); break
      case 'rm':      await ensureServer(); await cmdDelete(); break
      case 'logs':    await cmdLogs(args.slice(1)); break
      case 'log':     await cmdLogs(args.slice(1)); break
      case 'publish': await cmdPublish(); break
      case 'auth': await cmdAuth(); break
      case 'mcp-setup': await cmdMcpSetup(); break
      case 'config': await cmdConfig(); break
      case 'setup': await cmdSetup(); break
      case 'agent': await cmdAgent(); break
      case 'restart-mcp': await restartMcpAgents(process.argv.slice(3)); break // dev-only; surfaced via `tlda-dev restart-mcp`
      case 'dev': await cmdDev(); break
      case 'dev-url': await cmdDevUrl(); break
      case 'deploy': await cmdDeploy(); break
      case 'doctor': await cmdDoctor(); break
      case 'init-shadow': await cmdInitShadow(); break
      case 'repo-doctor': await cmdRepoDoctor(); break
      case 'doc':
        console.log(`tlda doc — work on a document project

  create <name>        Create a project, push files, build
  open [name]          Open the viewer
  push [name]          Push source, rebuild
  status [name]        Build status
  errors [name]        LaTeX errors/warnings
  preview <name> [p…]  Rasterize pages to PNG
  list                 List projects
  share [name]         Print a shareable read-only URL
  delete <name>        Delete a project
  publish [doc …]      Publish to GitHub Pages + Fly
  scratch <file>       Publish a scratch .md
  book <name>          Group existing docs into a book
  repo-doctor <proj>   Diagnose/repair a project's source repo
  init-shadow <proj>   Rebuild a project's shadow (version-history) repo`)
        break
      default:
        console.log(`tlda — collaborative LaTeX paper review

  tlda doc <cmd>       work on a document project   (\`tlda doc\` for the list)
  tlda server <cmd>    run/manage the tlda server   (start/stop/status/log)
  tlda agent <cmd>     fleet agents on this machine (list/spawn/attach/hibernate)
  tlda config <cmd>    configure tlda               (set/get/setup/mcp-setup/auth)
  tlda daemon [start|stop]  fleet daemon (source watch + activity)
  tlda doctor          health check (--fix to repair)
  tlda logs [agent]    unified logs across all sources

Run \`tlda <noun>\` (e.g. \`tlda doc\`) to list that group's commands.
Developer commands (hacking on tlda itself): \`tlda-dev --help\`

Options: --server <url> · --dir <path> · --title "…" · --main file.tex`)
    }
  } catch (e) {
    console.error(red(`Error: ${e.message}`))
    process.exit(1)
  }
}

main()
