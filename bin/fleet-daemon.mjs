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
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveFilePath, uploadFileToServer } from '../mcp-server/lib/chat-file-processing.mjs'
import { processMessageText } from '../mcp-server/lib/message-processing.mjs'
const execFileP = promisify(execFile)

const VERSION = '0.1.0'
// CONFIG_DIR holds config.json, cursors, PID and log files. Defaults to
// ~/.config/tlda. TLDA_DAEMON_CONFIG_DIR lets the E2E test start a second
// daemon in parallel without clobbering the live daemon's PID file.
const CONFIG_DIR = process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda')
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
const TMUX_SOCKET = config.tmuxSocket || null
const TMUX_ARGS = TMUX_SOCKET ? ['-L', TMUX_SOCKET] : []

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
    console.log(`[daemon] loaded ${_qualRules.length} qualification rules`)
  } catch (e) {
    console.error(`[daemon] failed to load qualifications: ${e.message}`)
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
const PRETTY_PRINT_TOOLS = new Set(['mcp__fleet__search_logs', 'mcp__fleet__get_thread', 'ScheduleWakeup', 'mcp__tlda__screenshot'])

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

let ws = null
let backoff = 1000
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
    console.error(`[daemon] plan-mode capture ${agentId}: ${e.message}`)
    return
  }

  if (!pane.includes("Here is Claude's plan")) return

  // Extract plan text between the two ╌╌╌ divider lines.
  const lines = pane.split('\n')
  let dividerIdx = []
  for (let i = 0; i < lines.length; i++) {
    if (/^[\s╌]{10,}$/.test(lines[i].trim()) || lines[i].includes('╌╌╌╌')) {
      dividerIdx.push(i)
    }
  }
  // Find the pair of dividers that straddles the plan content
  let planText = ''
  for (let d = 0; d < dividerIdx.length - 1; d++) {
    const between = lines.slice(dividerIdx[d] + 1, dividerIdx[d + 1]).join('\n').trim()
    if (between.length > 20) {
      planText = between
      break
    }
  }
  if (!planText) planText = pane  // fallback: send full pane

  const fingerprint = `${planText.length}:${planText.slice(0, 120)}`
  if (planModeHashes.get(agentId) === fingerprint) return  // already sent this plan
  planModeHashes.set(agentId, fingerprint)

  sendMsg({
    type: 'plan-mode-prompt',
    agent_id: agentId,
    plan_text: planText,
    tmux_session: agent.tmux_session,
  })
  console.log(`[daemon] plan-mode-prompt sent for agent ${agentId}`)
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
        text.startsWith('<channel') || text.startsWith('📬')) continue
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
        if ((block.name === 'Edit' || block.name === 'Write') && filePath) {
          checkQualification(agentId, block.name, filePath)
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
      console.log(`[daemon] search backfill: ${entries.length} entries for ${path.basename(jsonlPath)}`)
    }
  } catch (e) {
    console.error(`[daemon] search backfill failed for ${sessionId}: ${e.message}`)
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
    console.error(`[daemon] backfillAllPriorSessions failed for ${fleetId}: ${e.message}`)
  }
  if (found > 0) {
    console.log(`[daemon] backfilling ${found} prior session(s) for ${fleetId}`)
    scheduleCursorSave()
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

function syncSourceWatchers(projectList) {
  const activeNames = new Set()
  for (const p of projectList) {
    if (!p.sourceDir) continue
    if (!fs.existsSync(p.sourceDir)) continue
    activeNames.add(p.name)

    // watchSet: relative paths the build reads (from .fls). Falls back to
    // mainFile before the first build. Absolute paths derived via state.sourceDir.
    const watchSet = new Set(
      p.watchFiles?.length ? p.watchFiles : p.mainFile ? [p.mainFile] : []
    )

    if (sourceWatchers.has(p.name)) {
      const existing = sourceWatchers.get(p.name)
      // Add pollers for files newly in the set; remove pollers for files leaving.
      for (const rel of existing.watchSet) if (!watchSet.has(rel)) stopPolling(existing, rel)
      for (const rel of watchSet) if (!existing.watchSet.has(rel)) startPolling(existing, rel)
      existing.watchSet = watchSet
      continue
    }

    const state = { sourceDir: p.sourceDir, debounce: null, pending: new Set(), watchSet, onFileChange: null, watchFired: new Set() }

    const onFileChange = (filename, fromPoll) => {
      if (!filename) return
      if (state.watchSet.size > 0) {
        if (!state.watchSet.has(filename)) return
      } else {
        if (!isSourceFile(filename)) return
      }
      if (!fromPoll) {
        state.watchFired.add(filename)
      } else if (!state.watchFired.has(filename)) {
        // Poll caught a change that fs.watch missed — recreate once
        if (!state._recreatedRecently) {
          state._recreatedRecently = true
          setTimeout(() => { state._recreatedRecently = false }, 10000)
          console.warn(`[daemon] fs.watch missed ${filename} in ${p.name} — recreating`)
          try { state.watcher?.close() } catch {}
          try {
            state.watcher = fs.watch(p.sourceDir, { recursive: true }, (_ev, fn) => onFileChange(fn, false))
          } catch (e) { console.error(`[daemon] fs.watch recreate failed for ${p.name}: ${e.message}`) }
        }
      }
      state.pending.add(filename)
      if (state.debounce) clearTimeout(state.debounce)
      state.debounce = setTimeout(() => {
        state.watchFired.clear()
        flushSourceChanges(p.name)
      }, 200)
    }
    state.onFileChange = onFileChange

    try {
      state.watcher = fs.watch(p.sourceDir, { recursive: true }, (_event, filename) => onFileChange(filename, false))
      for (const rel of watchSet) startPolling(state, rel)

      sourceWatchers.set(p.name, state)
      console.log(`[daemon] watching source ${p.name}: ${p.sourceDir} (${watchSet.size} files)`)
      pushWatchedFiles(p.name, p.sourceDir, watchSet)
    } catch (e) {
      console.error(`[daemon] source watcher failed for ${p.name}: ${e.message}`)
    }
  }
  for (const [name, state] of sourceWatchers) {
    if (!activeNames.has(name)) {
      try { state.watcher?.close() } catch {}
      for (const rel of state.watchSet) stopPolling(state, rel)
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

const _pendingSourceProjects = new Set()

function flushSourceChanges(projectName) {
  const state = sourceWatchers.get(projectName)
  if (!state) return
  state.debounce = null

  if (!ws || ws.readyState !== 1) {
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

  // Remove watchers for files no longer in the list
  for (const [fp, entry] of [...backingWatchers]) {
    if (!incoming.has(fp)) {
      try { entry.watcher.close() } catch {}
      backingWatchers.delete(fp)
    }
  }

  // Add watchers for new files
  for (const [fp, docNames] of incoming) {
    if (backingWatchers.has(fp)) {
      backingWatchers.get(fp).docNames = docNames
      continue
    }
    try {
      let debounce = null
      const watcher = fs.watch(fp, { persistent: false }, () => {
        const entry = backingWatchers.get(fp)
        if (!entry) return
        if (Date.now() - entry.lastWriteAt < 2000) return  // suppress echo from own write
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          try {
            const content = fs.readFileSync(fp, 'utf8')
            sendMsg({ type: 'file-content-changed', filePath: fp, content })
          } catch (e) {
            console.warn(`[daemon] read backing file ${fp}: ${e.message}`)
          }
        }, 200)
      })
      backingWatchers.set(fp, { watcher, docNames, lastWriteAt: 0 })
    } catch (e) {
      console.warn(`[daemon] watch backing file ${fp}: ${e.message}`)
    }
  }
}

async function rpcWriteBackingFile({ filePath, content }) {
  const fp = expandHome(filePath)
  // Record write time before writing to suppress the watcher echo
  const entry = backingWatchers.get(fp)
  if (entry) entry.lastWriteAt = Date.now()
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
    [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-e', '-S', start],
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
          [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-S', '-50'],
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

async function rpcRestartMcp({ tmux_session, skipPreflight }) {
  // No-op: the fleet MCP reconnects automatically via WS retry logic.
  // Triggering a hard restart via /mcp causes unnecessary SIGTERM churn.
  return { ok: true, tmux_session, noop: true }
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
        [...TMUX_ARGS, 'capture-pane', '-t', tmux_session, '-p', '-e', '-S', '-200'],
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

async function rpcSpawn({ name, model, cwd, doc, respawn }) {
  // Generate a temp name if none provided
  const agentName = name || `agent-${Date.now().toString(36).slice(-4)}`
  // Resolve cwd from doc name if not explicitly set
  let resolvedCwd = cwd
  if (!resolvedCwd && doc) {
    const project = projects.find(p => p.name === doc)
    if (project?.sourceDir) resolvedCwd = project.sourceDir
  }
  const spawnScript = process.env.FLEET_SPAWN || 'fleet-spawn'
  const args = respawn ? [agentName] : ['--fresh', agentName]
  if (model) args.push('--model', model)
  if (resolvedCwd) args.push('--cwd', resolvedCwd)
  args.push('--no-attach')
  try {
    const { stdout, stderr } = await execFileP(spawnScript, args, {
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
    })
    return { ok: true, name, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (e) {
    throw new Error(`fleet-spawn failed: ${e.stderr || e.message}`)
  }
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

async function checkAgentLiveness() {
  if (!agents.length) return
  // One list-sessions call to find candidate sessions cheaply.
  let sessions
  try {
    const r = await rpcListSessions()
    sessions = new Set(r.sessions || [])
  } catch { return }  // tmux not available

  const aliveAgentIds = []
  for (const agent of agents) {
    if (agent.dead || agent.human) continue
    if (!agent.tmux_session) continue

    if (!sessions.has(agent.tmux_session)) {
      _alivenessCache.set(agent.tmux_session, false)
      if (!agent.hibernating) {
        console.log(`[daemon] agent ${agent.friendly_name || agent.id} is hibernating (tmux session ${agent.tmux_session} gone)`)
      }
      agent.hibernating = true
      continue
    }

    // Session exists — verify a claude process is running inside it.
    let claudeAlive = false
    try {
      const { stdout } = await execFileP('tmux',
        [...TMUX_ARGS, 'list-panes', '-t', agent.tmux_session, '-F', '#{pane_pid}'],
        { timeout: 3000, encoding: 'utf8' })
      const panePids = stdout.trim().split('\n').filter(Boolean)
      for (const pid of panePids) {
        try {
          const { stdout: self } = await execFileP('ps', ['-p', pid, '-o', 'args='],
            { timeout: 2000, encoding: 'utf8' })
          if (self.includes('claude')) { claudeAlive = true; break }
        } catch {}
        try {
          const { stdout: children } = await execFileP('pgrep', ['-P', pid, '-f', 'claude'],
            { timeout: 2000, encoding: 'utf8' })
          if (children.trim()) { claudeAlive = true; break }
        } catch {}
      }
    } catch {}

    _alivenessCache.set(agent.tmux_session, claudeAlive)

    if (!claudeAlive) {
      if (!agent.hibernating) {
        console.log(`[daemon] agent ${agent.friendly_name || agent.id} is hibernating (no claude in session ${agent.tmux_session})`)
      }
      agent.hibernating = true
      continue
    }

    if (agent.hibernating) {
      console.log(`[daemon] agent ${agent.friendly_name || agent.id} is awake`)
      agent.hibernating = false
    }
    aliveAgentIds.push(agent.id)
  }

  sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds })
}

async function rpcResolveFile({ path: filePath, cwd, server_url }) {
  const abs = resolveFilePath(filePath, cwd)
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
  const serverBase = server_url || `http://127.0.0.1:5176`
  return await uploadFileToServer(abs, serverBase)
}

async function rpcRechat({ text, cwd, server_url }) {
  const serverBase = server_url || `http://127.0.0.1:5176`
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

// ─── Vite reaper — kill dev servers nobody's using ──────────────────
//
// Agents start `npx vite` for HMR-based UI testing and leave the process
// running after their browser is closed/killed. This is a pure-daemon
// concern: vites listen on local ports the server never sees. We watch
// for `node .../vite ...` processes, find their listening port, and check
// (via lsof) whether any browser-like process has an established TCP
// connection. If no browser client appears for VITE_IDLE_THRESHOLD_MS,
// the vite is killed.
//
// Skip's own vite stays alive as long as Chrome is attached (HMR WS keeps
// the TCP connection open even when the tab is minimized). It only dies
// after Skip closes the tab entirely AND doesn't reopen for 10 min.
const VITE_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_VITE_MS, 10) || 10 * 60 * 1000
const VITE_SWEEP_INTERVAL_MS = parseInt(process.env.REAPER_VITE_INTERVAL_MS, 10) || 60 * 1000
const _viteLastClient = new Map()  // vite_pid -> ms timestamp last seen with a browser client
const BROWSER_NAME_RE = /Google|Chrome|Chromium|Firefox|Safari|WebKit/i

function isViteArgs(args) {
  // Matches `node .../vite ...` or `node .../vite.js ...`. Avoids matching
  // random scripts that happen to mention "vite" elsewhere on the command
  // line by requiring it to be the script path right after `node`.
  if (!args.startsWith('node ')) return false
  return /[\/\\]vite(\.js)?(\s|$)/.test(args)
}

async function findListeningPorts(pid) {
  // CRITICAL: `-a` ANDs the selectors. Without it lsof OR-combines `-p` and
  // `-iTCP` and returns every LISTEN port on the machine, which would make
  // viteHasBrowserClient check the wrong port.
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
  // Client rows have `<client_addr>:<client_port>-><vite_addr>:<vite_port>`
  // — i.e. the connection name ends with the vite's port.
  const remoteTag = ':' + port
  for (const r of records) {
    if (!r.names.some(n => n.endsWith(remoteTag))) continue  // not a client of this vite
    if (BROWSER_NAME_RE.test(r.command || '')) return true
  }
  return false
}

async function reapVites() {
  const vites = await listVites()
  const now = Date.now()
  for (const v of vites) {
    // Browser is "connected" if it has a client on ANY of the vite's
    // listening ports (vite typically binds an HTTP port and a separate
    // HMR WebSocket port; either alive = vite in use).
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
    if (idleMs > VITE_IDLE_THRESHOLD_MS) {
      try {
        process.kill(v.pid, 'SIGKILL')
        console.log(`[vite-reaper] killed pid=${v.pid} ports=${v.ports.join(',')} idle=${Math.round(idleMs / 60000)}m`)
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
}

let _viteReaperTimer = null
function startViteReaper() {
  if (_viteReaperTimer) return
  // First sweep after a short delay so the daemon doesn't compete with
  // its own startup work. Subsequent sweeps every VITE_SWEEP_INTERVAL_MS.
  setTimeout(() => {
    reapVites().catch(e => console.error('[vite-reaper] sweep failed:', e.message))
    _viteReaperTimer = setInterval(
      () => reapVites().catch(e => console.error('[vite-reaper] sweep failed:', e.message)),
      VITE_SWEEP_INTERVAL_MS,
    )
    _viteReaperTimer.unref?.()
  }, 10_000)
}

const RPC_HANDLERS = {
  'send-key': rpcSendKey,
  'send-text': rpcSendText,
  'capture-pane': rpcCapturePane,
  'interrupt': rpcInterrupt,
  'check-alive': rpcCheckAlive,
  'list-sessions': rpcListSessions,
  'kick': rpcKick,
  'kill-session': rpcKillSession,
  'restart-mcp': rpcRestartMcp,
  'start-terminal-watch': rpcStartTerminalWatch,
  'stop-terminal-watch': rpcStopTerminalWatch,
  'spawn': rpcSpawn,
  'resolve-file': rpcResolveFile,
  'rechat': rpcRechat,
  'kill-orphan-chromium': rpcKillOrphanChromium,
  'write-backing-file': rpcWriteBackingFile,
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
  // Source watchers survive WS disconnects — they detect file changes
  // independently and queue them for the next connected window.
  for (const [, t] of terminalWatchTimers) { try { clearInterval(t.timer) } catch {} }
  terminalWatchTimers.clear()
  for (const [, entry] of backingWatchers) { try { entry.watcher.close() } catch {} }
  backingWatchers.clear()
}

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
    flushPendingSourceChanges()
    // Periodic death detection — O(1) spawns per cycle (one tmux list-sessions).
    if (!_deathCheckInterval) {
      _deathCheckInterval = setInterval(checkAgentLiveness, DEATH_CHECK_MS)
      setTimeout(checkAgentLiveness, 5000)
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
  if (msg.type === 'version-committed') {
    handleVersionCommitted(msg)
    return
  }
  if (msg.type === 'daemon-evict') {
    if (msg.replaced_by_boot_id) {
      // Another live daemon took our slot — exit rather than loop-reconnecting.
      console.warn(`[daemon] evicted by newer daemon (boot_id=${msg.replaced_by_boot_id}) — exiting`)
      shutdown('evicted-by-newer-daemon')
      return
    }
    // No replacement boot_id = server restarted and lost our connection.
    // Reconnect — the daemon should survive server restarts.
    console.warn(`[daemon] evicted (${msg.reason || 'unknown'}) — reconnecting`)
    teardownWatchers()
    try { ws.close() } catch {}
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
      console.warn(`[daemon] failed to add tlda-shadow remote for ${projectName}: ${e.message}`)
      return
    }
  }

  // Fetch from shadow repo, stash local changes, fast-forward merge, unstash
  try {
    await execFileP('git', ['fetch', 'tlda-shadow'], { cwd: sourceDir, timeout: 15000 })
    // Determine the branch name in the shadow repo
    const { stdout: refOut } = await execFileP('git', ['rev-parse', '--verify', 'tlda-shadow/main'], { cwd: sourceDir, timeout: 5000 }).catch(() => ({ stdout: '' }))
    const ref = refOut.trim() ? 'tlda-shadow/main' : 'FETCH_HEAD'

    // Stash any local changes
    const { stdout: stashOut } = await execFileP('git', ['stash', 'push', '-m', 'tlda-sync-stash'], { cwd: sourceDir, timeout: 10000 })
    const didStash = !stashOut.includes('No local changes')

    try {
      await execFileP('git', ['merge', '--ff-only', ref], { cwd: sourceDir, timeout: 15000 })
      console.log(`[daemon] synced ${projectName}: ${hash?.slice(0, 7)}`)
    } finally {
      // Always unstash, even if merge fails
      if (didStash) {
        await execFileP('git', ['stash', 'pop'], { cwd: sourceDir, timeout: 10000 }).catch(e => {
          console.warn(`[daemon] stash pop failed for ${projectName}: ${e.message}`)
        })
      }
    }
  } catch (e) {
    console.warn(`[daemon] sync failed for ${projectName}: ${e.message}`)
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
      console.error(`[daemon] already running (pid=${existingPid}) — exiting`)
      process.exit(0)
    } catch { /* stale PID file — previous daemon is gone, continue */ }
  }
} catch { /* no PID file — first start, continue */ }

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

console.log(`[daemon] fleet-daemon ${VERSION} starting pid=${process.pid}`)
console.log(`[daemon]   server      = ${SERVER}`)
console.log(`[daemon]   machine_id  = ${MACHINE_ID}`)
console.log(`[daemon]   boot_id     = ${BOOT_ID}`)
console.log(`[daemon]   user        = ${USER}@${HOSTNAME}`)
startHeartbeat()
startViteReaper()
connect()
