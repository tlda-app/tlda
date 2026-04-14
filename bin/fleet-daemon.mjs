#!/usr/bin/env node
/**
 * fleet-daemon — per-machine local agent for the tlda hub server.
 *
 * The daemon owns everything that has to happen on the user's local machine:
 *
 *   1. JSONL watching — fs.watch on Claude Code session files in
 *      ~/.claude/projects/<projectHash>/<sessionId>.jsonl, parse new
 *      bytes, and push activity-event + terminal-chat messages over
 *      WebSocket to the server.
 *
 *   2. Document source watching — fs.watch on each tlda project's
 *      sourceDir; on file change, push a source-change message
 *      containing the file content. The server runs the build.
 *
 * What it does NOT do:
 *   - No SQLite. The server owns the fleet store.
 *   - No HTTP. Browsers talk to the server, not the daemon.
 *   - No tmux RPCs. Phase 2 will add those.
 *
 * Lifecycle:
 *   - Reads ~/.config/tlda/config.json for { server, tokenRw, machineId }.
 *   - Derives a stable machineId from the MAC if missing; persists it.
 *   - Opens WS to ${server}/ws/fleet-daemon?token=...
 *   - Sends `daemon-hello`; waits for `daemon-welcome` with the agent
 *     and project list for this machine, then starts watching.
 *   - Reconnects with exponential backoff on WS drop. State lives on
 *     the server; reconnection is a no-op for the daemon's logical state.
 *
 * Cursor persistence:
 *   - JSONL byte offsets are persisted to ~/.config/tlda/daemon-cursors.json
 *     keyed by sessionId, including the file's inode. On reconnect or
 *     daemon restart we resume from the saved offset, but only if the
 *     inode still matches — Claude Code rotates JSONLs on compaction
 *     (delete + recreate), and the old offset would point into a
 *     different file.
 *   - On first observation of a session, we start at EOF (no backfill);
 *     historical events would be too expensive to replay.
 *
 * Spec: scratch/fleet-daemon-spec.md (Phase 1).
 */

import { WebSocket } from 'ws'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileP = promisify(execFile)

const VERSION = '0.1.0'
const CONFIG_DIR = path.join(os.homedir(), '.config', 'tlda')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const CURSORS_FILE = path.join(CONFIG_DIR, 'daemon-cursors.json')
const PID_FILE = path.join(CONFIG_DIR, 'fleet-daemon.pid')
const LOG_FILE = path.join(CONFIG_DIR, 'fleet-daemon.log')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// ---------- config / machine identity ----------

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  catch (e) { console.error(`[daemon] failed to read config: ${e.message}`); return {} }
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

// Stable per-machine identifier. Uses the short hostname (hostname -s) —
// human-readable in the DB, stable across reboots, and the fleet MCP runs
// the same derivation so agent ↔ daemon mapping is consistent without
// coordination. Skip has one Mac; collision avoidance is future work.
function deriveMachineId() {
  // os.hostname() may return an FQDN like "skip-air.local" or
  // "skip-air.tail-scale.ts.net" — strip everything after the first dot
  // so the id is the same on a Tailscale-renamed box.
  return os.hostname().split('.')[0]
}

const config = loadConfig()
const SERVER = process.env.TLDA_SERVER || config.server || 'http://localhost:5176'
const TOKEN = process.env.TLDA_TOKEN || config.tokenRw || config.token || null

let MACHINE_ID = config.machineId || null
if (!MACHINE_ID) {
  MACHINE_ID = deriveMachineId()
  saveConfig({ ...config, machineId: MACHINE_ID })
  console.log(`[daemon] derived machine_id=${MACHINE_ID} (saved to config)`)
}

// boot_id — monotonic per process start. Used by the server to break ties
// when two daemons claim the same machine_id (newer wins, older evicted).
const BOOT_ID = Date.now()
const USER = os.userInfo().username
const HOSTNAME = os.hostname()

// ---------- cursor persistence ----------

function loadCursors() {
  if (!fs.existsSync(CURSORS_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(CURSORS_FILE, 'utf8')) }
  catch { return {} }
}
function saveCursors() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  try { fs.writeFileSync(CURSORS_FILE, JSON.stringify(cursors, null, 2)) }
  catch (e) { console.error(`[daemon] cursor save failed: ${e.message}`) }
}
let cursors = loadCursors() // { sessionId: { inode, offset } }

// Throttle saveCursors — flush at most once per 2s.
let _cursorSaveTimer = null
function scheduleCursorSave() {
  if (_cursorSaveTimer) return
  _cursorSaveTimer = setTimeout(() => { _cursorSaveTimer = null; saveCursors() }, 2000)
}

// ---------- JSONL parsing (mirrors fleet/dashboard/search-index.mjs) ----------

function parseSessionLine(jsonStr) {
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  const t = obj.type
  if (t === 'progress' || t === 'file-history-snapshot') return null
  const msg = obj.message || {}
  const ev = { type: t, timestamp: obj.timestamp }

  if (t === 'assistant' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: c.input, id: c.id }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
    if (msg.usage) {
      const u = msg.usage
      ev.usage = {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      }
    }
  } else if (t === 'user' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_result') {
        const text = typeof c.content === 'string' ? c.content :
          Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content)
        return { type: 'tool_result', id: c.tool_use_id, text, is_error: c.is_error || false }
      }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
  } else {
    return null
  }
  return ev
}

// Activity noise filter — these tools are fleet infrastructure, not real
// agent work, and don't deserve activity cards. Mirrored from
// fleet/dashboard/server.mjs ACTIVITY_NOISE.
const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'task_list', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'chat', 'delegate', 'report', 'share', 'spawn', 'respawn', 'interrupt',
  'name_agent', 'label_agent', 'observe', 'promote', 'cleanup',
  'mcp__fleet__wait_for_task', 'mcp__fleet__my_task', 'mcp__fleet__task_list',
  'mcp__fleet__register', 'mcp__fleet__register_manager', 'mcp__fleet__task_check',
  'mcp__fleet__task_done', 'mcp__fleet__timer',
  'mcp__fleet__chat', 'mcp__fleet__delegate', 'mcp__fleet__report',
  'mcp__fleet__share', 'mcp__fleet__spawn', 'mcp__fleet__respawn',
  'mcp__fleet__interrupt', 'mcp__fleet__name_agent', 'mcp__fleet__label_agent',
  'mcp__fleet__observe', 'mcp__fleet__promote', 'mcp__fleet__cleanup',
  'ToolSearch',
])

// Tools whose results should be captured and forwarded as pretty-printed cards
const PRETTY_PRINT_TOOLS = new Set(['mcp__fleet__search_logs', 'mcp__fleet__get_thread'])

// Pending pretty-print tool_uses waiting for their results. Keyed by tool_use_id.
// When a tool_use for a pretty-print tool arrives without a matching result in
// the same batch, we stash the activity event here. When the result arrives in
// a later batch, we send a follow-up activity event with the prettyResult.
// Entries expire after 30s to avoid leaking memory on abandoned tool calls.
const pendingPrettyPrint = new Map()  // id -> { agentId, evt, expiresAt }

function extractActivityEvents(events) {
  const result = []
  // Collect tool_results keyed by tool_use_id so we can match them
  const toolResults = new Map()
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      if (block.type === 'tool_result' && block.id) {
        toolResults.set(block.id, block.text || '')
      }
    }
  }
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      // Skip text from user turns — terminal input is captured separately
      // as terminal-chat. tool_result blocks fall through fine.
      if (ev.type === 'user' && block.type === 'text') continue
      if (block.type === 'tool_use') {
        const name = block.name || ''
        if (ACTIVITY_NOISE.has(name)) continue
        const humanName = name.replace(/^mcp__/, '').replace(/__/g, '/')
        const input = block.input || {}
        const arg = input.file_path || input.path ||
          input.command || input.pattern || input.message ||
          input.query || input.description || ''
        const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
        if (Object.keys(input).length > 0) evt.input = input
        // Attach result for pretty-printed tools
        if (PRETTY_PRINT_TOOLS.has(name) && block.id) {
          if (toolResults.has(block.id)) {
            const raw = toolResults.get(block.id)
            evt.prettyResult = raw.length > 5000 ? raw.slice(0, 5000) + '\n\n… (truncated)' : raw
          } else {
            // Result not in this batch — stash and wait
            pendingPrettyPrint.set(block.id, { evt: { ...evt }, expiresAt: Date.now() + 30000 })
          }
        }
        result.push(evt)
      } else if (block.type === 'text' && block.text?.length > 20) {
        result.push({ tool: '_text', arg: block.text, ts: ev.timestamp })
      }
    }
    if (ev.usage) result.push({ tool: '_usage', ts: ev.timestamp, usage: ev.usage })
  }
  // Check if any tool_results in this batch match pending pretty-print requests
  for (const [id, resultText] of toolResults) {
    const pending = pendingPrettyPrint.get(id)
    if (pending) {
      pendingPrettyPrint.delete(id)
      const capped = resultText.length > 5000 ? resultText.slice(0, 5000) + '\n\n… (truncated)' : resultText
      result.push({ ...pending.evt, tool: '_prettyResult', prettyResult: capped })
    }
  }
  // Expire old pending entries
  const now = Date.now()
  for (const [id, entry] of pendingPrettyPrint) {
    if (now > entry.expiresAt) pendingPrettyPrint.delete(id)
  }
  return result
}

// ---------- daemon state ----------

let ws = null
let backoff = 1000
let agents = []                   // current agent list (from welcome / updates)
let projects = []                 // current project list
const pathWatchers = new Map()    // jsonlPath -> { watcher, primaryAgentId, sessionId }
const agentPaths = new Map()      // agentId -> jsonlPath
const sourceWatchers = new Map()  // projectName -> { watcher, sourceDir, debounce, pending }

// Activity event buffer — flush at bounded rate (max 1 push per 2s) to
// avoid spamming the server during a chatty agent. Mirrors the original
// inline server's `_activityBuffer` / `_activityFlushTimer`.
let activityBuffer = {}          // { agentId: [{tool, arg, input, ts}, ...] }
let activityFlushTimer = null

function bufferActivity(agentId, evts) {
  if (!activityBuffer[agentId]) activityBuffer[agentId] = []
  activityBuffer[agentId].push(...evts)
  if (activityFlushTimer) return
  activityFlushTimer = setTimeout(() => {
    const buf = activityBuffer
    activityBuffer = {}
    activityFlushTimer = null
    for (const [aid, list] of Object.entries(buf)) {
      for (const evt of list) {
        sendMsg({
          type: 'activity-event',
          agent_id: aid,
          tool: evt.tool,
          arg: evt.arg || '',
          input: evt.input || null,
          ts: evt.ts,
          ...(evt.usage ? { usage: evt.usage } : {}),
          ...(evt.prettyResult ? { prettyResult: evt.prettyResult } : {}),
        })
      }
    }
  }, 2000)
}

// ---------- JSONL watching ----------

function syncSessionWatchers(agentList) {
  const activePaths = new Set()

  for (const agent of agentList) {
    if (agent.dead) continue
    const cwd = agent.cwd ?? ''
    const projectHash = cwd.replace(/\//g, '-')

    // Pick the freshest JSONL across all session_ids for this agent.
    // We must skip any session_id that's claimed by *another* live agent's
    // session_id, otherwise an old shared session would attribute its
    // events to the wrong agent.
    const candidateIds = []
    if (agent.session_id) candidateIds.push(agent.session_id)
    for (const sid of (agent.session_ids || [])) {
      if (!candidateIds.includes(sid)) candidateIds.push(sid)
    }
    if (candidateIds.length === 0) continue

    const otherAgentSessions = new Set(
      agentList.filter(a => a.id !== agent.id && a.session_id).map(a => a.session_id)
    )

    let jsonlPath = null
    let bestMtime = 0
    for (const sid of candidateIds) {
      if (otherAgentSessions.has(sid)) continue
      const p = path.join(PROJECTS_DIR, projectHash, sid + '.jsonl')
      try {
        const stat = fs.statSync(p)
        if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; jsonlPath = p }
      } catch {}
    }
    if (!jsonlPath) continue

    activePaths.add(jsonlPath)
    agentPaths.set(agent.id, jsonlPath)

    if (pathWatchers.has(jsonlPath)) {
      const pw = pathWatchers.get(jsonlPath)
      const fileSessionId = path.basename(jsonlPath, '.jsonl')
      // Whichever agent's session_id matches the JSONL filename is the
      // active session — others are historical sharers (post-inhabit).
      if (agent.session_id === fileSessionId) pw.primaryAgentId = agent.id
      continue
    }

    // First time watching this JSONL — initialize cursor.
    const sessionId = path.basename(jsonlPath, '.jsonl')
    let stat
    try { stat = fs.statSync(jsonlPath) } catch { continue }
    const inode = stat.ino
    const stored = cursors[sessionId]
    let offset
    if (stored && stored.inode === inode) {
      offset = Math.min(stored.offset, stat.size)
    } else {
      // New file (or rotated): start at EOF, no backfill.
      offset = stat.size
      cursors[sessionId] = { inode, offset }
      scheduleCursorSave()
    }

    try {
      let debounce = null
      const watcher = fs.watch(jsonlPath, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce)
        const pw = pathWatchers.get(jsonlPath)
        if (!pw) return
        debounce = setTimeout(() => readNewSessionLines(pw.primaryAgentId, jsonlPath, pw.sessionId), 150)
      })
      pathWatchers.set(jsonlPath, { watcher, primaryAgentId: agent.id, sessionId })
      console.log(`[daemon] watching JSONL for ${agent.friendly_name || agent.id}: ${path.basename(jsonlPath)} @ offset=${offset}`)
    } catch (e) {
      console.error(`[daemon] watcher creation failed for ${jsonlPath}: ${e.message}`)
    }
  }

  // Close watchers for paths no longer needed.
  for (const [p, pw] of pathWatchers) {
    if (!activePaths.has(p)) {
      try { pw.watcher.close() } catch {}
      pathWatchers.delete(p)
    }
  }
  for (const aid of [...agentPaths.keys()]) {
    if (!agentList.some(a => a.id === aid && !a.dead)) agentPaths.delete(aid)
  }
}

function readNewSessionLines(agentId, jsonlPath, sessionId) {
  let stat
  try { stat = fs.statSync(jsonlPath) } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[daemon] stat ${jsonlPath}: ${e.message}`)
    return
  }
  const cursor = cursors[sessionId]
  if (!cursor) return

  // Inode rotation — file was deleted+recreated. Reset cursor to start
  // of the new file.
  if (cursor.inode !== stat.ino) {
    cursors[sessionId] = { inode: stat.ino, offset: 0 }
  }
  if (stat.size <= cursors[sessionId].offset) return

  let buf
  try {
    const fd = fs.openSync(jsonlPath, 'r')
    const length = stat.size - cursors[sessionId].offset
    buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, cursors[sessionId].offset)
    fs.closeSync(fd)
  } catch (e) {
    console.error(`[daemon] read ${jsonlPath}: ${e.message}`)
    return
  }
  cursors[sessionId].offset = stat.size
  scheduleCursorSave()

  const lines = buf.toString('utf8').split('\n').filter(l => l.trim())
  const parsedEvents = []

  for (const line of lines) {
    const ev = parseSessionLine(line)
    if (ev) parsedEvents.push(ev)

    // Terminal-chat extraction: user-typed text in the terminal. Same
    // shape the inline server used: from='fleet:skip', to=agentId,
    // metadata.source='terminal'. Server dedups via (timestamp,
    // from, to, text) so duplicate JSONL lines don't double-fire.
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type !== 'user') continue
    const content = parsed.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
    if (!text || text.length < 3) continue
    if (text.length > 2000) text = text.substring(0, 2000)
    if (text.startsWith('<task-notification') || text.startsWith('<system-reminder') ||
        text.startsWith('<channel') || text.startsWith('📬')) continue
    const ts = parsed.timestamp || null
    if (!ts) continue
    sendMsg({
      type: 'terminal-chat',
      agent_id: agentId,
      from: 'fleet:skip',
      text,
      ts,
      session_id: sessionId,
    })
  }

  if (parsedEvents.length > 0) {
    const activity = extractActivityEvents(parsedEvents)
    if (activity.length > 0) bufferActivity(agentId, activity)
  }
}

// ---------- source watching ----------

// Source files we care about for tlda projects. Kept in sync with
// cli/lib/source-files.mjs's allowlist (extensions only — the cli
// helper does more, but the daemon stays standalone).
const SOURCE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.pdf', '.json', '.yml', '.yaml'])
const JUNK_PATTERNS = [/^\.#/, /\.swp$/, /~$/, /\.tmp$/, /\.lock$/]
function isSourceFile(name) {
  if (JUNK_PATTERNS.some(r => r.test(name))) return false
  if (name.includes('node_modules') || name.includes('.git/')) return false
  const ext = path.extname(name).toLowerCase()
  return SOURCE_EXTS.has(ext)
}

function readFileForUpload(fullPath) {
  const data = fs.readFileSync(fullPath)
  // Heuristic: text-y if mostly ASCII; otherwise base64.
  const ext = path.extname(fullPath).toLowerCase()
  const TEXT_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.json', '.yml', '.yaml'])
  if (TEXT_EXTS.has(ext)) return { content: data.toString('utf8') }
  return { content: data.toString('base64'), encoding: 'base64' }
}

function syncSourceWatchers(projectList) {
  const activeNames = new Set()
  for (const p of projectList) {
    if (!p.sourceDir) continue
    if (!fs.existsSync(p.sourceDir)) continue
    activeNames.add(p.name)

    // watchFiles: the set of files the build actually reads (from .fls).
    // If null (no prior build), fall back to just the main file.
    const watchSet = new Set(
      p.watchFiles
        ? p.watchFiles
        : p.mainFile ? [p.mainFile] : []
    )

    // If watcher already exists, just update its watch set (the .fls
    // may have changed after a build). Don't recreate the watcher.
    if (sourceWatchers.has(p.name)) {
      const existing = sourceWatchers.get(p.name)
      existing.watchSet = watchSet
      continue
    }

    const state = { sourceDir: p.sourceDir, debounce: null, pending: new Set(), watchSet }
    try {
      state.watcher = fs.watch(p.sourceDir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        // Only react to files in the watch set, or any .tex/.bib if no
        // watch set (bootstrapping — first build hasn't happened yet).
        if (watchSet.size > 0) {
          if (!watchSet.has(filename)) return
        } else {
          if (!isSourceFile(filename)) return
        }
        state.pending.add(filename)
        if (state.debounce) clearTimeout(state.debounce)
        state.debounce = setTimeout(() => flushSourceChanges(p.name), 200)
      })
      sourceWatchers.set(p.name, state)
      console.log(`[daemon] watching source ${p.name}: ${p.sourceDir} (${watchSet.size} watched files)`)

      // On connect, push only the watched files (not the whole directory).
      // This is a tiny payload — usually 2-5 text files.
      pushWatchedFiles(p.name, p.sourceDir, watchSet)
    } catch (e) {
      console.error(`[daemon] source watcher failed for ${p.name}: ${e.message}`)
    }
  }
  // Stop watching projects we no longer own.
  for (const [name, state] of sourceWatchers) {
    if (!activeNames.has(name)) {
      try { state.watcher.close() } catch {}
      sourceWatchers.delete(name)
    }
  }
}

/**
 * Push all source files in a directory to the server (recursive walk).
 * Called when a new watcher is set up so the server gets the current state,
 * catching any edits that occurred while the daemon was disconnected.
 */
/**
 * Push only the watched files (from .fls) to the server on connect.
 * If watchSet is empty (no prior build), push just .tex and .bib in the
 * top-level directory to bootstrap the first build.
 */
function pushWatchedFiles(projectName, sourceDir, watchSet) {
  const files = []
  if (watchSet.size > 0) {
    for (const rel of watchSet) {
      const full = path.join(sourceDir, rel)
      if (!fs.existsSync(full)) continue
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) { console.error(`[daemon] read ${full}: ${e.message}`) }
    }
  } else {
    // Bootstrap: top-level .tex and .bib only
    try {
      for (const entry of fs.readdirSync(sourceDir)) {
        const ext = path.extname(entry).toLowerCase()
        if (ext !== '.tex' && ext !== '.bib') continue
        const full = path.join(sourceDir, entry)
        try {
          const st = fs.statSync(full)
          if (!st.isFile()) continue
        } catch { continue }
        try { files.push({ path: entry, ...readFileForUpload(full) }) }
        catch (e) { console.error(`[daemon] read ${full}: ${e.message}`) }
      }
    } catch {}
  }
  if (files.length === 0) return
  console.log(`[daemon] connect push: ${files.length} files for ${projectName}`)
  sendMsg({ type: 'source-change', project: projectName, files })
}

function flushSourceChanges(projectName) {
  const state = sourceWatchers.get(projectName)
  if (!state) return
  const filePaths = [...state.pending]
  state.pending.clear()
  state.debounce = null

  const files = []
  const deleted = []
  for (const rel of filePaths) {
    const full = path.join(state.sourceDir, rel)
    if (!fs.existsSync(full)) { deleted.push(rel); continue }
    try { files.push({ path: rel, ...readFileForUpload(full) }) }
    catch (e) { console.error(`[daemon] read ${full}: ${e.message}`) }
  }
  if (files.length === 0 && deleted.length === 0) return

  sendMsg({
    type: 'source-change',
    project: projectName,
    files,
    ...(deleted.length > 0 && { deletedFiles: deleted }),
  })
}

// ---------- RPC handlers (server → daemon) ----------
//
// Each handler receives the params object from the inbound `rpc`
// message and returns a value (resolved into `result`) or throws (turned
// into `error`). The dispatcher in handleServerMessage takes care of
// sending `rpc-reply`.
//
// All tmux interaction goes through `execFile('tmux', [args])` so we
// don't have to worry about shell metacharacter escaping. The session
// names we accept are validated against [a-zA-Z0-9_.\-] just in case.
const SAFE_SESSION_RE = /^[a-zA-Z0-9_.\-]+$/

function checkSession(session) {
  if (!session || !SAFE_SESSION_RE.test(session)) {
    throw new Error(`unsafe tmux session name: ${session}`)
  }
}

async function tmux(...args) {
  return execFileP('tmux', args, { timeout: 5000, encoding: 'utf8' })
}

async function rpcSendKey({ tmux_session, key }) {
  checkSession(tmux_session)
  if (!key) throw new Error('missing key')
  // Translate `ctrl+x` → `C-x` for tmux's send-keys grammar; everything
  // else passes through as-is (Enter, Escape, etc.).
  const tmuxKey = key.replace(/^ctrl\+(.)/i, (_, c) => `C-${c}`)
  await tmux('send-keys', '-t', tmux_session, tmuxKey)
  return { ok: true }
}

async function rpcSendText({ tmux_session, text, enter }) {
  checkSession(tmux_session)
  if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
  if (enter !== false) await tmux('send-keys', '-t', tmux_session, 'Enter')
  return { ok: true }
}

async function rpcCapturePane({ tmux_session, lines }) {
  checkSession(tmux_session)
  const start = `-${Math.max(1, Math.min(parseInt(lines, 10) || 50, 5000))}`
  const { stdout } = await execFileP('tmux',
    ['capture-pane', '-t', tmux_session, '-p', '-e', '-S', start],
    { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  return { ok: true, pane: stdout }
}

async function rpcInterrupt({ tmux_session, agent_id }) {
  checkSession(tmux_session)
  // Synchronous first-shot Escape Escape so the caller can return fast.
  try { await tmux('send-keys', '-t', tmux_session, 'Escape', 'Escape') } catch {}
  // Background poll loop — the daemon owns this so the server can move on.
  ;(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2500))
      try {
        const cap = await execFileP('tmux',
          ['capture-pane', '-t', tmux_session, '-p', '-S', '-50'],
          { timeout: 3000, encoding: 'utf8' })
        const pane = cap.stdout
        const linesArr = pane.split('\n').filter(l => l.trim())
        const last = linesArr.length ? linesArr[linesArr.length - 1] : ''
        if (!pane.includes('esc to interrupt') &&
            (/^[\s]*[❯>][\s📬]*$/.test(last) || pane.includes('Enter to continue'))) break
      } catch {}
      try { await tmux('send-keys', '-t', tmux_session, 'Escape', 'Escape') } catch {}
    }
  })()
  return { ok: true }
}

async function rpcListSessions() {
  try {
    const { stdout } = await execFileP('tmux',
      ['list-sessions', '-F', '#{session_name}'],
      { timeout: 3000, encoding: 'utf8' })
    return { ok: true, sessions: stdout.trim().split('\n').filter(Boolean) }
  } catch (e) {
    // tmux exits non-zero with no sessions; treat as empty list, not error.
    if (/no server running|no sessions/i.test(e.stderr || '')) return { ok: true, sessions: [] }
    throw e
  }
}

async function rpcKick({ agent_id }) {
  if (!agent_id) throw new Error('missing agent_id')
  const dir = path.join(os.homedir(), '.fleet', 'signals')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, agent_id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  fs.writeFileSync(file, Date.now().toString())
  return { ok: true, signal: file }
}

async function rpcRestartMcp({ tmux_session }) {
  checkSession(tmux_session)
  // Verify session exists first so we return a clean error.
  try { await execFileP('tmux', ['has-session', '-t', tmux_session], { timeout: 3000 }) }
  catch { throw new Error(`tmux session not found: ${tmux_session}`) }
  // Delegate to fleet-mcp-restart, which navigates the /mcp interactive
  // menu (server list → fleet → Reconnect). Sending /mcp + Enter alone is
  // not enough — the menu requires cursor navigation. The script lives in
  // the fleet repo and is the canonical implementation.
  const script = '/Users/skip/work/fleet/bin/fleet-mcp-restart'
  try {
    // 30s: the script itself may spend up to 10s interrupting a mid-
    // operation agent (BUSY_TIMEOUT in fleet-mcp-restart) + up to 20s
    // across the four state-driven navigation steps. 15s was too tight
    // once the mid-Grooving handling landed.
    const { stdout, stderr } = await execFileP('bash', [script, tmux_session], { timeout: 30000 })
    return { ok: true, tmux_session, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (e) {
    throw new Error(`fleet-mcp-restart failed: ${e.stderr || e.message}`)
  }
}

// Live terminal-card watching. The server tracks per-browser interest
// and tells the daemon to start polling when the first watcher attaches
// and stop when the last one drops. State is server-held so we just
// keep a local Map of poll timers keyed by tmux_session.
const terminalWatchTimers = new Map() // tmux_session -> { timer, lastHash }
const TERMINAL_POLL_MS = 500
const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g

async function rpcStartTerminalWatch({ tmux_session, agent_id, poll_ms }) {
  checkSession(tmux_session)
  if (terminalWatchTimers.has(tmux_session)) return { ok: true, already: true }
  const interval = Math.max(200, Math.min(parseInt(poll_ms, 10) || TERMINAL_POLL_MS, 5000))
  const state = { lastHash: null, lastFrame: '' }
  const tick = async () => {
    try {
      const { stdout } = await execFileP('tmux',
        ['capture-pane', '-t', tmux_session, '-p', '-e', '-S', '-200'],
        { timeout: 2000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      // Strip ANSI for hashing so cursor-position deltas don't churn.
      const stripped = stdout.replace(ANSI_RE, '')
      const hash = stripped.length + ':' + stripped.slice(-200) // cheap fingerprint
      if (hash === state.lastHash) return
      state.lastHash = hash
      sendMsg({ type: 'terminal-frame', agent_id, tmux_session, pane: stdout, ts: new Date().toISOString() })
    } catch (e) {
      // Session vanished — push a one-shot dead-pane signal and stop polling.
      if (/session not found|can't find session/i.test(e.message)) {
        sendMsg({ type: 'terminal-frame', agent_id, tmux_session, pane: null, dead: true })
        rpcStopTerminalWatch({ tmux_session })
      }
    }
  }
  state.timer = setInterval(tick, interval)
  terminalWatchTimers.set(tmux_session, state)
  // Kick off first frame immediately.
  tick()
  return { ok: true, poll_ms: interval }
}

function rpcStopTerminalWatch({ tmux_session }) {
  const state = terminalWatchTimers.get(tmux_session)
  if (!state) return { ok: true, already: true }
  try { clearInterval(state.timer) } catch {}
  terminalWatchTimers.delete(tmux_session)
  return { ok: true }
}

const RPC_HANDLERS = {
  'send-key': rpcSendKey,
  'send-text': rpcSendText,
  'capture-pane': rpcCapturePane,
  'interrupt': rpcInterrupt,
  'list-sessions': rpcListSessions,
  'kick': rpcKick,
  'restart-mcp': rpcRestartMcp,
  'start-terminal-watch': rpcStartTerminalWatch,
  'stop-terminal-watch': rpcStopTerminalWatch,
}

async function handleRpc(msg) {
  const { id, op } = msg
  const handler = RPC_HANDLERS[op]
  if (!handler) {
    sendMsg({ type: 'rpc-reply', id, error: `unknown op: ${op}` })
    return
  }
  try {
    const result = await handler(msg)
    sendMsg({ type: 'rpc-reply', id, result })
  } catch (e) {
    sendMsg({ type: 'rpc-reply', id, error: e.message || String(e) })
  }
}

// ---------- WS connection ----------

let _droppedCount = 0
let _droppedWarnAt = 0
function sendMsg(obj) {
  if (!ws || ws.readyState !== 1) {
    _droppedCount++
    const now = Date.now()
    if (now - _droppedWarnAt > 5000) {
      console.warn(`[daemon] dropping messages (ws not open); dropped ${_droppedCount} since last warn; sample type=${obj?.type}`)
      _droppedCount = 0
      _droppedWarnAt = now
    }
    return false
  }
  try { ws.send(JSON.stringify(obj)); return true }
  catch (e) { console.error(`[daemon] ws send: ${e.message}`); return false }
}

function teardownWatchers() {
  for (const [, pw] of pathWatchers) { try { pw.watcher.close() } catch {} }
  pathWatchers.clear()
  agentPaths.clear()
  for (const [, s] of sourceWatchers) { try { s.watcher.close() } catch {} }
  sourceWatchers.clear()
  for (const [, t] of terminalWatchTimers) { try { clearInterval(t.timer) } catch {} }
  terminalWatchTimers.clear()
}

let evicted = false

function connect() {
  const wsUrl = SERVER.replace(/^http/, 'ws') + '/ws/fleet-daemon' +
    (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '')
  console.log(`[daemon] connecting to ${wsUrl.replace(/token=[^&]+/, 'token=***')}`)

  try { ws = new WebSocket(wsUrl) }
  catch (e) { console.error(`[daemon] WebSocket ctor: ${e.message}`); scheduleReconnect(); return }

  ws.on('open', () => {
    console.log(`[daemon] connected (machine_id=${MACHINE_ID}, boot_id=${BOOT_ID})`)
    backoff = 1000
    sendMsg({
      type: 'daemon-hello',
      machine_id: MACHINE_ID,
      user: USER,
      hostname: HOSTNAME,
      version: VERSION,
      boot_id: BOOT_ID,
    })
  })

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    handleServerMessage(msg)
  })

  ws.on('close', (code, reason) => {
    if (evicted) {
      console.log(`[daemon] WS closed after eviction; exiting`)
      process.exit(0)
    }
    console.log(`[daemon] WS closed (${code} ${reason || ''}); will reconnect`)
    teardownWatchers()
    scheduleReconnect()
  })

  ws.on('error', (e) => {
    console.error(`[daemon] WS error: ${e.message}`)
    // Belt-and-suspenders: some ws error paths (e.g. ECONNREFUSED before
    // the connection opens) may not reliably fire 'close' afterwards, or
    // may fire close before the next connect() has even started. Schedule
    // a reconnect here too — guarded by a flag so duplicate close+error
    // events don't stack setTimeouts.
    scheduleReconnect()
  })
}

let reconnectScheduled = false
function scheduleReconnect() {
  if (reconnectScheduled) return
  reconnectScheduled = true
  const delay = backoff
  backoff = Math.min(backoff * 2, 30000)
  console.log(`[daemon] scheduling reconnect in ${delay}ms (next backoff=${backoff}ms)`)
  setTimeout(() => {
    reconnectScheduled = false
    connect()
  }, delay)
}

function handleServerMessage(msg) {
  if (msg.type === 'daemon-welcome') {
    agents = msg.agents || []
    projects = msg.projects || []
    console.log(`[daemon] welcome: ${agents.length} agents, ${projects.length} projects`)
    syncSessionWatchers(agents)
    syncSourceWatchers(projects)
    return
  }
  if (msg.type === 'agents-updated') {
    agents = msg.agents || []
    syncSessionWatchers(agents)
    return
  }
  if (msg.type === 'projects-updated') {
    projects = msg.projects || []
    syncSourceWatchers(projects)
    return
  }
  if (msg.type === 'daemon-evict') {
    evicted = true
    const replacedBy = msg.replaced_by_boot_id ? ` (replaced by boot_id=${msg.replaced_by_boot_id})` : ''
    console.error(`[daemon] EVICTED: ${msg.reason || 'unknown'}${replacedBy}`)
    teardownWatchers()
    try { ws.close() } catch {}
    return
  }
  if (msg.type === 'rpc') {
    handleRpc(msg)
    return
  }
  // Unknown message — ignore for forward compatibility.
}

// ---------- lifecycle ----------

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch {}

function shutdown(signal) {
  // Log WHY we're dying so the next post-mortem isn't a scavenger hunt.
  console.log(`[daemon] shutdown via ${signal || 'unknown'} signal; saving cursors and exiting`)
  saveCursors()
  try { fs.unlinkSync(PID_FILE) } catch {}
  try { ws?.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
// Catch every cause-of-death we can intercept. SIGKILL and SIGSTOP can't
// be handled, but logging the rest narrows the post-mortem dramatically.
for (const sig of ['SIGQUIT', 'SIGABRT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2', 'SIGBUS', 'SIGSEGV', 'SIGFPE']) {
  try {
    process.on(sig, () => {
      console.error(`[daemon] received ${sig} — exiting`)
      process.exit(1)
    })
  } catch { /* some signals can't be handled on this platform */ }
}
process.on('uncaughtException', (e) => {
  console.error(`[daemon] uncaught: ${e.stack || e.message}`)
})
process.on('unhandledRejection', (e) => {
  console.error(`[daemon] unhandled rejection: ${e?.stack || e?.message || e}`)
})
// Also log the regular `exit` event so silent process exits get a trace.
process.on('exit', (code) => {
  console.log(`[daemon] process exit (code=${code})`)
})

// Heartbeat: lets the post-mortem distinguish "died at startup" from
// "died mid-life". If the log shows a heartbeat right before silence and
// no exit trace, it's SIGKILL or equivalent. If startup never reached the
// first heartbeat, the crash is in init. Once a minute is plenty.
const HEARTBEAT_INTERVAL_MS = 60_000
let _heartbeatTimer = null
function startHeartbeat() {
  if (_heartbeatTimer) return
  _heartbeatTimer = setInterval(() => {
    const mem = process.memoryUsage()
    console.log(`[daemon] heartbeat pid=${process.pid} rss=${(mem.rss / 1e6).toFixed(1)}MB heap=${(mem.heapUsed / 1e6).toFixed(1)}MB uptime=${Math.round(process.uptime())}s`)
  }, HEARTBEAT_INTERVAL_MS).unref?.() || _heartbeatTimer
}

// Periodically rebuild the search index so search_logs stays current.
// Runs every 5 minutes. buildIncremental is idempotent and only indexes new content.
let _searchRebuildTimer = null
async function rebuildSearchIndex() {
  try {
    const { SearchIndex } = await import('../mcp-server/dashboard/search-index.mjs')
    const idx = new SearchIndex(path.join(os.homedir(), '.claude', 'search-index.sqlite'))
    const result = await idx.buildIncremental()
    if (result.entriesAdded > 0) {
      console.log(`[daemon] search index: +${result.entriesAdded} entries (${result.elapsed}s)`)
    }
  } catch (e) {
    console.error(`[daemon] search index rebuild failed: ${e.message}`)
  }
}
function startSearchRebuild() {
  if (_searchRebuildTimer) return
  // Initial build after 30s (let the daemon finish connecting first)
  setTimeout(rebuildSearchIndex, 30_000)
  _searchRebuildTimer = setInterval(rebuildSearchIndex, 5 * 60_000)
}

console.log(`[daemon] fleet-daemon ${VERSION} starting pid=${process.pid}`)
console.log(`[daemon]   server      = ${SERVER}`)
console.log(`[daemon]   machine_id  = ${MACHINE_ID}`)
console.log(`[daemon]   boot_id     = ${BOOT_ID}`)
console.log(`[daemon]   user        = ${USER}@${HOSTNAME}`)
startHeartbeat()
startSearchRebuild()
connect()
