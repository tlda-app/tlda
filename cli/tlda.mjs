#!/usr/bin/env node
/**
 * tlda — tlda CLI.
 *
 * The user-facing command surface is noun-first: doc/server/daemon/agent/config.
 * Server URL resolution is centralized in shared/config.mjs; do not document
 * ad-hoc fallback chains here.
 */

import { resolve, basename, dirname, join, delimiter } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, appendFileSync, realpathSync } from 'fs'
import { fileURLToPath } from 'url'
import { homedir, hostname } from 'os'
import { randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { stringify as stringifyYaml } from 'yaml'
import { collectSourceFiles, collectSourceHashes, collectSpecificFiles } from './lib/source-files.mjs'
import { diffSourceHashes, normalizeSourceManifest } from '../shared/source-manifest.mjs'
import { collectHtmlArtifactFiles, htmlArtifactMainForSource } from './lib/html-artifact-files.mjs'
import {
  loadCliConfig, saveCliConfig, loadServerConfig, resolveConfig, getServerUrl, getFleetServerUrl, getRwToken, getReadToken, saveTokens, getActiveConfigName, DEFAULT_PORT,
  CONFIG_DIR, hasTls, TLS_CA_PATH, getManagedBots, getMachineId,
} from '../shared/config.mjs'
import { tldaFetch } from '../shared/http-client.mjs'
import { DEV_COMMANDS } from './lib/dev-commands.mjs'
import { getFunnelUrl, findTailscaleIPv4, selectDevShareBase, selectDocShareBase, viewerLoginUrl } from './lib/share-url.mjs'
import { scanMarkdownDeps } from '../shared/markdown-deps.mjs'
import { cmdLogs } from './lib/unified-logs.mjs'
import { planLaunchdApply } from './lib/config-apply-plan.mjs'
import { formatSystemStatus } from './lib/system-status.mjs'
import {
  bootstrapLaunchdJob,
  capcheckPlistContent,
  launchdDomain,
  launchdTarget,
  launchctlCommand,
  probeLaunchdBootstrapCapability,
} from './lib/launchd-supervision.mjs'
import {
  DEFAULT_SUPERVISED_START_TIMEOUT_MS,
  assertTargetEnvironmentDaemon,
  daemonReadyLogEvidence,
  isCompleteTargetDaemonReady,
  parseFleetDaemonPids,
  parseLaunchdPid,
  pollTargetDaemonReadiness,
  runDaemonStartWithSupervisedNoop,
  runBoundedDaemonStartTransition,
  terminatePidAndWait,
} from './lib/daemon-supervision-transition.mjs'
import { resolveAgentQuery } from './lib/agent-resolve.mjs'
import { parseAgentMoveTarget, describeAgentAddress } from '../shared/agent-move-target.mjs'
import { runtimeStatusName } from '../shared/fleet-runtime-status.mjs'
import { daemonSingletonLockPath, inspectSingletonLock } from '../agent-runtime/singleton-lock.mjs'
import {
  compilePermissionGrant,
  permissionGrantProfileName,
  permissionGrantTransparencyLine,
  resolveDirectSpawnGrant,
} from '../server/lib/permission-grants.mjs'
import { SPAWN_MACHINE_PREF_KEY } from '../server/lib/spawn-routing.mjs'
import {
  applyDaemonGrants,
  createPermissionLedger,
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  withDaemonModelAliases,
} from '../agent-launch/permission-ledger.mjs'
import { terminateTmuxSession } from '../agent-launch/tmux.mjs'
import { bindAgentSeat } from '../agent-launch/seat-binding.mjs'
import { projectWorldsPath, readProjectWorlds, writeProjectWorld } from '../shared/project-worlds.mjs'

// --- Argument parsing ---

// Noun routing. The CLI is organized under nouns (server / doc / agent / config).
// `tlda doc <sub> …` and `tlda config <sub> …` forward transparently to the
// sub's handler by splicing the noun out of argv, so every existing handler runs
// unchanged. (server/agent self-dispatch and aren't spliced; `doctor` and `logs`
// are their own top-level commands.) Flat forms still work for now so the
// feedback hook etc. don't break, but `--help` only advertises the nouns.
const DOC_SUBS = new Set([
  'open', 'push', 'list', 'ls', 'status', 'errors',
  'delete', 'rm', 'move', 'share', 'scratch', 'book', 'link', 'init',
  'repo-doctor', 'init-shadow',
])
const REMOVED_DOC_SUBS = new Set(['create', 'preview'])
const CONFIG_SUBS = new Set(['setup', 'mcp-setup', 'auth'])  // config subs that map to existing handlers
const TOP_LEVEL_COMMANDS = [
  ['doc', 'work on a document project'],
  ['server', 'run/manage the tlda server'],
  ['daemon', 'fleet daemon (source watch + activity)'],
  ['bot', 'manage configured fleet bots'],
  ['agent', 'fleet agents on this machine'],
  ['config', 'configure tlda'],
  ['system', 'show server, daemon, deploy stamp, and fleet runtime identity'],
  ['doctor', 'health check'],
  ['logs', 'unified logs across all sources'],
  ['completions', 'output zsh completion script'],
]
const DOC_COMMANDS = [
  ['init', 'Create a new blank git-backed project'],
  ['link', 'Link an existing project, push files, build'],
  ['open', 'Open the viewer'],
  ['push', 'Push source, rebuild'],
  ['status', 'Build status'],
  ['errors', 'LaTeX errors/warnings'],
  ['list', 'List projects'],
  ['share', 'Print a shareable read-only URL'],
  ['delete', 'Delete a project'],
  ['scratch', 'Publish a scratch .md'],
  ['book', 'Group existing docs into a book'],
  ['repo-doctor', 'Diagnose/repair a project source repo'],
  ['init-shadow', 'Rebuild a project shadow history repo'],
]
const SERVER_COMMANDS = [
  ['start', 'Start the server'],
  ['stop', 'Stop the server'],
  ['status', 'Check if server is running'],
  ['log', 'Show recent server log'],
  ['install', 'Install launchd service'],
  ['uninstall', 'Remove launchd service'],
]
const DAEMON_COMMANDS = [
  ['start', 'Start the fleet daemon'],
  ['stop', 'Stop the fleet daemon'],
  ['status', 'Check daemon status'],
  ['log', 'Show recent daemon log'],
  ['run', 'Run the daemon in the foreground'],
  ['install', 'Install launchd service'],
  ['uninstall', 'Remove launchd service'],
]
const BOT_COMMANDS = [
  ['list', 'List configured fleet bots'],
  ['install', 'Install bot launchd services'],
  ['uninstall', 'Remove bot launchd services'],
  ['start', 'Start bot services'],
  ['stop', 'Stop bot services'],
  ['status', 'Check bot services'],
  ['log', 'Show recent bot logs'],
]
let _nounUsed = null
{
  const noun = process.argv[2]
  const sub = process.argv[3]
  if (noun === 'doc' && sub && REMOVED_DOC_SUBS.has(sub)) {
    console.error(`Unknown tlda doc subcommand: ${sub}`)
    process.exit(1)
  }
  if (noun === 'doc' && sub && DOC_SUBS.has(sub)) { process.argv.splice(2, 1); _nounUsed = 'doc' }
  else if (noun === 'config' && sub && CONFIG_SUBS.has(sub)) { process.argv.splice(2, 1); _nounUsed = 'config' }
}

const args = process.argv.slice(2)
const command = args[0]

// Global `--config <name>`: select an alternate complete config (= an alternate
// server, the whole database+store pair) for THIS run only, WITHOUT editing the
// shared "defaultConfig". This is THE supported way to test against another
// server — editing defaultConfig is what caused the 6/27 split, where a leftover
// pointed every spawned agent at the wrong fleet. Set before any config
// resolution (getServerUrl/getRwToken/resolveConfig all read TLDA_CONFIG), and it
// flows into a spawned daemon via env inheritance (see ensureFleetDaemonRunning).
{
  const i = args.indexOf('--config')
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) {
    process.env.TLDA_CONFIG = args[i + 1]
  }
}

// Noun-only: a command lives under its noun, not flat. No back-compat aliases —
// reject the bare form and point at the noun. (Docs/callers use the noun forms.)
{
  const REDIRECT = { watch: 'daemon', 'watch-all': 'daemon', attach: 'agent attach' }
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
  link:    'tlda doc link <name> [file] [--title "Title"] [--format slides|html|markdown]\n\n  Link the repository containing file to tlda and push files. If the project already exists,\n  pushes files and triggers a rebuild.\n\n  Examples:\n    tlda doc link paper path/to/paper.tex\n    tlda doc link talk path/to/talk.qmd --format slides\n\n  Formats:\n    (default)  LaTeX → SVG pipeline (latexmk → dvisvgm)\n    slides     Reveal.js HTML (from Quarto revealjs or manual)\n    html       Multipage HTML chapters (from Quarto book render)\n    markdown   Markdown with KaTeX math → HTML\n\n  Advanced: --dir <path> and --main <file> override file-derived paths.',
  init:    'tlda doc init <name> [main-file] [--title "Title"] [--dir /path] [--format tex|markdown|html]\n\n  Create a new blank, git-backed project in a fresh directory and register it.\n  Unlike `tlda doc link` (which attaches an existing directory), `init` scaffolds a new one.\n\n  positional <main-file>  Main file name, e.g. paper.tex or notes.md.\n                          Format is inferred from the extension.\n                          Default: main.tex (format: tex/svg)\n  --dir <path>            Where to create the project directory (default: ./<name> in CWD)\n  --title "..."           Display title (default: <name>)\n  --format tex|markdown   Override format inference\n\n  Creates: <dir>/<main-file>, a git repo with an initial commit,\n           then registers and pushes the requested main file to the tlda server.',
  push:    'tlda doc push [name] [--dir /path]\n\n  Push source files to the server and trigger a rebuild.\n  Project name is inferred from the current directory if omitted.',
  watch:   'tlda daemon [start|stop|status|log|run|install|uninstall]\n\n  Control the per-machine fleet-daemon (bin/fleet-daemon.mjs).\n  The daemon watches Claude Code session JSONLs and project source\n  dirs locally, pushing events to the tlda server over WebSocket.',
  'watch-all': 'tlda daemon [start|stop|status|log|run|install|uninstall]\n\n  Alias for `tlda daemon start/stop/status/log/run` — runs the\n  per-machine fleet-daemon (bin/fleet-daemon.mjs), which watches\n  every project source dir AND every Claude Code session JSONL\n  on this machine and pushes events to the tlda server over WebSocket.',
  open:    'tlda doc open [name]\n\n  Open the viewer in the default browser (RW token = presenter permission).',
  share:   'tlda doc share [name|.]\n\n  Print a reachable viewer URL with the read-only token.\n    (no arg)  share the index page (root /)\n    .         share the project inferred from the current directory\n    <name>    share that specific doc\n  Uses the configured remote server when active, otherwise Funnel/Tailscale/LAN.\n  Does not print localhost as a share URL for users on another machine.\n  Recipients can annotate but cannot present.',
  status:  'tlda doc status [name]\n\n  Show build status for a project.',
  errors:  'tlda doc errors [name] [--wait]\n\n  Extract LaTeX errors and warnings from the last build log.\n  With --wait (-w), blocks until the current build finishes.',
  build:   'tlda build [name]\n\n  Trigger a rebuild without pushing files.\n\n  NOTE: Prefer the watcher pipeline. This command bypasses change\n  detection and should only be used for debugging.',
  delete:  'tlda doc delete <name>\n\n  Delete a project and all its data.',
  logs:    'tlda logs [agent] [--since 1h|2026-05-23] [--type chat,register] [-n 50] [-f] [--daemon] [--all]\n\n  Unified chronological log across all sources (DB events, daemon log, dead-letters).\n\n  agent      Filter by agent name (fuzzy match)\n  --since    Time range (e.g. 1h, 30m, 2d, or ISO date)\n  --type     Filter by event type (comma-separated)\n  -n N       Number of events (default: 50, or 10000 with --since)\n  -f         Follow mode (tail -f style)\n  --daemon   Include daemon log lines (heartbeats, WS, terminal exits)\n  --all      Include activity and client_error events (excluded by default)',
  server:  'tlda server [start|stop|status|log|install|uninstall]\n\n  start      Start the server (auto-restarts via launchd if installed)\n  stop       Stop the server\n  status     Check if server is running\n  log        Show recent server log\n  install    Install launchd service (macOS)\n  uninstall  Remove launchd service',
  bot:     'tlda bot [list|install|uninstall|start|stop|status|log] [name] [--dry-run]\n\n  Manage configured fleet bots as launchd services. The bot process logs in like an agent; the daemon does not start it.',
  system:  'tlda system status\n\n  Show server, daemon, deploy stamp, and fleet runtime identity.',
  daemon:  'tlda daemon [start|stop|status|log|run|install|uninstall]\n\n  Control the per-machine fleet daemon.\n  It watches project source directories and agent session activity,\n  then pushes events to the tlda server over WebSocket.',
  doctor:  'tlda doctor [--fix]\ntlda doctor yolo [--name yolo] --model <provider-model> [--kind codex] [--cwd /path] [--no-attach] [--dry-run]\n\n  Run a health check for local tools, server, SPA bundle, daemon, MCP setup,\n  project builds, and doc sync stores.\n\n  --fix  Apply the limited automatic repairs that doctor explicitly offers.\n\n  yolo   Break-glass: locally launch an unrestricted repair agent outside the\n         normal daemon/server/grant path. Deliberately shallow so it works when\n         the normal spawn path is broken.\n\n         --model names the provider model directly. --kind selects the harness\n         and defaults to codex. Run in a terminal and it attaches you into the\n         agent session when it comes up (--no-attach to skip). Non-interactive\n         calls report the local tmux session and local mint id; they do not claim\n         a fleet-recipient binding.',
  'repo-doctor': 'tlda doc repo-doctor <project> [--rescue|--apply|--rollback|--cleanup]\n\n  Diagnose a project source repo for tlda-induced damage.\n  No flag: diagnose only (read-only).\n  --rescue   Compute a rescue plan (dry run).\n  --apply    Execute the rescue plan.\n  --rollback Roll back a previous rescue apply.\n  --cleanup  Clean rescue apply state.',
  config:  'tlda config [apply | set <key> <value> | get [key]]\n\n  apply  Reconcile launchd jobs to daemon.yaml, bots.yaml, and the installed server job.\n  set    Manage CLI preferences.\n  get    Show CLI preferences.',
}

// Flags that take a value (--flag value). All others are boolean.
const VALUE_FLAGS = new Set([
  'server', 'dir', 'title', 'main', 'debounce', 'token', 'members', 'format',
  'session', 'target', 'timeout', 'id', 'book', 'worktree', 'port', 'browser',
  'model', 'cwd', 'effort', 'mode', 'name', 'kind',
  'agent-id', 'policy', 'permissions', 'machine', 'limit', 'from', 'poll', 'config',
  'label', 'plist',
])

const SPAWN_BOOLEAN_FLAGS = new Set([
  'fresh', 'refresh', 'enroll', 'i-like-to-live-dangerously', 'list-models',
])

const SPAWN_NON_MODEL_OPTION_FLAGS = new Set([
  'agent-id', 'config', 'cwd', 'enroll', 'fresh', 'i-like-to-live-dangerously',
  'kind', 'list-models', 'machine', 'mode', 'model', 'name', 'permissions',
  'policy', 'refresh', 'server', 'session',
])

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

function formatCommandRows(rows) {
  const width = rows.reduce((n, [name]) => Math.max(n, name.length), 0)
  return rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`).join('\n')
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

function printPushBuildStatus(result, unchangedMessage = 'No changes detected.') {
  if (result.unchanged) {
    console.log(dim(unchangedMessage))
  } else if (result.building) {
    console.log(green('Build triggered.'))
  } else {
    console.log(green('Source pushed; viewer rebuilds on demand.'))
  }
}

// --- HTTP helpers ---

async function api(method, path, body = null, { timeoutMs = 30000, token = getToken() } = {}) {
  return tldaFetch(path, {
    method, body, timeoutMs,
    server: getServer(),
    token,
  })
}

async function apiAt(server, method, path, body = null, { timeoutMs = 30000, token = null } = {}) {
  return tldaFetch(path, { method, body, timeoutMs, server, token })
}

// --- Source file collection ---

/**
 * Incremental push: compute local hashes, fetch server hashes, diff, send only changed files.
 * Returns the push API response.
 */
async function incrementalPush(name, dir, extraBody = {}, { forceMetadata = false } = {}) {
  let project
  try {
    project = await api('GET', `/api/projects/${name}`)
  } catch (e) {
    throw new Error(`could not fetch project metadata for ${name}: ${e.message}`)
  }
  const sourceContext = { format: project.format, mainFile: project.mainFile }
  // Compute local hashes (fast — just reads + MD5, no encoding)
  const localHashes = collectSourceHashes(dir, sourceContext)
  const localPaths = Object.keys(localHashes)
  const sourceManifest = normalizeSourceManifest(localPaths, sourceContext)

  // Get server hashes. If this fails, the server/API contract is broken; do not
  // hide it by full-pushing.
  let serverHashes
  try {
    const data = await api('GET', `/api/projects/${name}/hashes`)
    serverHashes = data.hashes
  } catch (e) {
    throw new Error(`could not fetch server hashes for ${name}: ${e.message}`)
  }
  if (!serverHashes || typeof serverHashes !== 'object' || Array.isArray(serverHashes)) {
    throw new Error(`invalid hash response for ${name}`)
  }
  let sourceAuthority
  try {
    sourceAuthority = await api('GET', `/api/projects/${name}/source-authority`)
  } catch (e) {
    throw new Error(`could not fetch source authority for ${name}: ${e.message}`)
  }

  const { changedPaths, deletedFiles } = diffSourceHashes(localHashes, serverHashes)

  const files = collectSpecificFiles(dir, changedPaths)
  const total = localPaths.length
  const skipped = total - changedPaths.length
  if (skipped > 0) {
    console.log(dim(`  ${skipped}/${total} files unchanged, sending ${changedPaths.length} changed`))
  }
  if (deletedFiles.length > 0) {
    console.log(dim(`  ${deletedFiles.length} files deleted on server`))
  }

  return await api('POST', `/api/projects/${name}/push`, {
    files,
    sourceManifest,
    expectedRevision: sourceAuthority.currentRevision,
    ...(deletedFiles?.length > 0 && { deletedFiles }),
    ...extraBody,
  })
}

function sourceManifestForFiles(files, context = {}) {
  return normalizeSourceManifest((files || []).map(f => f.path), context)
}

async function currentSourceRevision(name) {
  const authority = await api('GET', `/api/projects/${name}/source-authority`)
  return authority.currentRevision
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
  await api('POST', `/api/projects/${name}/push`, {
    files,
    sourceManifest: sourceManifestForFiles(files, { format: 'markdown', mainFile: fileName }),
    sourceDir: dir,
    expectedRevision: await currentSourceRevision(name),
  })
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
  if (!name) { console.error('Usage: tlda doc link <name> [file] [--title "Title"] [--format slides|html|markdown]'); process.exit(1) }

  let format = getFlag('format') || null
  const positionalMain = getPositional(1)
  let dir = resolve(getFlag('dir') || '.')
  let mainArg = getFlag('main')
  if (positionalMain) {
    const mainPath = resolve(positionalMain)
    dir = dirname(mainPath)
    mainArg = basename(mainPath)
  }
  const title = getFlag('title') || name

  // Infer the format from the file argument when --format is omitted. Without
  // this, `tlda doc link x README.md` falls through to the LaTeX/svg
  // path, which uploads the ENTIRE directory — gigabytes if --dir is a code repo.
  // Explicit --format always wins; .tex/unknown keep the existing LaTeX default.
  if (!format) {
    const mainHint = mainArg
    const ext = mainHint ? mainHint.toLowerCase().split('.').pop() : null
    if (ext === 'md') format = 'markdown'
    else if (ext === 'html' || ext === 'htm') format = 'html'
    if (format) console.log(dim(`  Inferred format: ${format} (from --main ${mainHint})`))
  }

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

    const slidesMain = htmlArtifactMainForSource(mainArg)
    const artifact = collectHtmlArtifactFiles(dir, { mainFile: slidesMain })
    const allFiles = artifact.files

    if (artifact.paths.filter(f => /\.(?:html|htm)$/i.test(f)).length === 0) {
      const hint = slidesMain ? ` (${slidesMain})` : ''
      console.error(`No .html files found in ${dir}${hint}`)
      process.exit(1)
    }

    if (artifact.missing.length > 0) {
      console.warn(yellow(`  Warning: ${artifact.missing.length} referenced local asset(s) were not found.`))
      for (const rel of artifact.missing.slice(0, 10)) console.warn(dim(`    missing: ${rel}`))
      if (artifact.missing.length > 10) console.warn(dim(`    ... ${artifact.missing.length - 10} more`))
    }

    console.log(`Pushing ${allFiles.length} artifact file(s)...`)
    await api('POST', `/api/projects/${name}/push`, {
      files: allFiles,
      sourceManifest: sourceManifestForFiles(allFiles, { format: 'slides' }),
      sourceDir: dir,
      expectedRevision: await currentSourceRevision(name),
    })
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
    await api('POST', `/api/projects/${name}/push`, {
      files: allFiles,
      sourceManifest: sourceManifestForFiles(allFiles, { format: 'html' }),
      sourceDir: dir,
      expectedRevision: await currentSourceRevision(name),
    })
    console.log(green('HTML project processed.'))

    const server = getServer()
    console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
    return
  }

  // Markdown format: push .md file, server renders to HTML with KaTeX
  if (format === 'markdown') {
    const mainFile = mainArg || readdirSync(dir).find(f => f.endsWith('.md'))
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

    // Push the main file PLUS every locally-referenced image. A remote server
    // (e.g. hosted) can't read the author's disk, and build-markdown.mjs copies
    // referenced images from the PUSHED source mirror — so if we only send the
    // .md, every image 404s off-machine. Scan with the same ref patterns the
    // server uses (build-markdown.mjs) and upload each referenced local file at
    // its relative path, so it lands where the server's copyRef looks for it.
    const mdSource = readFileSync(join(dir, mainFile), 'utf8')
    const files = [{ path: mainFile, content: Buffer.from(mdSource).toString('base64'), encoding: 'base64' }]

    const missing = []
    for (const { ref, abs } of scanMarkdownDeps(mdSource, dir)) {
      if (!abs || !existsSync(abs)) { missing.push(ref); continue }
      files.push({ path: ref, content: readFileSync(abs).toString('base64'), encoding: 'base64' })
    }
    const assetCount = files.length - 1

    console.log(`Pushing ${mainFile}${assetCount ? ` + ${assetCount} image(s)` : ''}...`)
    if (missing.length) console.log(dim(`  Skipped ${missing.length} unresolved image ref(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`))
    await api('POST', `/api/projects/${name}/push`, {
      files,
      sourceManifest: sourceManifestForFiles(files, { format: 'markdown', mainFile }),
      sourceDir: dir,
      expectedRevision: await currentSourceRevision(name),
    })
    console.log(green('Markdown project processed.'))

    const server = getServer()
    console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
    return
  }

  // `doc link` attaches an existing Git working copy. The source collector is
  // deliberately repository-aware: it skips `.git`, build products, and
  // non-source files, so the repository root is safe and is the canonical
  // local project directory watched by the daemon.
  let repoRoot
  try {
    repoRoot = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    console.error(red(`Refusing to link ${dir}`))
    console.error(red('  — tlda doc link requires an existing Git repository.'))
    process.exit(1)
  }
  if (realpathSync(repoRoot) !== realpathSync(dir)) {
    console.error(red(`Refusing to link ${dir}`))
    console.error(red(`  — use the Git repository root: ${repoRoot}`))
    process.exit(1)
  }

  const mainFile = mainArg || findMainTex(dir)
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
  printPushBuildStatus(result, 'No changes detected (use `tlda build` to force a rebuild).')

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

// A repository is just a remote you haven't cloned yet. `link` takes the main
// file either way; add `--from <git-url>` (Overleaf, GitHub, ssh, …) and the
// server clones + polls that remote instead of watching a local directory.
//   tlda doc link <name> <main-file> [--from <git-url>] [--token TOKEN] [--title T] [--poll 60]
async function cmdLink() {
  const from = getFlag('from')
  if (from) await cmdLinkRemote(from)
  else await cmdCreate()
}

// Link a project to a git remote (e.g. Overleaf). The server clones it, does an
// initial sync, and polls for changes — the author keeps editing upstream while
// tlda mirrors + rebuilds. The main file is the entry point *inside* the repo.
async function cmdLinkRemote(gitUrl) {
  const name = getPositional(0)
  const mainFile = getPositional(1) || getFlag('main')
  if (!name || !mainFile) {
    console.error('Usage: tlda doc link <name> <main-file> --from <git-url> [--token TOKEN] [--title "Title"] [--poll 60]')
    console.error('  <main-file> is the entry .tex inside the repo (no default — papers aren\'t all main.tex)')
    process.exit(1)
  }
  const overleafToken = getFlag('token')
  const title = getFlag('title')
  const pollSeconds = Number(getFlag('poll') || '60') || 60

  console.log(`Linking ${name} ← ${gitUrl} (main: ${mainFile}; cloning + initial build, this can take a minute)…`)
  const result = await api('POST', `/api/projects/${name}/overleaf-link`,
    { gitUrl, token: overleafToken, title, mainFile, pollSeconds },
    { timeoutMs: 300000, token: getRwToken() })
  console.log(`✓ Linked. Synced ${result.changed} file(s) at ${String(result.head || '').slice(0, 7)}; polling every ${pollSeconds}s.`)
}

async function cmdInit() {
  const name = getPositional(0)
  if (!name) {
    console.error('Usage: tlda doc init <name> [main-file] [--title "Title"] [--dir /path] [--format tex|markdown]')
    process.exit(1)
  }

  // Determine format and main file name
  let format = getFlag('format') || null
  const mainArg = getPositional(1)  // optional: paper.tex, notes.md, etc.

  // Infer format from the main file extension (same logic as cmdCreate)
  let mainFile
  if (mainArg) {
    const ext = mainArg.toLowerCase().split('.').pop()
    if (!format) {
      if (ext === 'md') format = 'markdown'
      else if (ext === 'html' || ext === 'htm') format = 'html'
    }
    mainFile = mainArg
  } else {
    // No explicit main file — pick sensible default per format
    if (format === 'markdown') mainFile = 'main.md'
    else if (format === 'html') mainFile = 'index.html'
    else mainFile = 'main.tex'
    // Default format for .tex is left as null (LaTeX/svg pipeline)
  }

  const title = getFlag('title') || name

  // Determine target directory: --dir overrides, otherwise ./<name> in CWD
  const targetDir = resolve(getFlag('dir') || join(process.cwd(), name))

  // Guard: refuse to clobber a non-empty directory
  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir)
    if (entries.length > 0) {
      console.error(red(`Directory already exists and is not empty: ${targetDir}`))
      console.error(`  Use \`tlda doc link\` to attach an existing project directory.`)
      process.exit(1)
    }
  }

  // Create the directory
  mkdirSync(targetDir, { recursive: true })
  console.log(dim(`  Creating project in ${targetDir}`))

  // Create only the explicitly requested starter main file; do not add ancillary source.
  const isMarkdown = format === 'markdown'
  const isHtml = format === 'html'
  const createdFiles = []

  if (isMarkdown) {
    // Minimal markdown stub
    const mdContent = `# ${title}\n\nWrite your notes here. Math works: $E = mc^2$\n`
    writeFileSync(join(targetDir, mainFile), mdContent, 'utf8')
    createdFiles.push(mainFile)
  } else if (isHtml) {
    // Minimal HTML stub
    const htmlContent = `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n<h1>${title}</h1>\n<p>Edit this file.</p>\n</body>\n</html>\n`
    writeFileSync(join(targetDir, mainFile), htmlContent, 'utf8')
    createdFiles.push(mainFile)
  } else {
    // Minimal compilable LaTeX stub for the requested main document.
    const texContent = `\\documentclass{article}\n\\title{${title}}\n\\author{}\n\\date{\\today}\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\nWrite your paper here.\n\n\\end{document}\n`
    writeFileSync(join(targetDir, mainFile), texContent, 'utf8')
    createdFiles.push(mainFile)
  }

  const formatLabel = isMarkdown ? 'markdown' : isHtml ? 'html' : 'LaTeX'

  console.log(dim(`  Created ${createdFiles.join(', ')}`))

  // Git init + initial commit
  const { execFileSync } = await import('child_process')
  try {
    execFileSync('git', ['init'], { cwd: targetDir, stdio: 'pipe' })
    if (createdFiles.length) execFileSync('git', ['add', ...createdFiles], { cwd: targetDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '--allow-empty', '-m', `init: ${name} (${formatLabel})`], {
      cwd: targetDir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'tlda', GIT_COMMITTER_NAME: 'tlda',
             GIT_AUTHOR_EMAIL: 'tlda@localhost', GIT_COMMITTER_EMAIL: 'tlda@localhost' },
    })
    console.log(dim(`  git init + initial commit`))
  } catch (gitErr) {
    console.warn(yellow(`  Warning: git init failed — ${gitErr.message.trim()}`))
    console.warn(yellow(`  Project directory and files were created, but no git repo was initialized.`))
  }

  // Register on the server and push the seeded files
  try {
    if (isMarkdown) {
      await api('POST', '/api/projects', { name, title, mainFile, format: 'markdown', sourceDir: targetDir })
      console.log(green(`Created markdown project "${name}".`))
      const files = [{
        path: mainFile,
        content: Buffer.from(readFileSync(join(targetDir, mainFile))).toString('base64'),
        encoding: 'base64',
      }]
      await api('POST', `/api/projects/${name}/push`, {
        files,
        sourceManifest: sourceManifestForFiles(files, { format: 'markdown', mainFile }),
        sourceDir: targetDir,
        expectedRevision: await currentSourceRevision(name),
      })
    } else if (isHtml) {
      await api('POST', '/api/projects', { name, title, format: 'html', sourceDir: targetDir })
      console.log(green(`Created HTML project "${name}".`))
      const files = [{
        path: mainFile,
        content: Buffer.from(readFileSync(join(targetDir, mainFile))).toString('base64'),
        encoding: 'base64',
      }]
      await api('POST', `/api/projects/${name}/push`, {
        files,
        sourceManifest: sourceManifestForFiles(files, { format: 'html', mainFile }),
        sourceDir: targetDir,
        expectedRevision: await currentSourceRevision(name),
      })
    } else {
      await api('POST', '/api/projects', { name, title, mainFile, sourceDir: targetDir })
      console.log(green(`Created project "${name}".`))
      const files = [{
        path: mainFile,
        content: Buffer.from(readFileSync(join(targetDir, mainFile))).toString('base64'),
        encoding: 'base64',
      }]
      await api('POST', `/api/projects/${name}/push`, {
        files,
        sourceManifest: sourceManifestForFiles(files, { format: 'svg', mainFile }),
        sourceDir: targetDir,
        expectedRevision: await currentSourceRevision(name),
      })
      console.log(green('Build triggered.'))
    }
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`Project "${name}" already exists on server — use \`tlda doc link\` or \`tlda doc push\` instead.`)
    } else {
      console.warn(yellow(`  Server registration failed: ${e.message}`))
      console.warn(yellow(`  Project directory and git repo are ready. Run \`tlda doc link ${name} ${mainFile}\` when the server is up.`))
      const server = getServer()
      console.log(`\nViewer (once registered): ${cyan(`${server}/?doc=${name}`)}`)
      return
    }
  }

  const server = getServer()
  console.log(`\nViewer: ${cyan(`${server}/?doc=${name}`)}`)
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
let DAEMON_WORLD_NAME
try {
  DAEMON_WORLD_NAME = getActiveConfigName() || 'default'
} catch {
  DAEMON_WORLD_NAME = process.env.TLDA_CONFIG || 'default'
}
const DAEMON_WORLD_SUFFIX = DAEMON_WORLD_NAME === 'default' ? '' : `.${DAEMON_WORLD_NAME.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
const FLEET_DAEMON_LOGFILE = join(homedir(), '.config', 'tlda', `fleet-daemon${DAEMON_WORLD_SUFFIX}.log`)
const FLEET_DAEMON_PIDFILE = join(homedir(), '.config', 'tlda', `fleet-daemon${DAEMON_WORLD_SUFFIX}.pid`)
const FLEET_DAEMON_SOCKET = join(CONFIG_DIR, `fleet-daemon${DAEMON_WORLD_SUFFIX}.sock`)
const FLEET_DAEMON_LABEL = `com.tlda.fleet-daemon${DAEMON_WORLD_SUFFIX}`
const FLEET_DAEMON_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${FLEET_DAEMON_LABEL}.plist`)
const _cliDir = dirname(fileURLToPath(import.meta.url))
const _cliWorktreeMatch = _cliDir.match(/^(.+?)\/(?:\.claude\/worktrees|\.worktrees)\//)
const FLEET_DAEMON_MAIN_ROOT = _cliWorktreeMatch ? _cliWorktreeMatch[1] : join(_cliDir, '..')
const FLEET_DAEMON_SCRIPT = _cliWorktreeMatch
  ? join(_cliWorktreeMatch[1], 'bin', 'fleet-daemon.mjs')
  : join(_cliDir, '..', 'bin', 'fleet-daemon.mjs')
const FLEET_DAEMON_DNS_ALIAS_PRELOAD = join(FLEET_DAEMON_MAIN_ROOT, 'shared', 'node-dns-alias.cjs')

function plistEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function daemonLaunchdTarget(label = FLEET_DAEMON_LABEL) {
  return launchdTarget(label, { uid: process.getuid() })
}

function daemonLaunchdDomain() {
  return launchdDomain({ uid: process.getuid() })
}

function daemonPathEnv() {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')
}

function daemonEnvironmentEntries({ configDir = null, configName = DAEMON_WORLD_NAME, processTitle = null } = {}) {
  const entries = [
    ['PATH', daemonPathEnv()],
    ['NODE_OPTIONS', `--require=${FLEET_DAEMON_DNS_ALIAS_PRELOAD}`],
  ]
  if (existsSync(TLS_CA_PATH)) entries.push(['NODE_EXTRA_CA_CERTS', TLS_CA_PATH])
  entries.push(['TLDA_CONFIG', configName])
  if (configDir) {
    entries.push(['TLDA_CONFIG_DIR', configDir])
    entries.push(['TLDA_DAEMON_CONFIG_DIR', configDir])
  }
  if (processTitle) entries.push(['TLDA_DAEMON_PROCESS_TITLE', processTitle])
  return entries
}

function daemonEnvironmentPlist({ configDir = null, configName = DAEMON_WORLD_NAME, processTitle = null } = {}) {
  return daemonEnvironmentEntries({ configDir, configName, processTitle })
    .map(([key, value]) => `        <key>${plistEscape(key)}</key>\n        <string>${plistEscape(value)}</string>`)
    .join('\n')
}

function daemonPlistContent({ label = FLEET_DAEMON_LABEL, logFile = FLEET_DAEMON_LOGFILE, configDir = null, configName = DAEMON_WORLD_NAME, cliPath = null, processTitle = null } = {}) {
  const command = `exec /opt/homebrew/bin/node --import tsx ${JSON.stringify(FLEET_DAEMON_SCRIPT)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plistEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-fc</string>
        <string>${plistEscape(command)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${plistEscape(FLEET_DAEMON_MAIN_ROOT)}</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
${daemonEnvironmentPlist({ configDir, configName, processTitle })}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${plistEscape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(logFile)}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
}

async function writeDaemonPlist({ plist = FLEET_DAEMON_PLIST, label = FLEET_DAEMON_LABEL, logFile = FLEET_DAEMON_LOGFILE, configDir = null, configName = DAEMON_WORLD_NAME, cliPath = null, processTitle = null } = {}) {
  if (!existsSync(dirname(plist))) mkdirSync(dirname(plist), { recursive: true })
  if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(plist, daemonPlistContent({ label, logFile, configDir, configName, cliPath, processTitle }))
  return plist
}

async function runLaunchctl(args, { ignoreFailure = false } = {}) {
  const { execFileSync } = await import('child_process')
  const invocation = launchctlCommand(args, { uid: process.getuid() })
  try {
    return execFileSync(invocation.command, invocation.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (ignoreFailure) return e.stdout?.toString?.() || ''
    const detail = e.stderr?.toString?.().trim()
    throw new Error(detail || e.message)
  }
}

function requireLaunchd() {
  if (process.platform !== 'darwin') {
    console.error('launchd is macOS-only.')
    process.exit(1)
  }
}

async function bootstrapDaemonPlist(plist = FLEET_DAEMON_PLIST, label = FLEET_DAEMON_LABEL) {
  await bootstrapLaunchdJob({
    plist,
    label,
    domain: daemonLaunchdDomain(),
    runLaunchctl,
  })
}

async function bootoutDaemonLabel(label = FLEET_DAEMON_LABEL) {
  await runLaunchctl(['bootout', daemonLaunchdTarget(label)], { ignoreFailure: true })
}

async function probeDaemonLaunchdStartCapability() {
  const label = `com.tlda.fleet-daemon.capcheck.${process.pid}`
  const plist = join(CONFIG_DIR, `${label}.plist`)
  await probeLaunchdBootstrapCapability({
    label,
    plist,
    domain: daemonLaunchdDomain(),
    runLaunchctl,
    writeFile: (file, content) => {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    },
    unlinkFile: (file) => {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch (e) {
        console.warn(yellow(`Could not remove launchd capability probe plist ${file}: ${e.message}`))
      }
    },
    plistContent: capcheckPlistContent({ label }),
  })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function botServiceName(name) {
  return String(name || '').trim()
}

function botServiceSuffix(name) {
  const suffix = botServiceName(name).replace(/[^A-Za-z0-9_.-]/g, '-')
  if (!suffix) throw new Error('bot name is required')
  return suffix
}

function botLaunchdLabel(name) {
  return `com.tlda.bot.${botServiceSuffix(name)}`
}

function botServicePaths(name) {
  const suffix = botServiceSuffix(name)
  return {
    label: botLaunchdLabel(name),
    plist: join(homedir(), 'Library', 'LaunchAgents', `${botLaunchdLabel(name)}.plist`),
    logFile: join(CONFIG_DIR, `${suffix}.log`),
    pidFile: join(CONFIG_DIR, `${suffix}.pid`),
    heartbeatFile: join(CONFIG_DIR, `${suffix}.heartbeat`),
    idFile: join(CONFIG_DIR, `${suffix}.fleet-id`),
    tmuxSession: `fleet-bot-${suffix}`,
    waitChannel: `fleet-bot-${suffix}-exit`,
  }
}

function resolveBotScriptForCli(script) {
  if (!script) throw new Error('bot script is required')
  if (script.startsWith('/')) return script
  return join(FLEET_DAEMON_MAIN_ROOT, script)
}

function configuredBots() {
  return getManagedBots()
}

function findConfiguredBot(name) {
  const bots = configuredBots()
  if (!name) return bots
  const bot = bots.find(b => b.name === name)
  if (!bot) throw new Error(`No configured bot named "${name}". Run \`tlda bot list\`.`)
  return [bot]
}

function botMachineId(bot) {
  return bot.machine_id || localMachineId()
}

function botEnvironmentEntries(bot, paths) {
  const entries = [
    ['PATH', daemonPathEnv()],
    ['TLDA_BOT_NAME', bot.name],
    ['TLDA_BOT_PIDFILE', paths.pidFile],
    ['TLDA_BOT_HEARTBEAT', paths.heartbeatFile],
    ['TLDA_BOT_IDFILE', paths.idFile],
    ['TLDA_BOT_MACHINE_ID', botMachineId(bot)],
    ['TLDA_BOT_TMUX_SESSION', paths.tmuxSession],
  ]
  if (existsSync(TLS_CA_PATH)) entries.push(['NODE_EXTRA_CA_CERTS', TLS_CA_PATH])
  if (bot.server) entries.push(['TLDA_CONFIG', String(bot.server)])
  for (const [key, value] of Object.entries(bot.env || {})) entries.push([key, String(value)])
  return entries
}

function botEnvironmentPlist(bot, paths) {
  return botEnvironmentEntries(bot, paths)
    .filter(([key]) => key === 'PATH' || key === 'NODE_EXTRA_CA_CERTS' || key === 'TLDA_CONFIG')
    .map(([key, value]) => `        <key>${plistEscape(key)}</key>\n        <string>${plistEscape(value)}</string>`)
    .join('\n')
}

function botCommandEnvironment(bot, paths) {
  return botEnvironmentEntries(bot, paths)
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
}

function botTmuxCommand(bot, paths) {
  const script = resolveBotScriptForCli(bot.script)
  const envPrefix = botCommandEnvironment(bot, paths)
  const signalExit = `tmux wait-for -S ${shellQuote(paths.waitChannel)}`
  return `exec env ${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(script)} >> ${shellQuote(paths.logFile)} 2>&1; ${signalExit}`
}

function botLaunchCommand(bot) {
  const paths = botServicePaths(bot.name)
  const tmuxCommand = botTmuxCommand(bot, paths)
  return [
    `tmux kill-session -t ${shellQuote(paths.tmuxSession)} 2>/dev/null || true`,
    `tmux new-session -d -s ${shellQuote(paths.tmuxSession)} ${shellQuote(tmuxCommand)}`,
    `tmux wait-for ${shellQuote(paths.waitChannel)}`,
  ].join('\n')
}

function botPlistContent(bot) {
  const paths = botServicePaths(bot.name)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plistEscape(paths.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-fc</string>
        <string>${plistEscape(botLaunchCommand(bot))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${plistEscape(FLEET_DAEMON_MAIN_ROOT)}</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
${botEnvironmentPlist(bot, paths)}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${plistEscape(paths.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(paths.logFile)}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
}

function writeBotPlist(bot) {
  const paths = botServicePaths(bot.name)
  if (!existsSync(dirname(paths.plist))) mkdirSync(dirname(paths.plist), { recursive: true })
  if (!existsSync(dirname(paths.logFile))) mkdirSync(dirname(paths.logFile), { recursive: true })
  writeFileSync(paths.plist, botPlistContent(bot))
  return paths
}

function launchAgentsDir() {
  return join(homedir(), 'Library', 'LaunchAgents')
}

function labelPlistPath(label) {
  return join(launchAgentsDir(), `${label}.plist`)
}

function daemonConfigSuffix(configName) {
  return configName === 'default' ? '' : `.${String(configName).replace(/[^a-zA-Z0-9._-]+/g, '-')}`
}

function daemonJobForConfigName(configName) {
  const suffix = daemonConfigSuffix(configName)
  const label = `com.tlda.fleet-daemon${suffix}`
  const logFile = join(CONFIG_DIR, `fleet-daemon${suffix}.log`)
  const plist = labelPlistPath(label)
  return {
    kind: 'daemon',
    name: configName,
    label,
    plist,
    content: daemonPlistContent({ label, logFile, configName }),
  }
}

function botJob(bot) {
  const paths = botServicePaths(bot.name)
  return {
    kind: 'bot',
    name: bot.name,
    label: paths.label,
    plist: paths.plist,
    content: botPlistContent(bot),
  }
}

function serverLaunchdLabel() {
  return 'com.tlda.server'
}

function serverPlistPath() {
  return labelPlistPath(serverLaunchdLabel())
}

function serverScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'unified-server.mjs')
}

function nodePathForLaunchd() {
  try {
    return execFileSync('which', ['node'], { stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch {
    return '/opt/homebrew/bin/node'
  }
}

function serverPlistContent({ nodePath = nodePathForLaunchd(), port = getPort(), logFile = LOGFILE } = {}) {
  const tokenEnvLines = []
  const tokenRw = getRwToken()
  const tokenRead = getReadToken()
  if (tokenRw) tokenEnvLines.push(`        <key>TLDA_TOKEN_RW</key>\n        <string>${plistEscape(tokenRw)}</string>`)
  if (tokenRead) tokenEnvLines.push(`        <key>TLDA_TOKEN_READ</key>\n        <string>${plistEscape(tokenRead)}</string>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${serverLaunchdLabel()}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${plistEscape(nodePath)}</string>
        <string>--import</string>
        <string>tsx</string>
        <string>${plistEscape(serverScriptPath())}</string>
        <string>--i-am-tlda-cli</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${plistEscape(port)}</string>
        <key>PATH</key>
        <string>${plistEscape(`${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)}</string>
${tokenEnvLines.join('\n')}
${hasTls ? `        <key>NODE_EXTRA_CA_CERTS</key>\n        <string>${plistEscape(TLS_CA_PATH)}</string>` : ''}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${plistEscape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(logFile)}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
}

function serverJobIfInstalled() {
  const plist = serverPlistPath()
  if (!existsSync(plist)) return null
  return {
    kind: 'server',
    name: 'server',
    label: serverLaunchdLabel(),
    plist,
    content: serverPlistContent(),
  }
}

function desiredLaunchdJobs() {
  const serverConfig = loadServerConfig()
  const serverNames = Object.keys(serverConfig.servers || {}).sort()
  const jobs = [
    ...serverNames.map(name => daemonJobForConfigName(name)),
    ...configuredBots().map(botJob),
  ]
  const serverJob = serverJobIfInstalled()
  if (serverJob) jobs.push(serverJob)
  return jobs
}

function isManagedLaunchdLabel(label) {
  return label === 'com.tlda.fleet-daemon' ||
    label.startsWith('com.tlda.fleet-daemon.') ||
    label.startsWith('com.tlda.bot.') ||
    label === serverLaunchdLabel()
}

function existingManagedLaunchdJobs() {
  const dir = launchAgentsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(file => file.endsWith('.plist'))
    .map(file => {
      const label = file.slice(0, -'.plist'.length)
      if (!isManagedLaunchdLabel(label)) return null
      const plist = join(dir, file)
      return { label, plist, content: readFileSync(plist, 'utf8') }
    })
    .filter(Boolean)
}

function writeLaunchdJob(job) {
  if (!existsSync(dirname(job.plist))) mkdirSync(dirname(job.plist), { recursive: true })
  const logPath = job.content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)/)?.[1]
  if (logPath && !existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(job.plist, job.content)
}

async function applyLaunchdOperation(job, operation) {
  const target = daemonLaunchdTarget(job.label)
  const bootoutIfLoaded = async () => {
    try {
      await runLaunchctl(['bootout', target])
    } catch (e) {
      const text = e?.message || String(e)
      if (/No such process/i.test(text) || /Could not find service/i.test(text)) return
      throw e
    }
  }
  const bootstrapAndKickstart = async () => {
    await bootstrapLaunchdJob({
      plist: job.plist,
      label: job.label,
      domain: daemonLaunchdDomain(),
      runLaunchctl,
    })
  }
  try {
    if (operation === 'add') {
      writeLaunchdJob(job)
      await bootstrapAndKickstart()
    } else if (operation === 'update') {
      writeLaunchdJob(job)
      await bootoutIfLoaded()
      await bootstrapAndKickstart()
    } else if (operation === 'remove') {
      await bootoutIfLoaded()
      if (existsSync(job.plist)) unlinkSync(job.plist)
    } else {
      throw new Error(`unknown launchd apply operation: ${operation}`)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

function printApplyGroup(title, jobs) {
  console.log(`${title}: ${jobs.length}`)
  for (const job of jobs) {
    console.log(`  ${job.label}`)
    console.log(dim(`    ${job.plist}`))
  }
}

async function cmdConfigApply() {
  requireLaunchd()
  const dryRun = hasFlag('dry-run')
  const desired = desiredLaunchdJobs()
  const existing = existingManagedLaunchdJobs()
  const plan = planLaunchdApply({ desiredJobs: desired, existingJobs: existing })
  const failures = []

  if (dryRun) console.log(yellow('Dry run: no plists written and no launchctl commands run.'))
  console.log(`Declaration: ${CONFIG_DIR}`)
  console.log(`LaunchAgents: ${launchAgentsDir()}`)
  printApplyGroup('Add', plan.add)
  printApplyGroup('Update', plan.update)
  printApplyGroup('Remove', plan.remove)
  printApplyGroup('Unchanged', plan.unchanged)

  if (dryRun) return

  for (const job of plan.add) {
    const result = await applyLaunchdOperation(job, 'add')
    if (result.ok) console.log(green(`Added ${job.label}`))
    else failures.push({ job, op: 'add', error: result.error })
  }
  for (const job of plan.update) {
    const result = await applyLaunchdOperation(job, 'update')
    if (result.ok) console.log(green(`Updated ${job.label}`))
    else failures.push({ job, op: 'update', error: result.error })
  }
  for (const job of plan.remove) {
    const result = await applyLaunchdOperation(job, 'remove')
    if (result.ok) console.log(green(`Removed ${job.label}`))
    else failures.push({ job, op: 'remove', error: result.error })
  }

  for (const job of plan.unchanged) {
    console.log(dim(`Unchanged ${job.label}`))
  }

  if (failures.length) {
    console.error(red(`tlda config apply failed for ${failures.length} job(s):`))
    for (const failure of failures) {
      console.error(red(`  ${failure.op} ${failure.job.label}: ${failure.error}`))
    }
    process.exit(1)
  }

  console.log(green('tlda config apply complete.'))
}

async function bootstrapBot(bot) {
  const paths = botServicePaths(bot.name)
  await runLaunchctl(['bootstrap', `gui/${process.getuid()}`, paths.plist], { ignoreFailure: true })
  await runLaunchctl(['kickstart', daemonLaunchdTarget(paths.label)])
}

async function bootoutBot(bot) {
  await runLaunchctl(['bootout', daemonLaunchdTarget(botLaunchdLabel(bot.name))], { ignoreFailure: true })
}

function printBotPlan(bot) {
  const paths = botServicePaths(bot.name)
  console.log(`${bot.name}: ${paths.label}`)
  console.log(dim(`  Script: ${resolveBotScriptForCli(bot.script)}`))
  console.log(dim(`  Machine: ${botMachineId(bot)}`))
  console.log(dim(`  Tmux: ${paths.tmuxSession}`))
  console.log(dim(`  Plist: ${paths.plist}`))
  console.log(dim(`  Log: ${paths.logFile}`))
}

function sandboxDaemonConfig(configDir, label) {
  const source = resolveConfig()
  const configName = 'sandbox'
  return {
    configName,
    server: {
      defaultServer: configName,
      servers: {
        [configName]: {
          database: source.database.http,
          store: source.store.http,
          licenseKey: source.licenseKey,
        },
      },
    },
    daemon: {
      machineId: `${label}.${hostname().split('.')[0]}.${process.pid}`,
      regions: {},
      profiles: {},
      grants: {},
      models: {},
    },
    tokens: { tokenRw: getRwToken() || '' },
  }
}

async function writeSandboxDaemonPlist() {
  const label = getFlag('label') || 'com.tlda.fleet-daemon.SANDBOXTEST'
  const baseDir = getFlag('dir') || join(CONFIG_DIR, 'launchd-sandboxtest')
  const plist = getFlag('plist') || join(baseDir, `${label}.plist`)
  const configDir = join(baseDir, 'config')
  const logFile = join(configDir, 'fleet-daemon.log')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  const authority = sandboxDaemonConfig(configDir, label)
  writeFileSync(join(configDir, 'server.yaml'), stringifyYaml(authority.server))
  writeFileSync(join(configDir, 'daemon.yaml'), stringifyYaml(authority.daemon))
  writeFileSync(join(configDir, 'tokens.json'), JSON.stringify(authority.tokens, null, 2))
  await writeDaemonPlist({
    plist,
    label,
    logFile,
    configDir,
    configName: authority.configName,
    cliPath: join(_cliDir, 'tlda.mjs'),
    processTitle: `tlda-fleet-daemon-${label.replace(/[^A-Za-z0-9_.-]/g, '-')}`,
  })
  console.log(`Wrote test plist: ${plist}`)
  console.log(`  Label: ${label}`)
  console.log(`  Config dir: ${configDir}`)
  console.log(`  WorkingDirectory: ${FLEET_DAEMON_MAIN_ROOT}`)
  console.log(`  Log: ${logFile}`)
  console.log('\nYolo acceptance commands:')
  console.log(`  launchctl bootout ${daemonLaunchdTarget(label)} 2>/dev/null || true`)
  console.log(`  launchctl bootstrap ${daemonLaunchdDomain()} ${JSON.stringify(plist)}`)
  console.log(`  launchctl kickstart ${daemonLaunchdTarget(label)}`)
  console.log(`  tail -f ${JSON.stringify(logFile)}`)
  console.log(`  kill "$(cat ${JSON.stringify(join(configDir, 'fleet-daemon.pid'))})"`)
  console.log(`  launchctl print ${daemonLaunchdTarget(label)}`)
  console.log(`\nCleanup after proof:`)
  console.log(`  launchctl bootout ${daemonLaunchdTarget(label)} 2>/dev/null || true`)
  return
}

function lastDaemonConnectedTarget() {
  try {
    const log = readFileSync(FLEET_DAEMON_LOGFILE, 'utf8')
    const matches = [...log.matchAll(/\[daemon\] connecting to (wss?:\/\/[^?\s]+)/g)]
    return matches.length ? matches[matches.length - 1][1] : null
  } catch {
    return null
  }
}

function runningFleetDaemonPid() {
  if (!existsSync(FLEET_DAEMON_PIDFILE)) return null
  const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function parseFleetDaemonPidfile() {
  if (!existsSync(FLEET_DAEMON_PIDFILE)) return null
  const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function actualFleetDaemonPids() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return parseFleetDaemonPids(out)
  } catch {
    return []
  }
}

function parentPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const ppid = parseInt(out, 10)
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null
  } catch {
    return null
  }
}

function processTreeOwnsPid(ancestorPid, childPid) {
  if (!ancestorPid || !childPid) return false
  if (ancestorPid === childPid) return true
  const seen = new Set()
  let pid = childPid
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    pid = parentPid(pid)
    if (pid === ancestorPid) return true
  }
  return false
}

function daemonTargetIdentity() {
  const server = getFleetServerUrl()
  const envName = getActiveConfigName()
  if (!envName) throw new Error('cannot identify daemon target: active config name is missing')
  const machineId = getMachineId() || hostname().split('.')[0]
  const lockScope = `${machineId}:${envName}`
  const lockPath = daemonSingletonLockPath({ configDir: CONFIG_DIR, origin: lockScope })
  return { machineId, envName, server, lockScope, lockPath }
}

async function launchdDaemonPid(label = FLEET_DAEMON_LABEL) {
  try {
    const out = await runLaunchctl(['print', daemonLaunchdTarget(label)])
    return parseLaunchdPid(out)
  } catch {
    return null
  }
}

async function waitForFleetDaemonPid({ previousPid = null, timeoutMs = 30_000, supervised = false } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = supervised ? await launchdDaemonPid() : runningFleetDaemonPid()
    if (pid && pid !== previousPid) return pid
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

async function terminateFleetDaemon(pid) {
  const identity = daemonTargetIdentity()
  await terminatePidAndWait({
    pid,
    timeoutMs: 10_000,
    inspectLock: () => inspectSingletonLock({ lockPath: identity.lockPath }),
  })
}

function targetServerHostPort(serverUrl) {
  const u = new URL(serverUrl)
  return {
    host: u.hostname,
    port: u.port || (u.protocol === 'http:' ? '80' : '443'),
  }
}

function hasEstablishedTcpToTarget(pid, serverUrl) {
  const { host, port } = targetServerHostPort(serverUrl)
  try {
    const out = execFileSync('lsof', ['-P', '-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED'], { encoding: 'utf8' })
    return out.split('\n').some(line =>
      line.includes(`->${host}:${port}`) &&
      line.includes('(ESTABLISHED)'),
    )
  } catch {
    return false
  }
}

function hasDaemonReadyLogMarker(pid, identity) {
  try {
    return daemonReadyLogEvidence(readFileSync(FLEET_DAEMON_LOGFILE, 'utf8'), {
      pid,
      server: identity.server,
      machineId: identity.machineId,
      envName: identity.envName,
    })
  } catch {
    return false
  }
}

async function inspectTargetFleetDaemonReadiness(expectedPid, { supervised = false } = {}) {
  const identity = daemonTargetIdentity()
  const lockInspection = inspectSingletonLock({ lockPath: identity.lockPath })
  const launchdPid = supervised ? await launchdDaemonPid() : null
  const launchdOwnsDaemon = !!(supervised && launchdPid && processTreeOwnsPid(launchdPid, expectedPid))
  return isCompleteTargetDaemonReady({
    expectedPid,
    lockInspection,
    pidFilePid: parseFleetDaemonPidfile(),
    launchdPid,
    launchdOwnsDaemon,
    observedDaemonPids: actualFleetDaemonPids(),
    flyWsConnected: hasEstablishedTcpToTarget(expectedPid, identity.server),
    watcherReady: hasDaemonReadyLogMarker(expectedPid, identity),
  })
}

async function waitForSupervisedFleetDaemonReady({ previousPid = null, timeoutMs = DEFAULT_SUPERVISED_START_TIMEOUT_MS } = {}) {
  const result = await pollTargetDaemonReadiness({
    previousPid,
    timeoutMs,
    getCandidatePid: () => launchdDaemonPid(),
    inspectReadiness: (pid) => inspectTargetFleetDaemonReadiness(pid, { supervised: true }),
  })
  return result.ready ? result.pid : null
}

async function verifyTargetFleetDaemon(expectedPid, { supervised = false } = {}) {
  const identity = daemonTargetIdentity()
  const lockInspection = inspectSingletonLock({ lockPath: identity.lockPath })
  const launchdPid = supervised ? await launchdDaemonPid() : null
  const launchdOwnsDaemon = !!(supervised && launchdPid && processTreeOwnsPid(launchdPid, expectedPid))
  assertTargetEnvironmentDaemon({
    expectedPid,
    lockInspection,
    pidFilePid: parseFleetDaemonPidfile(),
    launchdPid,
    launchdOwnsDaemon,
    observedDaemonPids: actualFleetDaemonPids(),
  })
  const readiness = isCompleteTargetDaemonReady({
    expectedPid,
    lockInspection,
    pidFilePid: parseFleetDaemonPidfile(),
    launchdPid,
    launchdOwnsDaemon,
    observedDaemonPids: actualFleetDaemonPids(),
    flyWsConnected: hasEstablishedTcpToTarget(expectedPid, identity.server),
    watcherReady: hasDaemonReadyLogMarker(expectedPid, identity),
  })
  if (!readiness.ready) throw new Error(readiness.reason)
  return identity
}

function currentDaemonCodeSha() {
  try {
    return execFileSync('git', ['-C', FLEET_DAEMON_MAIN_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// Idempotent daemon start — ensure launchd has the singleton job loaded.
// Used by `tlda server start` to make sure the daemon comes up alongside
// the server. The daemon dying silently was a recurring source of pain.
async function ensureFleetDaemonRunning() {
  if (process.platform !== 'darwin') return
  if (!existsSync(FLEET_DAEMON_SCRIPT)) return // not installed; silently skip
  const pid = runningFleetDaemonPid()
  if (pid) {
    console.log(yellow('Fleet daemon already running outside launchd') + dim(` (pid ${pid})`))
    return
  }
  await writeDaemonPlist()
  await bootstrapDaemonPlist()
  console.log(green('Fleet daemon launchd job started.'))
}

async function cmdFleetWatch(sub) {
  const daemonScript = FLEET_DAEMON_SCRIPT

  if (sub === 'install') {
    requireLaunchd()
    if (!existsSync(daemonScript)) {
      console.error(red(`Daemon script not found: ${daemonScript}`))
      process.exit(1)
    }
    await writeDaemonPlist()
    console.log(`Installed ${FLEET_DAEMON_PLIST}`)
    console.log(`  Label: ${FLEET_DAEMON_LABEL}`)
    console.log(`  WorkingDirectory: ${FLEET_DAEMON_MAIN_ROOT}`)
    console.log(`  Log: ${FLEET_DAEMON_LOGFILE}`)
    console.log('\nThe fleet daemon will auto-restart on crash and start on login.')
    console.log('Run `tlda daemon start` to start now.')
    return
  }

  if (sub === 'uninstall') {
    requireLaunchd()
    await bootoutDaemonLabel()
    if (existsSync(FLEET_DAEMON_PLIST)) unlinkSync(FLEET_DAEMON_PLIST)
    console.log(green('Uninstalled fleet daemon launchd service.'))
    return
  }

  if (sub === 'write-test-plist') {
    requireLaunchd()
    return writeSandboxDaemonPlist()
  }

  if (sub === 'stop') {
    requireLaunchd()
    const existingPid = runningFleetDaemonPid()
    await bootoutDaemonLabel()
    if (existingPid) await terminateFleetDaemon(existingPid)
    console.log(green('Fleet daemon launchd job stopped.'))
    return
  }

  if (sub === 'status') {
    if (process.platform === 'darwin' && existsSync(FLEET_DAEMON_PLIST)) {
      try {
        const out = await runLaunchctl(['print', daemonLaunchdTarget()])
        const pidLine = out.split('\n').find(line => line.trim().startsWith('pid ='))
        const stateLine = out.split('\n').find(line => line.trim().startsWith('state ='))
        console.log(green('Fleet daemon launchd job loaded'))
        if (stateLine) console.log(dim(`  ${stateLine.trim()}`))
        if (pidLine) console.log(dim(`  ${pidLine.trim()}`))
        console.log(dim(`  Config target: ${getFleetServerUrl()}`))
        const connectedTarget = lastDaemonConnectedTarget()
        if (connectedTarget) console.log(dim(`  Last WS target: ${connectedTarget}`))
        console.log(dim(`  Plist: ${FLEET_DAEMON_PLIST}`))
        console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
        return
      } catch {
        // Expected when a plist exists on disk but the launchd job is not loaded.
      }
    }
    if (existsSync(FLEET_DAEMON_PIDFILE)) {
      const pid = parseInt(readFileSync(FLEET_DAEMON_PIDFILE, 'utf8').trim(), 10)
      try {
        process.kill(pid, 0)
        console.log(yellow('Fleet daemon running outside launchd') + dim(` (pid ${pid})`))
        console.log(dim(`  Config target: ${getFleetServerUrl()}`))
        const connectedTarget = lastDaemonConnectedTarget()
        if (connectedTarget) console.log(dim(`  Last WS target: ${connectedTarget}`))
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
    const child = cpSpawn(process.execPath, ['--import', 'tsx', daemonScript], {
      stdio: 'inherit',
      ...(process.env.TLDA_DAEMON_PROCESS_TITLE ? { argv0: process.env.TLDA_DAEMON_PROCESS_TITLE } : {}),
      env: {
        ...process.env,
        TMUX: undefined,
        TMUX_PANE: undefined,
        ...(hasTls && !process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: TLS_CA_PATH } : {}),
      },
    })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  if (sub === 'start') {
    requireLaunchd()

    if (!existsSync(daemonScript)) {
      console.error(red(`Daemon script not found: ${daemonScript}`))
      process.exit(1)
    }

    const existingPid = runningFleetDaemonPid()
    if (existingPid) {
      const connectedTarget = lastDaemonConnectedTarget()
      const codeSha = currentDaemonCodeSha()
      const identity = daemonTargetIdentity()
      const supervisedPid = await launchdDaemonPid()
      const launchdOwnsExisting = !!(supervisedPid && processTreeOwnsPid(supervisedPid, existingPid))
      if (launchdOwnsExisting) {
        console.log(green('Fleet daemon launchd job already running') + dim(` (pid ${existingPid})`))
        try {
          await verifyTargetFleetDaemon(existingPid, { supervised: true })
          console.log(dim(`  Verified target environment readiness for ${identity.machineId}:${identity.envName}.`))
        } catch (e) {
          // This operator command surfaces unhealthy supervision on stderr and exits nonzero.
          console.error(red(`Fleet daemon is supervised but unhealthy: ${e?.message || String(e)}`))
          process.exit(1)
        }
        return
      }
      console.log(yellow('Fleet daemon is running outside launchd') + dim(` (pid ${existingPid})`))
      console.log(yellow('Starting bounded stop/start transition to launchd supervision.'))
      console.log(dim('  This is not a no-gap handoff.'))
      console.log(dim(`  Supervised readiness wait: ${DEFAULT_SUPERVISED_START_TIMEOUT_MS}ms.`))
      console.log(dim('  Healthy means: launchd pid + target lock + pidfile + established target WS + daemon-ready watcher marker.'))
      console.log(dim('  If launchd accepts the job but readiness is slow, this command reports pending without starting an unsupervised daemon.'))
      console.log(dim(`  Config target: ${getFleetServerUrl()}`))
      if (connectedTarget) console.log(dim(`  Last WS target: ${connectedTarget}`))
      if (codeSha) console.log(dim(`  Code SHA: ${codeSha}`))
      console.log(dim(`  Target daemon: ${identity.machineId}:${identity.envName}`))
      console.log(dim(`  Target lock: ${identity.lockPath}`))
      console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
      try {
        const result = await runDaemonStartWithSupervisedNoop({
          existingPid,
          getLaunchdPid: async () => supervisedPid,
          launchdOwnsExisting: (launchdPid, daemonPid) => processTreeOwnsPid(launchdPid, daemonPid),
          verifyTargetDaemon: verifyTargetFleetDaemon,
          runBoundedTransition: () => runBoundedDaemonStartTransition({
            existingPid,
            writePlist: async () => {
              await probeDaemonLaunchdStartCapability()
              await writeDaemonPlist()
            },
            bootstrap: () => bootstrapDaemonPlist(),
            stopExisting: terminateFleetDaemon,
            waitSupervised: ({ previousPid, timeoutMs }) => waitForSupervisedFleetDaemonReady({ previousPid, timeoutMs }),
            verifyTargetDaemon: verifyTargetFleetDaemon,
            log: ({ supervisedTimeoutMs }) => {
              console.log(dim(`  Bounded launchd readiness wait: ${supervisedTimeoutMs}ms`))
            },
          }),
        })
        if (result.mode === 'already-supervised') {
          console.log(green('Fleet daemon launchd job already running') + dim(` (pid ${result.pid})`))
          console.log(dim(`  Verified target environment readiness for ${identity.machineId}:${identity.envName}.`))
          return
        }
        if (result.mode === 'launchd-pending') {
          console.log(yellow('Fleet daemon launchd job accepted; readiness pending.'))
          console.log(dim(`  ${result.reason}`))
          console.log(dim('  Managed by launchd (auto-restarts).'))
          console.log(dim(`  Target daemon: ${identity.machineId}:${identity.envName}`))
          console.log(dim(`  Target lock: ${identity.lockPath}`))
          console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
          return
        }
        console.log(green('Fleet daemon launchd job started') + dim(` (pid ${result.pid})`))
        console.log(dim(`  Verified target environment singleton lock for ${identity.machineId}:${identity.envName}.`))
        console.log(dim(`  Launchd domain: ${daemonLaunchdDomain()}`))
        console.log(dim(`  Plist: ${FLEET_DAEMON_PLIST}`))
        console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
      } catch (e) {
        console.error(red(e?.message || String(e)))
        process.exit(1)
      }
      return
    }

    await writeDaemonPlist()
    await bootstrapDaemonPlist()
    const result = await pollTargetDaemonReadiness({
      timeoutMs: 5_000,
      getCandidatePid: () => launchdDaemonPid(),
      inspectReadiness: (pid) => inspectTargetFleetDaemonReadiness(pid, { supervised: true }),
    })
    if (result.ready) {
      console.log(green(`Fleet daemon launchd job started`) + dim(` (pid ${result.pid})`))
    } else {
      console.log(yellow('Fleet daemon launchd job accepted; readiness pending.'))
      console.log(dim(`  Last readiness check: ${result.reason}`))
    }
    console.log(dim(`  Managed by launchd (auto-restarts).`))
    console.log(dim(`  Plist: ${FLEET_DAEMON_PLIST}`))
    console.log(dim(`  Log: ${FLEET_DAEMON_LOGFILE}`))
    return
  }

  console.error(`Unknown subcommand: tlda daemon ${sub}`)
  console.error('Usage: tlda daemon [start|stop|status|log|run|install|uninstall|write-test-plist]')
  process.exit(1)
}

async function cmdBot() {
  const sub = getPositional(0) || 'list'
  const name = getPositional(1)
  const dryRun = hasFlag('dry-run')

  if (sub === 'list') {
    for (const bot of configuredBots()) printBotPlan(bot)
    return
  }

  if (sub === 'install') {
    const bots = findConfiguredBot(name)
    if (!dryRun) requireLaunchd()
    for (const bot of bots) {
      if (dryRun) {
        console.log('Would install bot service:')
        printBotPlan(bot)
        continue
      }
      const paths = writeBotPlist(bot)
      console.log(`Installed ${paths.plist}`)
      console.log(`  Label: ${paths.label}`)
      console.log(`  Script: ${resolveBotScriptForCli(bot.script)}`)
      console.log(`  Tmux: ${paths.tmuxSession}`)
      console.log(`  Log: ${paths.logFile}`)
    }
    if (!dryRun) console.log('\nRun `tlda bot start <name>` to start now.')
    return
  }

  if (sub === 'uninstall') {
    const bots = findConfiguredBot(name)
    requireLaunchd()
    for (const bot of bots) {
      const paths = botServicePaths(bot.name)
      await bootoutBot(bot)
      if (existsSync(paths.plist)) unlinkSync(paths.plist)
      console.log(green(`Uninstalled ${paths.label}.`))
    }
    return
  }

  if (sub === 'start') {
    const bots = findConfiguredBot(name)
    if (!dryRun) requireLaunchd()
    for (const bot of bots) {
      if (dryRun) {
        console.log('Would start bot service:')
        printBotPlan(bot)
        continue
      }
      const paths = existsSync(botServicePaths(bot.name).plist) ? botServicePaths(bot.name) : writeBotPlist(bot)
      await bootstrapBot(bot)
      console.log(green(`Started ${paths.label}.`))
      console.log(dim(`  Tmux: ${paths.tmuxSession}`))
      console.log(dim(`  Log: ${paths.logFile}`))
    }
    return
  }

  if (sub === 'stop') {
    const bots = findConfiguredBot(name)
    requireLaunchd()
    for (const bot of bots) {
      const paths = botServicePaths(bot.name)
      await bootoutBot(bot)
      try { (await import('child_process')).execFileSync('tmux', ['kill-session', '-t', paths.tmuxSession], { stdio: 'ignore' }) } catch {}
      console.log(green(`Stopped ${paths.label}.`))
    }
    return
  }

  if (sub === 'status') {
    const bots = findConfiguredBot(name)
    for (const bot of bots) {
      const paths = botServicePaths(bot.name)
      if (process.platform === 'darwin' && existsSync(paths.plist)) {
        try {
          const out = await runLaunchctl(['print', daemonLaunchdTarget(paths.label)])
          const pidLine = out.split('\n').find(line => line.trim().startsWith('pid ='))
          const stateLine = out.split('\n').find(line => line.trim().startsWith('state ='))
          console.log(green(`${bot.name} service loaded`) + dim(` (${paths.label})`))
          if (stateLine) console.log(dim(`  ${stateLine.trim()}`))
          if (pidLine) console.log(dim(`  ${pidLine.trim()}`))
          console.log(dim(`  Tmux: ${paths.tmuxSession}`))
          console.log(dim(`  Log: ${paths.logFile}`))
          continue
        } catch {}
      }
      console.log(red(`${bot.name} service not running`) + dim(` (${paths.label})`))
    }
    return
  }

  if (sub === 'log' || sub === 'logs') {
    const bots = findConfiguredBot(name)
    const { execSync } = await import('child_process')
    for (const bot of bots) {
      const { logFile } = botServicePaths(bot.name)
      if (existsSync(logFile)) execSync(`tail -50 "${logFile}"`, { stdio: 'inherit' })
      else console.log(`No bot log: ${bot.name}`)
    }
    return
  }

  console.error(`Unknown subcommand: tlda bot ${sub}`)
  console.error('Usage: tlda bot [list|install|uninstall|start|stop|status|log] [name] [--dry-run]')
  process.exit(1)
}

async function cmdWatch() {
  const arg1 = getPositional(0)

  // Fleet-daemon dispatch — `tlda daemon start/stop/status/log/run`
  const daemonSubs = new Set(['start', 'stop', 'status', 'log', 'logs', 'run', 'install', 'uninstall', 'write-test-plist'])
  if (daemonSubs.has(arg1)) {
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
    console.error(`  Run \`tlda doc link ${name}\` first, or did you mean \`tlda daemon start\`?`)
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
  const browser = getFlag('browser') || loadCliConfig().browser || null
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
  // Three shapes (Skip-confirmed):
  //   (no arg) → index page (root `/`, docName=null)
  //   `.`      → the project inferred from the cwd; error if none found
  //   <name>   → that specific doc
  const arg = getPositional(0)
  let name
  if (arg === undefined) {
    name = null
  } else if (arg === '.') {
    name = await inferProjectName()
    if (!name) {
      console.error('No project found for the current directory. Run `tlda doc share <name>` or `tlda doc share` for the index page.')
      process.exit(1)
    }
  } else {
    name = arg
  }

  const serverUrl = getServer()
  const port = new URL(serverUrl).port || getPort()
  const readToken = getReadToken()

  if (!readToken) {
    console.error('No read token configured. Run `tlda config auth init` to generate tokens.')
    process.exit(1)
  }

  const printQr = async (url) => {
    try {
      const qr = await import('qrcode-terminal')
      qr.default.generate(url, { small: true })
    } catch {}
  }

  const sel = selectDocShareBase({
    serverUrl,
    port,
    funnelUrl: getFunnelUrl(),
    tailscaleIp: findTailscaleIPv4(),
    lanIp: findLanIPv4(),
    hasTls,
  })
  const url = viewerLoginUrl(sel.base, name, readToken)
  const unavailable = sel.shareable === false
  console.log(`${bold(sel.label)}${unavailable ? ` ${dim('(not reachable from other devices)')}` : ''}`)
  console.log(`  ${cyan(url)}`)
  if (sel.note) console.log(`  ${dim(sel.note)}`)
  console.log()
  if (!unavailable) {
    await printQr(url)
    return
  }
  console.log(dim(`Reason: ${sel.reason}`))
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

async function cmdMoveProject() {
  const name = getPositional(0) || await inferProjectName()
  const targetConfig = getPositional(1)
  if (!name || !targetConfig) {
    console.error('Usage: tlda doc move <project> <config>')
    process.exit(1)
  }
  const selectedConfig = getActiveConfigName()
  const target = resolveConfig(targetConfig)
  let project = await api('GET', `/api/projects/${encodeURIComponent(name)}`)
  if (!project.sourceDir) throw new Error(`Project "${name}" has no local source directory; cannot change daemon ownership.`)
  const sourceDir = resolve(project.sourceDir)
  const projectWorlds = readProjectWorlds(projectWorldsPath(CONFIG_DIR))
  const sourceConfig = projectWorlds[sourceDir] || selectedConfig
  const alreadyOwned = sourceConfig === targetConfig
  if (sourceConfig !== selectedConfig) {
    const source = cfg.configs?.[sourceConfig]
    if (!source || typeof source.store !== 'string') throw new Error(`Recorded source config "${sourceConfig}" is missing.`)
    project = await apiAt(source.store.replace(/\/+$/, ''), 'GET', `/api/projects/${encodeURIComponent(name)}`)
  }
  if (!existsSync(sourceDir)) throw new Error(`Project source directory does not exist: ${sourceDir}`)
  const targetServer = target.store.replace(/\/+$/, '')
  if (hasFlag('dry-run')) {
    console.log(`[dry-run] would ${alreadyOwned ? 'ensure' : 'move'} project "${name}" ${alreadyOwned ? `in ${targetConfig}` : `from ${sourceConfig} to ${targetConfig}`}`)
    console.log(`  working directory stays: ${sourceDir}`)
    console.log(`  daemon ownership becomes: ${targetConfig}`)
    console.log(`  target viewer: ${targetServer}/?doc=${encodeURIComponent(name)}`)
    return
  }

  try {
    await apiAt(targetServer, 'POST', '/api/projects', {
      name: project.name,
      title: project.title || project.name,
      mainFile: project.mainFile,
      format: project.format,
      sourceDir,
      ...(project.members ? { members: project.members } : {}),
    })
  } catch (e) {
    if (!String(e.message).includes('already exists')) throw e
  }
  const moveContext = { format: project.format, mainFile: project.mainFile }
  const files = collectSourceFiles(sourceDir, moveContext)
  const targetAuthority = await apiAt(targetServer, 'GET', `/api/projects/${encodeURIComponent(name)}/source-authority`)
  await apiAt(targetServer, 'POST', `/api/projects/${encodeURIComponent(name)}/push`, {
    files,
    sourceManifest: sourceManifestForFiles(files, moveContext),
    sourceDir,
    expectedRevision: targetAuthority.currentRevision,
  }, { timeoutMs: 120000 })
  writeProjectWorld(projectWorldsPath(CONFIG_DIR), sourceDir, targetConfig)

  const daemonEnv = { ...process.env, TLDA_CONFIG: targetConfig }
  delete daemonEnv.TLDA_SERVER
  delete daemonEnv.TLDA_SYNC_SERVER
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'daemon', 'start', '--config', targetConfig], {
    cwd: FLEET_DAEMON_MAIN_ROOT,
    stdio: 'inherit',
    env: daemonEnv,
  })

  console.log(green(`${alreadyOwned ? 'Confirmed' : 'Moved'} project "${name}" ${alreadyOwned ? `in ${targetConfig}` : `from ${sourceConfig} to ${targetConfig}`}.`))
  console.log(dim(`  Working directory unchanged: ${sourceDir}`))
  console.log(dim(`  Daemon ownership: ${targetConfig}`))
  console.log(dim(`  Target viewer: ${targetServer}/?doc=${encodeURIComponent(name)}`))
  console.log(green(`  ${targetConfig} daemon world is running.`))
}

async function cmdMcpSetup() {
  const tldaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const nodePath = process.execPath
  const configName = getActiveConfigName()
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
        env: { TLDA_CONFIG: configName }
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
  console.log(`  config:    ${configName}`)
  console.log()
  console.log(`Open Claude Code in this directory and the tlda + fleet tools will be available.`)
}

async function cmdConfig() {
  const sub = getPositional(0)
  if (sub === 'apply') {
    await cmdConfigApply()
  } else if (sub === 'set') {
    const key = getPositional(1)
    const value = getPositional(2)
    if (!key || !value) { console.error('Usage: tlda config set <key> <value>'); process.exit(1) }
    if (key !== 'browser') throw new Error('cli.yaml supports only the browser preference')
    saveCliConfig({ browser: value })
    console.log(`Set ${key} = ${value}`)
  } else if (sub === 'get') {
    const key = getPositional(1)
    const config = loadCliConfig()
    console.log(key ? (config[key] || '') : JSON.stringify(config, null, 2))
  } else {
    console.log(`Server: ${getServer()}`)
    console.log(`CLI config: ${CONFIG_DIR}/cli.yaml`)
  }
}

async function cmdAuth() {
  const sub = getPositional(0)

  if (sub === 'init') {
    const tokenRw = randomBytes(24).toString('base64url')
    const tokenRead = randomBytes(24).toString('base64url')
    // Tokens live in their own tokens.json — never config.json or daemon.yaml.
    saveTokens({ tokenRw, tokenRead })

    console.log(green('Tokens generated and saved to tokens.json.'))
    console.log()
    console.log(`  RW token:   ${bold(tokenRw)}`)
    console.log(`  Read token: ${bold(tokenRead)}`)
    console.log()
    console.log(dim(`CLI config: ${CONFIG_DIR}/cli.yaml`))
    console.log(dim(`Restart the server for tokens to take effect.`))
    return
  }

  if (sub === 'show') {
    console.log(`  RW token:   ${getRwToken() || dim('(not set)')}`)
    console.log(`  Read token: ${getReadToken() || dim('(not set)')}`)
    return
  }

  console.log('Usage: tlda auth [init|show]')
  console.log('  init   Generate and save new tokens')
  console.log('  show   Show current tokens')
}


function cmdCompletions() {
  // Fetch project names at completion time via a helper function in the script
  const commandEntries = TOP_LEVEL_COMMANDS
    .map(([name, description]) => `    '${name}:${description}'`)
    .join('\n')
  const docSubs = DOC_COMMANDS.map(([name]) => `'${name}'`).join(' ')
  const serverSubs = SERVER_COMMANDS.map(([name]) => `'${name}'`).join(' ')
  const daemonSubs = DAEMON_COMMANDS.map(([name]) => `'${name}'`).join(' ')
  const botSubs = BOT_COMMANDS.map(([name]) => `'${name}'`).join(' ')
  const agentSubs = [
    'list', 'mint', 'wake', 'move', 'set-mint-machine',
    'check-ready', 'attach', 'hibernate', 'dismiss', 'permission', 'permissions', 'models',
  ].map(s => `'${s}'`).join(' ')
  const configSubs = ['apply', 'set', 'get', 'setup', 'mcp-setup', 'auth'].map(s => `'${s}'`).join(' ')

  console.log(`#compdef tlda
# Install: tlda completions > ~/.zsh/completions/_tlda && fpath=(~/.zsh/completions $fpath)
# Then restart your shell or run: autoload -Uz compinit && compinit

_tlda_projects() {
  local -a projects
  projects=(\${(f)"$(tlda doc list 2>/dev/null | sed 's/^ *//' | cut -d: -f1)"})
  _describe 'project' projects
}

_tlda_spawn_model_aliases() {
  local -a models
  models=(\${(f)"$(tlda agent models --json 2>/dev/null | node -e '
let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => {
  try {
    const c = JSON.parse(s || \"{}\");
    for (const m of c.models || []) console.log(String(m.alias) + \":\" + String(m.description || m.id || m.alias));
  } catch { /* completion probe failed: emit no model candidates */ }
})')"})
  _describe 'model' models
}

_tlda_spawn_model_arg() {
  local i
  for (( i = 1; i < \${#words}; i++ )); do
    if [[ \${words[$i]} == "--model" ]]; then
      echo \${words[$((i+1))]}
      return
    fi
  done
}

_tlda_spawn_option_flags() {
  local model="$(_tlda_spawn_model_arg)"
  [[ -z "$model" ]] && return
  local -a opts
  opts=(\${(f)"$(tlda agent models --json 2>/dev/null | MODEL="$model" TLDA_COMP_WORDS="\${(pj:\n:)words}" node -e '
let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => {
  try {
    const c = JSON.parse(s || \"{}\");
    const m = (c.models || []).find(x => x.alias === process.env.MODEL);
    const words = (process.env.TLDA_COMP_WORDS || \"\").split(\"\\n\").filter(Boolean);
    const kwargs = {};
    for (let i = 0; i < words.length - 1; i++) if (words[i].startsWith(\"--\")) kwargs[words[i].slice(2)] = words[i + 1];
    const active = {};
    function visit(options) {
      for (const [name, spec] of Object.entries(options || {})) {
        active[name] = spec;
        const value = kwargs[name] || spec.default;
        const child = spec.values?.[value]?.options;
        if (child) visit(child);
      }
    }
    visit(m?.options || {});
    for (const name of Object.keys(active)) console.log(\"--\" + name + \":\" + name);
  } catch { /* completion probe failed: emit no option flags */ }
})')"})
  _describe 'model option' opts
}

_tlda_spawn_option_values() {
  local flag="\${words[$((CURRENT-1))]#--}"
  local model="$(_tlda_spawn_model_arg)"
  [[ -z "$model" || -z "$flag" ]] && return
  local -a vals
  vals=(\${(f)"$(tlda agent models --json 2>/dev/null | MODEL="$model" OPT="$flag" TLDA_COMP_WORDS="\${(pj:\n:)words}" node -e '
let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => {
  try {
    const c = JSON.parse(s || \"{}\");
    const m = (c.models || []).find(x => x.alias === process.env.MODEL);
    const words = (process.env.TLDA_COMP_WORDS || \"\").split(\"\\n\").filter(Boolean);
    const kwargs = {};
    for (let i = 0; i < words.length - 1; i++) if (words[i].startsWith(\"--\")) kwargs[words[i].slice(2)] = words[i + 1];
    const active = {};
    function visit(options) {
      for (const [name, spec] of Object.entries(options || {})) {
        active[name] = spec;
        const value = kwargs[name] || spec.default;
        const child = spec.values?.[value]?.options;
        if (child) visit(child);
      }
    }
    visit(m?.options || {});
    const opt = active[process.env.OPT];
    for (const value of Object.keys(opt?.values || {})) console.log(value + (value === opt.default ? \":default\" : \"\"));
  } catch { /* completion probe failed: emit no option values */ }
})')"})
  _describe "$flag" vals
}

_tlda_agent_spawn_args() {
  if [[ \${words[$((CURRENT-1))]} == "--model" ]]; then
    _tlda_spawn_model_aliases
    return
  fi
  if [[ \${words[$((CURRENT-1))]} == --* ]]; then
    _tlda_spawn_option_values
    return
  fi
  if [[ \${words[$CURRENT]} == --* ]]; then
    local -a base=(--model --cwd --permissions --permission)
    _describe 'option' base
    _tlda_spawn_option_flags
    return
  fi
}

_tlda() {
  local -a commands
  commands=(
${commandEntries}
  )

  _arguments -C '1:command:->cmd' '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        doc)
          if (( CURRENT == 2 )); then
            local -a subs=(${docSubs})
            _describe 'subcommand' subs
          else
            case $words[2] in
              link|push|open|status|errors|delete)
                _tlda_projects
                ;;
            esac
          fi
          ;;
        server)
          local -a subs=(${serverSubs})
          _describe 'subcommand' subs
          ;;
        daemon)
          local -a subs=(${daemonSubs})
          _describe 'subcommand' subs
          ;;
        bot)
          local -a subs=(${botSubs})
          _describe 'subcommand' subs
          ;;
        agent)
          if (( CURRENT == 2 )); then
            local -a subs=(${agentSubs})
            _describe 'subcommand' subs
          else
            case $words[2] in
              mint|wake|enroll)
                _tlda_agent_spawn_args
                ;;
            esac
          fi
          ;;
        config)
          local -a subs=(${configSubs})
          _describe 'subcommand' subs
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
    execSync('node ' + JSON.stringify(join(tldaRoot, 'cli', 'tlda.mjs')) + ' server start', { stdio: 'pipe', timeout: 40_000 })
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

// ---- agent commands ----
// `create` starts a new agent; `wake` brings back an existing hibernating one. The
// implementation still uses the spawn library internally, but that is not part
// of the operator-facing lifecycle vocabulary.

function agentSessionName(name) {
  return name.startsWith('fleet-') ? name : `fleet-${name}`
}

function tmuxBase() {
  const sock = readDaemonConfig().tmuxSocket || null
  return sock ? ['-L', sock] : []
}

async function assertNotAgentContext() {
  const agentEnv = ['FLEET_ID', 'FLEET_HARNESS', 'FLEET_TMUX_SESSION', 'FLEET_NAME'].filter(k => process.env[k])
  if (agentEnv.length) {
    throw new Error(`Refusing: this tlda agent command is user/operator-only and cannot run from an agent context (${agentEnv.join(', ')} set).`)
  }

  if (process.env.TMUX) {
    const { spawnSync } = await import('child_process')
    const res = spawnSync('tmux', [...tmuxBase(), 'display-message', '-p', '#S'], { encoding: 'utf8' })
    const session = res.status === 0 ? res.stdout.trim() : ''
    if (session.startsWith('fleet-')) {
      throw new Error(`Refusing: this tlda agent command is user/operator-only and cannot run from fleet tmux session "${session}".`)
    }
  }
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

async function callLocalDaemonLifecycle(op, params = {}, { socketPath = FLEET_DAEMON_SOCKET, timeoutMs = 120000, onEvent = null } = {}) {
  const { createConnection } = await import('node:net')
  return await new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`local daemon ${op} timed out; use \`tlda doctor yolo\` only for break-glass repair`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.end(JSON.stringify({ op, params }))
    })
    const handlePayload = payload => {
      if (payload.event) {
        onEvent?.(payload.event, payload.data || {})
        return
      }
      if (!payload.ok) throw new Error(payload.error || `local daemon ${op} failed`)
      settled = true
      clearTimeout(timer)
      resolvePromise(payload.result)
    }
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          handlePayload(JSON.parse(line))
        } catch (e) {
          fail(e)
          break
        }
      }
    })
    socket.on('error', error => {
      clearTimeout(timer)
      const message = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? `local fleet daemon is unavailable; start it with \`tlda daemon start\` or use \`tlda doctor yolo\` for break-glass repair`
        : `local fleet daemon ${op} failed: ${error.message}`
      fail(new Error(message))
    })
    socket.on('close', () => {
      if (settled) return
      clearTimeout(timer)
      try {
        const line = buffer.trim()
        if (!line) throw new Error(`local daemon ${op} ended without a result`)
        handlePayload(JSON.parse(line))
      } catch (e) {
        fail(e)
      }
    })
  })
}

function printMintLifecycleEvent(event, data = {}) {
  const fleetId = data.fleet_id || data.fleetId || null
  const localId = data.local_agent_id || data.localAgentId || null
  const tmuxSession = data.tmux_session || data.tmuxSession || null
  if (event === 'local-mint') {
    console.log(`Local mint ${localId || '(pending local id)'}${tmuxSession ? ` in ${tmuxSession}` : ''}`)
    return
  }
  if (event === 'local-launch') {
    console.log(`Local launch ${localId || '(pending local id)'}${tmuxSession ? ` in ${tmuxSession}` : ''}`)
    return
  }
  if (event === 'server-registration-joined') {
    console.log(`Server registration joined ${fleetId || '(pending fleet id)'}`)
    return
  }
  if (event === 'server-binding-joined') {
    console.log(`Server binding joined ${fleetId || '(pending fleet id)'}`)
    return
  }
  if (event === 'server-registration-deferred') {
    console.log(`Server registration deferred${fleetId ? ` for ${fleetId}` : ''}: ${data.reason || 'server unavailable'}`)
    return
  }
  if (event === 'server-reconciliation-deferred') {
    console.error(`Server wake reconciliation deferred${fleetId ? ` for ${fleetId}` : ''}: ${data.reason || 'server unavailable'}`)
    return
  }
  if (event === 'terminal-command') {
    console.log(data.ok
      ? `Terminal command delivered${tmuxSession ? ` to ${tmuxSession}` : ''}`
      : `Terminal command unverified${tmuxSession ? ` for ${tmuxSession}` : ''}: ${data.reason || 'unknown'}`)
    return
  }
  if (event === 'terminal-local-only') {
    console.log(`Terminal local-only${tmuxSession ? ` in ${tmuxSession}` : ''}: ${data.reason || 'server registration deferred'}`)
  }
}

function printLocalDaemonOutcome(result = {}) {
  for (const failure of result.lifecycle_errors || []) {
    console.error(`Lifecycle delivery failed for ${failure.event || 'unknown event'}: ${failure.error || 'unknown error'}`)
  }
  if (result.reconciliation?.deferred) {
    console.error(`Server wake reconciliation deferred: ${result.reconciliation.error || 'server unavailable'}`)
  }
  if (result.cleanup_error) console.error(result.cleanup_error)
}

// `mint` makes a FRESH agent only. Adopting an already-running external session
// is a separate verb (`enroll`) so the two are never confused (Skip: "the create
// command now is overloaded, to both create fresh agents and enroll extant agents").
function agentMintArgs(rawArgs) {
  if (flagFromRaw(rawArgs, 'session')) {
    console.error(red('`tlda agent mint` makes a FRESH agent. To adopt an existing session, use:\n  tlda agent enroll --session <uuid> --kind <codex|claude> [name]'))
    process.exit(1)
  }
  return hasRawFlag(rawArgs, 'fresh') ? rawArgs : ['--fresh', ...rawArgs]
}

// `enroll` adopts an already-running external session as a fleet agent. The harness
// KIND is required and explicit — session ids are not unique across harnesses, so
// nothing is guessed.
function agentEnrollArgs(rawArgs) {
  if (!flagFromRaw(rawArgs, 'session')) {
    console.error(red('Usage: tlda agent enroll --session <uuid> --kind <codex|claude> [name] [--permissions <profile>]'))
    process.exit(1)
  }
  const kind = flagFromRaw(rawArgs, 'kind')
  if (kind !== 'codex' && kind !== 'claude') {
    console.error(red('`tlda agent enroll` requires --kind <codex|claude> (session ids are not unique across harnesses).'))
    process.exit(1)
  }
  return hasRawFlag(rawArgs, 'enroll') ? rawArgs : ['--enroll', ...rawArgs]
}

export async function runFleetSpawn(spawnArgs, {
  spawnImpl = null,
  configDir = CONFIG_DIR,
  loadDaemonConfigImpl = () => ({}),
  localAgentLedgerPath = null,
  apiImpl = api,
  cleanupFailedBindingImpl = cleanupFailedFreshBinding,
} = {}) {
  if (spawnArgs.includes('--list-models')) {
    const { listModels } = await import('../agent-launch/models.mjs')
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR))
    console.log(JSON.stringify(listModels(withDaemonModelAliases({}, daemonConfig)), null, 2))
    return
  }
  const { spawn: defaultSpawn } = await import('../agent-launch/index.mjs')
  const spawn = spawnImpl || defaultSpawn
  const session = flagFromRaw(spawnArgs, 'session')
  const refresh = hasRawFlag(spawnArgs, 'refresh')
  const fresh = hasRawFlag(spawnArgs, 'fresh')
  const name = spawnPositionalFromRaw(spawnArgs, 0)
  if (!name && !session) {
    console.error(red('Usage: tlda agent <create|wake> <agent> [--model model] [--cwd path] [--permissions <profile>] [--i-like-to-live-dangerously]'))
    process.exit(1)
  }
  // The ONE permission knob is --permissions <profile>, a named profile from
  // daemon.yaml (Skip: "in terms of the CLI, I just want my fucking profiles").
  // Naming a profile asks for that configured profile. Without --permissions,
  // fresh spawns use the configured default and wake restores the durable grant.
  const spawnMode = session ? 'session' : (refresh ? 'refresh' : (fresh ? 'fresh' : 'respawn'))
  const explicitPermissionArg = flagFromRaw(spawnArgs, 'permissions') || undefined
  const explicitCwd = hasRawFlag(spawnArgs, 'cwd')
  if (spawnMode === 'fresh') {
    const cwd = resolve(flagFromRaw(spawnArgs, 'cwd') || process.cwd())
    const result = await callLocalDaemonLifecycle('mint', {
      name,
      model: flagFromRaw(spawnArgs, 'model') || undefined,
      cwd,
      effort: flagFromRaw(spawnArgs, 'effort') || undefined,
      modelOptions: collectSpawnModelOptionsFromRaw(spawnArgs),
      mode: flagFromRaw(spawnArgs, 'mode') || undefined,
      permissionRequest: explicitPermissionArg ? permissionsFromRaw(spawnArgs) : undefined,
      acknowledgeNoSecurity: hasRawFlag(spawnArgs, 'i-like-to-live-dangerously'),
      requester: { id: 'localhost', human: true },
      fresh: true,
      respawn: false,
    }, { onEvent: printMintLifecycleEvent })
    if (!result?.ok) throw new Error(result?.error || result?.reason || `mint failed for ${name}`)
    printLocalDaemonOutcome(result)
    const agentId = result.agent_id || result.fleet_id
    if (!agentId) throw new Error(`mint completed without a public fleet_id for ${name}`)
    console.log(`Created ${result.tmux_session || result.tmuxSession || result.name || name} (${agentId}) in ${cwd}`)
    return
  }
  if (spawnMode === 'respawn') {
    const { MintStore } = await import('../daemon/mint-store.mjs')
    const mintStore = new MintStore(localAgentLedgerPath || resolve(configDir, 'daemon-mints.sqlite'))
    let restored
    try {
      const stored = mintStore.getByFleetId(name) || mintStore.getByFriendlyName(name)
      if (!stored?.fleetId) throw new Error(`no fleet_id recorded for ${name}`)
      restored = { agentId: stored.fleetId, cwd: stored.launchRecipe?.cwd || null }
    } finally {
      mintStore.close()
    }
    const result = await callLocalDaemonLifecycle('wake', { fleet_id: restored.agentId })
    if (!result?.ok) throw new Error(result?.error || result?.reason || `wake failed for ${restored.agentId}`)
    printLocalDaemonOutcome(result)
    console.log(`Woke ${result.tmux_session || result.tmuxSession || restored.agentId} (${result.agent_id || result.fleetId || restored.agentId}) in ${restored.cwd}`)
    return
  }
  let permissionArg = explicitPermissionArg
  let permissionRequest = explicitPermissionArg ? permissionsFromRaw(spawnArgs) : undefined
  let cwd = resolve(flagFromRaw(spawnArgs, 'cwd') || process.cwd())
  let wakeLocalAgentId = null
  let wakeAgentId = null
  const model = flagFromRaw(spawnArgs, 'model') || undefined
  const kind = undefined
  const acknowledgeNoSecurity = hasRawFlag(spawnArgs, 'i-like-to-live-dangerously')
  let ledger = null
  try {
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(configDir))
    if (spawnMode === 'respawn') {
      const { createLocalAgentLedger } = await import('../agent-launch/local-agent-ledger.mjs')
      const localLedger = createLocalAgentLedger(localAgentLedgerPath || undefined)
      try {
        const stored = localLedger.get(name) || localLedger.findByFriendlyName(name)
        const restored = resolveWakeRecipeFields({
          name,
          stored,
          explicitCwd,
          explicitPermissionArg,
        })
        cwd = restored.cwd
        wakeLocalAgentId = restored.localAgentId
        wakeAgentId = restored.agentId
        permissionArg = restored.permissionArg
        permissionRequest = restored.permissionRequest
      } finally {
        localLedger.close()
      }
    }
    const modelOptions = collectSpawnModelOptionsFromRaw(spawnArgs)
    // A named --permissions profile must be one the operator actually configured
    // in daemon.yaml. Unknown profile → loud error listing the real ones, never a
    // silent fallback.
    if (explicitPermissionArg) {
      const known = Object.keys(daemonConfig?.profiles || {})
      if (!known.includes(explicitPermissionArg)) {
        throw new Error(`unknown permission profile "${explicitPermissionArg}". Profiles (daemon.yaml): ${known.join(', ') || '(none configured)'}`)
      }
    }
    ledger = createPermissionLedger(permissionLedgerPathFromDaemonConfig(daemonConfig, configDir))
    applyDaemonGrants(ledger, daemonConfig)
    const config = withDaemonModelAliases(loadDaemonConfigImpl(), daemonConfig)
    const localhostGrant = ledger.grantFor({ id: 'localhost' })
    const grant = (spawnMode === 'respawn' && !explicitPermissionArg)
      ? durableWakeGrant(ledger, { agentId: wakeAgentId, name, config, cwd })
      : resolveDirectSpawnGrant({
          permissionRequest,
          model,
          kind,
          config,
          cwd,
          spawnerPermissionSet: compilePermissionGrant(config, localhostGrant.permissionGrant, { cwd }),
          spawnerPermissionProfile: permissionGrantProfileName(localhostGrant.permissionGrant),
        })
    const grantedProfile = grant.permissionGrant
    const permissionLine = permissionTransparencyLine(grant)
    const suppliedAgentId = flagFromRaw(spawnArgs, 'agent-id') || undefined
    // Local creation begins with the daemon-scoped local_agent_id. The server
    // assigns the fleet id through mint-shell; only an explicit caller-supplied
    // id bypasses that join.
    const preallocatedAgentId = suppliedAgentId
    const launchAgentId = spawnMode === 'respawn' ? wakeAgentId : preallocatedAgentId
    if (preallocatedAgentId) {
      await ledger.set(preallocatedAgentId, {
        permissionGrant: grant.permissionGrant,
        source: 'agent-lifecycle-cli',
      })
    }
    const params = {
      spawnMode,
      name,
      agentId: launchAgentId,
      model,
      kind,
      config,
      cwd,
      effort: flagFromRaw(spawnArgs, 'effort') || undefined,
      modelOptions,
      permissionMode: flagFromRaw(spawnArgs, 'mode') || undefined,
      permissionRequest: explicitPermissionArg ? permissionRequest : undefined,
      permissionGrant: grantedProfile,
      permissionSet: grant.permissionSet,
      permissionLedger: ledger,
      explicitPermissionRequest: !!explicitPermissionArg,
      acknowledgeNoSecurity,
      enforceFence: true,
      sessionId: session || undefined,
      enroll: hasRawFlag(spawnArgs, 'enroll'),
      startFreshIdentityPolling: (result) => pollLifecycleResumeIdentity(result, {
        cwd,
        name,
      }),
    }
    let result
    try {
      result = await spawn(params)
    } catch (e) {
      if (preallocatedAgentId) {
        await ledger.delete(preallocatedAgentId).catch(cleanupError => {
          console.error(`warning: failed to clean preallocated grant for ${preallocatedAgentId}: ${cleanupError.message}`)
        })
      }
      throw e
    }
    // A local-origin launch receives its fleet id from mint-shell. Persist the
    // already-authorized grant under that server id before runtime binding so
    // bindAgentSeat can mint the terminal capability for the same agent.
    await persistAssignedAgentGrant({ ledger, result, grant, grantedProfile, preallocatedAgentId, params })
    let boundResume
    try {
      boundResume = await bindSpawnRuntimeIfNeeded({ spawnMode, result, bindLifecycleImpl: bindLifecycleCodexResumeIdentity, options: {
        ledger,
        cwd,
        name,
        api: apiImpl,
        requireReadback: spawnMode === 'fresh' || spawnMode === 'session',
      } })
    } catch (e) {
      throw e
    }
    const promptDeliveryFailed = result?.promptDelivery?.ok === false
    if ((spawnMode === 'fresh' || spawnMode === 'session') && !boundResume.bound) {
      await createLifecycleSeatBindingObligation(result, { api: apiImpl, cwd, name })
    }
    if (!boundResume.bound && (boundResume.submitError || boundResume.readError)) {
      throw boundResume.submitError || boundResume.readError
    }
    if (spawnMode === 'respawn' && wakeLocalAgentId && grantedProfile) {
      const { createLocalAgentLedger } = await import('../agent-launch/local-agent-ledger.mjs')
      const localLedger = createLocalAgentLedger(localAgentLedgerPath || undefined)
      try {
        localLedger.updateProcess(wakeLocalAgentId, { cwd, permissionGrant: grantedProfile })
      } finally {
        localLedger.close()
      }
    }
    if (promptDeliveryFailed) {
      console.error(red(`fresh Codex prompt delivery was unverified for ${result.fleetId}; runtime/session binding remains pending`))
      process.exitCode = 1
      return
    }
    const action = params.enroll ? 'Enrolled' : (params.spawnMode === 'fresh' || params.spawnMode === 'session' ? 'Created' : 'Woke')
    console.log(`${action} ${result.tmuxSession} (${result.fleetId}) in ${params.cwd || process.cwd()}`)
    if (permissionLine) console.log(permissionLine)
  } catch (e) {
    console.error(red(e?.message || String(e)))
    process.exitCode = 1
  } finally {
    if (ledger) await ledger.close()
  }
}

export async function bindSpawnRuntimeIfNeeded({ spawnMode, result, bindLifecycleImpl = bindLifecycleCodexResumeIdentity, options } = {}) {
  // Wake resumes the runtime/session binding already used to locate the exact
  // session. Rebinding would rotate its terminal capability and conflict with
  // the current server record.
  if (spawnMode === 'respawn') return { bound: true, reused: true, existing: true }
  return bindLifecycleImpl(result, options)
}

export async function persistAssignedAgentGrant({ ledger, result, grant, grantedProfile, preallocatedAgentId, params } = {}) {
  const shouldPersistGrant = params?.spawnMode !== 'respawn' || params?.explicitPermissionRequest
  if (!shouldPersistGrant || (preallocatedAgentId && result?.fleetId === preallocatedAgentId)) return false
  await ledger.set(result.fleetId, {
    permissionGrant: grant.permissionGrant,
    source: 'agent-lifecycle-cli',
  })
  return true
}

export async function createLifecycleSeatBindingObligation(result, {
  api,
  cwd,
  name,
} = {}) {
  if (!api || !result?.fleetId || !result.localAgentId || !['codex', 'claude'].includes(result.harness)) {
    throw new Error('fresh/session pending requires an exact durable seat-binding obligation')
  }
  const machineId = localMachineId()
  const envName = getActiveConfigName()
  const response = await api('POST', '/api/agent-seat-binding-obligation', {
    agent_id: result.fleetId,
    local_agent_id: result.localAgentId || null,
    daemon_key: `${machineId}:${envName}`,
    machine_id: machineId,
    env_name: envName,
    cwd,
    kind: result.harness,
    model: result.model,
    friendly_name: name || result.name || result.fleetId,
    session_id: result.resumeId || null,
  })
  if (!response?.ok || !response?.obligation?.obligation_id) {
    throw new Error(`durable seat-binding obligation was not accepted for ${result.fleetId}`)
  }
  return response.obligation
}

export function resolveWakeRecipeFields({
  name,
  stored,
  explicitCwd = false,
  explicitPermissionArg = undefined,
} = {}) {
  const label = name || stored?.friendlyName || stored?.serverAgentId || stored?.localAgentId || '(unknown)'
  if (explicitCwd) {
    throw new Error(`wake refused: --cwd is not valid for wake; wake restores the durable recipe cwd for "${label}"`)
  }
  if (!stored) {
    throw new Error(`wake refused: local durable recipe missing for "${label}"`)
  }
  if (!stored.process?.cwd) {
    throw new Error(`wake refused: local durable recipe for "${label}" has no cwd`)
  }
  if (!stored.serverAgentId || !stored.serverAgentId.startsWith('fleet:')) {
    throw new Error(`wake refused: local durable recipe for "${label}" has no fleet_id binding`)
  }
  const permissionArg = explicitPermissionArg || stored.process.permissionGrant || undefined
  return {
    cwd: resolve(stored.process.cwd),
    localAgentId: stored.localAgentId,
    agentId: stored.serverAgentId,
    permissionArg,
    permissionRequest: explicitPermissionArg || undefined,
  }
}

function durableWakeGrant(ledger, { agentId, name, config, cwd } = {}) {
  const rec = ledger.get(agentId)
  if (!rec?.permissionGrant) {
    throw new Error(`wake refused: durable grant missing for "${name || agentId || '(unknown)'}"`)
  }
  return {
    permissionGrant: rec.permissionGrant,
    permissionSet: compilePermissionGrant(config, rec.permissionGrant, { cwd }),
  }
}

export function permissionTransparencyLine(grant = {}) {
  return permissionGrantTransparencyLine(grant.permissionGrant, grant.permissionSet)
}

export async function bindLifecycleCodexResumeIdentity(result, {
  ledger,
  cwd,
  name,
  api = null,
  resolveIdentity = null,
  requireReadback = false,
  timeoutMs = Number(process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS || 120000),
  intervalMs = 250,
} = {}) {
  if (result?.fleetId && result.tmuxSession && result.resumeId) {
    return await postLifecycleSeatBinding(result, { api, ledger, cwd, name, sessionId: result.resumeId, existing: true, requireReadback })
  }
  if (!result?.fleetId || !result.tmuxSession || !['codex', 'claude'].includes(result.harness)) {
    return { bound: false, skipped: true }
  }
  let resolution = result.identityResolution || null
  if (!resolution?.identity?.sessionId || !resolution?.identity?.model) {
    resolution = await pollLifecycleResumeIdentity(result, {
      cwd,
      name,
      resolveIdentity,
      timeoutMs,
      intervalMs,
    })
  }
  const identity = resolution?.identity || null
  if (!identity?.sessionId || !identity?.model) {
    return { bound: false, pending: true, reason: 'exact-identity-pending', identity, diagnostics: resolution?.diagnostics || null }
  }
  const binding = await postLifecycleSeatBinding(result, {
    api,
    ledger,
    cwd,
    name,
    sessionId: identity.sessionId,
    sessionPath: identity.jsonlPath,
    model: identity.model,
    kind: result.harness,
    requireReadback,
  })
  if (!binding.bound) return { ...binding, identity }
  result.resumeId = identity.sessionId
  return { ...binding, identity }
}

export async function pollLifecycleResumeIdentity(result, {
  cwd,
  name,
  resolveIdentity = null,
  timeoutMs = Number(process.env.TLDA_SPAWN_RESUME_ID_TIMEOUT_MS || 120000),
  intervalMs = 250,
} = {}) {
  if (!result?.fleetId || !result.tmuxSession || !['codex', 'claude'].includes(result.harness)) {
    return { identity: null, diagnostics: { failureStage: 'skipped' } }
  }
  const resolver = resolveIdentity || (await import(`../agent-launch/harness/${result.harness}.mjs`)).resolveLiveSessionIdentity
  const deadline = Date.now() + timeoutMs
  let identity = null
  while (Date.now() <= deadline) {
    identity = await resolver({
      agent: {
        id: result.fleetId,
        friendly_name: name || result.name || result.fleetId,
        cwd,
      },
      tmuxSession: result.tmuxSession,
      diagnose: result.harness === 'codex',
    })
    if (identity?.sessionId && identity?.model) break
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return {
    identity,
    diagnostics: identity?.sessionId && identity?.model
      ? null
      : { failureStage: identity?.failureStage || (!identity?.sessionId ? 'session-id' : 'model') },
  }
}

async function postLifecycleSeatBinding(result, {
  api = null,
  ledger = null,
  cwd,
  name,
  sessionId,
  sessionPath = null,
  model = result?.model,
  kind = result?.harness,
  existing = false,
  requireReadback = false,
} = {}) {
  if (!api) return { bound: false, pending: true }
  const machineId = localMachineId()
  const envName = getActiveConfigName()
  const daemonKey = `${machineId}:${envName}`
  const binding = await bindAgentSeat({
    ledger,
    identity: {
      agentId: result.fleetId,
      sessionId,
      resumeId: sessionId,
      kind,
      model,
      cwd,
      sessionPath,
      friendlyName: name || result.name || result.fleetId,
    },
    route: { machineId, envName, daemonKey, tmuxSession: result.tmuxSession },
    submit: (payload) => api('POST', '/api/agent-seat', payload),
    readback: (agentId) => api('GET', `/api/agent-seat?agent=${encodeURIComponent(agentId)}`),
    requireReadback,
    transitionReason: 'agent-lifecycle-cli',
  })
  return { ...binding, existing }
}

export async function cleanupFailedFreshBinding(result, {
  api = null,
  localAgentLedgerPath = null,
  terminateImpl = terminateTmuxSession,
} = {}) {
  const terminated = await terminateImpl(result.tmuxSession)
  if (!terminated) throw new Error(`terminal seat binding failed, but exact runtime ${result.tmuxSession} could not be terminated`)
  if (result.localAgentId) {
    const { createLocalAgentLedger } = await import('../agent-launch/local-agent-ledger.mjs')
    const localLedger = createLocalAgentLedger(localAgentLedgerPath || undefined)
    try { localLedger.delete(result.localAgentId) } finally { localLedger.close() }
  }
  if (result.fleetId && api) await api('POST', `/api/agents/${encodeURIComponent(result.fleetId)}/mark-dead`)
  return { terminated: true }
}

export async function bindDoctorYoloDurableSeat(launched, {
  cwd,
  name,
  api,
  configDir = CONFIG_DIR,
  daemonConfig = null,
  ledger = null,
  bindLifecycleImpl = bindLifecycleCodexResumeIdentity,
  cleanupFailedBindingImpl = cleanupFailedFreshBinding,
} = {}) {
  const resolvedDaemonConfig = daemonConfig || readDaemonConfig(defaultDaemonConfigPath(configDir))
  const permissionLedger = ledger || createPermissionLedger(permissionLedgerPathFromDaemonConfig(resolvedDaemonConfig, configDir))
  const ownsLedger = !ledger
  let seededGrant = false
  try {
    applyDaemonGrants(permissionLedger, resolvedDaemonConfig)
    if (!permissionLedger.get(launched.fleetId)) {
      const baseGrant = permissionLedger.grantFor({ id: 'localhost' })
      permissionLedger.setSync(launched.fleetId, {
        permissionGrant: baseGrant.permissionGrant,
        source: 'doctor-yolo',
      })
      seededGrant = true
    }
    const binding = await bindLifecycleImpl(launched, {
      ledger: permissionLedger,
      cwd,
      name,
      api,
      requireReadback: true,
    })
    if (!binding?.bound) {
      throw new Error(`Break-glass launch FAILED: ${launched.fleetId} logged in but did not create a current durable seat`)
    }
    return binding
  } catch (error) {
    let cleanupError = null
    try {
      await cleanupFailedBindingImpl(launched, { api })
    } catch (e) {
      cleanupError = e
    }
    if (seededGrant) {
      try {
        await permissionLedger.delete(launched.fleetId)
      } catch (e) {
        cleanupError ||= e
      }
    }
    if (cleanupError) {
      error.message = `${error.message}; cleanup failed: ${cleanupError.message}`
    }
    throw error
  } finally {
    if (ownsLedger) await permissionLedger.close()
  }
}

function flagFromRaw(rawArgs, name) {
  const idx = rawArgs.indexOf(`--${name}`)
  if (idx === -1) return null
  const next = rawArgs[idx + 1]
  if (!next || next.startsWith('--')) return ''
  return next
}

function hasRawFlag(rawArgs, name) {
  return rawArgs.includes(`--${name}`)
}

function spawnFlagTakesValue(name) {
  return !SPAWN_BOOLEAN_FLAGS.has(name)
}

export function collectSpawnModelOptionsFromRaw(rawArgs) {
  const modelOptions = {}
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    if (!spawnFlagTakesValue(name)) continue
    const next = rawArgs[i + 1]
    const value = !next || next.startsWith('--') ? '' : next
    if (!SPAWN_NON_MODEL_OPTION_FLAGS.has(name)) modelOptions[name] = value
    if (value !== '') i++
  }
  return modelOptions
}

export function spawnPositionalFromRaw(rawArgs, index = 0) {
  let pos = 0
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a.startsWith('--')) {
      if (spawnFlagTakesValue(a.slice(2))) {
        const next = rawArgs[i + 1]
        if (next && !next.startsWith('--')) i++
      }
      continue
    }
    if (pos === index) return a
    pos++
  }
  return null
}

function positionalFromRaw(rawArgs, index = 0) {
  let pos = 0
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (VALUE_FLAGS.has(key)) i++
      continue
    }
    if (pos === index) return a
    pos++
  }
  return null
}

function permissionsFromRaw(rawArgs) {
  const value = flagFromRaw(rawArgs, 'permissions')
  if (!value) return undefined
  if (existsSync(value)) {
    const text = readFileSync(value, 'utf8')
    try { return JSON.parse(text) } catch { return { source: text, sourcePath: value } }
  }
  return value
}

function quoteCommandArg(value) {
  const raw = String(value)
  return /^[A-Za-z0-9_./:=@+-]+$/.test(raw)
    ? raw
    : `'${raw.replace(/'/g, `'\\''`)}'`
}

function agentWakeSuggestion(rawArgs) {
  return ['tlda', 'agent', 'wake', ...rawArgs].map(quoteCommandArg).join(' ')
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

function formatAge(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return 'unknown'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function padRight(value, width) {
  const s = String(value ?? '')
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

async function listFleetAgents() {
  if (hasFlag('local')) return listLocalAgents()
  const limit = Number(getFlag('limit', '200')) || 200
  const data = await api('GET', `/api/fleet-roster-truth?limit=${encodeURIComponent(String(limit))}`)
  const agents = Array.isArray(data.agents) ? data.agents : []
  const totals = data.totals || { awake: 0, hibernating: 0, dead: 0, total: agents.length }
  const panes = data.panes || { fleet: 0, stale: 0, registry_without_pane: 0 }
  console.log(`Fleet registry: ${totals.awake || 0} awake · ${totals.hibernating || 0} hibernating · ${totals.dead || 0} dead · ${totals.total || 0} total`)
  console.log(`Tmux panes: ${panes.fleet || 0} fleet · ${panes.stale || 0} stale · ${panes.registry_without_pane || 0} registry-without-pane`)
  if (data.matched > agents.length) {
    console.log(dim(`Showing ${agents.length}/${data.matched}; use --limit ${data.matched} for the full table.`))
  }
  if (agents.length === 0) {
    console.log('No fleet agents.')
    return
  }

  const groups = new Map()
  for (const m of data.machines || []) {
    if (!groups.has(m.machine_id)) groups.set(m.machine_id, { rows: [], truth: m })
  }
  for (const a of agents) {
    const machine = a.machine_id || 'unassigned'
    if (!groups.has(machine)) groups.set(machine, { rows: [], truth: null })
    groups.get(machine).rows.push(a)
  }
  const statusRank = { awake: 0, thinking: 0, compacting: 0, hibernating: 1, dead: 2 }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [machine, group] of sortedGroups) {
    const rows = group.rows
    const rowStatus = (row) => {
      const { status: projectedStatus } = row
      return runtimeStatusName({ ...row, runtime_status: row.runtime_status || { status: projectedStatus } })
    }
    rows.sort((a, b) => (statusRank[rowStatus(a)] ?? 3) - (statusRank[rowStatus(b)] ?? 3) || (a.name || a.id).localeCompare(b.name || b.id))
    const truth = group.truth
    const suffix = truth
      ? ` — ${truth.registry.awake} awake, ${truth.registry.hibernating} hibernating, ${truth.registry.dead} dead; ${truth.panes.fleet} panes, ${truth.panes.stale} stale`
      : ''
    console.log(`\n${machine} (${rows.length})${suffix}`)
    if (truth?.registry_without_pane) {
      console.log(dim(`  ${truth.registry_without_pane} registry rows have no tmux pane on this connected daemon.`))
    }
    if (truth?.stale_panes?.length) {
      const names = truth.stale_panes.slice(0, 6).map(p => p.tmux_session.replace(/^fleet-/, '')).join(', ')
      console.log(dim(`  stale panes: ${names}${truth.stale_panes.length > 6 ? ', …' : ''}`))
    }
    console.log(`  ${padRight('status', 12)} ${padRight('agent', 24)} ${padRight('session', 28)} ${padRight('seen', 8)} cwd`)
    for (const a of rows) {
      const status = rowStatus(a) || 'unknown'
      const name = a.name || a.id
      const session = a.tmux_session || '-'
      const seen = formatAge(a.last_seen_ago_s)
      const cwd = a.cwd || ''
      const activity = [a.activity, a.tool].filter(Boolean).join(':')
      console.log(`  ${padRight(status, 12)} ${padRight(name, 24)} ${padRight(session, 28)} ${padRight(seen, 8)} ${cwd}${activity ? ` ${dim(activity)}` : ''}`)
    }
  }
}

async function hibernateAgent(name) {
  if (!name) {
    console.error('Usage: tlda agent hibernate <name>')
    process.exit(1)
  }
  const res = await hibernateLocalAgent(name)
  process.exit(res.status)
}

async function hibernateLocalAgent(name, { allowMissing = false } = {}) {
  const { spawnSync } = await import('child_process')
  const sess = agentSessionName(name)
  const has = spawnSync('tmux', [...tmuxBase(), 'has-session', '-t', sess], { stdio: 'ignore' })
  if (has.status !== 0) {
    const message = `No live session "${sess}" on this machine — already hibernating, or it lives on another box.`
    if (!allowMissing) {
      console.error(message)
      return { status: 1, hibernated: false, session: sess }
    }
    console.log(`${message} Continuing with metadata update and wake.`)
    return { status: 0, hibernated: false, session: sess }
  }
  const res = spawnSync('tmux', [...tmuxBase(), 'kill-session', '-t', sess], { stdio: 'inherit' })
  const short = name.replace(/^fleet-/, '')
  if (res.status === 0) {
    console.log(`Hibernated ${short} — its thread is intact; \`tlda agent wake ${short}\` brings it back locally.`)
  }
  return { status: res.status ?? 0, hibernated: res.status === 0, session: sess }
}

export async function dismissAgent(name, {
  ensureServerImpl = ensureServer,
  apiImpl = api,
  log = console,
  exitImpl = code => process.exit(code),
} = {}) {
  if (!name) {
    log.error('Usage: tlda agent dismiss <name>')
    exitImpl(1)
    return { ok: false, error: 'missing-name' }
  }
  await ensureServerImpl()
  const state = await apiImpl('GET', '/api/state')
  const agents = Array.isArray(state?.agents) ? state.agents : []
  const agent = resolveAgentQuery(agents, name)
  if (!agent) {
    log.error(`No agent found for "${name}".`)
    exitImpl(1)
    return { ok: false, error: 'agent-not-found' }
  }
  const label = agent.friendly_name || agent.id
  if (agent.dead) {
    log.log(`${label} is already dismissed.`)
    return { ok: true, already: true, agent }
  }
  let seat = null
  try {
    const data = await apiImpl('GET', `/api/agent-seat?agent=${encodeURIComponent(agent.id)}`)
    seat = data?.seat || null
  } catch (e) {
    if (e?.status && e.status !== 404) {
      log.error(`Failed to inspect current seat for ${label}; not marking it dismissed: ${e?.message || e}`)
      exitImpl(1)
      return { ok: false, error: 'seat-check-failed' }
    }
  }
  if (seat?.terminal_capability) {
    try {
      await apiImpl('POST', '/api/kill-session', { agent: agent.id })
    } catch (e) {
      log.error(`Failed to hibernate ${label}; not marking it dismissed: ${e?.message || e}`)
      exitImpl(1)
      return { ok: false, error: 'kill-failed' }
    }
  }
  await apiImpl('POST', `/api/agents/${encodeURIComponent(agent.id)}/mark-dead`)
  log.log(`Dismissed ${label} (${agent.id}) — marked dead and removed from the live roster.`)
  return { ok: true, agent, seat, killed: !!seat?.terminal_capability }
}

// The profile list in help is DERIVED from daemon.yaml — never hardcoded — so it
// can't drift from the real config. Each profile's human description is the inert
// `description:` field in the YAML.
// One place defines names and descriptions: the config.
function daemonProfileHelpBlock() {
  let profiles = {}
  try {
    const cfg = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR))
    profiles = cfg?.profiles && typeof cfg.profiles === 'object' && !Array.isArray(cfg.profiles) ? cfg.profiles : {}
  } catch {
    profiles = {}
  }
  const names = Object.keys(profiles)
  if (!names.length) return '  (no profiles configured in daemon.yaml)'
  const width = Math.max(...names.map((n) => n.length))
  return names
    .map((n) => {
      const desc = profiles[n]?.description
      return desc ? `  ${n.padEnd(width)}  ${desc}` : `  ${n}`
    })
    .join('\n')
}

function usageAgentPermissions() {
  const out = `Usage: tlda agent permissions <agent> [profile] [--on-wake] [--dry-run]

Profiles (from daemon.yaml):
${daemonProfileHelpBlock()}

Default behavior:
  With a profile, update the agent's next-wake permissions and wake it now.
  --on-wake  update metadata only; the next wake applies it
  --dry-run  print the change without mutating or waking`
  if (hasFlag('help')) console.log(out)
  else console.error(out)
}

function usageAgent() {
  console.log(`tlda agent — manage fleet agents

Usage:
  tlda agent list [--limit N] [--local]
  tlda agent mint <name> [--model model] [--cwd path] [--permissions <profile>]
  tlda agent enroll --session <uuid> --kind <codex|claude> [name] [--permissions <profile>]
  tlda agent wake <agent> [--permissions <profile>]
  tlda agent move <agent> [name@][box:]env
  tlda agent set-mint-machine <agent-or-user> <machine>
  tlda agent check-ready <agent> [--timeout seconds]
  tlda agent attach <agent>
  tlda agent hibernate <agent>
  tlda agent dismiss <agent>
  tlda agent permissions <agent> [profile] [--on-wake] [--dry-run]

Permission profiles (from daemon.yaml):
${daemonProfileHelpBlock()}

mint starts a FRESH agent; enroll adopts an already-running external session (kind
required); wake brings back an existing hibernating agent. All are local-operator gated
by machine access, and write the child grant to the daemon ledger.
--permissions names one of the profiles above; without it, fresh uses the configured default and wake restores the durable grant.
Set TLDA_DISABLE_PERMISSION_CLASSIFIER=1 only as a mint/wake-time emergency override to launch Claude with --dangerously-skip-permissions.
move must be run on the agent's current daemon address; cross-box moves use SSH/rsync.
set-mint-machine stores the caller's default mint machine in fleet prefs.
The permissions command defaults to waking now; --on-wake stores only the next-wake profile.
check-ready verifies registry + local tmux/runtime + recent login/inbox evidence.
list reads the server roster by default; --local shows only tmux sessions on this machine.`)
}

function permissionGrantNamesForError() {
  let daemonProfiles = []
  try {
    const cfg = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR))
    if (cfg?.profiles && typeof cfg.profiles === 'object' && !Array.isArray(cfg.profiles)) {
      daemonProfiles = Object.keys(cfg.profiles)
    }
  } catch {
    daemonProfiles = []
  }
  return daemonProfiles.join(', ')
}

function normalizeAgentMetadata(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
}

function localMachineId() {
  return getMachineId() || hostname().split('.')[0]
}

function parseJsonMaybe(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function processTreeHasRuntime(spawnSync, panePids, expectedKind = null) {
  const ps = spawnSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' })
  if (ps.status !== 0) return { ok: false, kind: null, pid: null }
  const children = new Map()
  const argsByPid = new Map()
  for (const line of ps.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const [, pid, ppid, procArgs] = m
    argsByPid.set(pid, procArgs)
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const runtimeRes = [
    ['codex', /(?:^|\s|\/)codex(?:\s|$)/],
    ['goose', /(?:^|\s|\/)goose(?:\s|$).*?\brun\b|\bgoose run\b/],
    ['claude', /(?:^|\s|\/)claude(?:\s|$)/],
  ]
  const ordered = expectedKind
    ? [...runtimeRes.filter(([k]) => k === expectedKind), ...runtimeRes.filter(([k]) => k !== expectedKind)]
    : runtimeRes
  const stack = [...panePids]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const procArgs = argsByPid.get(pid) || ''
    for (const [kind, re] of ordered) {
      if (re.test(procArgs)) return { ok: true, kind, pid }
    }
    for (const child of children.get(pid) || []) stack.push(child)
  }
  return { ok: false, kind: null, pid: null }
}

async function cmdAgentCheckReady() {
  const query = getPositional(1)
  if (!query) {
    console.error('Usage: tlda agent check-ready <agent> [--timeout seconds]')
    process.exit(1)
  }
  const { spawnSync } = await import('child_process')
  await ensureServer()
  const timeoutSec = Math.max(0, Number(getFlag('timeout', '0') || 0))
  const deadline = Date.now() + timeoutSec * 1000
  let final = null
  do {
    final = await collectAgentReadiness(query, spawnSync)
    if (final.ok) break
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  } while (true)

  printAgentReadiness(final)
  process.exit(final.ok ? 0 : 1)
}

export async function collectAgentReadiness(query, spawnSync, apiGet = api) {
  const state = await apiGet('GET', '/api/state')
  const agents = Array.isArray(state?.agents) ? state.agents : []
  let agent = null
  try {
    agent = resolveAgentQuery(agents, query)
  } catch (e) {
    return { ok: false, query, error: e.message }
  }
  if (!agent) return { ok: false, query, error: 'agent not found' }
  const meta = normalizeAgentMetadata(agent.metadata)
  const expectedKind = meta.kind || null
  let seat = null
  try {
    const data = await apiGet('GET', `/api/agent-seat?agent=${encodeURIComponent(agent.id)}`)
    seat = data?.seat || null
  } catch (e) {
    return { ok: false, query, agent, error: `current durable seat missing: ${e.message}` }
  }
  if (!seat?.terminal_capability) return { ok: false, query, agent, seat, error: 'current durable seat has no terminal capability' }
  if (seat.agent_id && seat.agent_id !== agent.id) return { ok: false, query, agent, seat, error: `current durable seat owner mismatch: ${seat.agent_id} != ${agent.id}` }
  const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR))
  const ledger = createPermissionLedger(permissionLedgerPathFromDaemonConfig(daemonConfig, CONFIG_DIR))
  let localRoute = null
  try {
    localRoute = ledger.get(agent.id)
  } finally {
    await ledger.close()
  }
  const localDaemonKey = `${localMachineId()}:${getActiveConfigName()}`
  if (seat.daemon_key !== localDaemonKey) {
    return { ok: false, query, agent, seat, error: `current durable seat belongs to ${seat.daemon_key || 'unknown daemon'}, not local ${localDaemonKey}` }
  }
  if (!localRoute?.tmuxSession || localRoute.terminalCapability !== seat.terminal_capability) {
    return { ok: false, query, agent, seat, error: 'current durable seat capability has no matching local terminal route' }
  }
  const sess = localRoute.tmuxSession
  const hasSession = spawnSync('tmux', [...tmuxBase(), 'has-session', '-t', sess], { stdio: 'ignore' }).status === 0
  let panes = []
  if (hasSession) {
    const r = spawnSync('tmux', [...tmuxBase(), 'list-panes', '-t', sess, '-F', '#{pane_pid}'], { encoding: 'utf8' })
    if (r.status === 0) panes = r.stdout.trim().split(/\s+/).filter(Boolean)
  }
  const runtime = hasSession ? processTreeHasRuntime(spawnSync, panes, expectedKind) : { ok: false, kind: null, pid: null }
  const table = await apiGet('GET', `/api/fleet-table?filter=${encodeURIComponent(agent.id)}&limit=5`)
  const row = (table.agents || []).find(a => a.id === agent.id) || null
  const eventsData = await apiGet('GET', `/api/store/events?agent=${encodeURIComponent(agent.id)}&limit=200`)
  const events = Array.isArray(eventsData?.events) ? eventsData.events : []
  const recentLogin = [...events].reverse().find(e => e.type === 'login' || e.type === 'register')
  const recentInbox = [...events].reverse().find(e => {
    if (e.type !== 'activity') return false
    const m = parseJsonMaybe(e.metadata) || {}
    const tool = String(m.tool || e.text || '')
    return tool.includes('inbox') || tool.includes('my_task')
  })
  const incoming = [...events].reverse().find(e => e.to === agent.id && e.from !== agent.id && ['chat', 'delegate'].includes(e.type))
  const replyAfterIncoming = incoming
    ? events.find(e => e.from === agent.id && e.to !== agent.id && Date.parse(e.timestamp) > Date.parse(incoming.timestamp))
    : null
  const ok = !agent.dead && hasSession && runtime.ok && !!recentLogin
  return {
    ok, query, agent, seat, tableRow: row, session: sess, hasSession, panes, runtime,
    recentLogin, recentInbox, incoming, replyAfterIncoming,
  }
}

function printAgentReadiness(r) {
  if (r.error) {
    console.error(`spawn readiness: FAIL — ${r.error}`)
    return
  }
  const agent = r.agent
  const row = r.tableRow
  console.log(`spawn readiness for ${agent.friendly_name || agent.id} (${agent.id})`)
  if (r.warning) console.log(`  warning: ${r.warning}`)
  console.log(`  registry: ${agent.dead ? 'dead' : 'live row'}; status=${row?.status || runtimeStatusName(agent) || 'unknown'}; machine=${agent.machine_id || 'unknown'}`)
  console.log(`  current seat: ${r.seat ? `${r.seat.session_id || 'no-session'} @ ${r.seat.daemon_key || 'no-daemon'}` : 'missing'}`)
  console.log(`  tmux: ${r.hasSession ? `ok ${r.session} panes=${r.panes.join(',') || 'none'}` : `missing ${r.session}`}`)
  console.log(`  runtime: ${r.runtime.ok ? `ok ${r.runtime.kind} pid=${r.runtime.pid}` : 'missing under tmux pane'}`)
  console.log(`  login event: ${r.recentLogin ? `${r.recentLogin.timestamp} #${r.recentLogin.id}` : 'missing'}`)
  console.log(`  recent inbox activity: ${r.recentInbox ? `${r.recentInbox.timestamp} #${r.recentInbox.id}` : 'not observed (inbox is often filtered as infrastructure)'}`)
  if (r.incoming) {
    const reply = r.replyAfterIncoming ? `${r.replyAfterIncoming.timestamp} #${r.replyAfterIncoming.id}` : 'no later outbound reply observed'
    console.log(`  chat/task roundtrip: incoming #${r.incoming.id}; reply=${reply}`)
  } else {
    console.log('  chat/task roundtrip: no recent inbound chat/delegate to evaluate')
  }
  console.log(`  result: ${r.ok ? 'READY' : 'NOT READY'}`)
}

async function findAgentForPermission(agentQuery) {
  const state = await api('GET', '/api/state')
  const agents = Array.isArray(state?.agents) ? state.agents : []
  const agent = resolveAgentQuery(agents, agentQuery)
  if (!agent) {
    throw new Error(`No existing agent found for "${agentQuery}". Use an existing fleet id or friendly name.`)
  }
  if (runtimeStatusName(agent) === 'dead') {
    throw new Error(`Agent ${agent.id} is marked dead; refusing to create an impostor identity.`)
  }
  const localMachine = getMachineId()
  if (agent.machine_id && localMachine && agent.machine_id !== localMachine) {
    throw new Error(`Agent ${agent.id} belongs to machine ${agent.machine_id}; run this command on that machine.`)
  }
  return agent
}

function spawnNameForAgent(agent, fallback) {
  return agent.friendly_name || agent.id || fallback
}

function hibernateNameForAgent(agent, fallback) {
  return agent.tmux_session ? agent.tmux_session.replace(/^fleet-/, '') : spawnNameForAgent(agent, fallback)
}

function walkFiles(dir, predicate, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(p, predicate, out)
    else if (predicate(p)) out.push(p)
  }
  return out
}

function relToHome(absPath) {
  const home = homedir()
  if (!absPath.startsWith(`${home}/`)) {
    throw new Error(`move artifact is outside home and cannot be imported by relative path: ${absPath}`)
  }
  return absPath.slice(home.length + 1)
}

function findClaudeSessionFiles(agent) {
  const ids = [agent.session_id, ...((agent.session_ids || []).slice().reverse())].filter(Boolean)
  const uniqueIds = [...new Set(ids)]
  const root = join(homedir(), '.claude', 'projects')
  const found = []
  for (const sid of uniqueIds) {
    for (const file of walkFiles(root, p => p.endsWith(`/${sid}.jsonl`))) {
      if (!found.includes(file)) found.push(file)
    }
  }
  return found
}

function findCodexRolloutFiles(agent) {
  const ids = [agent.session_id, ...((agent.session_ids || []).slice().reverse())].filter(Boolean)
  const uniqueIds = [...new Set(ids)]
  const root = join(homedir(), '.codex', 'sessions')
  const found = []
  for (const sid of uniqueIds) {
    for (const file of walkFiles(root, p => basename(p).startsWith('rollout-') && p.endsWith(`-${sid}.jsonl`))) {
      if (!found.includes(file)) found.push(file)
    }
  }
  if (found.length) return found
  const needle = `Registered ${agent.id}`
  for (const file of walkFiles(root, p => basename(p).startsWith('rollout-') && p.endsWith('.jsonl'))) {
    try {
      const text = readFileSync(file, 'utf8')
      if (text.includes(needle)) found.push(file)
    } catch (e) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(e?.code)) throw e
    }
  }
  return found
}

function moveArtifactsForAgent(agent) {
  const meta = normalizeAgentMetadata(agent.metadata)
  const kind = meta.kind
  if (!kind) throw new Error(`Agent ${agent.id} has no recorded harness kind; refusing to infer move artifacts`)
  if (kind === 'goose') {
    throw new Error('goose agent move is not implemented yet; goose session state is SQLite/data-dir based and needs a harness-specific exporter')
  }
  const files = kind === 'codex' ? findCodexRolloutFiles(agent) : findClaudeSessionFiles(agent)
  if (!files.length) {
    throw new Error(`no ${kind} wake artifact found for ${agent.friendly_name || agent.id}`)
  }
  return files.map(path => ({ path, rel: relToHome(path) }))
}

async function copyMoveArtifacts(targetMachine, artifacts) {
  const { spawnSync } = await import('child_process')
  for (const artifact of artifacts) {
    const remoteDir = `~/${artifact.rel.split('/').slice(0, -1).join('/')}`
    const mkdir = spawnSync('ssh', [targetMachine, 'mkdir', '-p', remoteDir], { stdio: 'inherit' })
    if (mkdir.status !== 0) {
      throw new Error(`failed to create destination directory on ${targetMachine}: ${remoteDir}`)
    }
    const source = `${homedir()}/./${artifact.rel}`
    const rsync = spawnSync('rsync', ['-a', '--relative', source, `${targetMachine}:~/`], { stdio: 'inherit' })
    if (rsync.status !== 0) {
      throw new Error(`failed to copy ${artifact.rel} to ${targetMachine}`)
    }
  }
}

async function findSingleAgent(agentQuery) {
  const state = await api('GET', '/api/state')
  const agents = Array.isArray(state?.agents) ? state.agents : []
  const agent = resolveAgentQuery(agents, agentQuery)
  if (!agent) throw new Error(`No existing agent found for "${agentQuery}".`)
  return agent
}

async function resolveFleetPrefUserId(query) {
  if (!query) throw new Error('missing agent-or-user')
  const state = await api('GET', '/api/state')
  const agents = Array.isArray(state?.agents) ? state.agents : []
  const agent = resolveAgentQuery(agents, query)
  if (agent) return agent.id
  if (query.startsWith('fleet:')) return query
  throw new Error(`No agent/user matched "${query}". Use an existing name or an explicit fleet:<id>.`)
}

async function cmdAgentSetSpawnMachine() {
  const userQuery = getPositional(1)
  const machineId = getPositional(2) || getFlag('machine')
  if (hasFlag('help')) {
    console.log(`Usage: tlda agent set-mint-machine <agent-or-user> <machine>\n\nStores fleet_prefs.${SPAWN_MACHINE_PREF_KEY} for that fleet identity. New agents minted by that identity route to this daemon machine.`)
    return
  }
  if (!userQuery || !machineId) {
    console.error('Usage: tlda agent set-mint-machine <agent-or-user> <machine>')
    process.exit(1)
  }
  await assertNotAgentContext()
  await ensureServer()
  const userId = await resolveFleetPrefUserId(userQuery)
  if (hasFlag('dry-run')) {
    console.log(`[dry-run] would set ${SPAWN_MACHINE_PREF_KEY} for ${userId} to ${machineId}`)
    return
  }
  await api('POST', `/api/fleet/prefs/${encodeURIComponent(SPAWN_MACHINE_PREF_KEY)}`, {
    user: userId,
    value: machineId,
  })
  const readback = await api('GET', `/api/fleet/prefs/${encodeURIComponent(SPAWN_MACHINE_PREF_KEY)}?user=${encodeURIComponent(userId)}`)
  if (readback?.value !== machineId) {
    throw new Error(`preference write did not stick for ${userId}: got ${JSON.stringify(readback?.value)}`)
  }
  console.log(`Set ${SPAWN_MACHINE_PREF_KEY} for ${userId} to ${machineId}.`)
}

async function cmdAgentMove() {
  const agentQuery = getPositional(1)
  const rawTarget = getPositional(2)
  if (hasFlag('help')) {
    console.log('Usage: tlda agent move <agent> [name@][box:]env\n\nRun from the agent current daemon address. Same-box env moves update the daemon lock and wake under the target config; cross-box moves copy resumable context with SSH/rsync first.')
    return
  }
  if (!agentQuery || !rawTarget) {
    console.error('Usage: tlda agent move <agent> [name@][box:]env')
    process.exit(1)
  }
  await assertNotAgentContext()
  await ensureServer()
  const agent = await findSingleAgent(agentQuery)
  const sourceMachine = localMachineId()
  const sourceEnv = getActiveConfigName()
  if (!agent.machine_id || !agent.env_name) throw new Error(`Agent ${agent.id} has no daemon address; cannot prove this is the source daemon.`)
  if (agent.machine_id !== sourceMachine || agent.env_name !== sourceEnv) {
    throw new Error(`Agent ${agent.id} belongs to ${describeAgentAddress(agent.machine_id, agent.env_name)}; run move from ${describeAgentAddress(agent.machine_id, agent.env_name)}.`)
  }
  const parsedTarget = parseAgentMoveTarget(rawTarget)
  if (parsedTarget.targetName && parsedTarget.targetName !== (agent.friendly_name || agent.id)) {
    throw new Error('move rename is parsed but not implemented in this slice')
  }
  const targetMachine = parsedTarget.machine_id || sourceMachine
  const targetEnv = parsedTarget.env_name
  if (sourceMachine === targetMachine && sourceEnv === targetEnv) {
    throw new Error(`Agent ${agent.id} is already on ${describeAgentAddress(targetMachine, targetEnv)}.`)
  }
  const sameBox = sourceMachine === targetMachine

  const artifacts = sameBox ? [] : moveArtifactsForAgent(agent)
  await api('POST', '/api/agents/move-daemon', {
    agent: agent.id,
    machine_id: targetMachine,
    env_name: targetEnv,
    expected_from: sourceMachine,
    expected_env: sourceEnv,
    check_only: true,
  })

  const meta = normalizeAgentMetadata(agent.metadata)
  if (!meta.kind) throw new Error(`Agent ${agent.id} has no recorded harness kind; refusing to infer a wake command`)
  if (hasFlag('dry-run')) {
    console.log(`[dry-run] would move ${agent.friendly_name || agent.id} (${agent.id}) ${describeAgentAddress(sourceMachine, sourceEnv)} -> ${describeAgentAddress(targetMachine, targetEnv)}`)
    console.log(`  mode: ${sameBox ? 'same-box env relock' : 'cross-box rsync move'}`)
    if (artifacts.length) console.log(`  artifacts: ${artifacts.map(a => a.rel).join(', ')}`)
    console.log(`  hibernate: ${hibernateNameForAgent(agent, agentQuery)}`)
    console.log(`  wake kind: ${meta.kind}`)
    console.log(`  wake config: ${targetEnv}`)
    return
  }

  console.log(`Moving ${agent.friendly_name || agent.id} (${agent.id}) ${describeAgentAddress(sourceMachine, sourceEnv)} -> ${describeAgentAddress(targetMachine, targetEnv)}`)
  const hibernate = await hibernateLocalAgent(hibernateNameForAgent(agent, agentQuery), { allowMissing: true })
  if (hibernate.status !== 0) throw new Error(`failed to hibernate ${agent.id}`)
  if (!sameBox) await copyMoveArtifacts(targetMachine, artifacts)
  await api('POST', '/api/agents/move-daemon', {
    agent: agent.id,
    machine_id: targetMachine,
    env_name: targetEnv,
    expected_from: sourceMachine,
    expected_env: sourceEnv,
  })
  const spawnArgs = [agent.id]
  if (meta.kind) spawnArgs.push('--kind', meta.kind)
  const configPrefix = targetEnv ? `TLDA_CONFIG=${quoteCommandArg(targetEnv)} ` : ''
  console.log(`Registry now points ${agent.id} at ${describeAgentAddress(targetMachine, targetEnv)}.`)
  console.log(`Wake locally on the target machine with: ${configPrefix}${agentWakeSuggestion(spawnArgs)}`)
}

async function cmdAgentPermissions() {
  const agentQuery = getPositional(1)
  const profileArg = getPositional(2)
  if (hasFlag('help')) {
    usageAgentPermissions()
    return
  }
  if (!agentQuery) {
    usageAgentPermissions()
    process.exit(1)
  }

  try {
    await assertNotAgentContext()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  if (!profileArg) {
    await ensureServer()
    const agent = await findSingleAgent(agentQuery)
    const meta = normalizeAgentMetadata(agent.metadata)
    const stored = meta.permissionGrant || null
    const storedText = stored ? (typeof stored === 'string' ? stored : JSON.stringify(stored)) : 'none'
    console.log(`${agent.friendly_name || agent.id} (${agent.id})`)
    console.log(`  permissions: ${storedText}`)
    return
  }

  try {
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR))
    const config = withDaemonModelAliases({}, daemonConfig)
    const profiles = config.permissionProfiles || {}
    const name = String(profileArg || '').trim()
    if (!profiles[name]) throw new Error('not configured')
  } catch (e) {
    const detail = e?.message ? `: ${e.message}` : ''
    console.error(`Unknown permission profile "${profileArg}"${detail}. Supported profiles: ${permissionGrantNamesForError()}`)
    process.exit(1)
  }
  const description = profileArg
  const wakeNow = !hasFlag('on-wake')

  if (hasFlag('dry-run')) {
    console.log(`[dry-run] would set ${agentQuery} permissions to ${description}`)
    console.log('  1. look up existing agent identity')
    console.log('  2. update the durable permission grant')
    console.log(wakeNow
      ? `  3. run locally: ${agentWakeSuggestion([agentQuery, '--permissions', profileArg])}`
      : '  3. leave the change for the next wake')
    return
  }

  await ensureServer()
  const agent = await findAgentForPermission(agentQuery)
  const spawnName = spawnNameForAgent(agent, agentQuery)
  await api('POST', '/api/set-metadata', {
    agent: agent.id,
    permissionRequest: profileArg,
    permissionGrant: profileArg,
    permissionGrantChangedBy: 'tlda-agent-permissions-cli',
    permissionGrantChangedAt: new Date().toISOString(),
  })
  if (!wakeNow) {
    console.log(`Updated ${agent.id} permissions to ${description}; will apply on wake.`)
    return
  }
  console.log(`Updated ${agent.id} permissions to ${description}.`)
  console.log(`Wake locally with: ${agentWakeSuggestion([spawnName, '--permissions', profileArg])}`)
}

async function cmdAgentModels() {
  const { listModels } = await import('../agent-launch/models.mjs')
  const daemonConfig = readDaemonConfig()
  const catalog = listModels(withDaemonModelAliases({}, daemonConfig))
  if (hasFlag('json')) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  const groups = new Map()
  for (const model of catalog.models || []) {
    const group = model.group || model.kind || 'models'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(model)
  }
  for (const [group, models] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const items = models
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.alias.localeCompare(b.alias))
      .map(model => model.alias === model.id ? model.alias : `${model.alias} -> ${model.id}`)
    console.log(`${group}: ${items.join(', ')}`)
  }
  if (catalog.defaultAlias) console.log(`default: ${catalog.defaultAlias}`)
}

async function cmdAgent() {
  const sub = getPositional(0)
  if (!sub || (hasFlag('help') && sub !== 'permissions' && sub !== 'move' && sub !== 'set-mint-machine')) {
    usageAgent()
    return
  }
  switch (sub) {
    case 'list':
    case 'ls':        await listFleetAgents(); break
    case 'mint':      await runFleetSpawn(agentMintArgs(process.argv.slice(4))); break
    case 'enroll':    await runFleetSpawn(agentEnrollArgs(process.argv.slice(4))); break
    case 'wake':      await runFleetSpawn(process.argv.slice(4)); break
    case 'move':      await cmdAgentMove(); break
    case 'set-mint-machine': await cmdAgentSetSpawnMachine(); break
    case 'check-ready': await cmdAgentCheckReady(); break
    case 'attach':    await attachToAgent(getPositional(1)); break
    case 'hibernate': await hibernateAgent(getPositional(1)); break
    case 'dismiss':   await dismissAgent(getPositional(1)); break
    case 'permissions': await cmdAgentPermissions(); break
    case 'models': await cmdAgentModels(); break
    default:
      console.error('Usage: tlda agent <list|mint|enroll|wake|move|set-mint-machine|check-ready|attach|hibernate|dismiss|permissions|models> [name]')
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

// Top-level attach is rejected earlier with a noun-first message; this helper
// remains for the dev command switch below.
async function cmdAttach() { await attachToAgent(getPositional(0)) }

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
  const sub = getPositional(0)
  if (sub === 'yolo') return await cmdDoctorYolo()

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
        const child = cpSpawn(process.execPath, ['--import', 'tsx', serverScript, '--i-am-tlda-cli'], {
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
    const configName = getActiveConfigName()

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
            env: { TLDA_CONFIG: configName }
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

async function cmdDoctorYolo() {
  if (hasFlag('help')) {
    console.log(COMMAND_HELP.doctor)
    return
  }

  const { launchDoctorYolo } = await import('../agent-launch/index.mjs')
  const { tmuxArgs } = await import('../agent-launch/tmux.mjs')

  const name = String(getFlag('name', 'yolo') || 'yolo')
  const cwd = resolve(getFlag('cwd') || process.cwd())
  const tmuxSocket = process.env.TMUX_SOCKET || null
  const dryRun = hasFlag('dry-run')
  const modelAlias = String(getFlag('model') || '')
  const kind = String(getFlag('kind', 'codex') || 'codex').trim().toLowerCase()
  if (!modelAlias) throw new Error('tlda doctor yolo requires --model <provider-model>')

  if (dryRun) {
    console.log('tlda doctor yolo dry run')
    console.log(`  name: ${name}`)
    console.log(`  cwd: ${cwd}`)
    console.log(`  model: ${modelAlias}`)
    console.log(`  kind: ${kind}`)
    console.log('  path: direct local tmux launch; no daemon/server/grant dependency')
    return
  }

  const launched = await launchDoctorYolo({
    name,
    cwd,
    model: modelAlias,
    kind,
    tmuxSocket,
  })
  const { localAgentId, fleetId, tmuxSession, harness: harnessKind, model } = launched

  // Interactive terminal → drop the operator straight into the agent's session, the
  // way spawn used to. You watch it log in live, so there is no false "launched" — a
  // stuck prompt or crash is right in front of you. (--no-attach opts out.)
  if (process.stdout.isTTY && !hasFlag('no-attach')) {
    const { spawnSync } = await import('node:child_process')
    console.log(dim(`Attaching to ${tmuxSession} (detach with Ctrl-b d)…`))
    spawnSync('tmux', tmuxArgs(tmuxSocket, 'attach', '-t', tmuxSession), { stdio: 'inherit' })
    return
  }

  console.log(green(bold('Break-glass agent launched locally.')))
  if (fleetId) console.log(`  fleet_id: ${fleetId}`)
  console.log(`  local_agent_id: ${localAgentId}`)
  console.log(`  name: ${name}`)
  console.log(`  kind: ${harnessKind}`)
  console.log(`  tmux: ${tmuxSession}`)
  console.log(`  cwd: ${cwd}`)
  console.log(`  model: ${model}`)
  if (launched.promptDelivery?.ok === false) {
    console.log(dim('  Prompt delivery was not verified; attach to inspect the local session.'))
  }
  console.log(dim('  This is not a normal fleet mint and does not prove a server recipient binding.'))
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

    const tokenEnvLines = []
    const tokenRw = getRwToken()
    const tokenRead = getReadToken()
    if (tokenRw) tokenEnvLines.push(`        <key>TLDA_TOKEN_RW</key>\n        <string>${tokenRw}</string>`)
    if (tokenRead) tokenEnvLines.push(`        <key>TLDA_TOKEN_READ</key>\n        <string>${tokenRead}</string>`)

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tlda.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>--import</string>
        <string>tsx</string>
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
    // Also kill a zombie MAIN server that isn't bound to the port (e.g. an old
    // instance still running its daemon-supervisor loop). Match the THIS-checkout
    // absolute server path only — NOT the bare "server/unified-server.mjs", which
    // is a substring of every worktree's `.../.worktrees/X/server/unified-server.mjs`
    // and so swept every `tlda-dev serve` preview on every stop/deploy. That
    // cross-worktree sweep is exactly what killed Skip's preview tabs when an
    // unrelated agent restarted the main server. Worktree dev servers are managed
    // by `tlda-dev serve stop`, never by the main `server stop`.
    try { execSync(`pkill -f ${JSON.stringify(serverScript)}`, { stdio: 'pipe' }) } catch {}
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
    const status = await resolveServerStatus({ serverUrl: getServer(), port })
    console.log(formatServerStatus(status))
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
      // No supervisor: spawn the server fully detached via the shared helper
      // (the same daemonization `tlda-dev serve` uses, so there's one robust
      // path, not a hand-rolled parallel one). reclaimPort: the main server owns
      // the fixed port, so clear a dead LISTENer before binding.
      const { spawnDetachedServer } = await import('./lib/server-start.mjs')
      spawnDetachedServer({
        serverScript, port, logFile: LOGFILE, reclaimPort: true,
        extraCaPath: hasTls ? TLS_CA_PATH : null,
      })
    }

    // Wait for it to come up. The server can boot slowly (large fleet-DB query
    // on a big roster — measured ~50s on a ~1500-row agents table), so give it
    // ~90s before declaring failure. A too-short wait (was 30s) made `tlda deploy`
    // falsely report "Server failed to start" while the server was still booting,
    // tempting a panic rollback. (Real cure: speed the boot — see the startup scan.)
    for (let i = 0; i < 360; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        const res = await fetch(`${getServer()}/health`)
        if (res.ok) {
          const data = await res.json()
          console.log(green(`Server running at ${getServer()}`) + dim(` (pid ${data.pid})`))
          console.log(dim(`  Log: ${LOGFILE}`))
          if (hasLaunchd) console.log(dim('  Managed by launchd (auto-restarts)'))
          // Also ensure the fleet daemon is up; the daemon owns configured bots.
          await ensureFleetDaemonRunning()
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

async function cmdSystem() {
  const sub = getPositional(0) || 'status'
  if (sub !== 'status') {
    console.error('Usage: tlda system status')
    process.exit(1)
  }
  const data = await api('GET', '/api/runtime-status')
  process.stdout.write(formatSystemStatus(data))
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

export function isLocalServerUrl(serverUrl) {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

export async function resolveServerStatus({
  serverUrl,
  port = getPort(),
  fetchImpl = fetch,
  execSyncImpl = null,
  timeoutMs = 3000,
} = {}) {
  const local = isLocalServerUrl(serverUrl)
  try {
    const res = await fetchImpl(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) {
      const data = await res.json()
      return {
        status: 'running',
        serverUrl,
        local,
        uptime: Number.isFinite(data.uptime) ? Math.floor(data.uptime) : null,
        pid: data.pid || null,
      }
    }
  } catch {
    // Probe miss: classify below according to the resolved URL's scope.
  }

  if (!local) {
    return { status: 'not-responding', serverUrl, local }
  }

  // /health didn't answer. For a local server URL only, a held local port means
  // the process is still alive but slow or wedged; do not restart-stampede it.
  let held = ''
  try {
    const exec = execSyncImpl || (await import('child_process')).execSync
    held = exec(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim()
  } catch {
    held = ''
  }
  const pid = held ? held.split('\n')[0] : null
  return pid
    ? { status: 'local-listener-not-responding', serverUrl, local, pid }
    : { status: 'not-running', serverUrl, local }
}

export function formatServerStatus(status) {
  if (status.status === 'running') {
    const details = []
    if (status.uptime !== null) details.push(`uptime: ${status.uptime}s`)
    if (status.pid) details.push(status.local ? `pid ${status.pid}` : `remote/container pid ${status.pid}`)
    const suffix = details.length ? dim(` (${details.join(', ')})`) : ''
    return green(`Server running at ${status.serverUrl}`) + suffix
  }
  if (status.status === 'local-listener-not-responding') {
    return yellow(`Server running at ${status.serverUrl}`) + dim(` but not responding (event loop busy, pid ${status.pid})`)
  }
  if (status.status === 'not-responding') {
    return red(`Server not responding at ${status.serverUrl}.`)
  }
  return red(`Server not running at ${status.serverUrl}.`)
}

async function serverHealthOk(serverUrl, { timeoutMs = 3000 } = {}) {
  for (const path of ['/health', '/api/health']) {
    try {
      const res = await fetch(`${serverUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return true
    } catch {
      // Expected probe miss: try the alternate health endpoint.
    }
  }
  return false
}

async function ensureServer() {
  const server = getServer()
  if (!isLocalServerUrl(server)) return
  if (await serverHealthOk(server)) return

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

// `tlda-dev serve` is the worktree-relative reachable preview — it lives in
// cli/lib/dev-worktree.mjs and is intercepted by the tlda-dev front-end, so there
// is no `serve` case in the switch below.

async function cmdDevUrl() {
  // Prefer the .dev-url that `tlda-dev serve` wrote (correct scheme + token).
  const devUrlPath = join(process.cwd(), '.dev-url')
  if (existsSync(devUrlPath)) { console.log(readFileSync(devUrlPath, 'utf8').trim()); return }
  const portArg = getFlag('port')
  const port = portArg ? parseInt(portArg) : 5180
  const token = getToken()
  const scheme = 'http'
  const selected = selectDevShareBase({ scheme, port, tailscaleIp: findTailscaleIPv4(), lanIp: findLanIPv4() })
  if (!selected.shareable) {
    console.error(`dev URL unavailable: ${selected.reason}.`)
    console.error('Not printing localhost; it is broken for users on another machine.')
    process.exit(1)
  }
  const base = `${selected.base}/`
  console.log(token ? `${base}?token=${token}` : base)
}

// --- Main ---

async function main() {
  try {
    // Developer commands live on the `tlda-dev` binary (the developer app), not
    // on plain `tlda` (the user app). When reached directly as `tlda <devcmd>`,
    // point the user at tlda-dev instead of silently running it. tlda-dev sets
    // TLDA_DEV_CLI=1 when it forwards, so it still works through that path.
    if (DEV_COMMANDS.includes(command) && !process.env.TLDA_DEV_CLI) {
      console.error(`'${command}' is a developer command — run: tlda-dev ${command}`)
      process.exit(1)
    }
    switch (command) {
      case 'server': await cmdServer(); break
      case 'system': await cmdSystem(); break
      case 'scratch': await ensureServer(); await cmdScratch(); break
      case 'book':   await ensureServer(); await cmdBook(); break
      case 'push':   await ensureServer(); await cmdPush(); break
      case 'link':   await ensureServer(); await cmdLink(); break
      case 'init':   await cmdInit(); break
      case 'daemon': await cmdWatch(); break
      case 'bot': await cmdBot(); break
      case 'open':   await ensureServer(); await cmdOpen(); break
      case 'share':  await cmdShare(); break
      case 'list':   await ensureServer(); await cmdList(); break
      case 'ls':     await ensureServer(); await cmdList(); break
      case 'status': await ensureServer(); await cmdStatus(); break
      case 'errors': await ensureServer(); await cmdErrors(); break
      case 'delete':  await ensureServer(); await cmdDelete(); break
      case 'rm':      await ensureServer(); await cmdDelete(); break
      case 'move':    await ensureServer(); await cmdMoveProject(); break
      case 'logs':    await cmdLogs(args.slice(1)); break
      case 'log':     await cmdLogs(args.slice(1)); break
      case 'auth': await cmdAuth(); break
      case 'mcp-setup': await cmdMcpSetup(); break
      case 'config': await cmdConfig(); break
      case 'setup': await cmdSetup(); break
      case 'agent': await cmdAgent(); break
      case 'restart-mcp': await restartMcpAgents(process.argv.slice(3)); break // dev-only; surfaced via `tlda-dev restart-mcp`
      case 'dev-url': await cmdDevUrl(); break
      case 'deploy': await cmdDeploy(); break
      case 'doctor':
      case 'dr': await cmdDoctor(); break
      case 'completions': cmdCompletions(); break
      case 'init-shadow': await cmdInitShadow(); break
      case 'repo-doctor': await cmdRepoDoctor(); break
      case 'doc':
        console.log(`tlda doc — work on a document project

${formatCommandRows(DOC_COMMANDS)}`)
        break
      default:
        console.log(`tlda — collaborative LaTeX paper review

${formatCommandRows(TOP_LEVEL_COMMANDS.map(([name, description]) => [`tlda ${name}${name === 'logs' ? ' [agent]' : name === 'daemon' ? ' [start|stop]' : name === 'doctor' ? ' [--fix]' : name === 'doc' || name === 'server' || name === 'agent' || name === 'config' || name === 'bot' ? ' <cmd>' : ''}`, description]))}

Run \`tlda <noun>\` (e.g. \`tlda doc\`) to list that group's commands.
Developer commands (hacking on tlda itself): \`tlda-dev --help\`

Options: --server <url> · --dir <path> · --title "…" · --main file.tex`)
    }
  } catch (e) {
    console.error(red(`Error: ${e.message}`))
    process.exit(1)
  }
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false
  const thisFile = fileURLToPath(import.meta.url)
  try {
    return realpathSync(thisFile) === realpathSync(resolve(process.argv[1]))
  } catch {
    return thisFile === resolve(process.argv[1])
  }
}

if (isCliEntrypoint()) {
  main()
}
