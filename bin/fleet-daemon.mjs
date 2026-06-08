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
 *   - On reconnect (daemon-welcome after the first), auto-restarts the fleet
 *     MCP for every alive agent with a tmux_session (staggered 500ms apart).
 *     This handles the common case of a server restart disconnecting all MCPs.
 *
 * TODO: individual MCP crash detection (server restart covers the common case)
 *   - Agents' MCPs can crash independently without a server restart.
 *   - To detect these, add a heartbeat: MCP sends a ping every ~60s; server
 *     tracks last_ping_at per agent; daemon polls (or server pushes) agents
 *     whose last_ping_at is stale (> 2min) and restarts them.
 *   - Requires: heartbeat message type in MCP register loop, server
 *     last_ping_at column, and daemon polling logic or server-push "agent-stale".
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
import { ResilientWS } from '../shared/resilient-ws.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveFilePath, uploadFileToServer } from '../shared/chat-file-processing.mjs'
import { processMessageText } from '../shared/message-processing.mjs'
import {
  loadConfig as _loadSharedConfig, saveConfig as _saveSharedConfig,
  getServerUrl, getRwToken, DEFAULT_PORT, hasTls,
  CONFIG_DIR as _SHARED_CONFIG_DIR,
} from '../shared/config.mjs'
const execFileP = promisify(execFile)

const VERSION = '0.1.1'
import { createLogger } from '../shared/logger.mjs'
const log = createLogger('daemon')
// CONFIG_DIR holds config.json, cursors, PID and log files. Defaults to
// ~/.config/tlda. TLDA_DAEMON_CONFIG_DIR lets the E2E test start a second
// daemon in parallel without clobbering the live daemon's PID file.
const CONFIG_DIR = process.env.TLDA_DAEMON_CONFIG_DIR || _SHARED_CONFIG_DIR
const CURSORS_FILE = path.join(CONFIG_DIR, 'daemon-cursors.json')
const PID_FILE = path.join(CONFIG_DIR, 'fleet-daemon.pid')
const LOG_FILE = path.join(CONFIG_DIR, 'fleet-daemon.log')
const DEAD_LETTER_FILE = path.join(CONFIG_DIR, 'daemon-dead-letters.jsonl')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// ---------- config / machine identity ----------

// When using a custom config dir (E2E tests), read from there instead of shared.
const _usingCustomConfigDir = !!process.env.TLDA_DAEMON_CONFIG_DIR

function loadConfig() {
  if (_usingCustomConfigDir) {
    const f = path.join(CONFIG_DIR, 'config.json')
    if (!fs.existsSync(f)) return {}
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return _loadSharedConfig()
}

function saveConfig(cfg) {
  if (_usingCustomConfigDir) {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg, null, 2))
    return
  }
  _saveSharedConfig(cfg)
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
const SERVER = _usingCustomConfigDir
  ? (process.env.TLDA_SERVER || config.server || `${hasTls ? 'https' : 'http'}://localhost:${DEFAULT_PORT}`)
  : getServerUrl(config)
const TOKEN = _usingCustomConfigDir
  ? (process.env.TLDA_TOKEN || config.tokenRw || config.token || null)
  : getRwToken(config)
const TMUX_SOCKET = config.tmuxSocket || null
const TMUX_ARGS = TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []

let MACHINE_ID = config.machineId || null
if (!MACHINE_ID) {
  MACHINE_ID = deriveMachineId()
  saveConfig({ ...config, machineId: MACHINE_ID })
  log.info(`derived machine_id=${MACHINE_ID} (saved to config)`)
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
  catch (e) { log.warn(`corrupt cursors file, resetting: ${e.message}`); return {} }
}
function saveCursors() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
  try { fs.writeFileSync(CURSORS_FILE, JSON.stringify(cursors, null, 2)) }
  catch (e) { log.error(`cursor save failed: ${e.message}`) }
}
let cursors = loadCursors() // { sessionId: { inode, offset } }

// Throttle saveCursors — flush at most once per 2s.
let _cursorSaveTimer = null
function scheduleCursorSave() {
  if (_cursorSaveTimer) return
  _cursorSaveTimer = setTimeout(() => { _cursorSaveTimer = null; saveCursors() }, 2000)
}

// ---------- Qualification checking ----------
// Detects agents editing files without having read required reference docs.
// Config: ~/.claude/qualifications.json — array of { edit: glob, requires: [paths] }

const QUALIFICATIONS_FILE = path.join(os.homedir(), '.claude', 'qualifications.json')
let _qualRules = []
// Per-agent read tracking: agentId → Set of resolved file paths they've Read
const _agentReads = new Map()
// Per-agent warnings already fired: agentId → Set of "editPath:requiredPath" to avoid spam
const _agentWarned = new Map()

function loadQualifications() {
  try {
    if (!fs.existsSync(QUALIFICATIONS_FILE)) return
    const data = JSON.parse(fs.readFileSync(QUALIFICATIONS_FILE, 'utf8'))
    _qualRules = (data.rules || []).map(r => ({
      editPattern: r.edit,
      editRe: globToRegex(r.edit),
      requires: r.requires || [],
    }))
    log.info(`loaded ${_qualRules.length} qualification rules`)
  } catch (e) {
    log.error(`failed to load qualifications: ${e.message}`)
  }
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]')
  // Handle {a,b} alternation
  const withAlts = escaped.replace(/\\\{([^}]+)\\\}/g, (_, inner) =>
    '(' + inner.split(',').join('|') + ')')
  return new RegExp('^' + withAlts + '$')
}

// Derive the virtual skill key from a skill SKILL.md path, e.g.
// ~/.claude/skills/writing/SKILL.md → 'skill:writing'
function skillKeyFromPath(resolvedPath) {
  const home = os.homedir()
  const skillsDir = path.join(home, '.claude', 'skills')
  if (!resolvedPath.startsWith(skillsDir + path.sep)) return null
  const rel = resolvedPath.slice(skillsDir.length + 1) // e.g. 'writing/SKILL.md'
  const parts = rel.split(path.sep)
  if (parts.length === 2 && parts[1] === 'SKILL.md') return 'skill:' + parts[0]
  return null
}

function checkQualification(agentId, toolName, filePath) {
  if (!filePath || _qualRules.length === 0) return
  if (toolName !== 'Edit' && toolName !== 'Write') return

  // Normalize path for matching — strip leading home dir for glob matching
  const home = os.homedir()
  const relative = filePath.startsWith(home) ? filePath.slice(home.length + 1) : filePath
  const reads = _agentReads.get(agentId) || new Set()
  const warned = _agentWarned.get(agentId) || new Set()

  for (const rule of _qualRules) {
    if (!rule.editRe.test(relative) && !rule.editRe.test(filePath)) continue
    for (const req of rule.requires) {
      const resolvedReq = req.startsWith('~') ? path.join(home, req.slice(2)) : req
      // Satisfied by a literal Read of the file OR by invoking the corresponding skill
      const skillKey = skillKeyFromPath(resolvedReq)
      if (reads.has(resolvedReq)) continue
      if (skillKey && reads.has(skillKey)) continue
      const warnKey = `${filePath}:${resolvedReq}`
      if (warned.has(warnKey)) continue
      warned.add(warnKey)
      if (!_agentWarned.has(agentId)) _agentWarned.set(agentId, warned)
      // Fire warning
      const reqShort = req.startsWith('~/') ? req : path.basename(req)
      const fileShort = path.basename(filePath)
      sendMsg({
        type: 'qualification-warning',
        agent_id: agentId,
        file: filePath,
        required: resolvedReq,
        message: `⚠ ${agentId} edited ${fileShort} without reading \`${reqShort}\``,
      })
    }
  }
}

function trackRead(agentId, filePath) {
  if (!filePath) return
  if (!_agentReads.has(agentId)) _agentReads.set(agentId, new Set())
  _agentReads.get(agentId).add(filePath)
}

// Edit attribution: remember which agent most recently Edited/Wrote each file
// (by canonical absolute path), so a source-change can be attributed to the
// agent whose edit triggered the build. Keyed by realpath where resolvable.
/** @type {Map<string, { agentId: string, ts: number }>} absPath → editor */
const _lastEditor = new Map()
function canonPath(p) {
  try { return fs.realpathSync(p) } catch { return p }
}
function recordEdit(agentId, filePath) {
  if (!agentId || !filePath) return
  _lastEditor.set(canonPath(filePath), { agentId, ts: Date.now() })
}
// Resolve the most-recent agent who edited one of the given absolute paths
// within the recency window. Returns null if none match.
const EDIT_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000
function resolveEditor(absPaths) {
  let best = null
  const now = Date.now()
  for (const p of absPaths) {
    const rec = _lastEditor.get(canonPath(p))
    if (!rec || now - rec.ts > EDIT_ATTRIBUTION_WINDOW_MS) continue
    if (!best || rec.ts > best.ts) best = rec
  }
  return best?.agentId || null
}

loadQualifications()

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
        const items = typeof c.content === 'string' ? [{ type: 'text', text: c.content }] :
          Array.isArray(c.content) ? c.content : []
        const text = items.map(x => x.text || '').join('')
        const imgItem = items.find(x => x.type === 'image')
        const imgData = imgItem?.source?.type === 'base64' ? imgItem.source.data : (imgItem?.data || null)
        const imgMime = imgItem?.source?.media_type || imgItem?.mimeType || 'image/png'
        return { type: 'tool_result', id: c.tool_use_id, text, is_error: c.is_error || false, imgData, imgMime }
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
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__task_list',
  'mcp__tlda__register', 'mcp__tlda__register_manager', 'mcp__tlda__task_check',
  'mcp__tlda__task_done', 'mcp__tlda__timer',
  'mcp__tlda__chat', 'mcp__tlda__delegate', 'mcp__tlda__report',
  'mcp__tlda__share', 'mcp__tlda__spawn', 'mcp__tlda__respawn',
  'mcp__tlda__interrupt', 'mcp__tlda__name_agent', 'mcp__tlda__label_agent',
  'mcp__tlda__observe', 'mcp__tlda__promote', 'mcp__tlda__cleanup',
  'ToolSearch',
])

// Tools whose results should be captured and forwarded as pretty-printed cards
const PRETTY_PRINT_TOOLS = new Set(['mcp__tlda__search_logs', 'mcp__tlda__get_thread', 'ScheduleWakeup', 'mcp__tlda__screenshot'])

function truncatePrettyResult(text, toolName) {
  if (text.length <= 5000) return text
  const tool = (toolName || '').toLowerCase()
  if (tool.includes('get_thread') || tool.includes('thread')) {
    const SEP = '\n\n---\n\n'
    const msgs = text.split(SEP)
    if (msgs.length > 8) {
      const front = msgs.slice(0, 3)
      const tail = msgs.slice(-5)
      const hidden = msgs.length - 8
      return front.join(SEP) + SEP + `… ${hidden} messages …` + SEP + tail.join(SEP)
    }
  }
  return text.slice(0, 5000) + '\n\n… (truncated)'
}

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
        let text = block.text || ''
        if (block.imgData) {
          try {
            const imgPath = `/tmp/tlda-ss-${block.id.replace(/[^a-z0-9]/gi, '_')}.png`
            fs.writeFileSync(imgPath, Buffer.from(block.imgData, 'base64'))
            text = text ? text + '\n\nimage:' + imgPath : 'image:' + imgPath
          } catch { /* disk write failed — fall back to text-only prettyResult */ }
        }
        toolResults.set(block.id, text)
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
          input.query || input.description || input.reason || ''
        const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
        if (Object.keys(input).length > 0) evt.input = input
        // Attach result for pretty-printed tools
        if (PRETTY_PRINT_TOOLS.has(name) && block.id) {
          if (toolResults.has(block.id)) {
            const raw = toolResults.get(block.id)
            evt.prettyResult = truncatePrettyResult(raw, name)
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
      const capped = truncatePrettyResult(resultText, pending.evt.tool)
      result.push({ ...pending.evt, origTool: pending.evt.tool, tool: '_prettyResult', prettyResult: capped })
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

let _rws = null  // ResilientWS instance, created at startup
let agents = []                   // current agent list (from welcome / updates)
let projects = []                 // current project list
const pathWatchers = new Map()    // jsonlPath -> { watcher, primaryAgentId, sessionId }
const agentPaths = new Map()      // agentId -> jsonlPath
const sourceWatchers = new Map()  // projectName -> { watcher, sourceDir, debounce, pending }

// ---------- plan mode detection ----------

// Tracks last plan fingerprint per agent to avoid sending duplicates.
const planModeHashes = new Map()        // agentId -> fingerprint string
// Pending setTimeout handles for plan-mode checks. One check per agent at a time.
const pendingPlanChecks = new Map()     // agentId -> timeoutHandle

// Strip ANSI escape codes from terminal output.
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// ---------- prompt detection + auto-accept ----------
//
// The sweep captures panes every 5s and classifies permission prompts:
//   - Memory file writes → auto-accept (option 1)
//   - Other permission prompts → surface as terminal_attention card

const MEMORY_PATH_RE = /\.claude\/projects\/[^/]+\/memory\//

// Detect the TUI radio-button prompt pattern (❯ 1. Yes / 2. ... / 3. No)
const RADIO_PROMPT_RE = /[❯>]\s*1\.\s*Yes/
// Detect y/n permission prompts (Allow this command? (y/n))
const YN_PROMPT_RE = /Allow this (?:command|action)\?\s*\(y\/n\)/i

function extractPromptContext(stripped) {
  // Extract the tool call line above the prompt (e.g. "⏺ Write(path/to/file)" or "⏺ Bash(command)")
  const toolMatch = stripped.match(/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit)\(([^)]*)\)/s)
  if (toolMatch) return `${toolMatch[1]}(${toolMatch[2].trim().slice(0, 120)})`
  // Try "Do you want to [verb] [thing]?" directly
  const doMatch = stripped.match(/Do you want to (\w+) (.+?)\?/)
  if (doMatch) return `${doMatch[1]} ${doMatch[2]}`
  // Try "Allow this command/action" with surrounding context
  const allowMatch = stripped.match(/Allow (.+?)\?/i)
  if (allowMatch) return allowMatch[1].trim().slice(0, 120)
  return null
}

function extractPromptBody(stripped) {
  const lines = stripped.split('\n')
  // Find the last tool call marker (⏺ Tool(...))
  let toolIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit|Agent|Skill)\(/.test(lines[i])) {
      toolIdx = i
      break
    }
  }
  if (toolIdx < 0) return null
  // Find the prompt question line ("Do you want to..." or "Allow this...")
  let promptIdx = -1
  for (let i = toolIdx + 1; i < lines.length; i++) {
    if (/Do you want to|Allow this/i.test(lines[i])) {
      promptIdx = i
      break
    }
  }
  if (promptIdx < 0) return null
  // Extract the tool call line plus any body between it and the question
  const bodyLines = lines.slice(toolIdx, promptIdx)
    .map(l => l.replace(/^\s{0,4}/, ''))
    .filter(l => l.trim())
  if (bodyLines.length === 0) return null
  return bodyLines.join('\n').slice(0, 1000)
}

function detectPrompt(paneText) {
  const stripped = typeof paneText === 'string' ? stripAnsi(paneText) : ''

  // Radio-button TUI prompt (Create/Edit file, self-edit)
  if ((stripped.includes('Do you want to') || stripped.includes('Allow this')) && RADIO_PROMPT_RE.test(stripped)) {
    if (MEMORY_PATH_RE.test(stripped)) {
      return { type: 'auto-accept', reason: 'memory file write' }
    }
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  // y/n permission prompt
  if (YN_PROMPT_RE.test(stripped)) {
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt (y/n)'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  return { type: 'none' }
}

async function autoAcceptPrompt(tmuxSession, reason) {
  try {
    const ptyState = terminalWatchPtys.get(tmuxSession)
    if (ptyState?.alive) {
      ptyState.pty.write('1\r')
    } else {
      await tmux('send-keys', '-t', tmuxSession, '1')
      await new Promise(r => setTimeout(r, 100))
      await tmux('send-keys', '-t', tmuxSession, 'Enter')
    }
    log.info(`auto-accepted prompt (${reason}) in ${tmuxSession}`)
    return true
  } catch (e) {
    log.error(`auto-accept failed in ${tmuxSession}: ${e.message}`)
    return false
  }
}

const AUTO_ACCEPT_INTERVAL_MS = 5000
const promptCooldowns = new Map()
const surfacedPrompts = new Map()

function startAutoAcceptSweep() {
  setInterval(async () => {
    for (const agent of agents) {
      if (!agent.tmux_session) continue
      // Skip agents with active PTY watchers — they get real-time detection
      if (terminalWatchPtys.get(agent.tmux_session)?.alive) continue
      try {
        const { stdout } = await execFileP('tmux',
          [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-80'],
          { timeout: 2000, encoding: 'utf8', maxBuffer: 512 * 1024 })
        const stripped = stripAnsi(stdout)
        const result = detectPrompt(stdout)
        if (result.type === 'auto-accept') {
          const lastAccept = promptCooldowns.get(agent.tmux_session)
          if (lastAccept && Date.now() - lastAccept < 10_000) continue
          promptCooldowns.set(agent.tmux_session, Date.now())
          surfacedPrompts.delete(agent.tmux_session)
          await autoAcceptPrompt(agent.tmux_session, result.reason)
          sendMsg({ type: 'prompt-auto-accepted', agent_id: agent.id, reason: result.reason, ts: new Date().toISOString() })
        } else if (result.type === 'surface') {
          if (surfacedPrompts.get(agent.tmux_session) === result.reason) continue
          surfacedPrompts.set(agent.tmux_session, result.reason)
          log.info(`surfacing prompt for ${agent.friendly_name || agent.id}: ${result.reason}`)
          sendMsg({ type: 'terminal_attention', agent_id: agent.id, tmux_session: agent.tmux_session, text: result.reason, reason: result.reason, snippet: result.snippet || null })
        } else {
          surfacedPrompts.delete(agent.tmux_session)
        }
        if (stripped.includes("Here is Claude's plan") && stripped.includes('Would you like to')) {
          scheduleCheckForPlanModePrompt(agent.id)
        } else {
          planModeHashes.delete(agent.id)
        }
      } catch {
        // Session gone or capture failed — skip silently
      }
    }
  }, AUTO_ACCEPT_INTERVAL_MS)
}

let _autoAcceptStarted = false

async function checkForPlanModePrompt(agentId) {
  pendingPlanChecks.delete(agentId)
  const agent = agents.find(a => a.id === agentId)
  if (!agent?.tmux_session) return

  let pane
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-e', '-S', '-150'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    pane = stripAnsi(stdout)
  } catch (e) {
    log.error(`plan-mode capture ${agentId}: ${e.message}`)
    return
  }

  if (!pane.includes("Here is Claude's plan") || !pane.includes('Would you like to')) return

  if (planModeHashes.has(agentId)) return
  planModeHashes.set(agentId, true)

  // Strategy 1: Read the plan file directly (most reliable).
  // Claude Code prints the path in the terminal output.
  let planText = ''
  const planFileMatch = pane.match(/\/[^\s]*\.claude\/plans\/[^\s]+\.md/)
  if (planFileMatch) {
    try {
      planText = fs.readFileSync(planFileMatch[0], 'utf8').trim()
      log.info(`plan-mode: read plan file ${planFileMatch[0]}`)
    } catch (e) {
      log.warn(`plan-mode: couldn't read plan file ${planFileMatch[0]}: ${e.message}`)
    }
  }

  // Strategy 2: Extract between ╌╌╌ divider lines (original approach).
  if (!planText) {
    const lines = pane.split('\n')
    const dividerIdx = []
    for (let i = 0; i < lines.length; i++) {
      if (/^[\s╌]{10,}$/.test(lines[i].trim()) || lines[i].includes('╌╌╌╌')) {
        dividerIdx.push(i)
      }
    }
    for (let d = 0; d < dividerIdx.length - 1; d++) {
      const between = lines.slice(dividerIdx[d] + 1, dividerIdx[d + 1]).join('\n').trim()
      if (between.length > 20) {
        planText = between
        break
      }
    }
  }

  // Strategy 3: Raw text between the sentinel strings (last resort).
  if (!planText) {
    const startIdx = pane.indexOf("Here is Claude's plan")
    const endIdx = pane.indexOf('Would you like to')
    if (startIdx >= 0 && endIdx > startIdx) {
      planText = pane.slice(startIdx + "Here is Claude's plan".length, endIdx).trim()
    }
  }

  // Always send — even with empty plan text, the card signals "agent is in plan mode"
  if (!planText) planText = '(Plan text could not be extracted — check the agent terminal)'

  sendMsg({
    type: 'plan-mode-prompt',
    agent_id: agentId,
    plan_text: planText,
    tmux_session: agent.tmux_session,
  })
  log.info(`plan-mode-prompt sent for agent ${agentId}`)
}

function scheduleCheckForPlanModePrompt(agentId) {
  if (pendingPlanChecks.has(agentId)) return  // already scheduled
  const handle = setTimeout(() => checkForPlanModePrompt(agentId), 1500)
  pendingPlanChecks.set(agentId, handle)
}


// ---------- activity event buffer ----------

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
          ...(evt.origTool ? { origTool: evt.origTool } : {}),
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
    // Strip worktree suffixes so the project hash matches where Claude Code
    // stores the JSONL (at the original project root, not the worktree).
    const canonicalCwd = cwd.replace(/\/\.claude\/worktrees\/[^/]+$/, '').replace(/\/\.worktrees\/[^/]+$/, '')
    const projectHash = canonicalCwd.replace(/[/.]/g, '-')

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
      let p = path.join(PROJECTS_DIR, projectHash, sid + '.jsonl')
      let foundStat = null
      try {
        foundStat = fs.statSync(p)
      } catch {
        // Not in cwd-derived dir — global search across all project dirs.
        // Needed when agent's JSONL is in a worktree-specific project dir
        // that doesn't match the stripped canonical cwd.
        try {
          for (const dir of fs.readdirSync(PROJECTS_DIR)) {
            const candidate = path.join(PROJECTS_DIR, dir, sid + '.jsonl')
            try { foundStat = fs.statSync(candidate); p = candidate; break } catch {}
          }
        } catch {}
      }
      if (foundStat && foundStat.mtimeMs > bestMtime) {
        bestMtime = foundStat.mtimeMs
        jsonlPath = p
      }
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
      // Backfill search index if not done yet for this session.
      if (!stored.searchBackfilled) {
        stored.searchBackfilled = true
        scheduleCursorSave()
        backfillSearchEntries(agent.id, jsonlPath, sessionId)
      }
    } else {
      // New file (or rotated): start at EOF for activity cards, but backfill
      // all historical content to the search index.
      offset = stat.size
      cursors[sessionId] = { inode, offset, searchBackfilled: true }
      scheduleCursorSave()
      backfillSearchEntries(agent.id, jsonlPath, sessionId)
      // Also backfill all prior sessions for this agent (other JSONLs that
      // contain a registration line for this fleet ID).
      backfillAllPriorSessions(agent.id, agent.id)
    }

    try {
      let debounce = null
      const onWatchFired = () => {
        if (debounce) clearTimeout(debounce)
        const pw = pathWatchers.get(jsonlPath)
        if (!pw) return
        pw.watchSeenAt = Date.now()
        debounce = setTimeout(() => readNewSessionLines(pw.primaryAgentId, jsonlPath, pw.sessionId), 150)
      }
      const createWatcher = () => fs.watch(jsonlPath, onWatchFired)
      const watcher = createWatcher()

      // Poll fallback: catches writes that fs.watch misses when FSEvents goes silent on macOS.
      fs.watchFile(jsonlPath, { interval: 2000, persistent: false }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return
        const pw = pathWatchers.get(jsonlPath)
        if (!pw) return
        if (pw.watchSeenAt && Date.now() - pw.watchSeenAt < 3000) return
        log.warn(`fs.watch missed ${path.basename(jsonlPath)} — recreating`)
        try { pw.watcher.close() } catch {}
        pw.watcher = createWatcher()
        readNewSessionLines(pw.primaryAgentId, jsonlPath, pw.sessionId)
      })

      pathWatchers.set(jsonlPath, { watcher, primaryAgentId: agent.id, sessionId, watchSeenAt: 0 })
      log.info(`watching JSONL for ${agent.friendly_name || agent.id}: ${path.basename(jsonlPath)} @ offset=${offset}`)

      // Drain any backlog immediately rather than waiting for the next write to
      // fire the watcher. This is what makes reconnect lossless: on a resumed
      // cursor (daemon was disconnected while the agent kept working), the bytes
      // written during the gap stream in now. Self-guards — for a fresh session
      // the cursor is at EOF, so this returns without replaying history.
      readNewSessionLines(agent.id, jsonlPath, sessionId)
    } catch (e) {
      log.error(`watcher creation failed for ${jsonlPath}: ${e.message}`)
    }
  }

  // Close watchers for paths no longer needed.
  for (const [p, pw] of pathWatchers) {
    if (!activePaths.has(p)) {
      try { pw.watcher.close() } catch {}
      fs.unwatchFile(p)
      pathWatchers.delete(p)
    }
  }
  for (const aid of [...agentPaths.keys()]) {
    if (!agentList.some(a => a.id === aid && !a.dead)) agentPaths.delete(aid)
  }
}

function readNewSessionLines(agentId, jsonlPath, sessionId) {
  // The cursor is a high-water mark of *delivered* bytes. If the WS is down we
  // can't push, so don't read+advance past it — leave the bytes for the next
  // read. Otherwise the cursor would skip over activity cards whose send was
  // dropped, losing them permanently. On reconnect, syncSessionWatchers does an
  // immediate read that drains everything written during the outage.
  if (!_rws?.connected) return
  let stat
  try { stat = fs.statSync(jsonlPath) } catch (e) {
    if (e.code !== 'ENOENT') log.error(`stat ${jsonlPath}: ${e.message}`)
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
    log.error(`read ${jsonlPath}: ${e.message}`)
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
    // shape the inline server used: from='fleet:<user>', to=agentId,
    // metadata.source='terminal'. Server dedups via (timestamp,
    // from, to, text) so duplicate JSONL lines don't double-fire.
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type !== 'user') continue
    if (parsed.isMeta) continue
    const content = parsed.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
    if (!text || text.length < 3) continue
    if (text.length > 2000) text = text.substring(0, 2000)
    if (text.startsWith('<task-notification') || text.startsWith('<system-reminder') ||
        text.startsWith('<channel') || text.startsWith('📬') ||
        // The resume/wake bootstrap prompt, in either the no-name `Call register()`
        // or named `Call register(name="foo")` form — plumbing, never shown to the user.
        /^Call register\([^)]*\) with the fleet MCP server\b/.test(text)) continue
    const ts = parsed.timestamp || null
    if (!ts) continue
    sendMsg({
      type: 'terminal-chat',
      agent_id: agentId,
      from: `fleet:${os.userInfo?.()?.username || 'user'}`,
      text,
      ts,
      session_id: sessionId,
    })
  }

  if (parsedEvents.length > 0) {
    const activity = extractActivityEvents(parsedEvents)
    if (activity.length > 0) bufferActivity(agentId, activity)

    // Context-percent: find the latest usage data and compute remaining %
    const lastUsage = [...parsedEvents].reverse().find(ev => ev.usage)
    if (lastUsage) {
      const MAX_CONTEXT = 200_000
      const used = lastUsage.usage.input
      const pct = Math.max(0, Math.round((1 - used / MAX_CONTEXT) * 100))
      sendMsg({ type: 'agent-context', agentId, contextPercent: pct, inputTokens: used })
    }

    // Qualification checking: track reads, check edits/writes
    for (const ev of parsedEvents) {
      if (!ev.blocks) continue
      for (const block of ev.blocks) {
        if (block.type !== 'tool_use') continue
        const input = block.input || {}
        const filePath = input.file_path || input.path || ''
        if (block.name === 'Read' && filePath) trackRead(agentId, filePath)
        if (block.name === 'Skill' && input.skill) trackRead(agentId, 'skill:' + input.skill)
        if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') && filePath) {
          checkQualification(agentId, block.name, filePath)
          recordEdit(agentId, filePath)
        }
      }
    }

    // Plan-mode capture DISABLED 2026-05-18 — was spawning tmux capture-pane
    // per active agent on every JSONL write, flooding the process table under
    // load. Re-enable only after replacing with a tmux-free detection path
    // (e.g. regex scan of the JSONL text itself for the plan-mode sentinel).

    // Check for tool approval prompts — these appear when Claude wants to
    // use a tool that requires permission.
  }

  // Extract text content for unified search and send to server.
  const searchEntries = []
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue
    const ts = parsed.timestamp || parsed.message?.timestamp || parsed.snapshot?.timestamp || null
    if (!ts) continue
    const content = parsed.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
    if (!text || text.length < 3) continue
    searchEntries.push({ agent_id: agentId, session_id: sessionId, role: parsed.type, timestamp: ts, text })
  }
  if (searchEntries.length > 0) sendMsg({ type: 'jsonl-index', entries: searchEntries })
}

// One-time backfill of a JSONL's full content to the search index.
// Called when the daemon first starts watching a new session.
function backfillSearchEntries(agentId, jsonlPath, sessionId) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8')
    const lines = content.split('\n')
    const entries = []
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue
      const ts = parsed.timestamp || parsed.message?.timestamp || parsed.snapshot?.timestamp || null
      if (!ts) continue
      const c = parsed.message?.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) text = c.filter(x => x?.type === 'text').map(x => x.text).join('\n')
      if (!text || text.length < 3) continue
      entries.push({ agent_id: agentId, session_id: sessionId, role: parsed.type, timestamp: ts, text })
    }
    if (entries.length > 0) {
      // Send in batches of 200 to avoid large WS messages
      for (let i = 0; i < entries.length; i += 200) {
        sendMsg({ type: 'jsonl-index', entries: entries.slice(i, i + 200) })
      }
      log.info(`search backfill: ${entries.length} entries for ${path.basename(jsonlPath)}`)
    }
  } catch (e) {
    log.error(`search backfill failed for ${sessionId}: ${e.message}`)
  }
}

// Scan all JSONLs under PROJECTS_DIR for prior sessions belonging to this agent.
// Called once when an agent is first seen (no cursor). Skips sessions already
// marked searchBackfilled in cursors.
function backfillAllPriorSessions(agentId, fleetId) {
  // Fleet IDs are like "fleet:f7322ebe" — the registration line contains the suffix.
  const suffix = fleetId.includes(':') ? fleetId.split(':')[1] : fleetId
  const marker = `Registered fleet:${suffix}`
  let found = 0
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const dirPath = path.join(PROJECTS_DIR, dir)
      let files
      try { files = fs.readdirSync(dirPath) } catch { continue }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.slice(0, -6)
        if (cursors[sessionId]?.searchBackfilled) continue
        const filePath = path.join(dirPath, file)
        let content
        try { content = fs.readFileSync(filePath, 'utf8') } catch { continue }
        if (!content.includes(marker)) continue
        backfillSearchEntries(agentId, filePath, sessionId)
        cursors[sessionId] = { ...(cursors[sessionId] || {}), searchBackfilled: true }
        found++
      }
    }
  } catch (e) {
    log.error(`backfillAllPriorSessions failed for ${fleetId}: ${e.message}`)
  }
  if (found > 0) {
    log.info(`backfilling ${found} prior session(s) for ${fleetId}`)
    scheduleCursorSave()
  }
}

// ---------- source watching ----------

// Source files we care about for tlda projects. Kept in sync with
// cli/lib/source-files.mjs's allowlist (extensions only — the cli
// helper does more, but the daemon stays standalone).
const SOURCE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.pdf', '.json', '.yml', '.yaml'])
const JUNK_PATTERNS = [/^\.#/, /\.swp$/, /~$/, /\.tmp$/, /\.lock$/]

// Bootstrap input scanner — regex-scan .tex files for \input-like commands
// to discover dependencies before the first successful build produces a .fls.
const DEFAULT_INPUT_COMMANDS = ['input', 'include', 'inputscratch', 'addbibresource', 'bibliography', 'usepackage']

function scanTexInputs(sourceDir, mainFile, extraCommands = []) {
  const commands = [...DEFAULT_INPUT_COMMANDS, ...extraCommands]
  const pattern = new RegExp(`\\\\(?:${commands.join('|')})\\{([^}]+)\\}`, 'g')
  const seen = new Set()
  const result = new Set()

  function scan(relPath) {
    if (seen.has(relPath)) return
    seen.add(relPath)
    const full = path.join(sourceDir, relPath)
    if (!fs.existsSync(full)) return
    let stat
    try { stat = fs.statSync(full) } catch { return }
    if (!stat.isFile()) return
    result.add(relPath)

    const ext = path.extname(relPath).toLowerCase()
    if (ext !== '.tex' && ext !== '.sty' && ext !== '.cls') return

    let content
    try { content = fs.readFileSync(full, 'utf8') } catch { return }
    for (const m of content.matchAll(pattern)) {
      const raw = m[1].trim()
      if (!raw) continue
      const cmd = m[0].split('{')[0]
      // \usepackage and \bibliography accept comma-separated lists
      const refs = (cmd === '\\usepackage' || cmd === '\\bibliography')
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : [raw]
      for (let ref of refs) {
        if (cmd === '\\usepackage') {
          if (!ref.endsWith('.sty')) ref += '.sty'
        } else if (cmd === '\\bibliography' || cmd === '\\addbibresource') {
          if (!ref.endsWith('.bib')) ref += '.bib'
        } else if (!path.extname(ref)) {
          ref += '.tex'
        }
        const dir = path.dirname(relPath)
        const resolved = path.normalize(path.join(dir, ref))
        if (resolved.startsWith('..')) continue
        scan(resolved)
        if (cmd === '\\inputscratch' && resolved.endsWith('.tex')) {
          const mdCompanion = resolved.replace(/\.tex$/, '.md')
          if (fs.existsSync(path.join(sourceDir, mdCompanion))) result.add(mdCompanion)
        }
      }
    }
  }

  scan(mainFile)
  return result
}
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

function startPolling(state, rel) {
  const full = path.join(state.sourceDir, rel)
  if (!fs.existsSync(full)) return
  fs.watchFile(full, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return
    state.onFileChange(rel, true)
  })
}

function stopPolling(state, rel) {
  try { fs.unwatchFile(path.join(state.sourceDir, rel)) } catch {}
}

let _activeViewerSet = new Set()

function syncSourceWatchers(projectList, activeViewers) {
  if (activeViewers) _activeViewerSet = new Set(activeViewers)
  const activeNames = new Set()
  for (const p of projectList) {
    if (!p.sourceDir) continue
    if (!fs.existsSync(p.sourceDir)) continue
    activeNames.add(p.name)

    const hasFlsWatchList = p.watchFiles?.length > 0
    const watchSet = new Set(
      hasFlsWatchList ? p.watchFiles : p.mainFile ? [p.mainFile] : []
    )

    if (sourceWatchers.has(p.name)) {
      const existing = sourceWatchers.get(p.name)
      for (const rel of existing.watchSet) if (!watchSet.has(rel)) stopPolling(existing, rel)
      for (const rel of watchSet) if (!existing.watchSet.has(rel)) startPolling(existing, rel)
      existing.watchSet = watchSet
      continue
    }

    const state = { sourceDir: p.sourceDir, debounce: null, pending: new Set(), watchSet, onFileChange: null, projectName: p.name, mainFile: p.mainFile, extraInputCommands: p.extraInputCommands || [], watchSeen: new Map() }

    const onFileChange = (filename, fromPoll) => {
      if (!filename) return
      const isScratch = filename.includes('.tlda/scratch/')
      if (!isScratch) {
        // Source files (.tex, .bib, .sty, etc.) always pass — even if not in the watchSet.
        // The watchSet comes from the PREVIOUS build's .fls; a newly-added \input dep
        // won't be in it yet, but we must still push it so the build can pick it up.
        // Non-source files (build artifacts, .aux, etc.) are filtered by watchSet when
        // available, or dropped entirely when the watchSet is empty (bootstrap mode).
        if (!isSourceFile(filename)) {
          if (state.watchSet.size > 0) {
            if (!state.watchSet.has(filename)) return
          } else {
            return
          }
        }
      }
      if (!fromPoll) {
        state.watchSeen.set(filename, Date.now())
      } else if (state.watcher) {
        const seenAt = state.watchSeen.get(filename)
        if (!seenAt || Date.now() - seenAt > 3000) {
          log.warn(`fs.watch missed ${filename} in ${state.projectName} — recreating`)
          try { state.watcher.close() } catch {}
          state.watcher = fs.watch(state.sourceDir, { recursive: true }, (_ev, fn) => state.onFileChange(fn))
        }
      }
      state.pending.add(filename)
      if (state.debounce) clearTimeout(state.debounce)
      state.debounce = setTimeout(() => flushSourceChanges(state.projectName), 200)
    }
    state.onFileChange = onFileChange

    try {
      for (const rel of watchSet) startPolling(state, rel)
      sourceWatchers.set(p.name, state)
      log.info(`watching source ${p.name}: ${p.sourceDir} (${watchSet.size} files${hasFlsWatchList ? '' : ', bootstrap'})`)
      pushWatchedFiles(p.name, p.sourceDir, watchSet, hasFlsWatchList ? null : p.mainFile, p.extraInputCommands)
    } catch (e) {
      log.error(`source watcher failed for ${p.name}: ${e.message}`)
    }
  }
  for (const [name, state] of sourceWatchers) {
    if (!activeNames.has(name)) {
      try { state.watcher?.close() } catch {}
      for (const rel of state.watchSet) stopPolling(state, rel)
      sourceWatchers.delete(name)
    }
  }
  syncFsWatchers()
}

function syncFsWatchers() {
  for (const [name, state] of sourceWatchers) {
    const needsWatch = _activeViewerSet.has(name)
    if (needsWatch && !state.watcher) {
      try {
        state.watcher = fs.watch(state.sourceDir, { recursive: true }, (_ev, fn) => state.onFileChange(fn))
        log.info(`fs.watch started for ${name} (viewer connected)`)
      } catch (e) { log.error(`fs.watch failed for ${name}: ${e.message}`) }
    } else if (!needsWatch && state.watcher) {
      try { state.watcher.close() } catch {}
      state.watcher = null
    }
  }
}

/**
 * Push all source files in a directory to the server (recursive walk).
 * Called when a new watcher is set up so the server gets the current state,
 * catching any edits that occurred while the daemon was disconnected.
 */
/**
 * Push source files to the server on connect.
 * When mainFile is set (no .fls yet), scan it recursively for \input-like
 * commands and push all discovered dependencies — the bootstrap path.
 * Otherwise push the .fls-derived watchSet.
 */
function pushWatchedFiles(projectName, sourceDir, watchSet, mainFile, extraInputCommands) {
  const files = []
  if (mainFile) {
    // Bootstrap mode: no .fls yet, scan main .tex for \input-like commands
    const deps = scanTexInputs(sourceDir, mainFile, extraInputCommands || [])
    log.info(`bootstrap scan for ${projectName}: ${deps.size} files from ${mainFile}`)
    for (const rel of deps) {
      const full = path.join(sourceDir, rel)
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  } else if (watchSet.size > 0) {
    for (const rel of watchSet) {
      const full = path.join(sourceDir, rel)
      if (!fs.existsSync(full)) continue
      try { files.push({ path: rel, ...readFileForUpload(full) }) }
      catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  }
  if (files.length === 0) return
  log.info(`connect push: ${files.length} files for ${projectName}`)
  sendMsg({ type: 'source-change', project: projectName, files })
}

const _pendingSourceProjects = new Set()

function flushSourceChanges(projectName) {
  const state = sourceWatchers.get(projectName)
  if (!state) return
  state.debounce = null

  if (!_rws?.connected) {
    _pendingSourceProjects.add(projectName)
    return
  }

  const filePaths = [...state.pending]
  state.pending.clear()
  _pendingSourceProjects.delete(projectName)

  const files = []
  const deleted = []
  for (const rel of filePaths) {
    const full = path.join(state.sourceDir, rel)
    if (!fs.existsSync(full)) { deleted.push(rel); continue }
    // Resolve symlinks so the server stores files at their canonical path.
    // Fixes the case where .tlda/scratch/ is a directory symlink (e.g. pointing
    // to revision/.tlda/scratch/) — without this the daemon pushes
    // .tlda/scratch/file.tex but the build expects revision/.tlda/scratch/file.tex.
    let pushPath = rel
    try {
      const realFull = fs.realpathSync(full)
      if (realFull !== full) {
        const canonical = path.relative(state.sourceDir, realFull)
        if (!canonical.startsWith('..')) {
          pushPath = canonical
          if (canonical !== rel) log.info(`resolved symlink: ${rel} → ${canonical}`)
        }
      }
    } catch {}
    try { files.push({ path: pushPath, ...readFileForUpload(full) }) }
    catch (e) { log.error(`read ${full}: ${e.message}`) }
  }

  // When a .tex file changes, rescan for new \input deps not yet on the server.
  // This catches newly-added \input{} or \inputscratch{} lines before the build
  // fails with "file not found".
  const changedTexFiles = filePaths.filter(f => f.endsWith('.tex'))
  if (changedTexFiles.length > 0 && state.mainFile) {
    const alreadyPushed = new Set(filePaths)
    const deps = scanTexInputs(state.sourceDir, state.mainFile, state.extraInputCommands)
    for (const rel of deps) {
      if (alreadyPushed.has(rel) || state.watchSet.has(rel)) continue
      const full = path.join(state.sourceDir, rel)
      if (!fs.existsSync(full)) continue
      try {
        files.push({ path: rel, ...readFileForUpload(full) })
        log.info(`rescan discovered new dep: ${rel}`)
      } catch (e) { log.error(`read ${full}: ${e.message}`) }
    }
  }

  // Watch symlink targets in .tlda/scratch/ — changes to the linked file
  // should trigger a rebuild. Poll the targets since they're outside the source dir.
  for (const rel of filePaths) {
    if (!rel.includes('.tlda/scratch/')) continue
    const full = path.join(state.sourceDir, rel)
    try {
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(full)
        if (!state._symlinkPolls) state._symlinkPolls = new Map()
        if (!state._symlinkPolls.has(target)) {
          state._symlinkPolls.set(target, rel)
          fs.watchFile(target, { interval: 2000 }, () => state.onFileChange(rel, true))
          log.info(`watching symlink target: ${target} -> ${rel}`)
        }
      }
    } catch {}
  }

  if (files.length === 0 && deleted.length === 0) return

  // Edit attribution: which agent's recent Edit/Write touched a changed file.
  const editedBy = resolveEditor(filePaths.map(rel => path.join(state.sourceDir, rel)))

  sendMsg({
    type: 'source-change',
    project: projectName,
    files,
    ...(deleted.length > 0 && { deletedFiles: deleted }),
    ...(editedBy && { editedBy }),
  })
}

function flushPendingSourceChanges() {
  for (const name of _pendingSourceProjects) {
    flushSourceChanges(name)
  }
}

// ---------- Backing file watchers ----------
// The server sends `watch-backing-files` with the current set of files to watch.
// When a file changes, we read it and send `file-content-changed`.
// When we write a file (via RPC), we suppress the next watcher event for it.

/** @type {Map<string, {watcher: import('fs').FSWatcher, docNames: string[], lastWriteAt: number}>} */
const backingWatchers = new Map()

/** Expand ~ in file paths */
function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

function syncBackingWatchers(files) {
  // files = [{filePath: string, docNames: string[]}]
  const incoming = new Map(files.map(f => [expandHome(f.filePath), f.docNames]))

  // Close all existing watchers and rebuild from scratch.
  for (const [, entry] of backingWatchers) {
    try { entry.watcher.close() } catch {}
  }
  backingWatchers.clear()

  for (const [fp, docNames] of incoming) {
    try {
      let debounce = null
      const watcher = fs.watch(fp, () => {
        const entry = backingWatchers.get(fp)
        if (!entry) return
        if (Date.now() - entry.lastWriteAt < 2000) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          try {
            const content = fs.readFileSync(fp, 'utf8')
            log.info(`backing file changed: ${fp} (${content.length} bytes)`)
            sendMsg({ type: 'file-content-changed', filePath: fp, content })
          } catch (e) {
            log.warn(`read backing file ${fp}: ${e.message}`)
          }
        }, 200)
      })
      backingWatchers.set(fp, { watcher, docNames, lastWriteAt: 0 })
      log.info(`watching backing file: ${fp}`)
    } catch (e) {
      log.warn(`watch backing file ${fp}: ${e.message}`)
    }
  }
  if (incoming.size > 0) log.info(`backing watchers: ${backingWatchers.size} active`)
}

async function rpcWriteBackingFile({ filePath, content }) {
  const fp = expandHome(filePath)
  // Record write time before writing to suppress the watcher echo
  const entry = backingWatchers.get(fp)
  if (entry) entry.lastWriteAt = Date.now()
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content ?? '', 'utf8')
  return { ok: true }
}

// ---------- RPC handlers (server → daemon) ----------
//
// Each handler receives the params object from the inbound `rpc`
// message and returns a value (resolved into `result`) or throws (turned
// into `error`). The dispatcher in handleServerMessage takes care of
// sending `rpc-reply`.
//
// All tmux interaction goes through `execFile('tmux', [args])` (never a shell),
// so shell metacharacters need no escaping — a name like `fleet-leverage?` is
// safe to pass verbatim. The only chars that genuinely break tmux are its target
// separators (`:` for session:window) plus whitespace/control, so reject only
// those and tolerate everything else. The old allowlist `[a-zA-Z0-9_.\-]` wrongly
// rejected expressive agent names like `leverage?`, wedging auto-hibernate in a
// retry loop. New spawns are sanitized at the source (fleet-spawn.py); this keeps
// the daemon tolerant of legacy sessions that already carry punctuation.
const SAFE_SESSION_RE = /^[^\s:\x00-\x1f]+$/

function checkSession(session) {
  if (!session || !SAFE_SESSION_RE.test(session)) {
    throw new Error(`unsafe tmux session name: ${session}`)
  }
}

async function tmux(...args) {
  return execFileP('tmux', [...TMUX_ARGS, ...args], { timeout: 5000, encoding: 'utf8' })
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

// Ephemeral PTY connections for reliable keystroke delivery.
// Spawned on demand when no long-lived watcher exists, torn down after idle.
const ephemeralPtys = new Map() // tmux_session -> { pty, alive, teardownTimer }
const EPHEMERAL_TTL_MS = 5000

async function getOrSpawnEphemeralPty(tmuxSession) {
  const existing = ephemeralPtys.get(tmuxSession)
  if (existing?.alive) {
    clearTimeout(existing.teardownTimer)
    existing.teardownTimer = setTimeout(() => teardownEphemeral(tmuxSession), EPHEMERAL_TTL_MS)
    return existing.pty
  }
  const nodePty = await getPty()
  const pty = nodePty.spawn('tmux', [...TMUX_ARGS, 'attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  const state = { pty, alive: true, teardownTimer: null }
  state.teardownTimer = setTimeout(() => teardownEphemeral(tmuxSession), EPHEMERAL_TTL_MS)
  ephemeralPtys.set(tmuxSession, state)
  pty.onExit(() => {
    state.alive = false
    clearTimeout(state.teardownTimer)
    ephemeralPtys.delete(tmuxSession)
  })
  // Discard output — ephemeral PTYs are write-only
  pty.onData(() => {})
  return pty
}

function teardownEphemeral(tmuxSession) {
  const state = ephemeralPtys.get(tmuxSession)
  if (!state) return
  state.alive = false
  ephemeralPtys.delete(tmuxSession)
  try { state.pty.kill() } catch {}
}

async function rpcSendText({ tmux_session, text, enter }) {
  checkSession(tmux_session)
  // Prefer long-lived PTY watcher, then ephemeral PTY, never tmux send-keys
  let pty = terminalWatchPtys.get(tmux_session)?.alive
    ? terminalWatchPtys.get(tmux_session).pty
    : null
  if (!pty) {
    try {
      pty = await getOrSpawnEphemeralPty(tmux_session)
    } catch (e) {
      log.error(`ephemeral PTY failed for ${tmux_session}: ${e.message}, falling back to tmux`)
    }
  }
  if (pty) {
    if (text) pty.write(text)
    if (enter !== false) pty.write('\r')
    return { ok: true, via: 'pty' }
  }
  if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
  if (enter !== false) await tmux('send-keys', '-t', tmux_session, 'Enter')
  return { ok: true, via: 'tmux' }
}

async function rpcCapturePane({ tmux_session, lines, agent_id }) {
  checkSession(tmux_session)
  const start = `-${Math.max(1, Math.min(parseInt(lines, 10) || 50, 5000))}`
  const { stdout } = await execFileP('tmux',
    [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-e', '-S', start],
    { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const prompt = detectPrompt(stdout)
  if (prompt.type === 'auto-accept') {
    const lastAction = promptCooldowns.get(tmux_session)
    if (!lastAction || Date.now() - lastAction >= 10_000) {
      promptCooldowns.set(tmux_session, Date.now())
      autoAcceptPrompt(tmux_session, prompt.reason)
      if (agent_id) sendMsg({ type: 'prompt-auto-accepted', agent_id, reason: prompt.reason, ts: new Date().toISOString() })
    }
  } else if (prompt.type === 'surface' && agent_id) {
    if (surfacedPrompts.get(tmux_session) !== prompt.reason) {
      surfacedPrompts.set(tmux_session, prompt.reason)
      sendMsg({ type: 'terminal_attention', agent_id, tmux_session, text: prompt.reason, reason: prompt.reason, snippet: prompt.snippet || null })
    }
  } else {
    surfacedPrompts.delete(tmux_session)
  }
  return { ok: true, pane: stdout }
}

async function capturePaneTail(tmux_session, lines = 50) {
  const cap = await execFileP('tmux',
    [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-S', `-${lines}`],
    { timeout: 3000, encoding: 'utf8' })
  return cap.stdout
}

// True while Claude Code is mid-turn: it shows a "…ing" spinner and/or the
// "esc to interrupt" hint. Both vanish the moment the agent goes idle. Same
// signal the liveness sweep trusts (THINKING_SPINNER_RE / INTERRUPT_HINT_RE).
function paneIsWorking(pane) {
  const tail = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n')
  return THINKING_SPINNER_RE.test(tail) || INTERRUPT_HINT_RE.test(tail)
}

async function rpcInterrupt({ tmux_session, agent_id }) {
  checkSession(tmux_session)
  // Hard interrupt. A SINGLE Escape stops a working agent (verified directly).
  // The critical invariant: never send a second Escape once the agent is idle —
  // two gapped escapes on an idle Claude Code open the Rewind menu. So send one
  // Escape, then poll; the instant the working indicators are gone, STOP. Only
  // re-send a single Escape while the agent is still visibly working.
  //
  // (The old code sent `Escape Escape` and retried that pair every 2.5s × 5.
  // The first pair stopped the agent; every later pair landed on an idle agent
  // with a gap → Rewind menu + a pile of spurious interrupt cards.)
  //
  // We AWAIT confirmation and return `stopped` so the server can render the
  // interrupt card only when the agent actually halted. A soft-promote also
  // writes "[Request interrupted by user]" to the pane but the agent resumes —
  // so "did it stop?" is the only signal that distinguishes a real hard
  // interrupt (card) from a soft promote (no card).
  try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  let stopped = false
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 1200))
    let pane = ''
    try { pane = await capturePaneTail(tmux_session) } catch {}
    if (!paneIsWorking(pane)) { stopped = true; break }  // idle — do NOT send another escape
    try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  }
  return { ok: true, stopped }
}

// Soft interrupt: promote a QUEUED channel message without stopping the agent's
// work. A single Escape does this — but ONLY when there's something queued. With
// nothing queued, that same Escape hard-interrupts, which is exactly what soft
// must never do.
//
// Anchor on the INPUT BOX (`❯`), not the spinner: the spinner word (`…ing`) only
// shows during the *thinking* phase — while the agent is streaming output there
// is no spinner line, just the "esc to interrupt" hint. The input prompt is the
// one landmark present in every phase. A pending queued message renders as a
// `← …` line sitting a couple of lines above the input box. Once promoted, the
// agent picks it up and new content appears below it, so it's no longer adjacent
// to the box — that's how we confirm.
const QUEUED_LINE_RE = /^\s*←\s/
// Index of a PENDING `← …` queued marker, or -1. The rule (Skip's): a queued
// marker is one that sits ANYWHERE BELOW the spinner. The message the agent is
// already answering has its `←` marker ABOVE the spinner (its output/spinner
// renders below it), so it's excluded automatically — only genuinely-queued
// messages, which land below the current activity line, count. Robust to todo
// lists / status panels, since we only ever match `←` markers. No spinner line
// (idle, or pure text streaming) → nothing to be "below" → no pending queue,
// which fails safe: soft never fires an escape it can't justify.
function pendingQueuedIdx(lines) {
  let s = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (THINKING_SPINNER_RE.test(lines[i])) { s = i; break } }
  if (s < 0) return -1
  for (let i = s + 1; i < lines.length; i++) if (QUEUED_LINE_RE.test(lines[i])) return i
  return -1
}
async function rpcSoftInterrupt({ tmux_session, agent_id }) {
  checkSession(tmux_session)
  let pane = ''
  try { pane = await capturePaneTail(tmux_session) } catch {}
  let lines = pane.split('\n').slice(-THINKING_SCAN_LINES)
  // Only fire when the agent is working AND a queued message is pending just
  // above the input box. Otherwise the escape would hard-interrupt — no-op.
  if (!paneIsWorking(pane) || pendingQueuedIdx(lines) < 0) {
    return { ok: true, promoted: false, reason: 'nothing-queued' }
  }
  try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 700))
    try { pane = await capturePaneTail(tmux_session) } catch {}
    lines = pane.split('\n').slice(-THINKING_SCAN_LINES)
    // Promoted = the queued line is no longer pending just above the input box
    // (the agent consumed it; new content/turn now sits below it).
    if (pendingQueuedIdx(lines) < 0) return { ok: true, promoted: true }
  }
  return { ok: true, promoted: false, reason: 'timeout' }
}

async function rpcListSessions() {
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-sessions', '-F', '#{session_name}'],
      { timeout: 3000, encoding: 'utf8' })
    return { ok: true, sessions: stdout.trim().split('\n').filter(Boolean) }
  } catch (e) {
    // tmux exits non-zero with no sessions; treat as empty list, not error.
    if (/no server running|no sessions/i.test(e.stderr || '')) return { ok: true, sessions: [] }
    throw e
  }
}

async function rpcCheckAlive({ tmux_session }) {
  // Read from the cache populated by checkAgentLiveness every 30s.
  // Zero spawns per call — the periodic poll handles the expensive pgrep work.
  if (!tmux_session) return { alive: false }
  return { alive: _alivenessCache.get(tmux_session) ?? false }
}

async function rpcKick({ agent_id }) {
  if (!agent_id) throw new Error('missing agent_id')
  const dir = path.join(os.homedir(), '.fleet', 'signals')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, agent_id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  fs.writeFileSync(file, Date.now().toString())
  return { ok: true, signal: file }
}

async function rpcKillSession({ tmux_session, agent_id: _agent_id }) {
  if (!tmux_session) throw new Error('missing tmux_session')
  checkSession(tmux_session)
  await tmux('kill-session', '-t', tmux_session)
  // NOTE: killing a tmux session is hibernation, not death. Don't mark dead.
  // Explicit kills go through a separate path that hits /mark-dead directly.
  return { ok: true, tmux_session }
}


// Live terminal-card watching via PTY streaming.
// Instead of polling `tmux capture-pane`, we spawn a PTY running
// `tmux attach -t SESSION` and stream the raw terminal output over WS.
const terminalWatchPtys = new Map() // tmux_session -> { pty, alive }
let ptyModule = null
async function getPty() {
  if (!ptyModule) {
    try {
      const mod = await import('node-pty')
      ptyModule = mod.default || mod
    } catch (e) { throw new Error('node-pty not available: ' + e.message) }
  }
  return ptyModule
}

function detectPromptFromPty(agentId, tmuxSession, state) {
  const result = detectPrompt(state.recentOutput)
  if (result.type === 'auto-accept') {
    const lastAccept = promptCooldowns.get(tmuxSession)
    if (lastAccept && Date.now() - lastAccept < 10_000) return
    promptCooldowns.set(tmuxSession, Date.now())
    state.lastPromptSurfaced = ''
    if (state.alive) {
      state.pty.write('1\r')
      log.info(`pty auto-accepted prompt (${result.reason}) in ${tmuxSession}`)
      sendMsg({ type: 'prompt-auto-accepted', agent_id: agentId, reason: result.reason, ts: new Date().toISOString() })
    }
  } else if (result.type === 'surface') {
    if (state.lastPromptSurfaced === result.reason) return
    state.lastPromptSurfaced = result.reason
    log.info(`pty surfacing prompt for ${agentId}: ${result.reason}`)
    sendMsg({ type: 'terminal_attention', agent_id: agentId, tmux_session: tmuxSession, text: result.reason, reason: result.reason, snippet: result.snippet || null })
  } else {
    state.lastPromptSurfaced = ''
  }
  // Plan mode detection
  if (state.recentOutput.includes("Here is Claude's plan") && state.recentOutput.includes('Would you like to')) {
    if (!planModeHashes.has(agentId)) {
      scheduleCheckForPlanModePrompt(agentId)
    }
  } else {
    planModeHashes.delete(agentId)
  }
}

async function rpcStartTerminalWatch({ tmux_session, agent_id, poll_ms }) {
  checkSession(tmux_session)
  if (terminalWatchPtys.has(tmux_session)) return { ok: true, already: true }

  // Disable tmux status bar — it generates escape code noise in the PTY stream
  try { await execFileP('tmux', [...TMUX_ARGS, 'set-option', '-t', tmux_session, 'status', 'off'], { timeout: 3000 }) } catch {}

  const nodePty = await getPty()
  const pty = nodePty.spawn('tmux', [...TMUX_ARGS, 'attach-session', '-t', tmux_session], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const state = { pty, alive: true, recentOutput: '', lastPromptSurfaced: '' }
  terminalWatchPtys.set(tmux_session, state)

  pty.onData((data) => {
    if (!state.alive) return
    sendMsg({
      type: 'terminal-data',
      agent_id,
      tmux_session,
      data: Buffer.from(data).toString('base64'),
    })
    // Rolling buffer for prompt detection — keep last ~4KB of stripped text
    state.recentOutput += stripAnsi(data)
    if (state.recentOutput.length > 8000) state.recentOutput = state.recentOutput.slice(-4000)
    detectPromptFromPty(agent_id, tmux_session, state)
  })

  pty.onExit(({ exitCode }) => {
    state.alive = false
    terminalWatchPtys.delete(tmux_session)
    log.info(`terminal exited: agent=${agent_id} session=${tmux_session} exitCode=${exitCode}`)
    sendMsg({ type: 'terminal-dead', agent_id, tmux_session, exitCode })
  })

  return { ok: true, streaming: true }
}

function rpcStopTerminalWatch({ tmux_session }) {
  const state = terminalWatchPtys.get(tmux_session)
  if (!state) return { ok: true, already: true }
  state.alive = false
  try { state.pty.kill() } catch {}
  terminalWatchPtys.delete(tmux_session)
  return { ok: true }
}

function rpcTerminalResize({ tmux_session, cols, rows }) {
  checkSession(tmux_session)
  const state = terminalWatchPtys.get(tmux_session)
  if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
  try { state.pty.resize(Math.max(1, cols), Math.max(1, rows)) } catch {}
  return { ok: true }
}

function rpcTerminalInput({ tmux_session, data }) {
  checkSession(tmux_session)
  const state = terminalWatchPtys.get(tmux_session)
  if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
  state.pty.write(data)
  return { ok: true }
}


const _activeSpawns = new Map()
async function rpcSpawn({ name, model, cwd, doc, respawn, effort }) {
  const agentName = name || `agent-${Date.now().toString(36).slice(-4)}`
  if (_activeSpawns.has(agentName)) {
    const age = Date.now() - _activeSpawns.get(agentName)
    if (age < 90_000) {
      log.info(`spawn deduped: ${agentName} already spawning (${Math.round(age / 1000)}s ago)`)
      return { ok: true, name: agentName, deduped: true }
    }
    _activeSpawns.delete(agentName)
  }
  let resolvedCwd = cwd
  if (!resolvedCwd && doc) {
    const project = projects.find(p => p.name === doc)
    if (!project) {
      // An unresolvable project used to drop --cwd silently → the agent launched
      // in launchd's cwd (`/`) and died as a ghost row. Reject loud instead.
      const known = projects.map(p => p.name).sort().join(', ')
      return { ok: false, error: `no project '${doc}'${known ? ` — known: ${known}` : ''}` }
    }
    if (project.sourceDir) resolvedCwd = project.sourceDir
  }
  const args = respawn ? [agentName] : ['--fresh', agentName]
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (resolvedCwd) args.push('--cwd', resolvedCwd)
  args.push('--no-attach')
  // Route spawn through `tlda` (the on-path installed binary, which resolves the
  // fleet-spawn script internally) rather than a bare `fleet-spawn` that depends
  // on PATH. FLEET_SPAWN env still overrides with a direct script path (tests).
  const override = process.env.FLEET_SPAWN
  const spawnScript = override || 'tlda'
  const spawnArgs = override ? args : ['agent', 'spawn', ...args]
  _activeSpawns.set(agentName, Date.now())
  execFile(spawnScript, spawnArgs, {
    timeout: 120_000,
    env: { ...process.env, PATH: process.env.PATH, TMUX: '' },
  }, (err, stdout, stderr) => {
    _activeSpawns.delete(agentName)
    if (err) {
      log.warn(`fleet-spawn finished with error: ${agentName}: ${stderr || err.message}`)
      // Spawn is fire-and-forget (we already returned ok:true), so this async
      // failure is invisible to the server unless we report it. Surface it so a
      // chat-wake that can't resume an agent isn't silently swallowed.
      const detail = ((stderr || err.message || '').trim().split('\n').filter(Boolean).pop()) || 'unknown error'
      sendMsg({ type: 'daemon-warning', message: `couldn't ${respawn ? 'wake' : 'spawn'} ${agentName} — ${detail}` })
    } else {
      log.info(`fleet-spawn finished: ${agentName}: ${stdout.trim()}`)
    }
  })
  return { ok: true, name: agentName, async: true }
}

// --- Agent death detection ---
// Periodically check if agents' claude processes are still running.
// When a process is gone, the agent is hibernating — NOT dead. We log it
// and stop tracking liveness locally (so we don't log every 30s), but
// crucially we do NOT mark them dead on the server. `dead` means an
// explicit kill; absent processes are just sleeping.
let _deathCheckInterval = null
const DEATH_CHECK_MS = 30_000   // liveness check every 30s

// Cache populated by checkAgentLiveness every 30s.
// rpcCheckAlive reads from here — zero spawns per call.
const _alivenessCache = new Map()  // tmux_session → boolean

// Thinking/compacting/approval detection — moved from MCP to daemon so it
// survives MCP restarts and the hibernate sweep can trust it.
const THINKING_SPINNER_RE = /[A-Z][a-z]+ing\u2026/
const INTERRUPT_HINT_RE = /esc to interrupt/
const COMPACTING_RE = /Compacting conversation/
const THINKING_SCAN_LINES = 40
const APPROVAL_PROMPT_RE = /[\u25CB\u25CF]\s*Allow once|Allow this .{0,30}\?\s*\(y\/n\)|Esc to cancel\s*\u00B7\s*Tab to amend/i
const APPROVAL_PROMPT_SCAN_LINES = 15
const _prevThinking = new Map()   // agent_id → boolean
const _prevCompacting = new Map() // agent_id → boolean
const _prevApprovalFP = new Map() // agent_id → string (fingerprint)

async function checkAgentLiveness() {
  if (!agents.length) return
  let sessions
  try {
    const r = await rpcListSessions()
    sessions = new Set(r.sessions || [])
  } catch { return }

  // Collect all candidate sessions in one pass, then batch-query pane PIDs.
  const candidateAgents = []
  for (const agent of agents) {
    if (agent.dead || agent.human) continue
    if (!agent.tmux_session) continue
    if (!sessions.has(agent.tmux_session)) {
      _alivenessCache.set(agent.tmux_session, false)
      if (!agent.hibernating) {
        log.info(`agent ${agent.friendly_name || agent.id} is hibernating (tmux session ${agent.tmux_session} gone)`)
      }
      agent.hibernating = true
      continue
    }
    candidateAgents.push(agent)
  }

  if (!candidateAgents.length) {
    sendMsg({ type: 'agent-liveness', agent_ids: [] })
    return
  }

  // One tmux call: get all pane PIDs across all sessions at once.
  const sessionToPanes = new Map()
  try {
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{session_name} #{pane_pid}'],
      { timeout: 5000, encoding: 'utf8' })
    for (const line of stdout.trim().split('\n')) {
      const sp = line.indexOf(' ')
      if (sp < 0) continue
      const sess = line.slice(0, sp), pid = line.slice(sp + 1)
      if (!sessionToPanes.has(sess)) sessionToPanes.set(sess, [])
      sessionToPanes.get(sess).push(pid)
    }
  } catch { /* tmux unavailable */ }

  // One ps call: get all processes with their args and PPIDs.
  const claudePids = new Set()
  try {
    const { stdout } = await execFileP('ps', ['-eo', 'pid,ppid,args'],
      { timeout: 5000, encoding: 'utf8' })
    for (const line of stdout.split('\n')) {
      if (line.includes('claude')) {
        const pid = line.trim().split(/\s+/)[0]
        const ppid = line.trim().split(/\s+/)[1]
        if (pid) claudePids.add(pid)
        if (ppid) claudePids.add(ppid)
      }
    }
  } catch (e) {
    log.warn(`ps failed during death detection — skipping cycle: ${e.message}`)
    return
  }

  const aliveAgentIds = []
  for (const agent of candidateAgents) {
    const panes = sessionToPanes.get(agent.tmux_session) || []
    const claudeAlive = panes.some(pid => claudePids.has(pid))

    _alivenessCache.set(agent.tmux_session, claudeAlive)

    if (!claudeAlive) {
      if (!agent.hibernating) {
        log.info(`agent ${agent.friendly_name || agent.id} is hibernating (no claude in session ${agent.tmux_session})`)
        // Capture last lines of tmux for crash diagnosis
        try {
          const { stdout: lastLines } = await execFileP('tmux',
            [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-15'],
            { timeout: 3000, encoding: 'utf8' })
          const trimmed = lastLines.trim()
          if (trimmed) {
            sendMsg({
              type: 'agent-crash',
              agent_id: agent.id,
              agent_name: agent.friendly_name || agent.id,
              tmux_session: agent.tmux_session,
              last_output: trimmed,
            })
          }
        } catch {}
      }
      agent.hibernating = true
      continue
    }

    if (agent.hibernating) {
      log.info(`agent ${agent.friendly_name || agent.id} is awake`)
      agent.hibernating = false
    }
    aliveAgentIds.push(agent.id)
  }

  // Scan alive agents for thinking/compacting/approval state
  for (const agent of candidateAgents) {
    if (agent.hibernating) continue
    try {
      const { stdout: pane } = await execFileP('tmux',
        [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', `-${THINKING_SCAN_LINES}`],
        { timeout: 3000, encoding: 'utf8' })

      const paneBottom = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n')
      const isThinking = THINKING_SPINNER_RE.test(paneBottom) || INTERRUPT_HINT_RE.test(paneBottom)
      sendMsg({ type: 'agent-thinking', agentId: agent.id, thinking: isThinking })
      if (isThinking !== _prevThinking.get(agent.id)) {
        _prevThinking.set(agent.id, isThinking)
      }

      const isCompacting = COMPACTING_RE.test(pane)
      sendMsg({ type: 'agent-compacting', agentId: agent.id, compacting: isCompacting })
      if (isCompacting !== _prevCompacting.get(agent.id)) {
        _prevCompacting.set(agent.id, isCompacting)
      }

      const approvalBottom = pane.split('\n').slice(-APPROVAL_PROMPT_SCAN_LINES).join('\n')
      if (APPROVAL_PROMPT_RE.test(approvalBottom)) {
        const fingerprint = approvalBottom.slice(-100)
        if (fingerprint !== _prevApprovalFP.get(agent.id)) {
          _prevApprovalFP.set(agent.id, fingerprint)
          sendMsg({ type: 'terminal_attention', agent_id: agent.id, reason: 'permission prompt', text: 'permission prompt' })
        }
      } else {
        _prevApprovalFP.delete(agent.id)
      }
    } catch {}
  }

  sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds })
}

async function rpcResolveFile({ path: filePath, cwd, server_url }) {
  const abs = resolveFilePath(filePath, cwd)
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const serverBase = server_url || getServerUrl()
  return await uploadFileToServer(abs, serverBase)
}

async function rpcRechat({ text, cwd, server_url }) {
  const serverBase = server_url || getServerUrl()
  return await processMessageText(text, cwd, serverBase)
}

// Kill the local playwright chromium process that owns a given TCP source
// port. Called by the server's zombie reaper when a /sync/ or /ws/fleet
// connection has been idle for too long.
//
// Discriminator: playwright launches the system Google Chrome binary with
// a temp profile path that always contains "playwright_chromiumdev_profile".
// The user's real Chrome uses their normal ~/Library profile dir. Anything
// that doesn't match the playwright signature in its `ps args=` output is
// refused — the user's real browser must be safe.
async function rpcKillOrphanChromium({ port }) {
  if (!port) return { killed: false, reason: 'no port' }
  let lsofOut = ''
  try {
    const { stdout } = await execFileP('lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
      { timeout: 5000, encoding: 'utf8' })
    lsofOut = stdout
  } catch (e) {
    // lsof exits non-zero when no rows match; nothing to kill.
    return { killed: false, reason: 'no process holds port ' + port }
  }
  // Parse -F pcn output. Each record starts with p<pid>, followed by
  // c<command> and one or more n<conn> lines.
  const records = []
  let cur = null
  for (const line of lsofOut.split('\n')) {
    if (!line) continue
    const k = line[0], v = line.slice(1)
    if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
    else if (k === 'c' && cur) cur.command = v
    else if (k === 'n' && cur) cur.names.push(v)
  }
  if (cur) records.push(cur)

  // Match rows where the LOCAL endpoint is :<port> (i.e. that PID owns the
  // outgoing connection from this port). Format: "addr:localPort->addr:remotePort"
  const localTag = ':' + port + '->'
  const owners = []
  for (const r of records) {
    if (r.names.some(n => n.includes(localTag))) owners.push(r)
  }
  if (owners.length === 0) {
    return { killed: false, reason: `no local owner of port ${port}` }
  }

  // Walk up to the top of any chromium process tree (the playwright main
  // browser process), so killing it cleans up all the renderer children.
  // Verify the binary path includes "ms-playwright" — anything else is a
  // process the user started and we must not touch it.
  const psArgs = async (pid) => {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='],
        { timeout: 2000, encoding: 'utf8' })
      return stdout.trim()
    } catch { return '' }
  }
  const psPpid = async (pid) => {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'ppid='],
        { timeout: 2000, encoding: 'utf8' })
      const v = parseInt(stdout.trim(), 10)
      return Number.isFinite(v) ? v : null
    } catch { return null }
  }
  const isPlaywright = (args) => {
    // Either the playwright-bundled chromium cache, or the system Chrome
    // launched with a playwright-style temp profile path (playwright-mcp's
    // pattern). Skip's regular Chrome would not match either.
    return args.includes('playwright_chromiumdev_profile') ||
           args.includes('ms-playwright')
  }

  for (const owner of owners) {
    let pid = parseInt(owner.pid, 10)
    let args = await psArgs(pid)
    if (!isPlaywright(args)) {
      // Not a playwright chromium — skip. (Could be node, ssh tunnel,
      // user's real browser, etc.) Defense in depth against killing the
      // wrong thing.
      continue
    }
    // Walk up while the parent is also playwright chromium.
    while (true) {
      const ppid = await psPpid(pid)
      if (!ppid || ppid <= 1) break
      const pargs = await psArgs(ppid)
      if (!isPlaywright(pargs)) break
      pid = ppid
      args = pargs
    }
    try {
      process.kill(pid, 'SIGKILL')
      // Best-effort: also nuke any orphaned children that didn't go down
      // with the parent. pkill returns non-zero when no match; ignore.
      try {
        await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 })
      } catch {}
      return { killed: true, pid, binary: args.slice(0, 200) }
    } catch (e) {
      return { killed: false, reason: `kill ${pid}: ${e.message}` }
    }
  }
  return { killed: false, reason: 'no playwright owner among port holders' }
}

// ─── Memory pressure ────────────────────────────────────────────────

function getMemoryPressure() {
  const total = os.totalmem()
  const free = os.freemem()
  return 1 - free / total  // 0 = empty, 1 = full
}

// Scale an idle timeout by memory pressure. At ≥90% usage the timeout
// drops to 1/10 of the base; below 50% usage it stays at the full base.
function pressureScaledTimeout(baseMs) {
  const p = getMemoryPressure()
  if (p < 0.5) return baseMs
  const scale = Math.max(0.1, 1 - (p - 0.5) / 0.4)  // linear 1→0.1 over 50%→90%
  return Math.round(baseMs * scale)
}

// ─── Process → agent attribution ───────────────────────────────────
// Walk up the ppid chain to find a `claude` process. Extract --resume
// session ID or tmux session name, match against the agent list.

async function getProcessInfo(pid) {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'pid=,ppid=,args='],
      { timeout: 2000, encoding: 'utf8' })
    const m = stdout.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) return null
    return { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), args: m[3] }
  } catch { return null }
}

async function attributeToAgent(pid) {
  let cur = pid
  const visited = new Set()
  for (let depth = 0; depth < 10; depth++) {
    if (visited.has(cur) || cur <= 1) break
    visited.add(cur)
    const info = await getProcessInfo(cur)
    if (!info) break
    if (info.args.includes('claude') && !info.args.includes('playwright')) {
      const resumeMatch = info.args.match(/--resume\s+([a-f0-9-]+)/)
      if (resumeMatch) {
        const sessionId = resumeMatch[1]
        const agent = agents.find(a => a.session_id === sessionId)
        if (agent) return { id: agent.id, name: agent.name || agent.id.slice(0, 8) }
      }
      const agentByTmux = agents.find(a => a.tmux_session && info.args.includes(a.tmux_session))
      if (agentByTmux) return { id: agentByTmux.id, name: agentByTmux.name || agentByTmux.id.slice(0, 8) }
    }
    cur = info.ppid
  }
  return null
}

async function attributeViteByCwd(pid) {
  try {
    const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: 2000, encoding: 'utf8' })
    const cwdLine = stdout.split('\n').find(l => l.startsWith('n/'))
    if (!cwdLine) return null
    const cwd = cwdLine.slice(1)
    const wtMatch = cwd.match(/\.worktrees\/([^/]+)/)
    if (wtMatch) return wtMatch[1]
  } catch {}
  return null
}

// ─── Vite reaper — kill dev servers nobody's using ──────────────────
const VITE_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_VITE_MS, 10) || 10 * 60 * 1000
// Floor the pressure-scaled timeout: even at 99% memory the threshold collapsed
// to ~1 min, which SIGKILLed dev servers during a normal edit pause (the "idle"
// signal is just "no browser currently on the port" — true for most of an agent's
// edit loop). Never reap a dev server with less than this much idle, so a brief
// pause can't lose an in-use server; a genuinely abandoned one still gets reaped.
const VITE_MIN_IDLE_MS = parseInt(process.env.REAPER_VITE_MIN_MS, 10) || 5 * 60 * 1000
const VITE_SWEEP_INTERVAL_MS = parseInt(process.env.REAPER_VITE_INTERVAL_MS, 10) || 60 * 1000
const _viteLastClient = new Map()
const BROWSER_NAME_RE = /Google|Chrome|Chromium|Firefox|Safari|WebKit/i

function isViteArgs(args) {
  if (!args.startsWith('node ')) return false
  return /[\/\\]vite(\.js)?(\s|$)/.test(args)
}

async function findListeningPorts(pid) {
  try {
    const { stdout } = await execFileP('lsof',
      ['-a', '-nP', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'],
      { timeout: 3000, encoding: 'utf8' })
    const ports = []
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue
      const m = line.slice(1).match(/:(\d+)$/)
      if (m) ports.push(parseInt(m[1], 10))
    }
    return [...new Set(ports)]
  } catch { return [] }
}

async function listVites() {
  let psOut = ''
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,args='], { timeout: 5000, encoding: 'utf8' })
    psOut = stdout
  } catch { return [] }
  const vites = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const args = m[2]
    if (!isViteArgs(args)) continue
    const ports = await findListeningPorts(pid)
    if (ports.length > 0) vites.push({ pid, ports, args })
  }
  return vites
}

async function viteHasBrowserClient(port) {
  let lsofOut = ''
  try {
    const { stdout } = await execFileP('lsof',
      ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
      { timeout: 3000, encoding: 'utf8' })
    lsofOut = stdout
  } catch { return false }
  const records = []
  let cur = null
  for (const line of lsofOut.split('\n')) {
    if (!line) continue
    const k = line[0], v = line.slice(1)
    if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
    else if (k === 'c' && cur) cur.command = v
    else if (k === 'n' && cur) cur.names.push(v)
  }
  if (cur) records.push(cur)
  const remoteTag = ':' + port
  for (const r of records) {
    if (!r.names.some(n => n.endsWith(remoteTag))) continue
    if (BROWSER_NAME_RE.test(r.command || '')) return true
  }
  return false
}

async function reapVites() {
  const vites = await listVites()
  const now = Date.now()
  const killed = []
  for (const v of vites) {
    let hasClient = false
    for (const port of v.ports) {
      if (await viteHasBrowserClient(port)) { hasClient = true; break }
    }
    if (hasClient) {
      _viteLastClient.set(v.pid, now)
      continue
    }
    if (!_viteLastClient.has(v.pid)) _viteLastClient.set(v.pid, now)
    const idleMs = now - _viteLastClient.get(v.pid)
    const threshold = Math.max(VITE_MIN_IDLE_MS, pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS))
    if (idleMs > threshold) {
      try {
        process.kill(v.pid, 'SIGKILL')
        console.log(`[vite-reaper] killed pid=${v.pid} ports=${v.ports.join(',')} idle=${Math.round(idleMs / 60000)}m pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
        const attr = await attributeToAgent(v.pid).catch(() => null)
        killed.push({ pid: v.pid, kind: 'vite', ts: now, reason: `idle ${Math.round(idleMs / 60000)}m`, agent: attr?.name || null })
      } catch (e) {
        console.log(`[vite-reaper] kill pid=${v.pid} failed: ${e.message}`)
      }
      _viteLastClient.delete(v.pid)
    }
  }
  const liveVites = new Set(vites.map(v => v.pid))
  for (const pid of [..._viteLastClient.keys()]) {
    if (!liveVites.has(pid)) _viteLastClient.delete(pid)
  }
  return { vites, killed }
}

// ─── Playwright reaper — kill orphan chromium browsers ──────────────
const PW_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_PW_MS, 10) || 5 * 60 * 1000
const _pwLastSeen = new Map()

async function listPlaywrightBrowsers() {
  let psOut = ''
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, encoding: 'utf8' })
    psOut = stdout
  } catch { return [] }
  const browsers = []
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    const args = m[3]
    if (!args.includes('playwright_chromiumdev_profile') && !args.includes('ms-playwright')) continue
    if (args.includes('--type=')) continue
    // Skip the playwright-cli session DAEMON itself (`run-cli-server`). Its
    // --daemon-session path lives under .../ms-playwright/..., so it matches the
    // browser filter above — but it's a node daemon, not a browser. It's detached
    // (ppid=1) so the orphan heuristic always flags it, and killing it orphans
    // the Chrome it owns and closes the session — the recurring "shared browser
    // keeps dying / nobody can use pw" bug. The reaper still reaps real orphan Chrome.
    if (args.includes('run-cli-server')) continue
    // Never reap the canonical `tlda-dev pw` shared browser. It's a launcher-less
    // daemon by design (persists until `tlda pw reap`), so the orphan heuristic
    // always flags it — and under memory pressure the threshold collapses to ~30s,
    // killing it every minute, which strands agents on a blank data: tab.
    if (args.includes('ud-shared-chrome')) continue
    browsers.push({ pid, ppid, args })
  }
  return browsers
}

async function isPlaywrightControllerAlive(ppid) {
  if (!ppid || ppid <= 1) return false
  try {
    const { stdout } = await execFileP('ps', ['-p', String(ppid), '-o', 'args='],
      { timeout: 2000, encoding: 'utf8' })
    const args = stdout.trim()
    return args.includes('playwright') || args.includes('node')
  } catch { return false }
}

async function reapPlaywright() {
  const browsers = await listPlaywrightBrowsers()
  if (browsers.length === 0) return { browsers: [], killed: [] }
  const now = Date.now()
  const threshold = pressureScaledTimeout(PW_IDLE_THRESHOLD_MS)
  const killed = []
  const enriched = []
  let orphanCount = 0
  for (const b of browsers) {
    const controllerAlive = await isPlaywrightControllerAlive(b.ppid)
    const idleMs = controllerAlive ? 0 : (now - (_pwLastSeen.get(b.pid) || now))
    enriched.push({ pid: b.pid, ppid: b.ppid, controllerAlive, idleMs })
    if (controllerAlive) {
      _pwLastSeen.set(b.pid, now)
      continue
    }
    orphanCount++
    if (!_pwLastSeen.has(b.pid)) _pwLastSeen.set(b.pid, now)
    const orphanMs = now - _pwLastSeen.get(b.pid)
    if (orphanMs > threshold) {
      try {
        process.kill(b.pid, 'SIGKILL')
        try { await execFileP('pkill', ['-9', '-P', String(b.pid)], { timeout: 2000 }) } catch {}
        console.log(`[pw-reaper] killed pid=${b.pid} orphan=${Math.round(orphanMs / 1000)}s threshold=${Math.round(threshold / 1000)}s pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
        const attr = await attributeToAgent(b.pid).catch(() => null)
        killed.push({ pid: b.pid, kind: 'playwright', ts: now, reason: `orphan ${Math.round(orphanMs / 1000)}s`, agent: attr?.name || null })
      } catch (e) {
        console.log(`[pw-reaper] kill pid=${b.pid} failed: ${e.message}`)
      }
      _pwLastSeen.delete(b.pid)
    } else {
      console.log(`[pw-reaper] orphan pid=${b.pid} age=${Math.round(orphanMs / 1000)}s waiting (threshold=${Math.round(threshold / 1000)}s)`)
    }
  }
  const livePids = new Set(browsers.map(b => b.pid))
  for (const pid of [..._pwLastSeen.keys()]) {
    if (!livePids.has(pid)) _pwLastSeen.delete(pid)
  }
  return { browsers: enriched, killed }
}

async function getMemoryByAgent() {
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 5000, encoding: 'utf8' })
    const procs = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const rss = parseInt(m[3], 10) * 1024
      if (rss < 10 * 1024 * 1024) continue
      const comm = m[4].trim().split('/').pop()
      procs.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), rss, name: comm })
    }
    const attrs = await Promise.all(procs.map(async p => {
      const match = await attributeToAgent(p.pid).catch(() => null)
      return { ...p, agent: match?.name || null }
    }))
    const groups = new Map()
    for (const p of attrs) {
      const key = p.agent || 'system'
      if (!groups.has(key)) groups.set(key, { agent: key, totalRss: 0, processes: [] })
      const g = groups.get(key)
      g.totalRss += p.rss
      g.processes.push({ name: p.name, rss: p.rss })
    }
    const result = [...groups.values()]
    result.sort((a, b) => b.totalRss - a.totalRss)
    return result
  } catch { return [] }
}

// ─── Combined reaper sweep with status broadcast ──────────────────
let _reaperTimer = null
let _sweepCount = 0
const _recentKills = []  // last 10 kills across sweeps
const MAX_RECENT_KILLS = 10

async function reaperSweep() {
  const viteResult = await reapVites().catch(e => { console.error('[vite-reaper] sweep failed:', e.message); return { vites: [], killed: [] } })
  const pwResult = await reapPlaywright().catch(e => { console.error('[pw-reaper] sweep failed:', e.message); return { browsers: [], killed: [] } })
  _sweepCount++

  const allKills = [...(viteResult.killed || []), ...(pwResult.killed || [])]
  _recentKills.push(...allKills)
  while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()

  const now = Date.now()
  const pressure = getMemoryPressure()

  // Attribute processes to agents (in parallel for speed)
  const viteAttrs = await Promise.all((viteResult.vites || []).map(async v => {
    const worktree = await attributeViteByCwd(v.pid)
    const agentMatch = await attributeToAgent(v.pid)
    return { pid: v.pid, agent: agentMatch?.name || worktree || null, agentId: agentMatch?.id || null }
  }))
  const browserAttrs = await Promise.all((pwResult.browsers || []).map(async b => {
    const agentMatch = await attributeToAgent(b.pid)
    return { pid: b.pid, agent: agentMatch?.name || null, agentId: agentMatch?.id || null }
  }))
  const viteAgentMap = Object.fromEntries(viteAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))
  const browserAgentMap = Object.fromEntries(browserAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))

  const viteSnap = (viteResult.vites || []).map(v => ({
    pid: v.pid,
    ports: v.ports,
    hasClient: _viteLastClient.has(v.pid) && (now - _viteLastClient.get(v.pid)) < 1000,
    idleMs: _viteLastClient.has(v.pid) ? now - _viteLastClient.get(v.pid) : 0,
    agent: viteAgentMap[v.pid]?.agent || null,
    agentId: viteAgentMap[v.pid]?.agentId || null,
  }))

  const memoryByAgent = await getMemoryByAgent().catch(() => [])

  sendMsg({
    type: 'reaper-status',
    data: {
      pressure,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      memoryByAgent,
      vites: viteSnap,
      browsers: (pwResult.browsers || []).map(b => ({
        ...b,
        agent: browserAgentMap[b.pid]?.agent || null,
        agentId: browserAgentMap[b.pid]?.agentId || null,
      })),
      lastKills: _recentKills.slice(),
      thresholds: { viteMs: VITE_IDLE_THRESHOLD_MS, pwMs: PW_IDLE_THRESHOLD_MS },
      scaledThresholds: { viteMs: pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS), pwMs: pressureScaledTimeout(PW_IDLE_THRESHOLD_MS) },
      sweepCount: _sweepCount,
      lastSweep: now,
    },
  })
}

function startReapers() {
  if (_reaperTimer) return
  setTimeout(() => {
    reaperSweep()
    _reaperTimer = setInterval(reaperSweep, VITE_SWEEP_INTERVAL_MS)
    _reaperTimer.unref?.()
  }, 10_000)
}

// ─── Reaper RPC handlers ──────────────────────────────────────────
async function rpcReaperKill({ pid }) {
  if (!pid) throw new Error('missing pid')
  const attr = await attributeToAgent(pid).catch(() => null)
  try {
    process.kill(pid, 'SIGKILL')
    try { await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 }) } catch {}
    _recentKills.push({ pid, kind: 'manual', ts: Date.now(), reason: 'manual kill', agent: attr?.name || null })
    while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()
    return { killed: true, pid }
  } catch (e) {
    return { killed: false, error: e.message }
  }
}

async function rpcReaperSweep() {
  await reaperSweep()
  return { ok: true, sweepCount: _sweepCount }
}

const RPC_HANDLERS = {
  'send-key': rpcSendKey,
  'send-text': rpcSendText,
  'capture-pane': rpcCapturePane,
  'interrupt': rpcInterrupt,
  'soft-interrupt': rpcSoftInterrupt,
  'check-alive': rpcCheckAlive,
  'list-sessions': rpcListSessions,
  'kick': rpcKick,
  'kill-session': rpcKillSession,
  'start-terminal-watch': rpcStartTerminalWatch,
  'stop-terminal-watch': rpcStopTerminalWatch,
  'terminal-resize': rpcTerminalResize,
  'terminal-input': rpcTerminalInput,
  'spawn': rpcSpawn,
  'resolve-file': rpcResolveFile,
  'rechat': rpcRechat,
  'kill-orphan-chromium': rpcKillOrphanChromium,
  'write-backing-file': rpcWriteBackingFile,
  'reaper-kill': rpcReaperKill,
  'reaper-sweep': rpcReaperSweep,
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

const CRITICAL_MSG_TYPES = new Set(['terminal-dead', 'terminal_attention'])
let _droppedCount = 0
let _droppedWarnAt = 0
function sendMsg(obj) {
  if (_rws?.send(obj)) return true
  _droppedCount++
  if (obj?.type && CRITICAL_MSG_TYPES.has(obj.type)) {
    try {
      const line = JSON.stringify({ ...obj, ts: new Date().toISOString(), dropped: true })
      fs.appendFileSync(DEAD_LETTER_FILE, line + '\n')
      log.warn(`WS down — persisted ${obj.type} for ${obj.agent_id || 'unknown'} to dead-letter file`)
    } catch (e) {
      log.error(`failed to write dead-letter: ${e.message}`)
    }
  }
  const now = Date.now()
  if (now - _droppedWarnAt > 5000) {
    log.warn(`dropping messages (ws not open); dropped ${_droppedCount} since last warn; sample type=${obj?.type}`)
    _droppedCount = 0
    _droppedWarnAt = now
  }
  return false
}

function teardownWatchers() {
  for (const [p, pw] of pathWatchers) { try { pw.watcher.close() } catch {}; fs.unwatchFile(p) }
  pathWatchers.clear()
  agentPaths.clear()
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  for (const [, s] of terminalWatchPtys) { s.alive = false; try { s.pty.kill() } catch {} }
  terminalWatchPtys.clear()
  for (const [, s] of ephemeralPtys) { s.alive = false; clearTimeout(s.teardownTimer); try { s.pty.kill() } catch {} }
  ephemeralPtys.clear()
  for (const [, entry] of backingWatchers) { try { entry.watcher.close() } catch {} }
  backingWatchers.clear()
}

function connect() {
  _rws = new ResilientWS({
    url: () => SERVER.replace(/^http/, 'ws') + '/ws/fleet-daemon' +
      (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''),
    label: 'daemon',
    onOpen: () => {
      sendMsg({
        type: 'daemon-hello',
        machine_id: MACHINE_ID,
        user: USER,
        hostname: HOSTNAME,
        version: VERSION,
        boot_id: BOOT_ID,
      })
    },
    onMessage: handleServerMessage,
    onClose: teardownWatchers,
  })
  _rws.connect()
}

function handleServerMessage(msg) {
  if (msg.type === 'daemon-welcome') {
    agents = msg.agents || []
    projects = msg.projects || []
    log.info(`welcome: ${agents.length} agents, ${projects.length} projects`)
    syncSessionWatchers(agents)
    syncSourceWatchers(projects, msg.activeViewers)
    flushPendingSourceChanges()
    // Periodic death detection — O(1) spawns per cycle (one tmux list-sessions).
    if (!_deathCheckInterval) {
      _deathCheckInterval = setInterval(checkAgentLiveness, DEATH_CHECK_MS)
      setTimeout(checkAgentLiveness, 5000)
    }
    if (!_autoAcceptStarted) {
      _autoAcceptStarted = true
      startAutoAcceptSweep()
    }
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
  if (msg.type === 'active-viewers') {
    _activeViewerSet = new Set(msg.projects || [])
    syncFsWatchers()
    return
  }
  if (msg.type === 'version-committed') {
    handleVersionCommitted(msg)
    return
  }
  if (msg.type === 'daemon-evict') {
    if (msg.replaced_by_boot_id) {
      // Another live daemon took our slot — exit rather than loop-reconnecting.
      log.warn(`evicted by newer daemon (boot_id=${msg.replaced_by_boot_id}) — exiting`)
      shutdown('evicted-by-newer-daemon')
      return
    }
    // No replacement boot_id = server restarted and lost our connection.
    // Reconnect — the daemon should survive server restarts.
    log.warn(`evicted (${msg.reason || 'unknown'}) — reconnecting`)
    teardownWatchers()
    try { _rws?.close() } catch {}
    scheduleReconnect()
    return
  }
  if (msg.type === 'watch-backing-files') {
    syncBackingWatchers(msg.files || [])
    return
  }
  if (msg.type === 'rpc') {
    handleRpc(msg)
    return
  }
  // Unknown message — ignore for forward compatibility.
}

// ---------- git mirror sync ----------

async function handleVersionCommitted(msg) {
  const { project: projectName, hash, repoPath, autoSync } = msg
  if (!autoSync) return

  const project = projects.find(p => p.name === projectName)
  if (!project?.sourceDir) return

  const sourceDir = project.sourceDir

  // Check if sourceDir is a git repo
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: sourceDir, timeout: 5000 })
  } catch {
    return // not a git repo
  }

  // Ensure shadow repo is added as a remote
  try {
    await execFileP('git', ['remote', 'get-url', 'tlda-shadow'], { cwd: sourceDir, timeout: 5000 })
  } catch {
    // Remote doesn't exist, add it
    try {
      await execFileP('git', ['remote', 'add', 'tlda-shadow', repoPath], { cwd: sourceDir, timeout: 5000 })
    } catch (e) {
      log.warn(`failed to add tlda-shadow remote for ${projectName}: ${e.message}`)
      return
    }
  }

  // Fetch from shadow repo, stash local changes, fast-forward merge, unstash
  try {
    await execFileP('git', ['fetch', 'tlda-shadow'], { cwd: sourceDir, timeout: 15000 })
    // Determine the branch name in the shadow repo
    const { stdout: refOut } = await execFileP('git', ['rev-parse', '--verify', 'tlda-shadow/main'], { cwd: sourceDir, timeout: 5000 }).catch(() => ({ stdout: '' }))
    const ref = refOut.trim() ? 'tlda-shadow/main' : 'FETCH_HEAD'

    // Stash any local changes (may fail on repos with symlink-traversing paths)
    let didStash = false
    try {
      const { stdout: stashOut } = await execFileP('git', ['stash', 'push', '-m', 'tlda-sync-stash'], { cwd: sourceDir, timeout: 10000 })
      didStash = !stashOut.includes('No local changes')
    } catch (stashErr) {
      log.warn(`stash failed for ${projectName} (continuing without stash): ${stashErr.message.split('\n')[0]}`)
    }

    try {
      await execFileP('git', ['merge', '--ff-only', ref], { cwd: sourceDir, timeout: 15000 })
      log.info(`synced ${projectName}: ${hash?.slice(0, 7)}`)
    } finally {
      // Always unstash, even if merge fails
      if (didStash) {
        await execFileP('git', ['stash', 'pop'], { cwd: sourceDir, timeout: 10000 }).catch(e => {
          log.warn(`stash pop failed for ${projectName}: ${e.message}`)
        })
      }
    }
  } catch (e) {
    log.warn(`sync failed for ${projectName}: ${e.message}`)
    sendMsg({ type: 'daemon-warning', project: projectName, message: `git sync failed: ${e.message.split('\n')[0]}` })
  }
}

// ---------- lifecycle ----------

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

// Singleton check — only one daemon per machine at a time.
try {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (existingPid && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 0)  // signal 0 = existence check only
      log.error(`already running (pid=${existingPid}) — exiting`)
      process.exit(0)
    } catch { /* stale PID file — previous daemon is gone, continue */ }
  }
} catch { /* no PID file — first start, continue */ }

try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch (e) { log.warn(`failed to write PID file: ${e.message}`) }

function shutdown(signal) {
  // Log WHY we're dying so the next post-mortem isn't a scavenger hunt.
  log.info(`shutdown via ${signal || 'unknown'} signal; saving cursors and exiting`)
  saveCursors()
  try { fs.unlinkSync(PID_FILE) } catch {}
  _rws?.close()
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
      log.error(`received ${sig} — exiting`)
      process.exit(1)
    })
  } catch { /* some signals can't be handled on this platform */ }
}
process.on('uncaughtException', (e) => {
  log.error(`uncaught: ${e.stack || e.message}`)
})
process.on('unhandledRejection', (e) => {
  log.error(`unhandled rejection: ${e?.stack || e?.message || e}`)
})
// Also log the regular `exit` event so silent process exits get a trace.
process.on('exit', (code) => {
  log.info(`process exit (code=${code})`)
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
    log.info(`heartbeat pid=${process.pid} rss=${(mem.rss / 1e6).toFixed(1)}MB heap=${(mem.heapUsed / 1e6).toFixed(1)}MB uptime=${Math.round(process.uptime())}s`)
  }, HEARTBEAT_INTERVAL_MS).unref?.() || _heartbeatTimer
}

log.info(`fleet-daemon ${VERSION} starting pid=${process.pid}`)
log.info(`  server      = ${SERVER}`)
log.info(`  machine_id  = ${MACHINE_ID}`)
log.info(`  boot_id     = ${BOOT_ID}`)
log.info(`  user        = ${USER}@${HOSTNAME}`)
startHeartbeat()
startReapers()
connect()
