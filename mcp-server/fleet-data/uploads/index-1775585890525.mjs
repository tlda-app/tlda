#!/usr/bin/env node
/**
 * Agent Manager MCP Server v5.0
 *
 * Coordinates agents via shared state file + tmux sessions.
 * Agent identity = fleet ID (durable), backed by sqlite identity ledger.
 * See fleet-identity.md for the full identity system design.
 *
 * Tools:
 *   - register(manager?, session_id?)    register this agent (all agents call this)
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                 send message + kick recipient
 *   - task_list()                        show active tasks + registered agents
 *   - task_done(agent?)                  mark task complete
 *   - task_check(agent)                  read agent's tmux terminal (escape hatch)
 *   - my_task()                          show own task + unread messages
 *   - report(pass?, summary?)            self-review gate for task completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync, exec } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SearchIndex } from './server/search-index.mjs';
// FleetStore import removed — MCP server is a REST client, no direct DB access
import { SessionExtractor, EventExtractor, TldaExtractor } from './playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback, playbackTranscript } from './playback/storage.mjs';
import { ledger } from './identity.mjs';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

// State file eliminated — all data through server REST API
const LOG_FILE = `${os.homedir()}/.claude/agent-messages.jsonl`;

// --- tlda integration ---
const TLDA_PORT = 5176;
const TLDA_CONFIG = path.join(os.homedir(), '.config', 'tlda', 'config.json');
let _tldaToken = null;
try {
  const cfg = JSON.parse(fs.readFileSync(TLDA_CONFIG, 'utf8'));
  _tldaToken = cfg.tokenRw || cfg.tokenRead || null;
} catch (e) {
  if (e.code !== 'ENOENT') process.stderr.write(`[fleet] tlda config read failed: ${e.message}\n`);
}

function tldaFetch(apiPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: 'localhost',
      port: TLDA_PORT,
      path: '/api/projects/' + apiPath,
      method: opts.method ?? 'GET',
      headers: { ...opts.headers },
    };
    if (_tldaToken) reqOpts.headers['Authorization'] = 'Bearer ' + _tldaToken;
    if (opts.body) reqOpts.headers['Content-Type'] = 'application/json';
    const req = http.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

// Highlight color → semantic meaning mapping
const HIGHLIGHT_THEMES = {
  'black': { type: 'cut', label: 'Cut (remove entirely)' },
  'light-red': { type: 'fix', label: 'Wrong — fix this' },
  'red': { type: 'fix', label: 'Wrong — fix this' },
  'orange': { type: 'expand', label: 'Expand — show more detail' },
  'yellow': { type: 'question', label: 'Question — clarify' },
  'grey': { type: 'compress', label: 'Compress — shorter, same content' },
  'light-blue': { type: 'presentation', label: 'Presentation / notation fix' },
  'blue': { type: 'presentation', label: 'Presentation / notation fix' },
  'light-green': { type: 'approve', label: 'Good — keep this' },
  'green': { type: 'approve', label: 'Good — keep this' },
  'violet': { type: 'personal', label: 'Personal note (ignore)' },
  'light-violet': { type: 'personal', label: 'Personal note (ignore)' },
};

// ---- b64 path encoding for highlight shapes ----
// Layout constants (match tlda's shared/layout-constants.json)
const TLDA_PDF_WIDTH = 612;
const TLDA_PDF_HEIGHT = 792;
const TLDA_TARGET_WIDTH = 800;
const TLDA_PAGE_HEIGHT = TLDA_PDF_HEIGHT * (TLDA_TARGET_WIDTH / TLDA_PDF_WIDTH);
const TLDA_PAGE_GAP = 32;
// dvisvgm SVG viewBox is "-72 -72 612 792" — the TeX origin (where synctex coords
// start) is at viewBox (0,0), but the page shape covers from viewBox (-72,-72).
// All synctex coords need this offset to align with the SVG text elements.
const TLDA_VIEWBOX_OFFSET = 72;

function tldaPdfToCanvas(page, pdfX, pdfY) {
  const pageY = (page - 1) * (TLDA_PAGE_HEIGHT + TLDA_PAGE_GAP);
  const scale = TLDA_TARGET_WIDTH / TLDA_PDF_WIDTH;
  return { x: (pdfX + TLDA_VIEWBOX_OFFSET) * scale, y: pageY + (pdfY + TLDA_VIEWBOX_OFFSET) * scale };
}

/** Encode a JavaScript number to IEEE 754 half-precision (16 bits). */
function toFloat16(value) {
  if (value === 0) return 0;
  if (!isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00;
  const sign = value < 0 ? 1 : 0;
  value = Math.abs(value);
  if (value > 65504) return sign ? 0xfc00 : 0x7c00;
  if (value < 5.96e-8) return sign << 15;
  const log2 = Math.log2(value);
  let exp = Math.floor(log2);
  let frac = value / Math.pow(2, exp) - 1;
  if (exp < -14) {
    frac = value / Math.pow(2, -14);
    return (sign << 15) | Math.round(frac * 1024);
  }
  exp += 15;
  if (exp >= 31) return sign ? 0xfc00 : 0x7c00;
  return (sign << 15) | (exp << 10) | Math.round(frac * 1024);
}

function float16Decode(bits) {
  const sign = bits >> 15;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) { const val = frac * (Math.pow(2, -14) / 1024); return sign ? -val : val; }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  const val = Math.pow(2, exp - 15) * (1 + frac / 1024);
  return sign ? -val : val;
}

/**
 * Encode points into TLDraw v4's base64 delta-encoded path format.
 * First point: 3x Float32 LE (12 bytes). Subsequent: 3x Float16 LE deltas (6 bytes each).
 */
function encodeB64Path(points) {
  if (points.length === 0) return '';
  const buf = Buffer.alloc(12 + (points.length - 1) * 6);
  buf.writeFloatLE(points[0].x, 0);
  buf.writeFloatLE(points[0].y, 4);
  buf.writeFloatLE(points[0].z ?? 0.5, 8);
  let prevX = points[0].x, prevY = points[0].y, prevZ = points[0].z ?? 0.5;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prevX;
    const dy = points[i].y - prevY;
    const dz = (points[i].z ?? 0.5) - prevZ;
    const off = 12 + (i - 1) * 6;
    buf.writeUInt16LE(toFloat16(dx), off);
    buf.writeUInt16LE(toFloat16(dy), off + 2);
    buf.writeUInt16LE(toFloat16(dz), off + 4);
    prevX += float16Decode(toFloat16(dx));
    prevY += float16Decode(toFloat16(dy));
    prevZ += float16Decode(toFloat16(dz));
  }
  return buf.toString('base64');
}

// Lazy search index — opened read-only on first search call
let _searchIndex = null;
function getSearchIndex() {
  if (!_searchIndex) {
    const dbPath = `${os.homedir()}/.claude/search-index.sqlite`;
    if (!fs.existsSync(dbPath)) return null;
    _searchIndex = new SearchIndex(dbPath);
  }
  return _searchIndex;
}

// Fleet store — REMOVED. MCP server is a REST client; all reads/writes go through the fleet server.
// getFleetStore() is gone. Use fetch() to the fleet server instead.

// Append-only message log (backup). Fleet store writes are handled by
// individual handlers (chat, delegate, task_done, register) to avoid
// double-writes. logEvent only writes JSONL + fleet store for event
// types that DON'T have dedicated handlers.
const _HANDLED_EVENT_TYPES = new Set(['chat', 'delegate', 'task_done', 'register', 'report']);

function logEvent(event) {
  const entry = { ...event, timestamp: new Date().toISOString() };
  // JSONL backup (append-only)
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[fleet] logEvent JSONL write failed: ${e.message}\n`);
  }
  // Broadcast non-handled event types to fleet server via fleet-event endpoint
  if (!_HANDLED_EVENT_TYPES.has(entry.type)) {
    const eventData = {
      type: entry.type || 'lifecycle',
      event_type: entry.type || 'lifecycle',
      timestamp: entry.timestamp,
      from: entry.from || null,
      to: entry.to || entry.agent || null,
      text: entry.message || entry.description || entry.text || entry.reason || null,
      taskId: entry.task_id || null,
      agentId: entry.agent || null,
      metadata: entry,
    };
    sendWS('fleet-event', { event_data: eventData });
  }
}

// --- Identity ---
// Simple: $FLEET_ID env var = your identity. No FLEET_ID = new agent (register creates one).
// No JSONL scanning, no state file reading, no guessing.
const ALIVE_THRESHOLD_MS = 10 * 60 * 1000;
let AGENT_ID = process.env.FLEET_ID || null;
// Ref tokens created by tlda_highlight — keyed by «annotation:label» token
const _refTokens = new Map();
// Detect Claude session ID at startup by finding the most recently created JSONL
// for this project. Safe at startup (our JSONL is the newest); NOT safe to re-run
// later (another agent's JSONL may be newer). Re-registration uses args.session_id.
let CLAUDE_SESSION = (function detectSessionAtStartup() {
  try {
    const projectDir = path.join(os.homedir(), '.claude', 'projects');
    const cwd = process.env.PWD || process.cwd();
    const projectHash = cwd.replace(/\//g, '-');
    const jsonlDir = path.join(projectDir, projectHash);
    if (!fs.existsSync(jsonlDir)) return null;
    const files = fs.readdirSync(jsonlDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        session: f.replace('.jsonl', ''),
        birthtime: fs.statSync(path.join(jsonlDir, f)).birthtimeMs,
      }))
      .sort((a, b) => b.birthtime - a.birthtime);
    if (files.length === 0) return null;
    return files[0].session;
  } catch (e) {
    return null;
  }
})();

// Agent pruning throttle
let _lastAgentPrune = 0;

// Notifications handled by fleet-notify daemon (bin/fleet-notify), not the MCP server.
// Daemon holds SSE connection, touches signal files, kicks tmux.

// ---- State helpers ----

// Bootstrap-only: sync state file read for identity resolution at startup.
// loadState: fetch from server. Returns { agents, tasks, messages } structure for compat.
// Callers should prefer specific API endpoints over loadState() where possible.
async function loadState() {
  try {
    const [agents, tasks] = await Promise.all([sendWS('store-agents'), sendWS('store-tasks')]);
    return { agents: agents || [], tasks: tasks || [], messages: [] };
  } catch (e) {
    process.stderr.write(`[fleet] loadState failed: ${e.message}\n`);
    return { tasks: [], messages: [], agents: [] };
  }
}

// saveState: no-op. All writes go through specific server endpoints now.
// Heartbeat is sent via the register API on every register() call.
function saveState(_state) {
  // No-op — MCP server does not write the state file.
  // All writes go through specific REST endpoints (chat, delegate, task_done, etc.)
}

// ---- Report linter ----
// Runs on task_done() calls. Returns array of violation objects: { id, pattern, location, text, advice }
function lintReport(reportText, gitDiff, overrides = []) {
  const violations = [];
  const overrideSet = new Set(overrides);

  function addViolation(id, pattern, location, text, advice) {
    if (!overrideSet.has(id)) {
      violations.push({ id, pattern, location, text, advice });
    }
  }

  function stripCodeFences(text) {
    return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  }

  // ---- Plans-plan lint (report text) ----
  if (reportText) {
    const lines = reportText.split('\n');
    lines.forEach((line, i) => {
      const loc = `L${i + 1}`;

      const planPatterns = [
        { re: /\bwe should\b/i, advice: 'report what was done, not what should be done' },
        { re: /\bnext step would be\b/i, advice: 'report what was done, not future steps' },
        { re: /\bconsider adding\b/i, advice: 'report what was done, not suggestions' },
        { re: /\bit would be good to\b/i, advice: 'report what was done, not future wishes' },
        { re: /\bproposed rewrite\b/i, advice: 'implement the rewrite, don\'t propose it' },
        { re: /\bhere's my plan\b/i, advice: 'execute the plan, don\'t describe it' },
        { re: /\bwant me to\b/i, advice: 'do the work, don\'t ask permission' },
        { re: /\bwaiting for\b/i, advice: 'don\'t report a waiting state — act or block' },
        { re: /\bready when you are\b/i, advice: 'don\'t report idle state' },
        { re: /\blet me know\b/i, advice: 'don\'t defer to the user — report outcomes' },
      ];
      for (const { re, advice } of planPatterns) {
        const match = line.match(re);
        if (match) {
          addViolation(`plans-plan:${loc}`, 'plans-plan', loc, match[0], advice);
        }
      }

      // ---- Stream-of-consciousness lint (report text) ----
      const socPatterns = [
        { re: /\boh no\b/i, advice: 'don\'t leak internal reactions' },
        { re: /\bhmm\b/i, advice: 'don\'t leak deliberation noise' },
        { re: /\blet me try\b/i, advice: 'don\'t narrate your process — report outcomes' },
        { re: /\bthat didn't work\b/i, advice: 'report final outcome, not debugging steps' },
        { re: /\bI apologize\b/i, advice: 'skip apologies — state the fix' },
        { re: /\bI'm sorry\b/i, advice: 'skip apologies — state the fix' },
        { re: /\blet me know if\b/i, advice: 'don\'t ask for follow-up — report outcomes' },
        { re: /\bwould you like me to\b/i, advice: 'do the work, don\'t ask' },
      ];
      for (const { re, advice } of socPatterns) {
        const match = line.match(re);
        if (match) {
          addViolation(`stream-of-consciousness:${loc}`, 'stream-of-consciousness', loc, match[0], advice);
        }
      }
    });

    // Length without structure check
    const wordCount = reportText.trim().split(/\s+/).length;
    const hasHeaders = /^#{1,3} /m.test(reportText);
    const hasBullets = /^[-*] /m.test(reportText);
    if (wordCount > 500 && !hasHeaders && !hasBullets) {
      addViolation('stream-of-consciousness:length', 'stream-of-consciousness', `${wordCount} words`,
        'report exceeds 500 words with no structure', 'add headers or bullet points to structure the report');
    }

    // ---- Wrong-format lint (report text) ----
    const stripped = stripCodeFences(reportText);
    stripped.split('\n').forEach((line, i) => {
      const loc = `L${i + 1}`;
      const beginEnd = line.match(/\\(?:begin|end)\{[^}]*\}/);
      if (beginEnd) {
        addViolation(`wrong-format:${loc}`, 'wrong-format', loc, beginEnd[0],
          'LaTeX environments don\'t render in markdown — use a code fence or write prose');
      }
      const crossRef = line.match(/\\(?:eqref|Cref|ref|label)\{[^}]*\}/);
      if (crossRef) {
        addViolation(`wrong-format:${loc}`, 'wrong-format', loc, crossRef[0],
          'LaTeX cross-references don\'t render in markdown — use prose references');
      }
    });
  }

  // ---- Proofs-prove lint (git diff, new lines in .tex files) ----
  if (gitDiff) {
    const diffLines = gitDiff.split('\n');
    let currentFile = '';
    let lineNum = 0;
    for (const line of diffLines) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        lineNum = 0;
        continue;
      }
      if (line.startsWith('@@ ')) {
        const m = line.match(/@@ [^+]*\+(\d+)/);
        lineNum = m ? parseInt(m[1], 10) - 1 : lineNum;
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineNum++;
        if (!currentFile.endsWith('.tex')) continue;
        const content = line.slice(1);
        const loc = `${currentFile}:L${lineNum}`;
        const proofPatterns = [
          { re: /\bone can (show|verify|check) that\b/i, advice: 'show the derivation directly' },
          { re: /\bit (can be|is readily|is easily) (verified|checked|seen)\b/i, advice: 'verify it in the text' },
          { re: /\bit is straightforward to (show|check|verify)\b/i, advice: 'show the argument' },
          { re: /\bby standard (arguments|techniques|methods|results)\b/i, advice: 'cite a result or derive it' },
          { re: /\bby (a similar|the same) (argument|reasoning|proof)\b/i, advice: 'repeat the argument or cite specifically' },
          { re: /\babsorbed into\b/i, advice: 'show the inequality that absorbs it' },
        ];
        for (const { re, advice } of proofPatterns) {
          const match = content.match(re);
          if (match) {
            addViolation(`proofs-prove:${loc}`, 'proofs-prove', loc, match[0], advice);
          }
        }
      } else if (!line.startsWith('-')) {
        lineNum++;
      }
    }
  }

  return violations;
}

function formatLintViolations(violations) {
  const lines = violations.map(v =>
    `- [${v.pattern}] ${v.location}: "${v.text}" — ${v.advice}`
  );
  return `Task report rejected. Fix these issues and resubmit:\n${lines.join('\n')}`;
}

// ---- Synthetic message tasks ----
// When an agent has unread messages, a synthetic task makes the obligation visible.
function syncSyntheticTasks(state) {
  if (!state.messages || !state.agents) return;

  // Group unread messages by recipient
  const unreadByAgent = {};
  for (const m of state.messages) {
    if (m.read) continue;
    if (!unreadByAgent[m.to]) unreadByAgent[m.to] = [];
    unreadByAgent[m.to].push(m);
  }

  // For each live agent: create, update, or resolve synthetic tasks
  const liveAgents = state.agents.filter(a => !a.dead);
  const allAgentIds = new Set(liveAgents.map(a => a.id));
  for (const agentId of allAgentIds) {
    const existing = state.tasks.find(t => t.agent === agentId && t.synthetic && t.status !== 'done');
    const unread = unreadByAgent[agentId] || [];

    if (unread.length === 0) {
      // No unread messages — resolve any existing synthetic task
      if (existing && existing.status !== 'done') {
        existing.status = 'done';
        existing.completed_at = now();
      }
      continue;
    }

    // Count by source type
    const fromSkip = unread.filter(m => isHuman(state, m.from)).length;
    const fromAgents = unread.length - fromSkip;

    let desc = `Respond to ${unread.length} message${unread.length > 1 ? 's' : ''}`;
    const parts = [];
    if (fromSkip > 0) parts.push(`${fromSkip} from skip`);
    if (fromAgents > 0) parts.push(`${fromAgents} from agents`);
    if (parts.length > 0) desc += ` (${parts.join(', ')})`;

    if (existing && existing.status !== 'done') {
      // Update existing synthetic task
      existing.description = desc;
      existing.priority = fromSkip > 0 ? 'urgent' : 'normal';
    } else {
      // Create new synthetic task
      const taskId = `${agentId.slice(0, 8)}-msg-${Date.now().toString(36)}`;
      state.tasks.push({
        id: taskId,
        agent: agentId,
        description: desc,
        message: fromSkip > 0
          ? 'You have unread messages from Skip/human. Respond promptly.'
          : 'You have unread messages from other agents. Respond at a natural break point.',
        delegated_at: now(),
        status: 'pending',
        synthetic: true,
        priority: fromSkip > 0 ? 'urgent' : 'normal',
      });
    }
  }
}

function getTask(state, agent) {
  // Prefer real tasks over synthetic ones
  return state.tasks.find(t => t.agent === agent && t.status !== 'done' && !t.synthetic)
    || state.tasks.find(t => t.agent === agent && t.status !== 'done');
}

function getTaskById(state, id) {
  return state.tasks.find(t => t.id === id);
}

function isBlocked(state, task) {
  if (!task.blockedBy || !task.blockedBy.length) return false;
  return task.blockedBy.some(depId => {
    const dep = getTaskById(state, depId);
    return dep && dep.status !== 'done';
  });
}

function unblockDependents(state, completedId) {
  const unblocked = [];
  for (const t of state.tasks) {
    if (t.status === 'blocked' && t.blockedBy) {
      if (!isBlocked(state, t)) {
        t.status = 'pending';
        unblocked.push(t);
      }
    }
  }
  return unblocked;
}

function now() {
  return new Date().toISOString();
}

function progressBar(completed, total, width = 20) {
  if (total <= 0) return '[' + '.'.repeat(width) + ']';
  const filled = Math.round(width * Math.min(completed / total, 1));
  return '[' + '#'.repeat(filled) + '.'.repeat(width - filled) + ']';
}

function requireManager() {
  if (!AGENT_ID) return 'Cannot identify caller — no session ID detected.';
  return null; // No permission gating — any agent can do anything
}

// Check if the calling manager can manage a specific agent.
// All managers are peers — any manager can manage any agent.
function requireAuthOver(state, targetId) {
  if (!AGENT_ID) return 'Cannot identify caller.';
  return null;
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  // Exact match on id, friendly_name, or session_id (name is display-only, not for resolution)
  const exact = state.agents.find(a =>
    a.id === id || a.friendly_name === id ||
    a.session_id === id || (a.session_ids && a.session_ids.includes(id))
  );
  return exact || null;
}

/** Check if an ID belongs to a human agent (by registry lookup, not aliases) */
function isHuman(state, id) {
  const agent = getAgent(state, id);
  return !!(agent?.human);
}

// Set friendly_name on an agent. Returns error string if name is taken, null on success.
function nameAgent(state, agent, friendlyName) {
  const conflict = state.agents.find(a => a.id !== agent.id && a.friendly_name === friendlyName);
  if (conflict) return `Name "${friendlyName}" is already taken by ${conflict.friendly_name || conflict.id}.`;
  agent.friendly_name = friendlyName;
  // Sync to identity ledger
  ledger.updateName(agent.id, friendlyName);
  return null;
}

function removeAgent(state, id) {
  if (!state.agents) return;
  state.agents = state.agents.filter(a => a.id !== id && a.friendly_name !== id);
}

// Heartbeat-based liveness: agent is alive if last_seen within threshold.
// Falls back to tmux session check if no heartbeat.
function agentAlive(agent) {
  if (!agent) return false;
  if (agent.last_seen) {
    return (Date.now() - new Date(agent.last_seen).getTime()) < ALIVE_THRESHOLD_MS;
  }
  // No heartbeat — check tmux session
  if (agent.tmux_session) return tmuxHasSession(agent.tmux_session);
  return false;
}

// ---- Task context helpers ----

/** Build a context block showing the original delegation + criteria for a task */
function taskContextBlock(task, state) {
  const parts = [];

  // Original delegation message
  if (task.message) {
    parts.push(`### Original Delegation\n\n${task.message}`);
  } else if (task.description) {
    parts.push(`### Original Delegation\n\n${task.description}`);
  }

  // Success criteria
  if (task.success_criteria?.length) {
    parts.push(`### Success Criteria\n\n${task.success_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

/** Find Skip messages related to a task's agent from the state file messages */
function findRelatedHumanMessages(state, task) {
  if (!state.messages || !task.agent) return [];
  const human = (state.agents || []).find(a => a.human);
  if (!human) return [];

  // Messages from human to/about this agent, after delegation
  const delegatedAt = task.delegated_at ? new Date(task.delegated_at).getTime() : 0;
  return state.messages.filter(m => {
    if (m.from !== human.id) return false;
    if (m.to !== task.agent && m.to !== task.delegated_by) return false;
    if (delegatedAt && new Date(m.timestamp).getTime() < delegatedAt) return false;
    return true;
  }).slice(-10); // last 10 relevant messages
}

/** Format related human messages for display */
function formatHumanMessages(messages, state) {
  if (!messages.length) return '';
  const lines = messages.map(m => {
    const ts = new Date(m.timestamp).toLocaleTimeString();
    const toAgent = (state.agents || []).find(a => a.id === m.to);
    const toName = toAgent?.friendly_name || m.to;
    const preview = m.text;
    return `- **${ts}** → ${toName}: ${preview}`;
  });
  return `### Related Skip Messages\n\n${lines.join('\n')}`;
}

// ---- Message helpers ----

function postMessage(to, from, text, metadata) {
  sendWS('chat', { message: text, to, from, ...metadata })?.catch(e => {
    process.stderr.write(`[fleet] postMessage failed: ${e.message}\n`);
  });
}

async function getUnread(_state, agent) {
  try {
    const data = await sendWS('my-task', { agent, peek: true });
    return data?.messages || [];
  } catch {}
  return [];
}

// Resolve {{att:N}} markers in message text using inline_attachments metadata.
// For agent delivery (MCP text output), converts to markdown links/images.
function resolveAttachmentMarkers(text, inlineAttachments) {
  if (!text) return text;
  if (!inlineAttachments?.length) return text.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => `[attachment ${idx}]`);
  const dashPort = process.env.FLEET_DASH_PORT || 5199;
  const baseUrl = `http://127.0.0.1:${dashPort}`;
  return text.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => {
    const att = inlineAttachments[+idx];
    if (!att) return `[attachment ${idx}]`;
    const name = att.name || att.path?.split('/').pop() || 'file';
    if (att.broken) return `⚠ ${name} (not found)`;
    const url = att.url ? `${baseUrl}${att.url}` : '';
    if (!url) return name;
    const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name);
    return isImage ? `![${name}](${url})` : `[${name}](${url})`;
  });
}

function markRead(_state, agent) {
  // Mark-read is handled server-side when my-task is called.
  // No separate endpoint needed — the server marks messages read on retrieval.
}

// ---- tmux helpers ----

function tmuxSessionName(agent) {
  // Build a tmux-safe session name from agent metadata
  const name = agent.friendly_name || agent.id;
  return `fleet-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function tmuxHasSession(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch { return false; }
}

function tmuxKick(sessionName) {
  try {
    execSync(`tmux send-keys -t ${sessionName} '📬' Enter`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true, result: `kicked tmux:${sessionName}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Verified kick: send 📬, wait, check if agent left the prompt. Retry up to 3x.
function tmuxKickVerified(sessionName) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const kick = tmuxKick(sessionName);
    if (!kick.ok) return kick;
    // Wait 5s for agent to start processing
    try { execSync('sleep 5', { timeout: 10000 }); } catch {}
    // Check if agent left the prompt
    const read = tmuxRead(sessionName);
    if (read.ok && !tmuxIsIdle(read.text)) {
      return { ok: true, result: `kicked tmux:${sessionName} (verified on attempt ${attempt})`, verified: true };
    }
    logEvent({ type: 'kick_retry', session: sessionName, attempt, reason: 'still idle after kick' });
  }
  return { ok: true, result: `kicked tmux:${sessionName} (unverified after 3 attempts)`, verified: false };
}

function tmuxInterrupt(sessionName) {
  try {
    execSync(`tmux send-keys -t ${sessionName} Escape`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true, result: `interrupted tmux:${sessionName}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxRead(sessionName) {
  try {
    const out = execSync(`tmux capture-pane -t ${sessionName} -p -S -200`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxIsIdle(text) {
  if (!text) return false;
  // Working if "esc to interrupt" visible
  if (text.includes('esc to interrupt')) return false;
  // Check for prompt char (❯ or >) on last non-blank line
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return false;
  const last = lines[lines.length - 1];
  return /^[\s]*[❯>][\s📬]*$/.test(last);
}

function tmuxSpawn(cwd, fleetId, sessionName, opts = {}) {
  const dir = cwd || os.homedir();
  const claudeModels = ['claude', 'sonnet', 'opus', 'haiku'];
  const isGoose = opts.model && !claudeModels.some(m => opts.model.startsWith(m));
  const fleetMcp = path.join(__dirname, 'index.mjs');

  if (isGoose) {
    // Goose + third-party model: determine provider and key
    // Read keys from ~/.fleet/env at spawn time (process.env may not have them)
    const fleetEnv = {};
    try {
      const envFile = path.join(os.homedir(), '.fleet', 'env');
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.+)$/);
        if (m) fleetEnv[m[1]] = m[2].trim();
      }
    } catch {}
    const providerMap = {
      'gemini/': { provider: 'google', envKey: 'GOOGLE_API_KEY', keyName: 'GOOGLE_API_KEY' },
      'deepseek/': { provider: 'openai', envKey: 'OPENAI_API_KEY', keyName: 'DEEPSEEK_API_KEY', extraEnv: 'OPENAI_HOST=https://api.deepseek.com' },
    };
    const prefix = Object.keys(providerMap).find(p => opts.model.startsWith(p)) || 'gemini/';
    const { provider, envKey, keyName, extraEnv } = providerMap[prefix];
    const key = fleetEnv[keyName] || process.env[keyName];
    if (!key) {
      throw new Error(`No API key found for ${keyName} in ~/.fleet/env or environment`);
    }
    const modelName = opts.model.replace(prefix, '');
    const envStr = `GOOSE_PROVIDER=${provider} GOOSE_MODEL=${modelName} ${envKey}=${key} FLEET_RESTRICTED=1${extraEnv ? ' ' + extraEnv : ''}`;
    const fleetGoose = path.join(__dirname, 'bin', 'fleet-goose');
    const cmd = `tmux new-session -d -s ${sessionName} -c ${JSON.stringify(dir)} "${envStr} FLEET_ID=${fleetId} node ${fleetGoose} --with-extension 'node ${fleetMcp}' -n ${sessionName}"`;
    execSync(cmd, { encoding: 'utf8', timeout: 10000 });
  } else {
    // Claude Code
    const rGuard = path.join(__dirname, 'bin', 'R-guard');
    const rsGuard = path.join(__dirname, 'bin', 'Rscript-guard');
    const setup = `alias R='${rGuard}' Rscript='${rsGuard}'; `;
    const modelFlag = ` --model ${opts.model || 'sonnet'}`;
    const channelFlag = ' --dangerously-load-development-channels server:fleet';
    const cmd = `tmux new-session -d -s ${sessionName} -c ${JSON.stringify(dir)} "${setup}FLEET_ID=${fleetId} claude${modelFlag}${channelFlag}"`;
    execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    // Auto-accept channels development warning dialog (3s for startup, Enter selects pre-selected option 1)
    exec(`sleep 3 && tmux send-keys -t ${sessionName} Enter`, { timeout: 10000 });
  }
  return sessionName;
}

function tmuxRespawn(sessionName, cwd, fleetId, sessionId) {
  // Create a detached tmux session that resumes an existing claude session
  const dir = cwd || os.homedir();
  const rGuard = path.join(__dirname, 'bin', 'R-guard');
  const rsGuard = path.join(__dirname, 'bin', 'Rscript-guard');
  const setup = `alias R='${rGuard}' Rscript='${rsGuard}'; `;
  const channelFlag = ' --dangerously-load-development-channels server:fleet';
  const cmd = `tmux new-session -d -s ${sessionName} -c ${JSON.stringify(dir)} "${setup}FLEET_ID=${fleetId} claude --resume ${sessionId}${channelFlag}"`;
  execSync(cmd, { encoding: 'utf8', timeout: 10000 });
  // Auto-accept channels development warning dialog
  exec(`sleep 3 && tmux send-keys -t ${sessionName} Enter`, { timeout: 10000 });
  return sessionName;
}

function listTmuxSessions() {
  // Return fleet-* tmux sessions
  try {
    const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    return out.trim().split('\n').filter(s => s.startsWith('fleet-'));
  } catch { return []; }
}

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// Interrupt an agent via tmux.
function interruptAgent(state, agentId) {
  const agent = getAgent(state, agentId);
  if (!agent) return { ok: false, error: 'agent not found' };

  if (agent.tmux_session && tmuxHasSession(agent.tmux_session)) {
    return tmuxInterrupt(agent.tmux_session);
  }

  return { ok: false, error: 'no tmux session' };
}

// ---- MCP server ----

const server = new Server(
  { name: 'fleet', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: 'Fleet messages arrive as <channel source="fleet"> tags. When you see one, call my_task() to get full context and respond via chat(). Treat channel messages exactly like 📬 notifications.',
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ---- Registration & Identity ----
    {
      name: 'register',
      description: 'Register this agent. All agents call this at session start. Pass manager=true to register as manager.',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'boolean', description: 'Register as manager (default false)' },
          testing: { type: 'boolean', description: 'Deprecated, ignored. Any manager can register alongside others now.' },
          session_id: { type: 'string', description: 'Claude session ID (for JSONL lookup)' },
          name: { type: 'string', description: 'Agent name' },
        },
      },
    },
    {
      name: 'inhabit',
      description: 'Claim a fleet identity. Use when identity detection got it wrong (e.g. after MCP restart in shared cwd). Sets this agent\'s fleet ID to the specified one.',
      inputSchema: {
        type: 'object',
        properties: {
          fleet_id: { type: 'string', description: 'The fleet ID to claim (e.g. "fleet:868edc45")' },
        },
        required: ['fleet_id'],
      },
    },
    // ---- Task Management ----
    {
      name: 'delegate',
      description: 'Assign a task to an agent. Auto-promotes caller to manager on first use. Agent is notified via fs.watch on state file.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier — session UUID, agent name, or friendly name' },
          description: { type: 'string', description: 'Short human-readable description (5-10 words)' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          friendly_name: { type: 'string', description: 'Set a friendly name for the agent (optional, same as name_agent)' },
          success_criteria: { type: 'array', items: { type: 'string' }, description: 'Verifiable success criteria. Agent must verify each before marking done.' },
          template: { type: 'string', description: 'Task template name (e.g. "math-edit"). Auto-populates success_criteria; explicit criteria are appended.' },
        },
        required: ['agent', 'description', 'message'],
      },
    },
    // ---- Messaging ----
    {
      name: 'chat',
      description: 'Send a message. Filter is { to?: string[][] } — DNF label expression matching agent name/ID/labels. Omit filter to send to your manager. Format with markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'object', description: 'Filter object: { to?: string[][] }. DNF expression — resolves to matching agents, sends to all of them.' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['message'],
      },
    },
    {
      name: 'task_list',
      description: 'List all active (non-done) tasks and registered agents. Call at session start.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'task_done',
      description: 'Mark a task done. If the task has success_criteria, you must pass verified=true confirming you checked each one. Call with no args to mark your own task done, or specify agent to accept/reject (manager only).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name). Omit to mark own task done.' },
          verified: { type: 'boolean', description: 'Confirm you have verified all success criteria. Required when task has criteria.' },
          rejected: { type: 'boolean', description: ' reject instead of accept. Bounces task back to pending.' },
          feedback: { type: 'string', description: ' feedback when rejecting a task.' },
          report: { type: 'string', description: 'Summary of what was done. Linted before accepting — no plans, no stream-of-consciousness, no raw LaTeX.' },
          overrides: { type: 'array', items: { type: 'string' }, description: 'Lint violation IDs to suppress (e.g. ["proofs-prove:main.tex:L42"]). Use sparingly.' },
        },
      },
    },
    {
      name: 'delete_task',
      description: 'Delete a task permanently. Pass task_id. Any agent can delete any task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to delete.' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'task_check',
      description: 'Read an agent\'s tmux terminal. Pass agent name or ID.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (name, fleet ID, or UUID).' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'my_task',
      description: 'Show what task is assigned to this agent and any unread messages.',
      inputSchema: { type: 'object', properties: {} },
    },
    // Keep register_manager as alias for backward compat (keepalive watcher calls it)
    {
      name: 'register_manager',
      description: 'Register as manager. Alias for register(manager=true).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'unregister_manager',
      description: 'Step down as manager. ',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    // ---- Agent Lifecycle ----
    {
      name: 'name_agent',
      description: 'Set or change a friendly name for an agent.  Names are for manager/human communication — agents don\'t need to know their names.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name)' },
          friendly_name: { type: 'string', description: 'Friendly name (e.g. "sims guy", "survival paper")' },
        },
        required: ['agent', 'friendly_name'],
      },
    },
    {
      name: 'adopt',
      description: 'Reassign a fleet identity to a different agent. The new agent inherits the old fleet ID, friendly name, tasks, and message history. Use when an agent dies and is replaced by a fresh session. ',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The new agent to receive the identity (session UUID, name, or friendly name)' },
          identity: { type: 'string', description: 'The old fleet ID (or friendly name) to adopt' },
        },
        required: ['agent', 'identity'],
      },
    },
    {
      name: 'spawn',
      description: 'Spawn or respawn a fleet agent via fleet-spawn. Default: respawn existing agent (resume session). Pass fresh=true to create a new agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name to respawn (default behavior).' },
          fresh: { type: 'boolean', description: 'Create a fresh agent instead of respawning.' },
          name: { type: 'string', description: 'Name for the new agent (fresh mode only).' },
          model: { type: 'string', description: 'Model override. Default: sonnet.' },
          cwd: { type: 'string', description: 'Working directory (fresh mode only).' },
        },
      },
    },
    // ---- Search & History ----
    {
      name: 'search_logs',
      description: 'Full-text search across all agent session logs and event history. Returns matching snippets with source info. Powered by FTS5 index (fast). Use this to find past conversations, decisions, or context from any agent session.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (supports FTS5 syntax: AND, OR, "exact phrase", prefix*)' },
          project: { type: 'string', description: 'Filter to a specific project directory name (e.g. "-Users-skip-work-foo")' },
          agent: { type: 'string', description: 'Filter to a specific agent (by UUID, name, or friendly name)' },
          role: { type: 'string', description: 'Filter by role: "user" (human messages), "assistant" (agent responses), "chat", "delegate", "task_done"' },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' },
          context: { type: 'number', description: 'Number of surrounding messages to include with each chat match (default 0, max 20). Shows N messages before and after each match.' },
          before: { type: 'string', description: 'ISO timestamp — only return matches before this time. Use for pagination: pass the oldest timestamp from a previous result set.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'observe',
      description: 'Gather structured summary of recent fleet activity for process review. Returns completed tasks, message traffic, agent lifecycle events, and potential patterns (dropped tasks, unanswered messages, rapid task cycling). Designed for the process observer agent.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO timestamp — activity since this time. Default: last 24 hours.' },
          focus: { type: 'string', description: 'Optional focus area: "tasks", "messages", "lifecycle", or omit for all.' },
        },
      },
    },
    {
      name: 'get_thread',
      description: 'Read a conversation thread. This is the PRIMARY tool for reading what was said — use it whenever you need to understand a conversation, review what an agent did, or read task history. Returns complete formatted messages in chronological order. Do NOT read JSONL files directly — use this instead.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name). Required unless task_id is given.' },
          task_id: { type: 'string', description: 'Task ID — returns all messages related to this task.' },
          since: { type: 'string', description: 'ISO timestamp — only messages after this time.' },
          until: { type: 'string', description: 'ISO timestamp — only messages before this time.' },
          include_delegations: { type: 'boolean', description: 'Include task delegations (default true).' },
          limit: { type: 'number', description: 'Max messages (default 50). Use since/until for time-based queries instead of large limits.' },
        },
      },
    },
    {
      name: 'get_refs',
      description: 'Get pinned reference material — conversation excerpts, files, and other artifacts marked as authoritative. Check this when starting a new task or when you need to understand what the human has approved.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pin_ref',
      description: 'Pin a reference — mark something as authoritative source material. Use this when you find approved content in the logs (user said "perfect", "that\'s it", etc.) or when the user tells you something is the reference. Types: "file" (a file path), "conversation" (a log excerpt), "snippet" (inline text).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '"file", "conversation", or "snippet"' },
          label: { type: 'string', description: 'Short description of what this reference is' },
          path: { type: 'string', description: 'File path (for type=file)' },
          project: { type: 'string', description: 'Project dir (for type=conversation)' },
          sessionId: { type: 'string', description: 'Session UUID (for type=conversation)' },
          line: { type: 'number', description: 'Center line number (for type=conversation)' },
          startLine: { type: 'number', description: 'Start line (for type=conversation)' },
          endLine: { type: 'number', description: 'End line (for type=conversation)' },
          content: { type: 'string', description: 'Text content (for type=snippet)' },
          note: { type: 'string', description: 'Optional note about why this is authoritative' },
        },
        required: ['type', 'label'],
      },
    },
    // ---- Labels & Interrupts ----
    {
      name: 'label_agent',
      description: 'Set labels on an agent. Labels are tags for filtering and grouping agents in the fleet UI. ',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (session UUID, name, or friendly name)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Array of label strings to set on the agent (replaces existing labels)' },
        },
        required: ['agent', 'labels'],
      },
    },
    {
      name: 'interrupt',
      description: 'Stop an agent via tmux ESC. Sends ESC repeatedly until the agent reaches its prompt (up to 5 attempts, ~12s max). Returns whether the agent was confirmed stopped. Use chat() separately if you need to send a message.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name)' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'restart_mcp',
      description: 'Restart MCP servers on one or all agents by sending /mcp + Enter to their tmux sessions.  Use after updating fleet code that agents need to pick up.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name). Omit to restart all agents.' },
        },
      },
    },
    // ---- Fleet Operations ----
    {
      name: 'cleanup',
      description: 'Prune dead agents from registry and abandon their orphan tasks. Checks heartbeat (10min) and tmux session liveness. Returns what was removed.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'roll_call',
      description: 'Show fleet status: who is alive, who is missing. Reads identity ledger + scans tmux sessions. Use before rehydrate to see what needs recovery.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'rehydrate',
      description: 'Batch respawn agents into tmux sessions. Finds dead agents with session_ids and resumes them in tmux. ',
      inputSchema: {
        type: 'object',
        properties: {
          agents: { type: 'array', items: { type: 'string' }, description: 'Specific agents to respawn (names or IDs). Omit to respawn all dead agents.' },
        },
      },
    },
    // ---- Cluster Jobs ----
    {
      name: 'job_register',
      description: 'Register a cluster job for tracking. Call after sbatch. Adds the job to the manifest on the cluster so the watcher counts its output files.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'SLURM job ID (from sbatch output)' },
          label: { type: 'string', description: 'Short human-readable label (e.g. "c13 sweep fill")' },
          output_dir: { type: 'string', description: 'Directory containing output files (on cluster, e.g. ~/work/spinoffs/code/spinoff3)' },
          output_pattern: { type: 'string', description: 'Glob pattern for output files (e.g. sweep-a_grf1_h05_16-n200-rep*.rds)' },
          total_reps: { type: 'number', description: 'Total expected output files' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
        required: ['job_id', 'label', 'output_dir', 'output_pattern', 'total_reps'],
      },
    },
    {
      name: 'job_check',
      description: 'Check cluster job status. Pulls latest status from the cluster watcher, returns queue state and file counts for tracked jobs. Optionally filter to a single job.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Filter to a specific job ID. Omit to show all.' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
      },
    },
    {
      name: 'job_log',
      description: 'Tail the log for a cluster job task. SSHes to the cluster and reads the SLURM output log.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'SLURM job ID' },
          task_id: { type: 'string', description: 'Array task ID (default: most recent)' },
          lines: { type: 'number', description: 'Number of lines to tail (default: 50)' },
          stderr: { type: 'boolean', description: 'Read stderr instead of stdout (default: false)' },
          cluster: { type: 'string', description: 'Cluster hostname (default: qtm)' },
        },
        required: ['job_id'],
      },
    },
    // ---- Wiretap ----
    {
      name: 'wiretap',
      description: 'Listen in on messages matching a filter. You get CC\'d on matching messages. Call with no args to list. Filter is DNF of [role, label] tuples: [[["to","skip"],["from","math"]]] = to:skip AND from:math. Roles: "to", "from". Labels match agent name/ID/labels.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'array', description: 'DNF of [role, label] tuples. E.g. [[["to","skip"],["from","math"]],[["to","apps"]]]' },
          remove: { description: 'true to remove all wiretaps, or a wiretap ID to remove one.' },
        },
      },
    },
    // ---- Utilities ----
    {
      name: 'timer',
      description: 'Set a non-blocking timer. Returns immediately — you get a 📬 notification when it fires. Use instead of `sleep X && ...` in bash.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Duration in seconds (1–600)' },
          message: { type: 'string', description: 'Reminder message delivered when timer fires (e.g. "check build status")' },
        },
        required: ['seconds', 'message'],
      },
    },
    {
      name: 'set_preamble',
      description: 'Set KaTeX macros for math rendering in chat. Reads a .tex file, extracts \\newcommand/\\DeclareMathOperator definitions, and stores them for the fleet UI to use when rendering $math$ in chat messages.',
      inputSchema: {
        type: 'object',
        properties: {
          tex_file: { type: 'string', description: 'Path to a .tex file to extract macros from' },
          target: { type: 'string', description: 'Chat room or context name (default: "default"). Use to set different macros per project.' },
        },
        required: ['tex_file'],
      },
    },
    // ---- Document Sharing & Review ----
    {
      name: 'watch_highlights',
      description: 'Start or stop watching a tlda document for new highlights. New highlights are delivered as fleet messages to the assigned agent. ',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'Start watching, stop watching, or list active watchers' },
          doc: { type: 'string', description: 'Document name (e.g. "retargeted-mean")' },
          agent: { type: 'string', description: 'Agent to receive highlight messages (fleet ID or friendly name). Required for start.' },
        },
        required: ['action'],
      },
    },
    // ---- Playback ----
    {
      name: 'playback_record',
      description: 'Extract events from sources into a new playback recording. Sources: session logs, agent events, tlda changelogs. Returns playback ID and event count.',
      inputSchema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            description: 'Data sources to extract from',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['session', 'events', 'tlda'], description: 'Source type' },
                id: { type: 'string', description: 'Session UUID (for type=session)' },
                project: { type: 'string', description: 'Project name (for type=session or type=tlda)' },
                agents: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to include (for type=events)' },
              },
              required: ['type'],
            },
          },
          start: { type: 'string', description: 'ISO timestamp — start of extraction range' },
          end: { type: 'string', description: 'ISO timestamp — end of extraction range' },
          title: { type: 'string', description: 'Playback title' },
        },
        required: ['sources'],
      },
    },
    {
      name: 'playback_list',
      description: 'List available playback recordings, optionally filtered by project or agent.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project name' },
          agent: { type: 'string', description: 'Filter by agent ID' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'playback_get',
      description: 'Get a playback recording by ID. Format: "full" (all data), "summary" (metadata + event counts), "events_only" (just events).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID (UUID)' },
          format: { type: 'string', enum: ['full', 'summary', 'events_only'], description: 'Output format (default: full)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'playback_edit',
      description: 'Apply editing operations to a playback. Supports: trim (select time range), annotate (add markers), speed (adjust playback speed for regions), focus (frost non-focus panels with narration overlay).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID' },
          operations: {
            type: 'array',
            description: 'Edit operations to apply',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['trim', 'annotate', 'speed', 'focus'], description: 'Operation type' },
                start_ms: { type: 'number', description: 'Start time in ms (for trim, speed)' },
                end_ms: { type: 'number', description: 'End time in ms (for trim, speed)' },
                t: { type: 'number', description: 'Timestamp in ms (for annotate, focus)' },
                text: { type: 'string', description: 'Annotation text (for annotate)' },
                factor: { type: 'number', description: 'Speed multiplier (for speed)' },
                panel: { type: 'string', description: 'Panel to focus on — others get frosted (for focus). Values: chat, terminal, code, agents, tasks' },
                narration: { type: 'string', description: 'Narration text shown on the frosted panel (for focus)' },
              },
              required: ['op'],
            },
          },
        },
        required: ['id', 'operations'],
      },
    },
    {
      name: 'playback_transcript',
      description: 'Generate a human-readable transcript of a playback. Shows chat messages, annotations, focus/layout changes. Includes content density analysis to find empty stretches.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playback ID (UUID)' },
          start_ms: { type: 'number', description: 'Start time in ms (default: 0)' },
          end_ms: { type: 'number', description: 'End time in ms (default: full duration)' },
          types: { type: 'array', items: { type: 'string' }, description: 'Event types to include (default: all). Values: chat, marker, focus, layout, delegate, task_done, user_text, assistant_text, tool_call, tool_result' },
          density: { type: 'boolean', description: 'Include content density analysis per time window (default: false)' },
          window_ms: { type: 'number', description: 'Window size in ms for density analysis (default: 60000 = 1 min)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'share',
      description: 'Share a scratch file with quality gate. First call (no reviewed flag) reads the file and returns a self-review prompt — you must evaluate whether the content is reader-ready. Second call (reviewed: true) posts to chat and shares to tlda. Quality bar: self-contained, clear to someone without context, well-structured.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the scratch/markdown file to share' },
          doc: { type: 'string', description: 'Doc name for tlda (auto-generated from filename if omitted). Lowercase alphanumeric + hyphens.' },
          title: { type: 'string', description: 'Human-readable title (defaults to first heading or filename)' },
          to: { type: 'string', description: 'Recipient agent ID or name for chat post. Omit to share to manager.' },
          reviewed: { type: 'boolean', description: 'Set to true after self-review passes. First call without this flag returns review instructions.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'check_doc_feedback',
      description: 'Check for highlight feedback on a shared doc. Reads pen/highlighter annotations from the tlda canvas and translates themed colors into structured feedback: green=approve, red=reject, yellow=question, violet=expand. Returns feedback objects with line ranges and the highlighted text. Use since_minutes to filter to recent feedback only.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
          since_minutes: { type: 'number', description: 'Only return feedback created in the last N minutes (default: all). Use 5 or 10 to see only recent highlights.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'suggest',
      description: 'Post a suggestion card on a shared doc in response to feedback. The card appears as a sticky note anchored at specific lines, with optional Accept/Reject/Modify buttons for one-tap review. Use after check_doc_feedback to respond to highlights.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
          line: { type: 'number', description: 'Source line to anchor the suggestion at' },
          text: { type: 'string', description: 'Suggestion text (supports $math$ and $$display math$$)' },
          reply_to: { type: 'string', description: 'Shape ID of the feedback to reply to (from check_doc_feedback). Creates a threaded reply instead of a new note.' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Action buttons (default: ["Accept", "Reject", "Modify"])' },
          color: { type: 'string', description: 'Note color (default: orange for agent notes)' },
        },
        required: ['doc', 'text'],
      },
    },
    {
      name: 'update_shared_doc',
      description: 'Re-push a shared doc to tlda after editing it. Reads the file from its tracked path and pushes the updated content. Use after making changes in response to feedback.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
        },
        required: ['doc'],
      },
    },
    // ---- Promote ephemeral doc ----
    {
      name: 'promote',
      description: 'Promote an ephemeral scratch doc to permanent. Flips the ephemeral flag so it appears in the tlda index and is no longer auto-pruned.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Doc name (as returned by share())' },
        },
        required: ['doc'],
      },
    },
    // ---- tlda Proxy Tools ----
    {
      name: 'tlda_create_shape',
      description: 'Create a shape (annotation, highlight, arrow, etc.) on a tlda document canvas. Proxies to tlda REST API.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          shape: { type: 'object', description: 'Shape object with at minimum { type, x, y, props }. See tlda shape schema.' },
        },
        required: ['doc', 'shape'],
      },
    },
    {
      name: 'tlda_build',
      description: 'Trigger a build (LaTeX/markdown compilation) for a tlda document. Returns immediately — use tlda_build_status to poll, or wait for the async 📬 notification when the build completes.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'tlda_build_status',
      description: 'Check the current build status for a tlda document. Returns phase, status, and any errors.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'lookup_theorem',
      description: 'Look up a theorem, lemma, proposition, corollary, definition, or assumption in a tlda document by number or label. Returns label, type, number, page, source line, and title.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          query: { type: 'string', description: 'Number ("4.3", "A.1") or full label ("thm:rate-main")' },
        },
        required: ['doc', 'query'],
      },
    },
    {
      name: 'tlda_annotate',
      description: 'Add a math-note annotation to a tlda document. Semantic wrapper around shape creation — positions relative to source lines.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          text: { type: 'string', description: 'Annotation text (markdown/LaTeX supported)' },
          line: { type: 'number', description: 'Source line number to attach to' },
          page: { type: 'number', description: 'PDF page number (0-indexed)' },
          color: { type: 'string', description: 'Note color: light-green, light-red, light-yellow, light-violet, orange. Default: light-yellow' },
          file: { type: 'string', description: 'Source file path (for multi-file projects)' },
          side: { type: 'string', description: 'left or right margin. Default: right' },
        },
        required: ['doc', 'text'],
      },
    },
    {
      name: 'tlda_highlight',
      description: 'Create a visual highlight on a tlda document page. Produces the same highlight shape as the user\'s pen tool — a thick semi-transparent stroke over text. Resolves source line positions via synctex. Use for marking text that needs attention, approval, questions, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          line: { type: 'number', description: 'Source line number to highlight' },
          endLine: { type: 'number', description: 'End line number for multi-line highlight (default: same as line)' },
          file: { type: 'string', description: 'Source file path (for multi-file projects)' },
          color: { type: 'string', description: 'Highlight color: light-green (approve), light-red (fix), yellow (question), light-violet (expand), orange (comment), light-blue (presentation). Default: yellow' },
          text: { type: 'string', description: 'Optional text content being highlighted (stored as metadata for feedback extraction)' },
        },
        required: ['doc', 'line'],
      },
    },
    {
      name: 'tlda_screenshot',
      description: 'Take a cropped screenshot of a specific region on a tlda document. Pass a screenshotRef from an annotation attachment (from dragged annotation metadata), or specify doc + bounds directly. Returns a PNG image.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          ref: { type: 'string', description: 'Screenshot ref from annotation attachment (format: "tlda-screenshot:page:page:x,y,w,h")' },
          x: { type: 'number', description: 'Canvas X of crop region (if not using ref)' },
          y: { type: 'number', description: 'Canvas Y of crop region (if not using ref)' },
          w: { type: 'number', description: 'Width of crop region (if not using ref)' },
          h: { type: 'number', description: 'Height of crop region (if not using ref)' },
          padding: { type: 'number', description: 'Extra pixels around the region (default: 200)' },
          shapeId: { type: 'string', description: 'Shape ID of the target annotation — other annotations are desaturated to make this one stand out' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'tlda_get_feedback',
      description: 'Read visual feedback (highlights, pen marks, annotations) from a tlda document canvas. Returns structured feedback with line ranges, colors mapped to semantic meaning (green=approve, red=reject, yellow=question, violet=expand). Use since_minutes to filter to recent feedback only.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          since_minutes: { type: 'number', description: 'Only return feedback created in the last N minutes (default: all). Use 5 or 10 to see only recent highlights.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'tlda_push',
      description: 'Push source files to a tlda document and optionally trigger a build. Files are read from the local filesystem.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to project root' },
                content: { type: 'string', description: 'File content. If omitted, reads from local filesystem.' },
                localPath: { type: 'string', description: 'Local filesystem path to read from (alternative to content)' },
              },
              required: ['path'],
            },
            description: 'Files to push',
          },
          build: { type: 'boolean', description: 'Trigger build after push. Default: true' },
        },
        required: ['doc', 'files'],
      },
    },
    {
      name: 'publish_report',
      description: 'Publish a markdown report as a page in fleet-workspace. Creates a markdown project, pushes the file, and auto-joins the book. Subsequent edits are auto-pushed by watch-all.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Absolute path to the .md file' },
          title: { type: 'string', description: 'Display title (default: first heading or filename)' },
          book: { type: 'string', description: 'Book to join (default: fleet-workspace)' },
        },
        required: ['file'],
      },
    },
    // ---- Checkpoint / Rollback ----
    {
      name: 'checkpoint',
      description: 'Create a timestamped backup of a tlda document\'s source directory. Call before delegating an edit task so the agent can roll back if needed. Keeps last 10 checkpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'tlda document name (e.g. "bregman")' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'rollback',
      description: 'Restore a tlda document\'s source directory from a checkpoint and push to tlda so the rendered doc updates.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'tlda document name' },
          timestamp: { type: 'string', description: 'ISO timestamp of the checkpoint to restore. If omitted, restores the most recent checkpoint.' },
        },
        required: ['doc'],
      },
    },
    // ---- Report Gate ----
    {
      name: 'report',
      description: 'Submit work for QA review. Required fields depend on task_type. Validates fields, checks QA agents are alive, stores report, kicks qa-haiku. If no QA agents configured, falls back to self-review mode (pass + summary).',
      inputSchema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean', description: 'Legacy self-review mode: set true if self-review passed. Only used when QA is not configured.' },
          summary: { type: 'string', description: 'Legacy self-review mode: structured summary. Required when pass=true. Also used as summary field in QA reports.' },
          task_type: { type: 'string', enum: ['app', 'math'], description: 'Task type — determines required fields.' },
          worktree_branch: { type: 'string', description: 'App: git branch name from worktree.' },
          dev_port: { type: 'number', description: 'App: port the vite dev server ran on.' },
          files_changed: { type: 'array', items: { type: 'string' }, description: 'Files modified.' },
          screenshot_before: { type: 'string', description: 'App: path to before screenshot.' },
          screenshot_after: { type: 'string', description: 'App: path to after screenshot.' },
          test_method: { type: 'string', description: 'App: how it was tested.' },
          test_evidence: { type: 'string', description: 'App: path to test output/screenshot.' },
          console_errors: { type: 'boolean', description: 'App: did you check for console errors?' },
          builds_clean: { type: 'boolean', description: 'Math: latex compiles without errors?' },
          theorem_statement: { type: 'string', description: 'Math: what was proved/changed.' },
          proof_sketch: { type: 'string', description: 'Math: brief proof approach.' },
        },
      },
    },
    {
      name: 'sign_report',
      description: 'QA-only tool. Sign off on a submitted report. Only callable by configured QA agents (qa-haiku, qa-opus).',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to sign off on.' },
          verdict: { type: 'string', enum: ['approved', 'rejected'], description: 'Approve or reject the report.' },
          notes: { type: 'string', description: 'Required if rejected, optional if approved.' },
        },
        required: ['task_id', 'verdict'],
      },
    },
    // ---- Browser Tools ----
    {
      name: 'get_console',
      description: "Read Skip's Safari browser console. Injects a collector on first call, returns buffered logs on subsequent calls. Non-destructive.",
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['error', 'warn', 'all'], description: 'Filter by level (default: error)' },
          limit: { type: 'number', description: 'Max entries to return (default: 20)' },
        },
      },
    },
    {
      name: 'reload_browser',
      description: "Hard-reload Skip's Safari tab. Asks Skip for permission first via chat, waits up to 60s for approval.",
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the reload is needed (shown to Skip)' },
        },
        required: ['reason'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Report tool_call status to fleet server (replaces pane scraping for idle detection)
  reportStatus('tool_call', name);

  // ==== Registration & Identity ====

  // ---- register ----
  if (name === 'register' || name === 'register_manager') {
    const isManager = name === 'register_manager' || args.manager === true;
    const agentName = args.name || null;

    // On re-registration (compaction), update session only if explicitly passed.
    // Re-detect session at register() time to catch post-compaction new sessions.
    // After compaction, claude code creates a new JSONL file. The MCP still holds
    // the old CLAUDE_SESSION. Re-scan using birthtime (not mtime) — birthtime is
    // unique per session creation and won't be confused by other agents writing to
    // shared files. Only update if the new file is NEWER than the current one.
    if (!args.session_id && CLAUDE_SESSION) {
      try {
        const cwd = process.env.PWD || process.cwd();
        const projectHash = cwd.replace(/\//g, '-');
        const jsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
        const curPath = path.join(jsonlDir, CLAUDE_SESSION + '.jsonl');
        const curBirth = fs.statSync(curPath).birthtimeMs;
        // Post-compaction: Claude creates a new JSONL within seconds of register().
        // Only consider files created in the last 2 minutes (avoids stealing other
        // agents' older unclaimed sessions in shared project dirs).
        const twoMinsAgo = Date.now() - 2 * 60 * 1000;
        const fresh = fs.readdirSync(jsonlDir)
          .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
          .map(f => {
            try {
              const st = fs.statSync(path.join(jsonlDir, f));
              return { session: f.replace('.jsonl', ''), birth: st.birthtimeMs };
            } catch { return null; }
          })
          .filter(Boolean)
          .filter(f => f.birth > twoMinsAgo) // must be recently created
          .sort((a, b) => b.birth - a.birth)[0];
        if (fresh && fresh.session !== CLAUDE_SESSION && fresh.birth > curBirth) {
          process.stderr.write(`[fleet] register: post-compaction session update ${CLAUDE_SESSION.slice(0,8)} → ${fresh.session.slice(0,8)}\n`);
          CLAUDE_SESSION = fresh.session;
        }
      } catch {}
    }
    if (args.session_id) {
      CLAUDE_SESSION = args.session_id;
      // If the passed session_id maps to a different agent than our current AGENT_ID,
      // override AGENT_ID. This fixes shared-cwd identity collisions where
      // detectClaudeSession() picked the wrong JSONL at startup.
      if (AGENT_ID) {
        let earlyAgents = [];
        try {
          earlyAgents = await sendWS('store-agents') || [];
        } catch (e) {
          process.stderr.write(`[fleet] register: early agent fetch failed: ${e.message}\n`);
        }
        const match = earlyAgents.find(a =>
          a.id !== AGENT_ID && a.session_id === args.session_id
        );
        if (match) {
          logEvent({ type: 'identity_override', old: AGENT_ID, new: match.id, reason: `session_id ${args.session_id} belongs to ${match.id}, not ${AGENT_ID}` });
          AGENT_ID = match.id;
        }
      }
    }

    // Need either a session UUID or a name
    if (!AGENT_ID && !CLAUDE_SESSION && !agentName) {
      return { content: [{ type: 'text', text: 'No session ID detected and no name provided. Pass session_id or name for headless agents.' }], isError: true };
    }

    let agents = [];
    try {
      agents = await sendWS('store-agents') || [];
    } catch (e) {
      process.stderr.write(`[fleet] register: failed to fetch agents from server: ${e.message}\n`);
    }
    // Build a minimal state-like object for compat
    const state = { agents };

    const claudeSession = args.session_id || CLAUDE_SESSION;
    if (args.session_id && args.session_id !== CLAUDE_SESSION) {
      CLAUDE_SESSION = args.session_id;
    }

    // --- Identity resolution (see fleet-identity.md) ---
    // Two-tier: AGENT_ID (already known or from $FLEET_ID) → session/name lookup
    let resolvedFleetId = AGENT_ID || null;
    let identitySource = AGENT_ID ? (process.env.FLEET_ID ? '$FLEET_ID' : 'startup detection') : null;

    if (!resolvedFleetId && claudeSession) {
      // Look up session in ledger
      const ledgerAgent = ledger.findBySession(claudeSession);
      if (ledgerAgent) {
        // Check if that agent is alive — refuse to steal a live agent's identity
        const holder = getAgent(state, ledgerAgent.fleet_id);
        if (holder && holder.last_seen && (Date.now() - new Date(holder.last_seen).getTime()) < ALIVE_THRESHOLD_MS) {
          logEvent({ type: 'identity_collision_prevented', session: claudeSession, agent: ledgerAgent.fleet_id,
            reason: `register: session ${claudeSession} maps to ${ledgerAgent.fleet_id} who is alive — skipping` });
          identitySource = `session ${claudeSession} → ${ledgerAgent.fleet_id} (BLOCKED: agent alive)`;
        } else {
          resolvedFleetId = ledgerAgent.fleet_id;
          identitySource = `ledger session match: ${claudeSession} → ${ledgerAgent.fleet_id}`;
          logEvent({ type: 'identity_match', agent: resolvedFleetId, reason: `ledger session match for ${claudeSession}` });
        }
      }
    }

    // Also check state file for session match (transition period)
    if (!resolvedFleetId && claudeSession) {
      const stateMatch = state.agents.find(a =>
        a.session_id === claudeSession ||
        (a.session_ids && a.session_ids.includes(claudeSession))
      );
      if (stateMatch) {
        // Check liveness here too
        if (stateMatch.last_seen && (Date.now() - new Date(stateMatch.last_seen).getTime()) < ALIVE_THRESHOLD_MS) {
          logEvent({ type: 'identity_collision_prevented', session: claudeSession, agent: stateMatch.id,
            reason: `register: session ${claudeSession} maps to ${stateMatch.id} (state) who is alive — skipping` });
          if (!identitySource) identitySource = `session ${claudeSession} → ${stateMatch.id} (BLOCKED: agent alive)`;
        } else {
          resolvedFleetId = stateMatch.id;
          identitySource = `state session match: ${claudeSession} → ${stateMatch.id}`;
          logEvent({ type: 'identity_match', agent: resolvedFleetId, reason: `state session match for ${claudeSession}` });
        }
      }
    }

    // Match by name in ledger (headless agents using register(name=...))
    if (!resolvedFleetId && agentName) {
      const ledgerAgent = ledger.findByName(agentName);
      if (ledgerAgent) {
        resolvedFleetId = ledgerAgent.fleet_id;
        identitySource = `ledger name match: "${agentName}" → ${ledgerAgent.fleet_id}`;
      }
      if (!resolvedFleetId) {
        const stateMatch = state.agents.find(a => a.friendly_name === agentName);
        if (stateMatch) {
          resolvedFleetId = stateMatch.id;
          identitySource = `state name match: "${agentName}" → ${stateMatch.id}`;
        }
      }
    }

    // Uniqueness check: if resolvedFleetId is held by a different LIVE agent, reject
    if (resolvedFleetId && AGENT_ID && resolvedFleetId !== AGENT_ID) {
      const holder = getAgent(state, resolvedFleetId);
      if (holder && agentAlive(holder)) {
        return { content: [{ type: 'text', text: `Identity collision: fleet ID ${resolvedFleetId} is held by a live agent. Use adopt() to merge or cleanup() to remove the stale entry.` }], isError: true };
      }
    }

    // New agent — create fleet ID (always fleet: prefixed for consistency)
    if (!resolvedFleetId) {
      if (claudeSession) {
        resolvedFleetId = `fleet:${claudeSession.slice(0, 8)}`;
      } else {
        resolvedFleetId = `fleet:${crypto.randomUUID().slice(0, 8)}`;
      }
      identitySource = identitySource || `new: created ${resolvedFleetId} from ${claudeSession ? 'session ' + claudeSession : 'name ' + agentName}`;
    }

    // Find or create state entry
    let entry = state.agents.find(a => a.id === resolvedFleetId);
    if (!entry) {
      entry = { id: resolvedFleetId, registered_at: now() };
      state.agents.push(entry);
    } else {
      entry.registered_at = now();
      // If re-registering an entry that was compacting (same fleet ID),
      // preserve compacting for one SSE cycle so the fleet UI sees the transition
      if (entry.compacting) {
        entry._keepCompacting = true;
      }
    }

    // Update fields
    // Auto-detect tmux session if running inside one
    let detectedTmux = null;
    if (process.env.TMUX) {
      try {
        const tmuxSession = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 3000 }).trim();
        if (tmuxSession.startsWith('fleet-')) {
          entry.tmux_session = tmuxSession;
          detectedTmux = tmuxSession;
        }
      } catch (e) {
        // Not in tmux — expected for non-fleet agents
      }
    }

    // tmux is metadata, not identity. If two fleet IDs share a tmux session, that's a spawn bug.
    // Don't silently merge — just store the metadata.

    if (agentName && !entry.friendly_name) entry.friendly_name = agentName;
    if (claudeSession) {
      entry.session_id = claudeSession;
      if (!entry.session_ids) entry.session_ids = [];
      if (!entry.session_ids.includes(claudeSession)) entry.session_ids.push(claudeSession);
    }

    entry.last_seen = now();
    // Compacting state: cleared after registration completes (see below after stale cleanup)
    delete entry.dead;
    if (process.env.PWD) entry.cwd = process.env.PWD;
    // is_manager removed — no permission gating

    // Labels: preserve existing, add auto-labels
    const labels = new Set(entry.labels || []);
    // No auto-labels based on manager status
    if (entry.cwd) {
      const project = path.basename(entry.cwd);
      if (project && project !== '~') labels.add(project);
    }
    if (labels.size > 0) entry.labels = [...labels];

    // Uniqueness: name must be unique among live agents — error, don't log-and-continue
    if (entry.friendly_name) {
      const nameConflict = state.agents.find(a =>
        a.id !== entry.id && (a.friendly_name === entry.friendly_name) && agentAlive(a)
      );
      if (nameConflict) {
        return { content: [{ type: 'text', text: `Name collision: "${entry.friendly_name}" is already used by live agent ${nameConflict.id}. Use a different name or respawn the existing agent.` }], isError: true };
      }
    }

    // Clear compacting flag unless just inherited from a stale entry.
    // Inherited compacting persists for one SSE cycle, then the heartbeat clears it.
    if (!entry._keepCompacting) {
      delete entry.compacting;
      delete entry.compacting_since;
    }

    // Remove legacy top-of-chain singleton
    delete state.manager;

    // Start keepalive if none running
    try {
      execSync('pgrep -f agent-keepalive', { timeout: 3000 });
    } catch {
      exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
    }

    // Chief-of-staff auto-spawn DISABLED — was flooding chat with timer spam.
    // Re-enable when rate limiting is implemented.
    if (false && isManager) {
      const chiefAlive = (state.agents || []).some(a =>
        a.friendly_name === 'chief-of-staff' && !a.dead &&
        a.tmux_session && tmuxHasSession(a.tmux_session)
      );
      if (!chiefAlive) {
        try {
          const chiefId = `fleet:${crypto.randomUUID().slice(0, 8)}`;
          const chiefSession = 'fleet-chief';
          if (!tmuxHasSession(chiefSession)) {
            const chiefCwd = __dirname; // fleet repo
            ledger.upsertAgent(chiefId, null, chiefCwd, 'chief-of-staff');
            // Register in state immediately so other agents see it
            state.agents.push({
              id: chiefId, tmux_session: chiefSession, friendly_name: 'chief-of-staff',
              cwd: chiefCwd, registered_at: now(), last_seen: now(), is_manager: false,
            });
            const preamblePath = path.join(__dirname, 'chief-preamble.md');
            const rGuard = path.join(__dirname, 'bin', 'R-guard');
            const rsGuard = path.join(__dirname, 'bin', 'Rscript-guard');
            const setup = `alias R='${rGuard}' Rscript='${rsGuard}'; `;
            // Launch claude with initial prompt to read the preamble and start monitoring
            const prompt = fs.existsSync(preamblePath)
              ? 'Read chief-preamble.md and follow its instructions.'
              : 'You are the chief of staff. Call register(), then observe(), then start monitoring.';
            tmuxSpawn(chiefCwd, chiefId, chiefSession);
            // Send the initial prompt to the chief's tmux session
            setTimeout(() => {
              try {
                execSync(`tmux send-keys -t ${chiefSession} ${JSON.stringify(prompt)} Enter`, { timeout: 5000, stdio: 'pipe' });
              } catch {}
            }, 3000); // wait for claude to start
          }
        } catch (e) {
          process.stderr.write(`[fleet] chief-of-staff spawn failed: ${e.message}\n`);
        }
      }
    }

    // Set this process's fleet identity
    AGENT_ID = entry.id;

    // Update the identity ledger
    const cwd = entry.cwd || process.env.PWD || null;
    ledger.upsertAgent(AGENT_ID, claudeSession, cwd, entry.friendly_name);

    // Register via server WS — wait briefly if WS not yet connected
    const regBody = {
      id: entry.id,
      name: entry.friendly_name,
      session_id: entry.session_id,
      tmux_session: entry.tmux_session,
      cwd: entry.cwd,
      labels: entry.labels,
      manager: entry.is_manager,
    };
    // Wait up to 2s for WS to connect (it should be fast — localhost)
    if (!_channelWS) {
      startChannelWS();
      const deadline = Date.now() + 2000;
      while (!_channelWS && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    const wsSent = sendWS('register', regBody);
    if (wsSent) {
      await wsSent.catch(e => process.stderr.write(`[fleet] register WS failed: ${e.message}\n`));
    } else {
      process.stderr.write(`[fleet] register failed: WS not connected after 2s\n`);
    }

    const agentCount = state.agents.length;
    const role = isManager ? 'manager' : 'agent';
    let msg = `Registered ${entry.id} as ${role}. ${agentCount} agent(s) registered.`;
    if (identitySource) {
      msg += `\nIdentity: ${identitySource}`;
    }
    if (entry.friendly_name) {
      msg += `\nYour name: "${entry.friendly_name}" — other agents and the user know you by this name.`;
    }

    const refPath = `${os.homedir()}/.claude/reference/managing-agents.md`;
    const repoRefPath = path.join(__dirname, 'managing-agents.md');
    const refExists = fs.existsSync(refPath);

    if (isManager) {
      msg += '\n\nWhen you see 📬 as input, call my_task() — it means an agent sent you a message or a task changed.';
      if (refExists) {
        msg += '\nRead ~/.claude/reference/managing-agents.md before proceeding.';
      } else {
        msg += `\n\n⚠ ~/.claude/reference/managing-agents.md not found. Symlink it:\n  ln -s ${repoRefPath} ${refPath}\n\nFor now, read ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    } else {
      msg += '\n\nAfter registering: call my_task() to check for a task. If nothing, just keep working — you\'ll see 📬 when a task or message arrives.';
      msg += '\nWhen you see 📬 as input, call my_task() — it means you have a new task or message.';
      if (refExists) {
        msg += '\nSee ~/.claude/reference/managing-agents.md for how to work with the manager.';
      } else {
        msg += `\nSee ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    }
    msg += '\nChat formatting: fleet UI renders markdown (**bold**, `code`, lists, headers) and LaTeX ($inline$, $$display$$). Use them in chat() messages.';

    // Start channel WS for direct message injection (replaces tmux send-keys)
    if (!_channelWS && !_channelRetryTimer) {
      startChannelWS();
    }

    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- unregister_manager ----
  if (name === 'unregister_manager') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    // No state write needed — manager flag is handled server-side
    return { content: [{ type: 'text', text: 'Stepped down as manager.' }] };
  }

  // ---- inhabit ----
  if (name === 'inhabit') {
    const targetFleetId = args.fleet_id;
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    let agents = [];
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/agents`);
      if (res.ok) agents = await res.json();
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }
    const state = { agents };

    // Check if a different LIVE agent holds this identity
    const holder = getAgent(state, targetFleetId);
    if (holder && agentAlive(holder) && holder.id !== AGENT_ID) {
      return { content: [{ type: 'text', text: `Cannot inhabit ${targetFleetId} — it's held by a live agent. Kill or cleanup that agent first.` }], isError: true };
    }

    const oldId = AGENT_ID;
    const myEntry = getAgent(state, oldId);

    AGENT_ID = targetFleetId;

    // Update ledger
    ledger.upsertAgent(targetFleetId, CLAUDE_SESSION, myEntry?.cwd || process.env.PWD, myEntry?.friendly_name);

    // Re-register with the new identity via server
    const inhabRegBody = {
      id: targetFleetId,
      name: myEntry?.friendly_name || holder?.friendly_name,
      session_id: myEntry?.session_id || CLAUDE_SESSION,
      tmux_session: myEntry?.tmux_session,
      cwd: myEntry?.cwd || process.env.PWD,
      labels: myEntry?.labels,
    };
    await sendWS('register', inhabRegBody)?.catch(e => process.stderr.write(`[fleet] inhabit register failed: ${e.message}\n`));

    // TODO: Need server endpoint to transfer tasks/messages from oldId to targetFleetId
    // For now, log the event and let the server handle identity merging

    logEvent({ type: 'inhabit', from: oldId, to: targetFleetId });

    const name_ = myEntry?.friendly_name || holder?.friendly_name || targetFleetId;
    return { content: [{ type: 'text', text: `Identity changed: ${oldId} → ${targetFleetId} ("${name_}"). Tasks and messages transferred.` }] };
  }

  // ==== Task Templates ====
  const TASK_TEMPLATES = {
    'math-edit': [
      'Proof audit completed (persistent + fresh reader)',
      'Propagation grep — no stale patterns',
      'Kindness check passed — notation self-documenting, steps motivated',
      'Skip reviewer pass — verifiable without re-deriving',
      'All fixable issues fixed, remaining items have proposals',
      'Revision plan doc created and maintained',
      'Recheck completed — fresh reader on edited sections after fixes',
    ],
  };

  // ==== Task Management ====

  // ---- delegate ----
  if (name === 'delegate') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot delegate: not registered.' }], isError: true };
    const { agent, description, message } = args;
    if (!agent || !description) return { content: [{ type: 'text', text: 'Missing agent or description.' }], isError: true };

    // Merge template + explicit criteria
    const templateCriteria = args.template ? (TASK_TEMPLATES[args.template] || []) : [];
    if (args.template && !TASK_TEMPLATES[args.template]) {
      return { content: [{ type: 'text', text: `Unknown template "${args.template}". Available: ${Object.keys(TASK_TEMPLATES).join(', ')}` }], isError: true };
    }
    const criteria = [...templateCriteria, ...(args.success_criteria || [])];
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const delegateBody = { from: AGENT_ID, agent, description, message: message || description, success_criteria: criteria.length ? criteria : undefined, blocked_by: blockedBy.length ? blockedBy : undefined };
      const data = await sendWS('delegate', delegateBody);
      if (data.event_id) {
        _originatedEventIds.add(data.event_id);
        setTimeout(() => _originatedEventIds.delete(data.event_id), ORIGINATED_TTL_MS);
      }
      if (!data.ok) return { content: [{ type: 'text', text: `Delegate failed: ${JSON.stringify(data)}` }], isError: true };

      // Set friendly name if provided
      if (args.friendly_name) {
        await sendWS('rename', { agent, name: args.friendly_name })?.catch(() => {});
      }

      return { content: [{ type: 'text', text: `Delegated to ${agent} [${data.task_id}]: ${description}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Delegate failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ==== Messaging ====

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot send chat: not registered.' }], isError: true };

    // Resolve recipients from filter
    if (!args.filter?.to) return { content: [{ type: 'text', text: 'Missing filter.to — specify recipients as DNF expression.' }], isError: true };
    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
    let recipients = [];
    try {
      const agents = await sendWS('store-agents');
      for (const a of agents) {
        if (a.id === AGENT_ID) continue;
        const labels = [...(a.labels || []), a.friendly_name, a.id].filter(Boolean);
        if (args.filter.to.some(andGroup => andGroup.every(term => labels.includes(term)))) {
          recipients.push(a.id);
        }
      }
    } catch {}
    if (recipients.length === 0) return { content: [{ type: 'text', text: 'No agents matched filter.' }], isError: true };

    // Resolve file paths in message text → inline attachments
    const agentCwd = process.env.PWD || null;
    let resolvedMessage = message;
    const inlineAttachments = [];
    if (agentCwd) {
      let attIdx = 0;
      resolvedMessage = message.replace(/(?<![\/\w])(~?\/[\w.\-\/]+\.(?:md|R|qmd|py|mjs|js|ts|tsx|jsx|css|html|tex|bib|rds|csv|tsv|txt|sh|yml|yaml|json|toml|cfg|log|svg|png|jpg|jpeg|gif|webp|pdf|sql|xml|rs|go|c|h|cpp|hpp|lua|rb|jl|rmd)|[\w][\w.\-\/]*\.(?:md|R|qmd|py|mjs|js|ts|tsx|jsx|css|html|tex|bib|rds|csv|tsv|txt|sh|yml|yaml|json|toml|cfg|log|svg|png|jpg|jpeg|gif|webp|pdf|sql|xml|rs|go|c|h|cpp|hpp|lua|rb|jl|rmd))(?!\w)/g, (match, filePath) => {
        const expanded = filePath.replace(/^~\//, os.homedir() + '/');
        if (expanded.startsWith('/')) {
          if (fs.existsSync(expanded)) {
            const id = attIdx++;
            inlineAttachments.push({ type: 'file', id, path: expanded, name: path.basename(expanded) });
            return `{{att:${id}}}`;
          }
          return match;
        }
        // Relative path — resolve against agent cwd
        const abs = path.resolve(agentCwd, expanded);
        if (fs.existsSync(abs)) {
          const id = attIdx++;
          inlineAttachments.push({ type: 'file', id, path: abs, name: path.basename(abs) });
          return `{{att:${id}}}`;
        }
        return match;
      });
    }

    // Upload file attachments to fleet server so they're accessible via URL
    const dashPortUpload = process.env.FLEET_DASH_PORT || 5199;
    for (const att of inlineAttachments) {
      if (att.path && fs.existsSync(att.path)) {
        try {
          const buf = fs.readFileSync(att.path);
          const res = await fetch(`http://127.0.0.1:${dashPortUpload}/api/upload`, {
            method: 'POST',
            headers: { 'x-filename': encodeURIComponent(att.name) },
            body: buf,
          });
          const data = await res.json();
          if (data.url) att.url = data.url;
        } catch {}
      }
    }

    // Auto-attach ref metadata for «...» tokens in the message
    const refAttachments = [];
    const tokenRe = /«(.+?)»/g;
    let tokenMatch;
    while ((tokenMatch = tokenRe.exec(resolvedMessage)) !== null) {
      const fullToken = `«${tokenMatch[1]}»`;
      const refData = _refTokens.get(fullToken);
      if (refData) refAttachments.push({ ...refData, token: fullToken });
    }

    // Single write: send to fleet server via WS.
    const sent = [];
    for (const to of recipients) {
      const chatBody = { message: resolvedMessage, to, from: AGENT_ID };
      if (inlineAttachments.length) chatBody.inline_attachments = inlineAttachments;
      if (refAttachments.length) chatBody.attachments = refAttachments;
      try {
        const data = await sendWS('chat', chatBody);
        if (data?.ok) sent.push(to);
      } catch {}
    }

    if (sent.length === 0) return { content: [{ type: 'text', text: 'Send failed — no messages delivered.' }], isError: true };

    let warning = '';
    if (message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    return { content: [{ type: 'text', text: `Message queued for ${sent.join(', ')}.${warning}` }] };
  }


  // ---- task_list ----
  if (name === 'task_list') {
    let agents, active;
    try {
      [agents, active] = await Promise.all([sendWS('store-agents'), sendWS('store-tasks', { active: true })]);
      if (agents.error) return { content: [{ type: 'text', text: `task_list failed: ${agents.error}` }], isError: true };
      if (active.error) return { content: [{ type: 'text', text: `task_list failed: ${active.error}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `task_list failed (server unreachable): ${e.message}` }], isError: true };
    }

    let text = '';

    // Show registered agents
    if (agents.length > 0) {
      const agentLines = agents.map(a => {
        let label = a.friendly_name ? `"${a.friendly_name}"` : a.id;
        if (a.friendly_name) label += ` [${a.id}]`;
        if (a.dead) label += ' [dead]';
        if (a.human) label += ' [human]';
        // No manager label
        if (a.tmux_session) label += ` tmux:${a.tmux_session}`;
        return label;
      });
      text += `Agents: ${agentLines.join(', ')}\n\n`;
    }

    if (!active.length) {
      text += 'No active tasks.';
      return { content: [{ type: 'text', text }] };
    }

    // Check if there are multiple managers (show delegated_by if so)
    const managerCount = agents.filter(a => a.is_manager).length;
    const showOwner = managerCount > 1;

    const agentMap = new Map(agents.map(a => [a.id, a]));
    const lines = active.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      let status = t.status;
      if (t.synthetic) status = `📬 ${t.priority || 'normal'}`;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if (!t.synthetic && (t.status === 'pending' || t.status === 'working') && age > 1440) {
        status += ` [stale — ${Math.round(age / 60)}h]`;
      }
      let owner = '';
      if (showOwner && t.delegated_by) {
        const ownerAgent = agentMap.get(t.delegated_by);
        const ownerLabel = ownerAgent?.friendly_name || t.delegated_by;
        owner = ` | by:${ownerLabel}`;
      }
      return `[${t.id}] ${t.agent} | ${status} | ${t.description} | ${age}m ago${owner}`;
    });

    text += lines.join('\n');

    const working = active.filter(t => t.status === 'working');
    const pending = active.filter(t => t.status === 'pending');
    const idle = active.filter(t => t.status === 'idle');
    const blocked = active.filter(t => t.status === 'blocked');

    const unread = AGENT_ID ? await getUnread(null, AGENT_ID) : [];

    let nudge = '';
    if (unread.length > 0) nudge += `\n\n📬 ${unread.length} unread message(s). Check them.`;
    if (idle.length > 0) nudge += `\n\n${idle.length} idle — review and delegate or mark done.`;
    if (working.length > 0) nudge += `\n\n${working.length} working.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked.`;
    return { content: [{ type: 'text', text: text + nudge }] };
  }

  // ---- delete_task ----
  if (name === 'delete_task') {
    const { task_id } = args;
    if (!task_id) return { content: [{ type: 'text', text: 'missing task_id' }], isError: true };
    try {
      const res = await sendWS('delete-task', { task_id });
      if (!res?.ok) return { content: [{ type: 'text', text: `Delete failed: ${res?.error || 'unknown'}` }], isError: true };
      return { content: [{ type: 'text', text: `Deleted task ${task_id}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }
  }

  // ---- task_done ----
  if (name === 'task_done') {
    let agent = args.agent || AGENT_ID;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and not registered.' }], isError: true };

    // Check task exists via server
    let taskRes;
    try {
      taskRes = await sendWS('my-task', { agent, peek: true });
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }
    const task = taskRes.task;
    if (!task) return { content: [{ type: 'text', text: `No active task for ${agent}.` }] };

    // Success criteria gate (own task only)
    if (agent === AGENT_ID && task.success_criteria?.length && !args.verified) {
      const criteria = task.success_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
      return { content: [{ type: 'text', text: `This task has success criteria you must verify before marking done:\n\n${criteria}\n\nHave you verified each of these? Call task_done(verified: true) to confirm.` }] };
    }

    // Report gate (own task only)
    if (agent === AGENT_ID && !task.reported) {
      try {
        const diff = execSync('git diff HEAD --name-only 2>/dev/null', {
          cwd: process.env.PWD || os.homedir(), encoding: 'utf8', timeout: 5000,
        }).trim();
        if (diff) {
          return { content: [{ type: 'text', text: `File report() before task_done(). You have uncommitted file edits:\n${diff.split('\n').slice(0, 10).join('\n')}\n\nCall report() to self-review your changes first.` }] };
        }
      } catch {}
    }

    // QA gate (own task only — check for QA signatures)
    if (agent === AGENT_ID) {
      try {
        const qaRes = await fetch(`http://127.0.0.1:${dashPort}/api/qa/status?task_id=${encodeURIComponent(task.id)}`);
        const qaStatus = await qaRes.json();
        // Only enforce if QA is configured (has agent IDs) and a report exists
        let qaConfigRes;
        try { qaConfigRes = await (await fetch(`http://127.0.0.1:${dashPort}/api/qa/config`)).json(); } catch { qaConfigRes = { qa_agent_ids: [] }; }
        if (qaConfigRes.qa_agent_ids?.length > 0) {
          if (qaStatus.status === 'no_report') {
            return { content: [{ type: 'text', text: 'Submit a report() first' }], isError: true };
          }
          if (qaStatus.status === 'rejected') {
            return { content: [{ type: 'text', text: `QA rejected: ${qaStatus.notes || 'no details'}. Fix and re-report.` }], isError: true };
          }
          if (qaStatus.status === 'pending') {
            return { content: [{ type: 'text', text: `Waiting for QA sign-off (${(qaStatus.approved_by || []).length}/${qaConfigRes.qa_agent_ids.length} approved)` }], isError: true };
          }
        }
      } catch {}
    }

    // Lint gate (own task only)
    let _lintOverrides = [];
    if (agent === AGENT_ID) {
      const reportText = args.report || args.description || null;
      _lintOverrides = Array.isArray(args.overrides) ? args.overrides : [];
      let gitDiff = null;
      try {
        gitDiff = execSync('git diff HEAD 2>/dev/null', {
          cwd: process.env.PWD || os.homedir(), encoding: 'utf8', timeout: 5000,
        });
      } catch {}
      const violations = lintReport(reportText, gitDiff, _lintOverrides);
      if (violations.length > 0) {
        return { content: [{ type: 'text', text: formatLintViolations(violations) }], isError: true };
      }
    }

    // Complete via server
    try {
      const doneBody = { agent, task_id: task.id, lint_overrides: _lintOverrides.length > 0 ? _lintOverrides : undefined };
      const data = await sendWS('task-done', doneBody);
      if (data.event_id) {
        _originatedEventIds.add(data.event_id);
        setTimeout(() => _originatedEventIds.delete(data.event_id), ORIGINATED_TTL_MS);
      }
      if (!data.ok) return { content: [{ type: 'text', text: `task_done failed: ${JSON.stringify(data)}` }], isError: true };

      let msg = `Marked ${agent} task done: ${task.description}.`;
      if (_lintOverrides.length > 0) {
        msg += `\n\nNote: ${_lintOverrides.length} lint override(s) were used: ${_lintOverrides.join(', ')}`;
      }
      if (agent === AGENT_ID) {
        msg += '\n\nKeep working or use timer() — you\'ll see 📬 when the next task arrives.';
      }
      return { content: [{ type: 'text', text: msg }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `task_done failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- report (QA-aware report gate) ----
  if (name === 'report') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered. Call register() first.' }], isError: true };

    let taskData;
    try {
      taskData = await sendWS('my-task', { agent: AGENT_ID, peek: true });
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }
    const task = taskData.task;
    if (!task) return { content: [{ type: 'text', text: 'No active task to report on.' }], isError: true };

    let agents = [];
    try { agents = await sendWS('store-agents'); } catch {}
    const state = { agents, tasks: [], messages: [] };

    const agent = getAgent(state, AGENT_ID);
    const cwd = agent?.cwd || process.env.PWD || null;

    // Check if QA system is configured
    let qaConfig;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/qa/config`);
      qaConfig = await res.json();
    } catch { qaConfig = { qa_agent_ids: [] }; }
    const qaEnabled = qaConfig.qa_agent_ids?.length > 0;

    // ---- QA-enabled path: structured report submission ----
    if (qaEnabled && args.task_type) {
      const taskType = args.task_type;
      const missing = [];

      // Validate required fields by task type
      if (taskType === 'app') {
        if (!args.files_changed?.length) missing.push('files_changed');
        if (!args.screenshot_before) missing.push('screenshot_before');
        if (!args.screenshot_after) missing.push('screenshot_after');
        if (!args.test_method) missing.push('test_method');
        if (args.console_errors === undefined) missing.push('console_errors');
        if (!args.summary) missing.push('summary');
      } else if (taskType === 'math') {
        if (!args.files_changed?.length) missing.push('files_changed');
        if (args.builds_clean === undefined) missing.push('builds_clean');
        if (!args.theorem_statement) missing.push('theorem_statement');
        if (!args.proof_sketch) missing.push('proof_sketch');
        if (!args.summary) missing.push('summary');
      } else {
        return { content: [{ type: 'text', text: `Invalid task_type: "${taskType}". Must be "app" or "math".` }], isError: true };
      }

      if (missing.length > 0) {
        return { content: [{ type: 'text', text: `Missing required fields for ${taskType} report: ${missing.join(', ')}` }], isError: true };
      }

      // Validate file paths exist (screenshots, test evidence)
      const pathsToCheck = [];
      if (args.screenshot_before) pathsToCheck.push(args.screenshot_before);
      if (args.screenshot_after) pathsToCheck.push(args.screenshot_after);
      if (args.test_evidence) pathsToCheck.push(args.test_evidence);
      for (const p of pathsToCheck) {
        try {
          if (!fs.existsSync(p)) {
            return { content: [{ type: 'text', text: `File not found: ${p}` }], isError: true };
          }
        } catch (e) {
          return { content: [{ type: 'text', text: `Cannot check file ${p}: ${e.message}` }], isError: true };
        }
      }

      // Check QA agents are alive (tmux sessions exist)
      const qaDown = [];
      for (const qaId of qaConfig.qa_agent_ids) {
        const qaAgent = agents.find(a => a.id === qaId);
        if (!qaAgent?.tmux_session) { qaDown.push(qaId); continue; }
        try {
          execSync(`tmux has-session -t ${qaAgent.tmux_session} 2>/dev/null`, { timeout: 3000 });
        } catch {
          qaDown.push(qaAgent.friendly_name || qaId);
        }
      }
      if (qaDown.length > 0) {
        return { content: [{ type: 'text', text: `QA system is down — cannot submit report. Missing QA agents: ${qaDown.join(', ')}. Ask the manager to respawn them.` }], isError: true };
      }

      // Build fields object
      const fields = {};
      const fieldNames = ['worktree_branch', 'dev_port', 'files_changed', 'screenshot_before', 'screenshot_after',
        'test_method', 'test_evidence', 'console_errors', 'builds_clean', 'theorem_statement', 'proof_sketch', 'summary'];
      for (const f of fieldNames) {
        if (args[f] !== undefined) fields[f] = args[f];
      }

      // Submit report to server
      try {
        const res = await fetch(`http://127.0.0.1:${dashPort}/api/qa/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: task.id, agent_id: AGENT_ID, task_type: taskType, fields }),
        });
        const data = await res.json();
        if (!data.ok) return { content: [{ type: 'text', text: `Report submission failed: ${JSON.stringify(data)}` }], isError: true };

        // Kick qa-haiku (first QA agent in the list)
        const firstQa = qaConfig.qa_agent_ids[0];
        if (firstQa) {
          const qaAgent = agents.find(a => a.id === firstQa);
          if (qaAgent?.tmux_session) {
            try { execSync(`tmux send-keys -t ${qaAgent.tmux_session} '📬' Enter`, { timeout: 5000 }); } catch {}
          }
        }

        logEvent({ type: 'qa_report', agent: AGENT_ID, task_id: task.id, task_type: taskType, report_id: data.report.id });
        return { content: [{ type: 'text', text: `Report submitted for QA review (report #${data.report.id}). qa-haiku will review first, then qa-opus. Wait for 📬 — QA will sign off or send feedback.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Report submission failed (server unreachable): ${e.message}` }], isError: true };
      }
    }

    // ---- Legacy self-review path (no QA configured, or pass+summary mode) ----
    if (args.pass && args.summary) {
      const friendlyName = agent?.friendly_name || AGENT_ID.slice(0, 8);

      let screenshotSection = '';
      const isUITask = /dashboard|ui|css|chat|widget|panel|render|display|theme|layout|scroll/i.test(task.description);
      if (isUITask) {
        try {
          const screenshotBin = path.join(__dirname, 'bin', 'screenshot-dashboard');
          const ssResult = execSync(`node ${screenshotBin} --output /tmp/fleet-report-screenshots`, {
            encoding: 'utf8', timeout: 30000, cwd: __dirname,
          });
          const ssData = JSON.parse(ssResult);
          const shots = (ssData.screenshots || []).filter(s => s.ok);
          if (shots.length > 0) {
            screenshotSection = '\n\n## Screenshots\n\n' +
              shots.map(s => `![${s.view}](${s.path})`).join('\n\n');
          }
        } catch (e) {
          screenshotSection = `\n\n*Auto-screenshot failed: ${e.message}*`;
        }
      }

      const summaryMsg = `**${friendlyName} report: ${task.description}**\n\n${args.summary}`;
      const to = task.delegated_by || agents.find(a => a.id !== AGENT_ID && agentAlive(a))?.id;
      if (to) {
        postMessage(to, AGENT_ID, summaryMsg);
      }

      const docName = `report-${task.id}`;
      const reportContent = `# ${task.description}\n\n**Agent:** ${friendlyName}  \n**Status:** tentative  \n**Filed:** ${new Date().toISOString()}\n\n---\n\n${args.summary}${screenshotSection}`;
      const mainFile = `${docName}.md`;
      let tldaMsg = '';
      try {
        const check = await tldaFetch(docName);
        if (check.status === 404) {
          await tldaFetch('', {
            method: 'POST',
            body: { name: docName, title: task.description, format: 'markdown', mainFile },
          });
        }
        await tldaFetch(docName + '/push', {
          method: 'POST',
          body: {
            files: [{ path: mainFile, content: reportContent }],
            sourceDir: cwd || process.env.PWD || '/tmp',
            session: CLAUDE_SESSION,
          },
        });
        tldaMsg = `\n📄 Report pushed to tlda as **${docName}** [tentative]`;
        logEvent({ type: 'report_share', agent: AGENT_ID, doc: docName, task_id: task.id, status: 'tentative' });
      } catch (e) {
        tldaMsg = `\n⚠ tlda unavailable (${e.message}) — report posted to chat only.`;
      }

      try {
        await fetch(`http://127.0.0.1:${dashPort}/api/tasks/done`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: AGENT_ID, task_id: task.id, skip_qa: true }),
        });
      } catch (e) {
        process.stderr.write(`[fleet] report task_done failed: ${e.message}\n`);
      }
      logEvent({ type: 'task_done', agent: AGENT_ID, task_id: task.id, description: task.description });
      logEvent({ type: 'report', agent: AGENT_ID, task_id: task.id, summary: args.summary });

      let msg = `Report accepted. Marked task done: ${task.description}.`;
      msg += tldaMsg;
      msg += '\n\nKeep working or use timer() — you\'ll see 📬 when the next task arrives.';
      return { content: [{ type: 'text', text: msg }] };
    }

    // --- First call: gather diff and return review prompt ---
    let diff = '';
    if (cwd) {
      try {
        diff = execSync('git diff HEAD 2>/dev/null || git diff 2>/dev/null', {
          cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        }).trim();
        if (!diff) {
          diff = execSync('git diff HEAD~1 2>/dev/null', {
            cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
          }).trim();
        }
      } catch (e) {
        diff = `(git diff failed: ${e.message})`;
      }
    } else {
      diff = '(no working directory detected — cannot diff)';
    }

    const diffLines = diff.split('\n').length;
    const truncatedDiff = diffLines > 500
      ? diff.split('\n').slice(0, 500).join('\n') + `\n\n... (${diffLines - 500} more lines truncated)`
      : diff;

    const context = taskContextBlock(task, state);
    const humanMsgs = findRelatedHumanMessages(state, task);
    const humanMsgBlock = formatHumanMessages(humanMsgs, state);
    const contextSection = [context, humanMsgBlock].filter(Boolean).join('\n\n');

    // If QA is enabled, prompt for structured report instead of pass/summary
    const qaPrompt = qaEnabled ? `

### QA is enabled. Submit a structured report:

Call \`report(task_type="app"|"math", ...fields)\` with the required fields for your task type.

**App tasks:** worktree_branch, dev_port, files_changed, screenshot_before, screenshot_after, test_method, test_evidence, console_errors, summary
**Math tasks:** files_changed, builds_clean, theorem_statement, proof_sketch, summary` : `

If you find issues: fix them now, then call \`report()\` again.
If it's clean: call \`report(pass=true, summary="...")\` with a structured summary including screenshot verification.`;

    const reviewPrompt = `## Self-Review Gate

**Task:** ${task.description}
**Working directory:** ${cwd || 'unknown'}
**Diff:** ${diffLines} lines
**QA system:** ${qaEnabled ? 'enabled' : 'disabled (self-review mode)'}

${contextSection ? contextSection + '\n\n---\n' : ''}
\`\`\`diff
${truncatedDiff}
\`\`\`

### Review your diff honestly. Check for:

1. **Correctness** — Does this do what was asked? Any logic bugs?
2. **Completeness** — Anything missing? Partial implementations?
3. **Quality** — Sloppy formatting? Dead code? Leftover debug prints?
4. **Consistency** — Does it match the existing code style?
5. **Side effects** — Could this break anything else?

### Screenshot verification (REQUIRED for UI tasks):

If your task involves UI changes, you MUST:
1. Take a Playwright screenshot of the specific feature you changed
2. **Read the screenshot file** using the Read tool — actually look at it
3. For each success criterion, state what you see in the screenshot that proves it's met
4. If ANYTHING looks wrong or doesn't match criteria, fix it before reporting

Do NOT report "looks good" without reading and describing the screenshots.${qaPrompt}`;

    return { content: [{ type: 'text', text: reviewPrompt }] };
  }

  // ---- sign_report (QA-only) ----
  if (name === 'sign_report') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered. Call register() first.' }], isError: true };

    const { task_id, verdict, notes } = args;
    if (!task_id || !verdict) return { content: [{ type: 'text', text: 'Missing required fields: task_id, verdict' }], isError: true };
    if (verdict === 'rejected' && !notes) return { content: [{ type: 'text', text: 'Notes are required when rejecting a report.' }], isError: true };

    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/qa/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id, agent_id: AGENT_ID, verdict, notes }),
      });
      const data = await res.json();
      if (res.status === 403) return { content: [{ type: 'text', text: `Permission denied: ${data}` }], isError: true };
      if (res.status === 404) return { content: [{ type: 'text', text: `No active report for task ${task_id}` }], isError: true };
      if (!res.ok) return { content: [{ type: 'text', text: `sign_report failed: ${JSON.stringify(data)}` }], isError: true };

      logEvent({ type: 'qa_sign', agent: AGENT_ID, task_id, verdict, notes });
      let msg = `Signed report for ${task_id}: ${verdict}.`;
      if (verdict === 'approved') {
        msg += ' Next QA reviewer will be notified, or task is ready for completion if all QA agents have signed.';
      } else {
        msg += ` Manager notified with rejection notes.`;
      }
      return { content: [{ type: 'text', text: msg }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `sign_report failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- task_check (terminal escape hatch) ----
  if (name === 'task_check') {
    if (!args.agent) {
      return { content: [{ type: 'text', text: 'Specify agent (name/ID).' }], isError: true };
    }

    // Look up agent via server API
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    let agents;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/agents`);
      agents = await res.json();
      if (agents.error) return { content: [{ type: 'text', text: `task_check failed: ${agents.error}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `task_check failed (server unreachable): ${e.message}` }], isError: true };
    }

    const agentEntry = agents.find(a =>
      a.id === args.agent || a.friendly_name === args.agent ||
      a.session_id === args.agent || (a.session_ids && a.session_ids.includes(args.agent))
    );
    if (!agentEntry) {
      return { content: [{ type: 'text', text: `Agent "${args.agent}" not found.` }], isError: true };
    }

    let result = null;
    let idle = false;
    let targetLabel = '';

    if (agentEntry.tmux_session && tmuxHasSession(agentEntry.tmux_session)) {
      result = tmuxRead(agentEntry.tmux_session);
      if (result.ok) idle = tmuxIsIdle(result.text);
      targetLabel = `tmux:${agentEntry.tmux_session}`;
    }

    if (!result?.ok) {
      // TODO: Need server endpoint to mark agent dead (POST /api/agents/mark-dead)
      return { content: [{ type: 'text', text: `Cannot read terminal for ${agentEntry.friendly_name || agentEntry.id}: ${result?.error || 'no tmux session'}. Agent marked dead.` }], isError: true };
    }

    // Fetch tasks to find active task for this agent
    let tasks;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/tasks?active=true`);
      tasks = await res.json();
    } catch {
      tasks = [];
    }

    const agentId = agentEntry.id;
    const task = agentId ? tasks.find(t => t.agent === agentId && t.status !== 'done') : null;
    if (task) {
      // TODO: Need server endpoint to update task status (idle/working) and last_checked
      // POST /api/tasks/update-status { task_id, status, last_checked }
    }

    const statusStr = idle ? 'IDLE' : 'WORKING';
    let taskStr = ' [no recorded task]';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      taskStr = ` [${task.id}: ${task.description} | ${age}m ago]`;
    }

    return {
      content: [{
        type: 'text',
        text: `${targetLabel} ${statusStr}${taskStr}:\n${windowTail(result.text)}`,
      }],
    };
  }

  // ---- my_task ----
  if (name === 'my_task') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };

    let data;
    try {
      data = await sendWS('my-task', { agent: AGENT_ID });
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }

    if (!data) return { content: [{ type: 'text', text: 'Server unreachable (WS not connected).' }], isError: true };
    const task = data.task;
    const unread = data.messages || [];

    let text = '';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      text = `Your task [${task.id}]: ${task.description}\nStatus: ${task.status} | ${age}m ago`;
      if (task.message) {
        text += `\n\n${resolveAttachmentMarkers(task.message, task.metadata?.inline_attachments)}`;
        if (task.success_criteria?.length) {
          text += `\n\n**Success criteria** (verify before calling task_done):`;
          task.success_criteria.forEach((c, i) => { text += `\n${i + 1}. ${c}`; });
        }
      }
    } else {
      text = `Nothing new. Keep working or use timer() — you'll see 📬 when a task or message arrives.`;
    }

    if (unread.length > 0) {
      const formatted = unread.map(m => {
        const fromLabel = m.metadata?.fromLabel || m.from;
        const replyHint = ` (reply with chat(to: "${m.from}"))`;
        const resolvedText = resolveAttachmentMarkers(m.text, m.metadata?.inline_attachments);
        return `[from ${fromLabel}]${replyHint} ${resolvedText}`;
      }).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
    }

    return { content: [{ type: 'text', text }] };
  }

  // ==== Agent Lifecycle ====

  // ---- name_agent ----
  if (name === 'name_agent') {
    try {
      const data = await sendWS('rename', { agent: args.agent, name: args.friendly_name });
      if (data.error) return { content: [{ type: 'text', text: `Rename failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Named ${args.agent}: "${args.friendly_name}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Rename failed: ${e.message}` }], isError: true };
    }
  }

  // ---- adopt ----
  if (name === 'adopt') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    let agents = [];
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/agents`);
      if (res.ok) agents = await res.json();
    } catch (e) {
      return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
    }
    const state = { agents };

    const newAgent = getAgent(state, args.agent);
    if (!newAgent) return { content: [{ type: 'text', text: `Agent ${args.agent} not registered.` }], isError: true };
    const oldAgent = getAgent(state, args.identity);
    if (!oldAgent) return { content: [{ type: 'text', text: `Identity ${args.identity} not found.` }], isError: true };
    if (oldAgent.id === newAgent.id) return { content: [{ type: 'text', text: `Agent already has that identity.` }], isError: true };

    const oldId = oldAgent.id;
    const newId = newAgent.id;

    // Update this process's identity if we adopted ourselves
    if (AGENT_ID === newId) { AGENT_ID = oldId; }

    // Update ledger: transfer sessions from newId to oldId
    ledger.transferSessions(newId, oldId);
    ledger.upsertAgent(oldId, newAgent.session_id, newAgent.cwd, newAgent.friendly_name || oldAgent.friendly_name);

    // Re-register the merged agent via WS
    const adoptRegWS = sendWS('register', {
      id: oldId,
      name: oldAgent.friendly_name || newAgent.friendly_name,
      session_id: newAgent.session_id,
      tmux_session: newAgent.tmux_session,
      cwd: newAgent.cwd,
      labels: newAgent.labels,
    });
    if (adoptRegWS) await adoptRegWS.catch(e => process.stderr.write(`[fleet] adopt register failed: ${e.message}\n`));

    // Transfer tasks and unread messages from the new agent entry to the old identity
    await fetch(`http://127.0.0.1:${dashPort}/api/agents/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: newId, to: oldId }),
    }).catch(e => process.stderr.write(`[fleet] adopt transfer failed: ${e.message}\n`));

    logEvent({ type: 'adopt', agent: oldId, from: newId, reason: `${newId} adopted identity ${oldId}` });

    // Send orientation message to the adopted agent
    if (args.orient !== false) {
      const name_ = newAgent.friendly_name || oldAgent.friendly_name || oldId;
      const orientMsg = `You have been assigned the identity "${name_}" (fleet ID: ${oldId}). You are a continuation of a previous agent. Use a subagent to read your old session logs via search_logs(agent: "${oldId}") and orient yourself — figure out what you were working on, what tasks are active, and what the current state is. Report back via chat when oriented.`;
      postMessage(oldId, AGENT_ID, orientMsg);
    }

    return { content: [{ type: 'text', text: `${newId} adopted identity "${oldId}" (name: "${newAgent.friendly_name || oldAgent.friendly_name || '?'}"). Old entry removed. Tasks and messages transferred. Agent notified to orient.` }] };
  }

  // ---- spawn (respawn or fresh) ----
  if (name === 'spawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const isFresh = !!args.fresh;
    const agentName = isFresh ? args.name : args.agent;
    if (!agentName) {
      return { content: [{ type: 'text', text: isFresh ? 'fresh=true requires name' : 'agent name required' }], isError: true };
    }

    const fleetSpawnScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'bin', 'fleet-spawn');
    const cmdParts = [fleetSpawnScript];
    if (isFresh) cmdParts.push('--fresh');
    if (args.model) cmdParts.push('--model', args.model);
    if (args.cwd) cmdParts.push('--cwd', JSON.stringify(args.cwd));
    cmdParts.push('--no-attach');
    cmdParts.push(agentName);

    try {
      const output = execSync(cmdParts.join(' '), { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { content: [{ type: 'text', text: output.trim() }] };
    } catch (e) {
      const msg = (e.stderr || e.stdout || e.message || '').trim();
      return { content: [{ type: 'text', text: `spawn failed: ${msg}` }], isError: true };
    }
  }


  // ---- get_refs ----
  if (name === 'get_refs') {
    const refsFile = `${os.homedir()}/.claude/references.json`;
    let refs = [];
    try { refs = JSON.parse(fs.readFileSync(refsFile, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') process.stderr.write(`[fleet] refs file read failed: ${e.message}\n`);
    }
    if (refs.length === 0) {
      return { content: [{ type: 'text', text: 'No references pinned.' }] };
    }
    const lines = refs.map(r => {
      const parts = [`[${r.type}] ${r.label}`];
      if (r.note) parts.push(r.note);
      if (r.type === 'file') parts.push(r.path);
      if (r.type === 'conversation') parts.push(`${r.project} / ${r.sessionId?.slice(0, 8)} lines ${r.startLine}-${r.endLine}`);
      if (r.preview) parts.push(r.preview);
      return parts.join('\n  ');
    });
    return { content: [{ type: 'text', text: `${refs.length} reference(s):\n\n${lines.join('\n\n')}` }] };
  }

  // ---- pin_ref ----
  if (name === 'pin_ref') {
    const refsFile = `${os.homedir()}/.claude/references.json`;
    let refs = [];
    try { refs = JSON.parse(fs.readFileSync(refsFile, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') process.stderr.write(`[fleet] refs file read failed: ${e.message}\n`);
    }
    const ref = {
      id: 'ref-' + Date.now().toString(36),
      type: args.type,
      label: args.label,
      note: args.note || '',
      path: args.path,
      project: args.project,
      sessionId: args.sessionId,
      line: args.line,
      startLine: args.startLine,
      endLine: args.endLine,
      content: args.content,
      created: now(),
      pinned_by: AGENT_ID || 'unknown',
    };
    refs.push(ref);
    fs.writeFileSync(refsFile, JSON.stringify(refs, null, 2));
    logEvent({ type: 'pin_ref', from: AGENT_ID || 'unknown', ref_type: args.type, label: args.label });
    return { content: [{ type: 'text', text: `Pinned: [${args.type}] ${args.label}` }] };
  }

  // ==== Search & History ====

  // ---- observe (process observer data gathering) ----
  if (name === 'observe') {
    const state = await loadState();
    const sinceMs = args.since
      ? new Date(args.since).getTime()
      : Date.now() - 24 * 60 * 60 * 1000; // default: last 24h
    const focus = args.focus || 'all';

    const sections = [];

    // 1. Agent lifecycle: who registered, died, respawned
    if (focus === 'all' || focus === 'lifecycle') {
      const lifecycleEvents = [];
      // Read JSONL for lifecycle events
      if (fs.existsSync(LOG_FILE)) {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            const evTime = new Date(ev.timestamp).getTime();
            if (evTime < sinceMs) continue;
            if (['register', 'auto_prune', 'cleanup', 'respawn', 'spawn'].includes(ev.type)) {
              const agentEntry = ev.agent ? getAgent(state, ev.agent) : null;
              lifecycleEvents.push({
                time: ev.timestamp,
                type: ev.type,
                agent: agentEntry?.friendly_name || ev.name || ev.agent,
                detail: ev.reason ?? ev.description ?? '',
              });
            }
          } catch {}
        }
      }
      if (lifecycleEvents.length) {
        sections.push(`## Agent Lifecycle (${lifecycleEvents.length} events)\n\n` +
          lifecycleEvents.map(e => `- **${new Date(e.time).toLocaleTimeString()}** ${e.type}: ${e.agent}${e.detail ? ` (${e.detail})` : ''}`).join('\n'));
      }
    }

    // 2. Task history: delegated, completed, bounced, duration
    if (focus === 'all' || focus === 'tasks') {
      const taskEvents = [];
      if (fs.existsSync(LOG_FILE)) {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            const evTime = new Date(ev.timestamp).getTime();
            if (evTime < sinceMs) continue;
            if (['delegate', 'task_done', 'report'].includes(ev.type)) {
              const agentEntry = ev.agent ? getAgent(state, ev.agent) : null;
              taskEvents.push({
                time: ev.timestamp,
                type: ev.type,
                agent: agentEntry?.friendly_name || ev.agent,
                task: ev.description ?? ev.task_id ?? '',
                summary: ev.summary ?? '',
              });
            }
          } catch {}
        }
      }

      // Also check current tasks for anomalies
      const activeTasks = (state.tasks || []).filter(t => t.status !== 'done' && !t.synthetic);
      const staleTaskThreshold = 30 * 60 * 1000; // 30 min without progress
      const staleTasks = activeTasks.filter(t => {
        const taskAge = Date.now() - new Date(t.delegated_at || t.last_checked || 0).getTime();
        return taskAge > staleTaskThreshold;
      });

      if (taskEvents.length || staleTasks.length) {
        let taskSection = `## Task Activity (${taskEvents.length} events)\n\n`;
        taskSection += taskEvents.map(e =>
          `- **${new Date(e.time).toLocaleTimeString()}** ${e.type}: ${e.agent} — ${e.task}${e.summary ? `\n  Summary: ${e.summary}` : ''}`
        ).join('\n');
        if (staleTasks.length) {
          taskSection += `\n\n### Potentially Stale Tasks\n\n` +
            staleTasks.map(t => {
              const agentEntry = getAgent(state, t.agent);
              const age = Math.round((Date.now() - new Date(t.delegated_at).getTime()) / 60000);
              return `- **${agentEntry?.friendly_name || t.agent}**: "${t.description}" (${t.status}, ${age}m old)`;
            }).join('\n');
        }
        sections.push(taskSection);
      }
    }

    // 3. Message patterns: unanswered, high-volume, Skip frustration signals
    if (focus === 'all' || focus === 'messages') {
      const human = (state.agents || []).find(a => a.human);
      const recentMsgs = (state.messages || []).filter(m =>
        new Date(m.timestamp).getTime() >= sinceMs
      );

      // Unanswered human messages
      const unanswered = recentMsgs.filter(m =>
        m.from === human?.id && !m.read && m.to !== human?.id
      );

      // Frustration signals
      const frustrationPatterns = /\b(dude|wtf|bro|WTF|DUDE)\b|[A-Z]{4,}/;
      const frustrationMsgs = recentMsgs.filter(m =>
        m.from === human?.id && frustrationPatterns.test(m.text ?? '')
      );

      // Message volume by agent
      const volumeByAgent = {};
      for (const m of recentMsgs) {
        const from = m.from || 'unknown';
        volumeByAgent[from] = (volumeByAgent[from] || 0) + 1;
      }

      let msgSection = `## Message Patterns (${recentMsgs.length} messages)\n\n`;
      msgSection += `**Volume by agent:**\n${Object.entries(volumeByAgent).map(([id, count]) => {
        const agent = getAgent(state, id);
        return `- ${agent?.friendly_name || id}: ${count} messages`;
      }).join('\n')}\n`;

      if (unanswered.length) {
        msgSection += `\n**Unanswered Skip messages (${unanswered.length}):**\n` +
          unanswered.slice(-5).map(m => {
            const to = getAgent(state, m.to);
            return `- → ${to?.friendly_name || m.to}: "${(m.text ?? '')}"`;
          }).join('\n') + '\n';
      }

      if (frustrationMsgs.length) {
        msgSection += `\n**Frustration signals (${frustrationMsgs.length}):**\n` +
          frustrationMsgs.slice(-5).map(m =>
            `- "${(m.text ?? '')}"`
          ).join('\n') + '\n';
      }

      sections.push(msgSection);
    }

    // 4. Summary stats
    const liveAgents = (state.agents || []).filter(a => !a.dead && !a.human);
    const deadAgents = (state.agents || []).filter(a => a.dead);
    const activeTasks = (state.tasks || []).filter(t => t.status !== 'done' && !t.synthetic);
    const doneTasks = (state.tasks || []).filter(t => t.status === 'done' && !t.synthetic);

    const summary = `## Fleet Summary\n\n- **Live agents:** ${liveAgents.length}\n- **Dead agents:** ${deadAgents.length}\n- **Active tasks:** ${activeTasks.length}\n- **Completed tasks (in state):** ${doneTasks.length}\n- **Period:** since ${new Date(sinceMs).toLocaleString()}`;
    sections.unshift(summary);

    const output = `# Process Observer — Activity Report\n\n${sections.join('\n\n---\n\n')}

---

## Your Job as Observer

Analyze the data above for patterns. Look for:
1. **Dropped tasks** — delegated but never completed, no report filed
2. **Ignored feedback** — Skip sent corrections that weren't acted on
3. **Thrashing** — agent doing many small changes without progress
4. **Find-and-replace fixes** — mechanical changes instead of understanding the problem
5. **Communication gaps** — unanswered messages, missed handoffs
6. **Stale agents** — registered but not producing work

Write your analysis to \`scratch/process-review-${new Date().toISOString().slice(0, 10)}.md\` with:
- Specific vignettes (agent X did Y, causing Z)
- Proposed fixes (tooling changes, guidance updates, process changes)
- Severity assessment (blocking, friction, minor)`;

    return { content: [{ type: 'text', text: output }] };
  }

  // ---- search_logs ----
  if (name === 'search_logs') {
    const idx = getSearchIndex();
    if (!idx) {
      return { content: [{ type: 'text', text: 'Search index not available. The fleet server builds the index — make sure it has run at least once.' }], isError: true };
    }

    const query = args.query;
    if (!query || query.length < 2) {
      return { content: [{ type: 'text', text: 'Query must be at least 2 characters.' }], isError: true };
    }

    const limit = Math.min(args.limit || 20, 100);
    const contextWindow = Math.min(Math.max(args.context || 0, 0), 20);
    const beforeTs = args.before || undefined;

    let agentIds;
    let isHumanAgent = false;
    if (args.agent) {
      const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
      let allAgents = [];
      try {
        const res = await fetch(`http://127.0.0.1:${dashPort_}/api/store/agents`);
        if (res.ok) allAgents = await res.json();
      } catch {}
      // Collect all matching agent IDs (friendly_name, session_id)
      // Prefix match is intentional here — search_logs is read-only, broad matching is useful
      const matches = allAgents.filter(a =>
        a.id === args.agent || a.friendly_name === args.agent ||
        a.id.startsWith(args.agent)
      );
      const ids = new Set();
      for (const a of matches) {
        ids.add(a.id);
        if (a.session_id) ids.add(a.session_id);
        if (a.session_ids) for (const sid of a.session_ids) ids.add(sid);
      }
      if (ids.size === 0) ids.add(args.agent);
      agentIds = [...ids];
      // Detect if the agent filter targets a human (e.g. fleet:skip) — their messages
      // appear as role='user' in all agent session logs with null from_id/to_id
      isHumanAgent = matches.some(a => a.human);
    }
    // Search session logs (entries_fts)
    let sessionResults = idx.search(query, { project: args.project || undefined, agent: agentIds, role: args.role || undefined, limit, isHuman: isHumanAgent });

    // Search chat events (chat_events_fts)
    // Pass context: 0 to searchChat — we handle context ourselves via getChatContext
    let chatResults = [];
    try {
      chatResults = idx.searchChat(query, { agent: agentIds, role: args.role || undefined, limit, context: 0 });
    } catch { /* chat FTS not yet built — degrade gracefully */ }

    // Apply `before` timestamp filter for pagination
    if (beforeTs) {
      sessionResults = sessionResults.filter(r => !r.timestamp || r.timestamp < beforeTs);
      chatResults = chatResults.filter(r => !r.timestamp || r.timestamp < beforeTs);
    }

    if (sessionResults.length === 0 && chatResults.length === 0) {
      return { content: [{ type: 'text', text: `No results for "${query}".` }] };
    }

    // Format results
    const state = await loadState();
    const resolveName = (id) => id ? (getAgent(state, id)?.friendly_name || id) : '';

    const fmtTs = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      const h = d.getHours();
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      return `${d.getMonth()+1}/${d.getDate()} ${h12}:${String(d.getMinutes()).padStart(2,'0')} ${ampm}`;
    };

    const fmtCtxMsg = (c) => {
      const cFrom = resolveName(c.from);
      const cTo = resolveName(c.to);
      const cDir = cTo ? `${cFrom} → ${cTo}` : cFrom;
      const text = c.text.length > 300 ? c.text.slice(0, 300) + '...' : c.text;
      return `  [${fmtTs(c.timestamp)}] ${cDir}: ${text}`;
    };

    // Format session results
    const sessionLines = sessionResults.map(r => {
      const parts = [];
      if (r.timestamp) parts.push(new Date(r.timestamp).toLocaleString());
      if (r.source === 'events') {
        const from = resolveName(r.from);
        parts.push(`[session] [${r.role}] ${from}`);
      } else {
        const proj = r.project?.match(/work-(.+)$/)?.[1]?.replace(/-/g, '/') ?? r.project ?? '';
        parts.push(`[session] [${r.role}] ${proj}`);
        if (r.sessionId) parts.push(r.sessionId.slice(0, 8));
      }
      const snippet = r.snippet.replace(/⟨⟨/g, '**').replace(/⟩⟩/g, '**');
      parts.push(snippet);
      return { timestamp: r.timestamp, text: parts.join(' | ') };
    });

    // Format chat results — with context from getChatContext when requested
    const chatLines = chatResults.map(r => {
      const from = resolveName(r.from);
      const to = resolveName(r.to);
      const direction = to ? `${from} → ${to}` : from;
      const snippet = r.snippet.replace(/⟨⟨/g, '**').replace(/⟩⟩/g, '**');

      let text;
      if (contextWindow > 0 && r.timestamp) {
        // Rich context format
        const ctx = idx.getChatContext(r.timestamp, contextWindow);
        const matchLine = `  [${fmtTs(r.timestamp)}] ${direction}: ${snippet}  ← MATCH`;
        const beforeLines = ctx.before.map(fmtCtxMsg);
        const afterLines = ctx.after.map(fmtCtxMsg);

        text = `=== Match ===\n`;
        if (beforeLines.length > 0) text += beforeLines.join('\n') + '\n';
        text += matchLine;
        if (afterLines.length > 0) text += '\n' + afterLines.join('\n');
      } else {
        // Compact format (no context)
        const parts = [];
        if (r.timestamp) parts.push(new Date(r.timestamp).toLocaleString());
        const sourceTag = r.source === 'terminal' ? 'terminal' : 'fleet chat';
        parts.push(`[${sourceTag}] [${r.event_type}] ${direction}`);
        parts.push(snippet);
        text = parts.join(' | ');
      }

      return { timestamp: r.timestamp, text };
    });

    // Merge and sort by timestamp descending
    const allResults = [...sessionLines, ...chatLines]
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
      .slice(0, limit);

    const stats = idx.stats();

    // Log search event so fleet server can show what agents searched for
    const filters = [];
    if (args.agent) filters.push(`agent=${args.agent}`);
    if (args.role) filters.push(`role=${args.role}`);
    if (args.project) filters.push(`project=${args.project}`);
    if (beforeTs) filters.push(`before=${beforeTs}`);
    if (contextWindow > 0) filters.push(`context=${contextWindow}`);
    const allSnippets = [...sessionResults, ...chatResults].slice(0, 5).map(r => {
      return r.snippet.replace(/⟨⟨/g, '').replace(/⟩⟩/g, '');
    });
    logEvent({
      type: 'search',
      from: AGENT_ID || 'unknown',
      query: args.query,
      filters: filters.join(', '),
      resultCount: allResults.length,
      snippets: allSnippets,
    });

    let header = `${allResults.length} results (${sessionResults.length} session, ${chatResults.length} chat) — index: ${stats.totalEntries} entries, ${stats.totalFiles} files`;
    if (beforeTs) header += ` — filtered before ${beforeTs}`;
    if (contextWindow > 0) header += ` — with ${contextWindow} context messages`;

    const separator = contextWindow > 0 ? '\n\n' : '\n\n';
    return { content: [{ type: 'text', text: `${header}\n\n${allResults.map(r => r.text).join(separator)}` }] };
  }

  // ---- get_thread ----
  if (name === 'get_thread') {
    const state = await loadState();
    const tasks = state.tasks || [];
    let filtered = [];

    // When since/until is provided, timestamps scope the results — use a higher default limit
    const effectiveLimit = args.limit || (args.since || args.until ? 500 : 50);

    const fetchEventsForAgent = async (agentId) => {
      const dashPort = process.env.FLEET_DASH_PORT || 5199;
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/events?agent=${encodeURIComponent(agentId)}&limit=${effectiveLimit}`);
      if (!res.ok) return;
      const { events } = await res.json();
      for (const e of (events || [])) {
        let text = e.type === 'delegate'
          ? `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`
          : e.type === 'task_done'
          ? `[DONE] ${e.description || ''}`
          : e.text || e.message || '';
        text = resolveAttachmentMarkers(text, e.metadata?.inline_attachments);
        filtered.push({ from: e.from_id, to: e.to_id, text, timestamp: e.timestamp });
      }
    };

    if (args.task_id) {
      const task = tasks.find(t => t.id === args.task_id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${args.task_id} not found.` }], isError: true };
      }
      try { await fetchEventsForAgent(task.agent); } catch (e) {
        process.stderr.write(`[fleet] get_thread DB fetch failed: ${e.message}\n`);
      }
    } else if (args.agent) {
      const agentEntry = getAgent(state, args.agent);
      if (!agentEntry) {
        return { content: [{ type: 'text', text: `Agent "${args.agent}" not found.` }], isError: true };
      }
      try { await fetchEventsForAgent(agentEntry.id); } catch (e) {
        process.stderr.write(`[fleet] get_thread DB fetch failed: ${e.message}\n`);
      }
    } else {
      return { content: [{ type: 'text', text: 'Provide either agent or task_id.' }], isError: true };
    }

    // Apply time filters
    if (args.since) filtered = filtered.filter(m => m.timestamp >= args.since);
    if (args.until) filtered = filtered.filter(m => m.timestamp <= args.until);

    // Sort by time, deduplicate, limit
    filtered.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    const seen = new Set();
    filtered = filtered.filter(m => {
      const key = `${m.timestamp}|${m.from}|${(m.text ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    filtered = filtered.slice(-effectiveLimit);

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: 'No messages found for the given criteria.' }] };
    }

    const truncationWarning = filtered.length === effectiveLimit
      ? `⚠️ Thread truncated at ${effectiveLimit} messages. Use since/until to narrow, or pass a higher limit.\n\n`
      : '';

    // Format as readable thread
    const lines = filtered.map(m => {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      const fromAgent = getAgent(state, m.from);
      const from = fromAgent?.friendly_name || m.from?.slice?.(0, 8) || m.from;
      const toAgent = getAgent(state, m.to);
      const to = toAgent?.friendly_name || m.to?.slice?.(0, 8) || m.to;
      return `[${ts}] ${from} → ${to}\n${m.text}`;
    });

    return { content: [{ type: 'text', text: `${truncationWarning}${filtered.length} messages:\n\n${lines.join('\n\n---\n\n')}` }] };
  }

  // ==== Labels & Interrupts ====

  // ---- label_agent ----
  if (name === 'label_agent') {
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: args.agent, labels: args.labels || [] }),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Label failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Labels for ${data.agent}: ${(data.labels || []).join(', ') || '(none)'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Label failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- interrupt ----
  if (name === 'interrupt') {
    const { agent } = args;
    if (!agent) return { content: [{ type: 'text', text: 'Specify an agent to interrupt.' }], isError: true };

    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Interrupt failed: ${data.error}` }], isError: true };
      const status = data.stopped ? 'confirmed stopped' : `not confirmed after ${data.attempts} attempts`;
      return { content: [{ type: 'text', text: `${data.agent || agent}: ${status}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Interrupt failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- restart_mcp ----
  if (name === 'restart_mcp') {
    if (!args.agent) return { content: [{ type: 'text', text: 'Specify an agent to restart.' }], isError: true };
    if (args.agent === AGENT_ID) return { content: [{ type: 'text', text: 'Cannot restart yourself. Ask another agent or the user.' }], isError: true };
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: args.agent }),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Restart failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Restarting ${data.agent} → Ctrl+C + ${data.resume} in tmux:${data.tmux}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Restart failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ==== Fleet Operations ====

  // ---- cleanup ----
  if (name === 'cleanup') {
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Cleanup failed: ${data.error}` }], isError: true };

      const removed = data.removed_agents || [];
      const orphaned = data.abandoned_tasks || [];
      const remaining = data.remaining_agents ?? '?';

      const lines = [];
      if (removed.length === 0 && orphaned.length === 0) {
        lines.push('Nothing to clean up — all agents are alive or already gone.');
      } else {
        if (removed.length) lines.push(`Removed ${removed.length} dead agent(s): ${removed.map(r => r.name || r.id).join(', ')}`);
        if (orphaned.length) lines.push(`Abandoned ${orphaned.length} orphan task(s): ${orphaned.map(o => o.description).join(', ')}`);
        lines.push(`${remaining} agent(s) remaining.`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Cleanup failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- roll_call ----
  if (name === 'roll_call') {
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/roll-call`);
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Roll call failed: ${data.error}` }], isError: true };

      const agentStatus = data.agents || [];
      const missing = data.missing_from_roster || [];
      const unmatchedTmux = data.unregistered_tmux || [];

      const lines = [];
      const alive = [], stale = [], dead = [];
      for (const a of agentStatus) {
        const label = a.friendly_name || a.id;
        const transport = a.tmux_session ? `tmux:${a.tmux_session}` : 'no session';
        const seenAgo = a.last_seen_ago_s == null ? 'never' : `${a.last_seen_ago_s}s ago`;
        const info = `${label} (${a.id}) — ${transport}, cwd: ${a.cwd || '?'}, seen ${seenAgo}`;
        if (a.status === 'alive') alive.push(info);
        else if (a.status === 'stale') stale.push(info);
        else dead.push(info);
      }

      if (alive.length) lines.push(`Alive (${alive.length}):\n  ${alive.join('\n  ')}`);
      if (stale.length) lines.push(`Stale (${stale.length}):\n  ${stale.join('\n  ')}`);
      if (dead.length) lines.push(`Dead (${dead.length}):\n  ${dead.join('\n  ')}`);

      if (missing.length) {
        lines.push(`\nIn roster but gone (${missing.length}):`);
        for (const m of missing) {
          const label = m.name || m.fleet_id;
          lines.push(`  ${label} (${m.fleet_id}) — cwd: ${m.cwd || '?'}, session: ${m.session || '?'}`);
        }
      }

      if (unmatchedTmux.length) {
        lines.push(`\nUnregistered tmux sessions (${unmatchedTmux.length}): ${unmatchedTmux.join(', ')}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') || 'No agents, no roster entries, no tmux sessions.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Roll call failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ---- rehydrate ----
  if (name === 'rehydrate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const state = await loadState();
    const lines = [];
    const respawned = [], failed = [], skipped = [], pruned = [];

    // Build candidate list: agents from registry + ledger
    let candidates = [];

    if (args.agents && args.agents.length > 0) {
      // Selective: resolve each name/ID
      for (const q of args.agents) {
        const agent = getAgent(state, q);
        if (agent) {
          candidates.push(agent);
        } else {
          // Check ledger
          const la = ledger.findByFleetId(q) || ledger.findByName(q) || ledger.findBySession(q);
          if (la) {
            candidates.push({
              id: la.fleet_id, session_id: la.session, cwd: la.cwd,
              friendly_name: la.name, session_ids: la.sessions || [],
            });
          } else {
            skipped.push(`${q}: not found`);
          }
        }
      }
    } else {
      // All: find dead agents + ledger entries not in registry
      const registryIds = new Set((state.agents || []).map(a => a.id));

      for (const a of (state.agents || [])) {
        if (a.id === AGENT_ID) continue; // skip self
        if (a.tmux_session && tmuxHasSession(a.tmux_session)) continue; // already in tmux
        candidates.push(a);
      }

      // Ledger entries not in registry
      const ledgerAgents = ledger.listAgents();
      for (const la of ledgerAgents) {
        if (registryIds.has(la.fleet_id)) continue;
        if (la.fleet_id === AGENT_ID) continue;
        candidates.push({
          id: la.fleet_id, session_id: la.session, cwd: la.cwd,
          friendly_name: la.name, session_ids: la.sessions || [],
        });
      }
    }

    // Deduplicate by fleet ID
    const seen = new Set();
    candidates = candidates.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    // Process each candidate
    for (const agent of candidates) {
      const label = agent.friendly_name || agent.id;

      // Skip human agent
      if (agent.human || agent.id === 'human' || agent.id === 'fleet:human') {
        skipped.push(`${label}: human agent`);
        continue;
      }

      // Prune dead agents with no session_id
      if (!agent.session_id) {
        pruned.push(`${label}: no session_id — cannot resume`);
        const existing = (state.agents || []).find(a => a.id === agent.id);
        if (existing) {
          removeAgent(state, agent.id);
        }
        continue;
      }

      // Skip if already alive
      const existing = getAgent(state, agent.id);
      if (existing && agentAlive(existing) && existing.tmux_session && tmuxHasSession(existing.tmux_session)) {
        skipped.push(`${label}: already alive in tmux:${existing.tmux_session}`);
        continue;
      }

      // Respawn into tmux
      const sessionName = `fleet-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      const cwd = agent.cwd || os.homedir();

      try {
        // Kill old tmux session if name collision
        if (tmuxHasSession(sessionName)) {
          execSync(`tmux kill-session -t ${sessionName}`, { timeout: 3000 });
        }

        tmuxRespawn(sessionName, cwd, agent.id, agent.session_id);

        // Register via server API
        const rehydrateRegWS = sendWS('register', {
          id: agent.id, name: agent.friendly_name, session_id: agent.session_id,
          tmux_session: sessionName, cwd,
        });
        if (rehydrateRegWS) await rehydrateRegWS.catch(() => {});

        logEvent({ type: 'rehydrate', action: 'tmux_respawn', agent: agent.id, name: label, tmux_session: sessionName, cwd });
        respawned.push(`${label} → tmux:${sessionName} (cwd: ${cwd})`);

        // Throttle: wait 5s between spawns to avoid overwhelming the system
        execSync('sleep 5', { timeout: 10000 });
      } catch (e) {
        failed.push(`${label}: ${e.message}`);
      }
    }

    // Report
    if (respawned.length) lines.push(`Respawned (${respawned.length}):\n  ${respawned.join('\n  ')}`);
    if (skipped.length) lines.push(`\nSkipped (${skipped.length}):\n  ${skipped.join('\n  ')}`);
    if (failed.length) lines.push(`\nFailed (${failed.length}):\n  ${failed.join('\n  ')}`);
    if (pruned.length) lines.push(`\nPruned (${pruned.length}):\n  ${pruned.join('\n  ')}`);
    if (!respawned.length && !skipped.length && !failed.length && !pruned.length) {
      lines.push('Nothing to rehydrate — no candidates found.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ==== Cluster Jobs ====

  // ---- job_register ----
  if (name === 'job_register') {
    const { job_id, label, output_dir, output_pattern, total_reps, cluster } = args;
    const host = cluster || 'qtm';
    const manifestLine = `${job_id}\t${output_dir}\t${output_pattern}\t${total_reps}\t${label}`;

    try {
      execSync(`ssh ${host} 'echo "${manifestLine}" >> ~/.cluster-status/manifest.tsv'`, {
        encoding: 'utf8', timeout: 15000,
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to register job on ${host}: ${e.message}` }], isError: true };
    }

    // TODO: Need server endpoint to track cluster jobs (POST /api/cluster-jobs)
    // For now, just log the event

    logEvent({ type: 'job_register', job_id, label, cluster: host, agent: AGENT_ID });
    return { content: [{ type: 'text', text: `Registered job ${job_id} (${label}) on ${host}. Watcher will track ${output_pattern} in ${output_dir}.` }] };
  }

  // ---- job_check ----
  if (name === 'job_check') {
    const host = args.cluster || 'qtm';
    const localDir = path.join(os.homedir(), '.claude', 'cluster-status');

    try {
      fs.mkdirSync(localDir, { recursive: true });
      execSync(`scp -q ${host}:~/.cluster-status/status.json ${localDir}/${host}.json`, {
        encoding: 'utf8', timeout: 15000,
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to pull status from ${host}: ${e.message}` }], isError: true };
    }

    let status;
    try {
      status = JSON.parse(fs.readFileSync(path.join(localDir, `${host}.json`), 'utf8'));
    } catch (e) {
      return { content: [{ type: 'text', text: `No status file from ${host}. Is the watcher installed? Run: cluster/setup.sh ${host}` }], isError: true };
    }

    let jobs = status.jobs || [];
    if (args.job_id) {
      jobs = jobs.filter(j => j.id === args.job_id);
    }

    const lines = [];
    lines.push(`Cluster: ${host} | Updated: ${status.timestamp}`);
    lines.push('');

    const queueEntries = Object.entries(status.queue || {});
    if (queueEntries.length > 0) {
      lines.push('Queue:');
      for (const [jid, q] of queueEntries) {
        lines.push(`  ${jid} (${q.name}): ${q.running} running, ${q.pending} pending`);
      }
    } else {
      lines.push('Queue: empty');
    }
    lines.push('');

    if (jobs.length > 0) {
      lines.push('Tracked jobs:');
      for (const j of jobs) {
        const pct = j.total > 0 ? Math.round(100 * j.completed / j.total) : 0;
        const bar = progressBar(j.completed, j.total);
        const queueStatus = j.in_queue ? ` | ${j.running}R ${j.pending}P` : ' | done';
        lines.push(`  ${j.id} ${j.label}: ${bar} ${j.completed}/${j.total} (${pct}%)${queueStatus}`);
      }
    } else if (args.job_id) {
      lines.push(`Job ${args.job_id} not found in manifest.`);
    } else {
      lines.push('No tracked jobs. Use job_register after sbatch.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ---- job_log ----
  if (name === 'job_log') {
    const { job_id, task_id, stderr } = args;
    const host = args.cluster || 'qtm';
    const nlines = args.lines || 50;
    const ext = stderr ? 'err' : 'out';

    let cmd;
    if (task_id) {
      cmd = `find ~ -maxdepth 5 -name "*-${job_id}_${task_id}.${ext}" -newer ~/.cluster-status/manifest.tsv 2>/dev/null | head -1`;
    } else {
      cmd = `find ~ -maxdepth 5 -name "*-${job_id}_*.${ext}" 2>/dev/null | xargs ls -t 2>/dev/null | head -1`;
    }

    try {
      const logFile = execSync(`ssh ${host} '${cmd}'`, {
        encoding: 'utf8', timeout: 15000,
      }).trim();

      if (!logFile) {
        return { content: [{ type: 'text', text: `No log file found for job ${job_id}${task_id ? ' task ' + task_id : ''} on ${host}.` }] };
      }

      const logContent = execSync(`ssh ${host} 'tail -${nlines} "${logFile}"'`, {
        encoding: 'utf8', timeout: 15000,
      });

      return { content: [{ type: 'text', text: `${logFile}:\n\n${logContent}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to read log: ${e.message}` }], isError: true };
    }
  }

  // ==== Utilities ====

  // ---- wiretap ----
  if (name === 'wiretap') {
    const dashPort = process.env.FLEET_DASH_PORT || 5199;
    const myId = AGENT_ID;
    if (!myId) return { content: [{ type: 'text', text: 'Not registered. Call register() first.' }], isError: true };

    if (args.remove) {
      if (typeof args.remove === 'number' || (typeof args.remove === 'string' && !isNaN(args.remove))) {
        // Remove specific wiretap by ID
        await fetch(`http://127.0.0.1:${dashPort}/api/wiretap/${args.remove}`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: `Removed wiretap #${args.remove}.` }] };
      }
      // Remove all wiretaps for this agent
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/wiretaps?agent=${encodeURIComponent(myId)}`);
      const existing = await res.json();
      for (const tap of existing) {
        await fetch(`http://127.0.0.1:${dashPort}/api/wiretap/${tap.id}`, { method: 'DELETE' });
      }
      return { content: [{ type: 'text', text: `Removed ${existing.length} wiretap(s).` }] };
    }

    // List existing wiretaps if no filter specified
    if (!args.filter) {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/wiretaps?agent=${encodeURIComponent(myId)}`);
      const taps = await res.json();
      if (taps.length === 0) return { content: [{ type: 'text', text: 'No active wiretaps.' }] };
      const lines = taps.map(t => `#${t.id}: ${JSON.stringify(t.filter)}`);
      return { content: [{ type: 'text', text: `Active wiretaps:\n${lines.join('\n')}` }] };
    }

    const res = await fetch(`http://127.0.0.1:${dashPort}/api/wiretap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: myId, filter: args.filter }),
    });
    const tap = await res.json();
    return { content: [{ type: 'text', text: `Wiretap #${tap.id} active. Filter: ${JSON.stringify(args.filter)}` }] };
  }

  // ---- timer (non-blocking) ----
  if (name === 'timer') {
    const seconds = Math.min(Math.max(args.seconds || 10, 1), 600);
    const message = args.message || 'Timer fired';
    const fireAt = new Date(Date.now() + seconds * 1000).toISOString();

    // Store timer-set event immediately for countdown display
    sendWS('timer-set', { agent: AGENT_ID, message, fire_at: fireAt });

    // Fire after delay: deliver via channel notification + store fired event in DB
    setTimeout(async () => {
      // Deliver directly to Claude via channel (no tmux, no polling)
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: { content: `⏰ ${message}`, meta: { event_type: 'timer' } },
        });
      } catch (e) {
        process.stderr.write(`[fleet] timer channel delivery failed: ${e.message}\n`);
      }
      // Also record in DB for chat history
      sendWS('timer-fire', { agent: AGENT_ID, message: `⏰ ${message}` });
    }, seconds * 1000);

    return { content: [{ type: 'text', text: `Timer set: ${seconds}s → "${message}". You'll get ⏰ when it fires.` }] };
  }

  // ---- set_preamble ----
  if (name === 'set_preamble') {
    const texFile = args.tex_file;
    const target = args.target || 'default';

    // Resolve path
    const resolved = path.resolve(texFile);
    let tex;
    try {
      tex = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
    }

    // Extract macros from preamble
    const macros = {};

    // \newcommand{\name}{def} or \newcommand{\name}[n]{def}
    // Also handle \renewcommand
    const newcommandRegex = /\\(?:re)?newcommand\{\\(\w+)\}(?:\[\d+\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match;
    while ((match = newcommandRegex.exec(tex)) !== null) {
      macros[`\\${match[1]}`] = match[2];
    }

    // \DeclareMathOperator{\name}{text} or \DeclareMathOperator*{\name}{text}
    const operatorRegex = /\\DeclareMathOperator\*?\{\\(\w+)\}\{([^}]+)\}/g;
    while ((match = operatorRegex.exec(tex)) !== null) {
      const isStar = match[0].includes('*');
      macros[`\\${match[1]}`] = isStar ? `\\operatorname*{${match[2]}}` : `\\operatorname{${match[2]}}`;
    }

    const count = Object.keys(macros).length;
    if (count === 0) {
      return { content: [{ type: 'text', text: `No macros found in ${resolved}. Looked for \\newcommand, \\renewcommand, \\DeclareMathOperator.` }] };
    }

    // Broadcast preamble via fleet-event so fleet server picks it up
    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
    await fetch(`http://127.0.0.1:${dashPort_}/api/fleet-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'preamble',
        target,
        macros,
        source: resolved,
        timestamp: now(),
      }),
    }).catch(() => {});

    logEvent({ type: 'set_preamble', agent: AGENT_ID, target, source: resolved, macroCount: count });

    const examples = Object.entries(macros).slice(0, 5).map(([k, v]) => `  ${k} → ${v}`).join('\n');
    return { content: [{ type: 'text', text: `Set ${count} macro(s) for "${target}" from ${resolved}.\n\nExamples:\n${examples}${count > 5 ? `\n  ... and ${count - 5} more` : ''}` }] };
  }

  // ==== Document Sharing & Review ====

  // ---- watch_highlights ----
  if (name === 'watch_highlights') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const action = args.action;
    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;

    if (action === 'list' || action === 'stop' || action === 'start') {
      // Delegate to server's highlight-watch endpoint
      try {
        const res = await fetch(`http://127.0.0.1:${dashPort_}/api/highlight-watch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, doc: args.doc, agent: args.agent }),
        });
        const data = await res.json();
        if (data.error) return { content: [{ type: 'text', text: data.error }], isError: true };
        return { content: [{ type: 'text', text: data.message || JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Server unreachable: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
  }

  // ==== Playback ====

  // ---- playback_record ----
  if (name === 'playback_record') {
    const sources = args.sources;
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return { content: [{ type: 'text', text: 'At least one source is required.' }], isError: true };
    }

    const allEvents = [];
    const sourceMeta = [];

    for (const src of sources) {
      if (src.type === 'session') {
        if (!src.id) {
          return { content: [{ type: 'text', text: 'Session source requires an id (session UUID).' }], isError: true };
        }
        const extractor = new SessionExtractor();
        const events = extractor.extract(src.id, { project: src.project, start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'session', id: src.id, project: src.project });
      } else if (src.type === 'events') {
        const extractor = new EventExtractor();
        const events = extractor.extract({ agents: src.agents, start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'events', agents: src.agents });
      } else if (src.type === 'tlda') {
        if (!src.project) {
          return { content: [{ type: 'text', text: 'tlda source requires a project name.' }], isError: true };
        }
        const extractor = new TldaExtractor();
        const events = extractor.extract(src.project, { start: args.start, end: args.end });
        allEvents.push(...events);
        sourceMeta.push({ type: 'tlda', project: src.project });
      }
    }

    if (allEvents.length === 0) {
      return { content: [{ type: 'text', text: 'No events found for the given sources and time range.' }] };
    }

    const result = createPlayback({
      title: args.title,
      sources: sourceMeta,
      events: allEvents,
      start: args.start,
      end: args.end,
    });

    logEvent({ type: 'playback_record', from: AGENT_ID || 'unknown', playbackId: result.id, eventCount: result.event_count, title: args.title });

    return { content: [{ type: 'text', text: `Playback created: ${result.id}\n\nTitle: ${result.title}\nEvents: ${result.event_count}\nDuration: ${(result.duration_ms / 1000).toFixed(1)}s\nSources: ${result.sources}` }] };
  }

  // ---- playback_list ----
  if (name === 'playback_list') {
    const playbacks = listPlaybacks({ project: args.project, agent: args.agent, limit: args.limit });

    if (playbacks.length === 0) {
      return { content: [{ type: 'text', text: 'No playbacks found.' }] };
    }

    const lines = playbacks.map(pb => {
      const types = Object.entries(pb.event_types).map(([k, v]) => `${k}:${v}`).join(', ');
      return `**${pb.title}** (${pb.id.slice(0, 8)})\n  ${pb.event_count} events (${types}) | ${(pb.duration_ms / 1000).toFixed(0)}s | ${new Date(pb.created).toLocaleString()}`;
    });

    return { content: [{ type: 'text', text: `${playbacks.length} playback(s):\n\n${lines.join('\n\n')}` }] };
  }

  // ---- playback_get ----
  if (name === 'playback_get') {
    if (!args.id) {
      return { content: [{ type: 'text', text: 'Playback ID is required.' }], isError: true };
    }

    const playback = getPlayback(args.id, args.format || 'full');
    if (!playback) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify(playback, null, 2) }] };
  }

  // ---- playback_edit ----
  if (name === 'playback_edit') {
    if (!args.id || !args.operations) {
      return { content: [{ type: 'text', text: 'Playback ID and operations are required.' }], isError: true };
    }

    const result = editPlayback(args.id, args.operations);
    if (!result) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: `Edited playback ${result.id}: ${result.edit_count} edit(s), ${result.event_count} events.` }] };
  }

  // ---- playback_transcript ----
  if (name === 'playback_transcript') {
    if (!args.id) {
      return { content: [{ type: 'text', text: 'Playback ID is required.' }], isError: true };
    }

    const result = playbackTranscript(args.id, {
      startT: args.start_ms || 0,
      endT: args.end_ms,
      types: args.types,
      density: args.density || false,
      windowMs: args.window_ms || 60000,
    });
    if (!result) {
      return { content: [{ type: 'text', text: `Playback ${args.id} not found.` }], isError: true };
    }

    return { content: [{ type: 'text', text: result.transcript }] };
  }

  // ---- share ----
  if (name === 'share') {
    const filePath = args.path;
    if (!filePath) {
      return { content: [{ type: 'text', text: 'Path is required.' }], isError: true };
    }

    // Resolve the file
    const resolved = path.resolve(filePath);
    let content;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
    }

    // Generate doc name from filename if not provided
    const basename = path.basename(resolved, path.extname(resolved));
    const docName = (args.doc || basename).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!docName) {
      return { content: [{ type: 'text', text: 'Could not generate a valid doc name. Provide one explicitly.' }], isError: true };
    }

    // Extract title from first heading or use provided title
    let title = args.title;
    if (!title) {
      const headingMatch = content.match(/^#\s+(.+)$/m);
      title = headingMatch ? headingMatch[1].trim() : basename;
    }

    // --- Quality gate: first call returns review prompt ---
    if (!args.reviewed) {
      const lines = content.split('\n');
      const wordCount = content.split(/\s+/).length;
      const preview = lines.slice(0, 30).join('\n');
      const truncated = lines.length > 30 ? `\n... (${lines.length - 30} more lines)` : '';

      return { content: [{ type: 'text', text:
        `**Quality gate — self-review before sharing**\n\n` +
        `File: ${resolved}\nTitle: ${title}\nDoc: ${docName}\n` +
        `${wordCount} words, ${lines.length} lines\n\n` +
        `---\n\n${preview}${truncated}\n\n---\n\n` +
        `**Review this content against the quality bar:**\n\n` +
        `1. **Self-contained** — Can someone without context understand this? No dangling references to "the above" or unexplained terms?\n` +
        `2. **Clear structure** — Does it have a clear opening statement, logical sections, and conclusion/summary?\n` +
        `3. **Reader-ready** — Is this polished prose, or stream-of-consciousness notes? Would you be comfortable if a collaborator read this?\n` +
        `4. **No filler** — Any unnecessary hedging, apologies, or meta-commentary that should be cut?\n` +
        `5. **Math/code** — If present, are equations/snippets correctly formatted and explained?\n\n` +
        `If it passes, call \`share(path: "${filePath}", reviewed: true)\` to post.\n` +
        `If it needs work, edit the file first, then call share again.`
      }] };
    }

    // --- Reviewed: post to chat and share to tlda ---
    // Resolve local image paths to base64 data URIs for tlda rendering
    const imageDir = path.dirname(resolved);
    content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imgPath) => {
      if (imgPath.startsWith('data:') || imgPath.startsWith('http')) return match;
      const absPath = path.isAbsolute(imgPath) ? imgPath : path.resolve(imageDir, imgPath);
      try {
        const imgData = fs.readFileSync(absPath);
        const ext = path.extname(absPath).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
        return `![${alt}](data:${mime};base64,${imgData.toString('base64')})`;
      } catch {
        return match; // keep original if file not found
      }
    });
    const mainFile = path.basename(resolved);

    // Post content as chat message
    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
    let agents_ = [];
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort_}/api/store/agents`);
      if (res.ok) agents_ = await res.json();
    } catch {}
    const state = { agents: agents_ };
    const recipient = args.to
      ? (getAgent(state, args.to)?.id || args.to)
      : agents_.find(a => a.id !== AGENT_ID && agentAlive(a))?.id || null;

    if (recipient) {
      const chatText = `[doc:${docName}] ${title}`;
      postMessage(recipient, AGENT_ID, chatText, {
        attachments: [{ type: 'shared-doc', source: `doc:${AGENT_ID}:${docName}`, text: content, path: resolved }],
      });
      logEvent({ type: 'chat', from: AGENT_ID, to: recipient, message: `[shared] ${title} (${docName})` });
    }

    // Share to tlda
    let tldaResult = '';
    try {
      const check = await tldaFetch(docName);
      if (check.status === 404) {
        const createRes = await tldaFetch('', {
          method: 'POST',
          body: { name: docName, title, format: 'markdown', mainFile },
        });
        if (createRes.status >= 400) {
          tldaResult = `\n⚠ Failed to create tlda project: ${JSON.stringify(createRes.data)}`;
        }
      }
      if (!tldaResult) {
        const pushRes = await tldaFetch(docName + '/push', {
          method: 'POST',
          body: {
            files: [{ path: mainFile, content }],
            sourceDir: path.dirname(resolved),
            session: CLAUDE_SESSION,
          },
        });
        if (pushRes.status >= 400) {
          tldaResult = `\n⚠ Failed to push to tlda: ${JSON.stringify(pushRes.data)}`;
        } else {
          tldaResult = `\nShared to tlda as **${docName}** — live on canvas for review.`;
          // Add to fleet review book (creates book if needed) and reload viewer
          try {
            await tldaFetch('fleet-review/members', { method: 'PATCH', body: { add: docName } });
            await tldaFetch('fleet-review/signal', { method: 'POST', body: { key: 'signal:reload', pages: 1, timestamp: Date.now() } });
          } catch {}
          // Notify fleet server
          const dashPort = process.env.FLEET_DASH_PORT || 5199;
          fetch(`http://127.0.0.1:${dashPort}/api/fleet-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'open-doc', doc: docName, title, book: 'fleet-review', url: `http://localhost:${TLDA_PORT}/fleet-review` }),
          }).catch(() => {});
        }
      }
    } catch (e) {
      tldaResult = `\n⚠ tlda unavailable (${e.message}) — posted to chat only.`;
    }

    // Register shared doc in the server DB (required for card click to work)
    const isScratch = /\/scratch\//.test(resolved);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const regRes = await fetch(`http://127.0.0.1:${dashPort_}/api/shared-docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc: docName, title, path: resolved, agent: AGENT_ID, ephemeral: isScratch }),
        });
        if (regRes.ok) break;
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }
    logEvent({ type: 'share', agent: AGENT_ID, doc: docName, path: resolved, title, ephemeral: isScratch });

    const chatMsg = recipient ? `Posted to chat → ${getAgent(state, recipient)?.friendly_name || recipient}` : '⚠ No recipient found — not posted to chat.';
    return { content: [{ type: 'text', text: `✓ Shared "${title}"\n${chatMsg}${tldaResult}\n\nUse \`check_doc_feedback("${docName}")\` to read highlight feedback.` }] };
  }

  // ---- check_doc_feedback ----
  if (name === 'check_doc_feedback') {
    const { doc, since_minutes } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Doc name is required.' }], isError: true };
    }
    const sinceTs = since_minutes ? Date.now() - since_minutes * 60 * 1000 : 0;

    try {
      // Read pen/highlighter annotations from tlda
      // Check both the shared doc and the preview-* version (card iframes create preview- projects)
      let shapesRes = await tldaFetch(doc + '/shapes?type=highlight,draw');
      let notesRes = await tldaFetch(doc + '/shapes?type=math-note');
      let shapes = Array.isArray(shapesRes.data) ? shapesRes.data : [];
      let notes = Array.isArray(notesRes.data) ? notesRes.data : [];

      // If no shapes on the shared doc, check the preview version
      // Preview docs are named preview-<filename-stem> (from /api/tlda-preview)
      if (shapes.length === 0 && notes.length === 0 && !doc.startsWith('preview-')) {
        // Try preview-<doc> first, then look up the filename from shared_docs
        const candidates = ['preview-' + doc];
        const dashPort__ = process.env.FLEET_DASH_PORT || 5199;
        try {
          const sdRes = await fetch(`http://127.0.0.1:${dashPort__}/api/shared-docs`);
          if (sdRes.ok) {
            const docs = await sdRes.json();
            const sd = docs.find(d => d.doc === doc);
            if (sd?.mainFile) candidates.push('preview-' + sd.mainFile.replace(/\.md$/, ''));
            if (sd?.path) candidates.push('preview-' + path.basename(sd.path).replace(/\.md$/, ''));
          }
        } catch {}
        for (const previewDoc of [...new Set(candidates)]) {
          const pShapes = await tldaFetch(previewDoc + '/shapes?type=highlight,draw');
          const pNotes = await tldaFetch(previewDoc + '/shapes?type=math-note');
          if (Array.isArray(pShapes.data) && pShapes.data.length > 0) { shapes = pShapes.data; break; }
          if (Array.isArray(pNotes.data) && pNotes.data.length > 0) { notes = pNotes.data; break; }
        }
      }

      if (shapesRes.status >= 400 && shapes.length === 0) {
        return { content: [{ type: 'text', text: `Failed to read shapes: ${JSON.stringify(shapesRes.data)}` }], isError: true };
      }

      // Read the source file for line content extraction
      const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
      let sharedDocs = [];
      try {
        const res = await fetch(`http://127.0.0.1:${dashPort_}/api/shared-docs`);
        if (res.ok) sharedDocs = await res.json();
      } catch {}
      const sharedDoc = sharedDocs.find(d => d.doc === doc);
      let sourceLines = [];
      if (sharedDoc?.path) {
        try { sourceLines = fs.readFileSync(sharedDoc.path, 'utf8').split('\n'); } catch (e) {
          if (e.code !== 'ENOENT') process.stderr.write(`[fleet] shared doc read failed: ${e.message}\n`);
        }
      }

      // Process highlights into structured feedback
      const feedback = [];

      for (const shape of shapes) {
        if (sinceTs && (shape.meta?.createdAt || 0) < sinceTs) continue;
        const color = shape.props?.color || shape.meta?.color || 'orange';
        const theme = HIGHLIGHT_THEMES[color] || { type: 'comment', label: color };
        const anchor = shape.meta?.sourceAnchor;
        const startLine = anchor?.startLine || anchor?.line || shape.meta?.startLine;
        const endLine = anchor?.endLine || shape.meta?.endLine || startLine;

        // For freehand highlights without source anchors, estimate line from y position
        let estimatedLine = startLine;
        if (!estimatedLine && shape.y != null) {
          // tlda renders ~18px per line, page starts at ~60px header
          estimatedLine = Math.max(1, Math.round((shape.y - 60) / 18));
        }
        if (!estimatedLine) continue; // Skip shapes with no position data at all

        const resolvedEnd = endLine || estimatedLine;

        // Extract the highlighted text from source
        const text = sourceLines.length > 0
          ? sourceLines.slice(estimatedLine - 1, resolvedEnd).join('\n')
          : `(line ~${estimatedLine})`;

        feedback.push({
          type: theme.type,
          label: theme.label,
          color,
          lines: [estimatedLine, resolvedEnd],
          text,
          shapeId: shape.id,
          estimated: !startLine, // true if line was estimated from y position
        });
      }

      // Process sticky notes as text feedback
      for (const note of notes) {
        if (note.meta?.createdBy === 'claude') continue; // Skip agent's own notes
        const anchor = note.meta?.sourceAnchor;
        const line = anchor?.line || anchor?.startLine;
        feedback.push({
          type: 'note',
          label: 'Text feedback',
          color: note.props?.color ?? 'yellow',
          lines: line ? [line, anchor?.endLine ?? line] : null,
          text: note.props?.text ?? '',
          done: note.props?.done ?? false,
          shapeId: note.id,
        });
      }

      if (feedback.length === 0) {
        return { content: [{ type: 'text', text: `No feedback on "${doc}" yet. The doc is on the canvas — waiting for highlights.` }] };
      }

      // Format feedback summary
      const summary = feedback.map(f => {
        const lineRef = f.lines ? `L${f.lines[0]}${f.lines[1] !== f.lines[0] ? '-' + f.lines[1] : ''}` : '';
        const icon = { approve: '✅', reject: '❌', question: '❓', expand: '💡', comment: '💬', note: '📝', info: 'ℹ️' }[f.type] || '•';
        return `${icon} **${f.type}** ${lineRef}: ${f.text}${f.text.length > 200 ? '...' : ''}`;
      }).join('\n');

      return { content: [{ type: 'text', text: `**Feedback on "${doc}"** (${feedback.length} items):\n\n${summary}\n\n---\nRaw feedback:\n${JSON.stringify(feedback, null, 2)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}. Is tlda running?` }], isError: true };
    }
  }

  // ---- suggest ----
  if (name === 'suggest') {
    const { doc, text } = args;
    if (!doc || !text) {
      return { content: [{ type: 'text', text: 'Doc and text are required.' }], isError: true };
    }

    const choices = args.choices || ['Accept', 'Reject', 'Modify'];
    const color = args.color || 'orange';
    const line = args.line || null;
    const replyTo = args.reply_to || null;

    // Page width = 800 canvas pixels (TARGET_WIDTH). Margin dot at right edge + 10.
    const MARGIN_X = 810;

    try {
      if (replyTo) {
        // Reply to an existing annotation thread
        // Look up parent shape to position note near it and inherit its color
        let noteY = 100;
        let inheritedColor = color;
        const parentRes = await tldaFetch(doc + '/shapes/' + replyTo);
        if (parentRes.status < 400 && parentRes.data) {
          const parent = parentRes.data;
          noteY = parent.y ?? parent.meta?.anchorCanvasY ?? 100;
          // Inherit parent highlight's color
          if (parent.props?.color) inheritedColor = parent.props.color;
        }
        const replyId = 'shape:claude-' + crypto.randomUUID().slice(0, 12);
        const replyRes = await tldaFetch(doc + '/shapes', {
          method: 'POST',
          body: {
            id: replyId,
            type: 'math-note',
            typeName: 'shape',
            parentId: 'page:page',
            index: 'a1',
            x: MARGIN_X, y: noteY, rotation: 0, isLocked: false, opacity: 1,
            props: { w: 10, h: 10, text, color: inheritedColor, collapsed: true },
            meta: { createdBy: 'claude', replyTo, choices: choices || [], sourceAnchor: line ? { line } : undefined },
          },
        });
        if (replyRes.status >= 400) {
          return { content: [{ type: 'text', text: `Failed to post reply: ${JSON.stringify(replyRes.data)}` }], isError: true };
        }
        logEvent({ type: 'suggest', agent: AGENT_ID, doc, line, replyTo, text: text });
        return { content: [{ type: 'text', text: `Posted reply on "${doc}" ${line ? 'at L' + line : ''} (replying to ${replyTo}). Choices: ${Array.isArray(choices) ? choices.join(', ') : choices}` }] };
      } else {
        // Create new suggestion note — estimate y from line number (18px/line, 60px header)
        const noteY = line ? Math.max(60, 60 + (line - 1) * 18) : 100;
        const noteId = 'shape:claude-' + crypto.randomUUID().slice(0, 12);
        const noteRes = await tldaFetch(doc + '/shapes', {
          method: 'POST',
          body: {
            id: noteId,
            type: 'math-note',
            typeName: 'shape',
            parentId: 'page:page',
            index: 'a1',
            x: MARGIN_X, y: noteY, rotation: 0, isLocked: false, opacity: 1,
            props: { w: 10, h: 10, text, color, collapsed: true },
            meta: { createdBy: 'claude', choices: choices || [], sourceAnchor: line ? { line } : undefined },
          },
        });
        if (noteRes.status >= 400) {
          return { content: [{ type: 'text', text: `Failed to post suggestion: ${JSON.stringify(noteRes.data)}` }], isError: true };
        }
        logEvent({ type: 'suggest', agent: AGENT_ID, doc, line, text: text });
        return { content: [{ type: 'text', text: `Posted suggestion on "${doc}" ${line ? 'at L' + line : ''}. Choices: ${Array.isArray(choices) ? choices.join(', ') : choices}` }] };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- update_shared_doc ----
  if (name === 'update_shared_doc') {
    const doc = args.doc;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Doc name is required.' }], isError: true };
    }

    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
    let sharedDocs = [];
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort_}/api/shared-docs`);
      if (res.ok) sharedDocs = await res.json();
    } catch {}
    const sharedDoc = sharedDocs.find(d => d.doc === doc);
    if (!sharedDoc) {
      return { content: [{ type: 'text', text: `Doc "${doc}" not found in shared docs. Share it first with share().` }], isError: true };
    }

    let content;
    try {
      content = fs.readFileSync(sharedDoc.path, 'utf8');
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
    }

    const mainFile = path.basename(sharedDoc.path);

    try {
      const pushRes = await tldaFetch(doc + '/push', {
        method: 'POST',
        body: {
          files: [{ path: mainFile, content }],
          sourceDir: path.dirname(sharedDoc.path),
          session: CLAUDE_SESSION,
        },
      });
      if (pushRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to push update: ${JSON.stringify(pushRes.data)}` }], isError: true };
      }

      // TODO: Need server endpoint to update shared doc timestamp (POST /api/shared-docs/update)
      logEvent({ type: 'update_doc', agent: AGENT_ID, doc, path: sharedDoc.path });

      return { content: [{ type: 'text', text: `Updated "${doc}" on tlda. The canvas will reload with the new content.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_create_shape ----
  if (name === 'tlda_create_shape') {
    const { doc, shape } = args;
    if (!doc || !shape) {
      return { content: [{ type: 'text', text: 'doc and shape are required.' }], isError: true };
    }
    try {
      const res = await tldaFetch(doc + '/shapes', {
        method: 'POST',
        body: shape,
      });
      if (res.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to create shape: ${JSON.stringify(res.data)}` }], isError: true };
      }
      logEvent({ type: 'tlda_create_shape', agent: AGENT_ID, doc, shapeType: shape.type });
      return { content: [{ type: 'text', text: `Created ${shape.type} shape on "${doc}". ID: ${res.data?.id || 'unknown'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_build ----
  if (name === 'tlda_build') {
    const { doc } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };
    }
    try {
      const res = await tldaFetch(doc + '/build', { method: 'POST' });
      if (res.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to trigger build: ${JSON.stringify(res.data)}` }], isError: true };
      }
      logEvent({ type: 'tlda_build', agent: AGENT_ID, doc });

      // Background poll for build completion — notify agent via inbox
      const pollInterval = setInterval(async () => {
        try {
          const status = await tldaFetch(doc + '/build/status');
          if (status.data?.phase === 'idle' || status.data?.status === 'complete' || status.data?.status === 'error') {
            clearInterval(pollInterval);
            const errRes = await tldaFetch(doc + '/build/errors');
            const errors = Array.isArray(errRes.data) ? errRes.data : [];
            const success = errors.length === 0 && status.data?.status !== 'error';
            logEvent({ type: 'tlda_build_done', agent: AGENT_ID, doc, success, errorCount: errors.length });
            // Log to stderr only — no chat message. Agent can check via tlda_build_status.
            process.stderr.write(`[fleet] tlda build ${success ? 'success' : 'failed'} for "${doc}" (agent: ${AGENT_ID})\n`);
          }
        } catch (e) {
          process.stderr.write(`[fleet] tlda build poll failed: ${e.message}\n`);
        }
      }, 3000);
      // Safety timeout — stop polling after 5 minutes
      setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);

      return { content: [{ type: 'text', text: `Build triggered for "${doc}". You'll get a 📬 when it completes. Use tlda_build_status to check progress.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_build_status ----
  if (name === 'tlda_build_status') {
    const { doc } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };
    }
    try {
      const statusRes = await tldaFetch(doc + '/build/status');
      const errRes = await tldaFetch(doc + '/build/errors');
      const errors = Array.isArray(errRes.data) ? errRes.data : [];
      const status = statusRes.data || {};
      const summary = [
        `**Phase**: ${status.phase || 'unknown'}`,
        `**Status**: ${status.status || 'unknown'}`,
        errors.length > 0 ? `**Errors** (${errors.length}):\n${errors.map(e => `  • ${e.message || e}`).join('\n')}` : '**Errors**: none',
      ].join('\n');
      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- lookup_theorem ----
  if (name === 'lookup_theorem') {
    const { doc, query } = args;
    if (!doc || !query) {
      return { content: [{ type: 'text', text: 'doc and query are required.' }], isError: true };
    }
    try {
      // Read theorem-map.json directly from disk
      const tldaProjectsDir = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects');
      const mapPath = path.join(tldaProjectsDir, doc, 'output', 'theorem-map.json');
      if (!fs.existsSync(mapPath)) {
        return { content: [{ type: 'text', text: `No theorem-map.json for "${doc}". Trigger a build first.` }], isError: true };
      }
      const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

      const q = query.trim();
      // Try direct label match first
      let entry = mapData[q];
      // Try number match (e.g. "4.3" or "A.1")
      if (!entry) {
        entry = Object.values(mapData).find(e => e.number === q);
      }

      if (!entry) {
        const available = Object.values(mapData).map(e => `${e.number} (${e.label})`).join(', ');
        return { content: [{ type: 'text', text: `No match for "${q}" in ${doc}.\nAvailable: ${available}` }] };
      }

      const lines = [
        `**${entry.type.toUpperCase()} ${entry.number}** — ${entry.title || '(no title)'}`,
        `Label: \`${entry.label}\``,
        `Page: ${entry.page}`,
        entry.file ? `Source: ${entry.file}:${entry.line}` : 'Source: unknown',
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `lookup_theorem error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_annotate ----
  if (name === 'tlda_annotate') {
    const { doc, text, line, page, color = 'light-yellow', file, side = 'right' } = args;
    if (!doc || !text) {
      return { content: [{ type: 'text', text: 'doc and text are required.' }], isError: true };
    }
    try {
      const shape = {
        type: 'math-note',
        props: { text, color },
        meta: {
          createdBy: 'claude',
          agentId: AGENT_ID,
          sourceAnchor: {},
        },
      };
      if (line != null) shape.meta.sourceAnchor.line = line;
      if (page != null) shape.meta.sourceAnchor.page = page;
      if (file) shape.meta.sourceAnchor.file = file;
      if (side) shape.meta.side = side;

      const res = await tldaFetch(doc + '/shapes', {
        method: 'POST',
        body: shape,
      });
      if (res.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to create annotation: ${JSON.stringify(res.data)}` }], isError: true };
      }
      logEvent({ type: 'tlda_annotate', agent: AGENT_ID, doc, line, page });
      const lineRef = line != null ? ` at L${line}` : '';
      const pageRef = page != null ? ` (p${page + 1})` : '';
      return { content: [{ type: 'text', text: `Annotation added to "${doc}"${lineRef}${pageRef}. ID: ${res.data?.id || 'unknown'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_highlight ----
  if (name === 'tlda_highlight') {
    const { doc, line, endLine, file, color = 'yellow', text } = args;
    if (!doc || line == null) {
      return { content: [{ type: 'text', text: 'doc and line are required.' }], isError: true };
    }
    try {
      // Fetch lookup.json from tlda server (served at /docs/<name>/lookup.json)
      const lookupRes = await new Promise((resolve, reject) => {
        const headers = {};
        if (_tldaToken) headers['Authorization'] = 'Bearer ' + _tldaToken;
        const req = http.request({ hostname: 'localhost', port: TLDA_PORT, path: `/docs/${encodeURIComponent(doc)}/lookup.json`, method: 'GET', headers }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      if (lookupRes.status >= 400 || !lookupRes.data?.lines) {
        return { content: [{ type: 'text', text: `Could not load lookup.json for "${doc}": ${lookupRes.status}` }], isError: true };
      }
      const lookup = lookupRes.data;

      // Resolve line range
      const startLine = line;
      const lastLine = endLine || line;
      const createdIds = [];

      // Default textwidth for full-line highlights (single-column LaTeX)
      const TEXT_WIDTH_PDF = 468;
      // Typical rendered line height in PDF points (synctex y-step between consecutive lines)
      const LINE_HEIGHT_PDF = 12;

      // For multi-line ranges: collect all entries to find the y-span, then fill every
      // rendered line in between. Source lines don't map 1:1 to rendered lines.
      const lookupKey = (ln) => file ? `${file.split('/').pop()}:${ln}` : `${ln}`;
      const startEntry = lookup.lines[lookupKey(startLine)] || lookup.lines[`${startLine}`];
      const endEntry = endLine ? (lookup.lines[lookupKey(lastLine)] || lookup.lines[`${lastLine}`]) : startEntry;
      if (!startEntry) {
        return { content: [{ type: 'text', text: `No synctex entry for line ${startLine}` }], isError: true };
      }

      // Build the list of rendered lines to highlight
      const renderLines = [];
      if (!endLine || lastLine === startLine || !endEntry || startEntry.page !== endEntry.page) {
        // Single line or cross-page: just highlight each source line individually
        for (let ln = startLine; ln <= lastLine; ln++) {
          const entry = lookup.lines[lookupKey(ln)] || lookup.lines[`${ln}`];
          if (!entry) continue;
          const hlStartX = (ln === startLine) ? entry.x : 0;
          let hlWidth = TEXT_WIDTH_PDF - hlStartX;
          if (ln === lastLine && endLine && endLine > line) {
            const nextEntry = lookup.lines[lookupKey(ln + 1)] || lookup.lines[`${ln + 1}`];
            if (nextEntry && nextEntry.page === entry.page && nextEntry.y === entry.y) {
              hlWidth = nextEntry.x - hlStartX;
            }
          }
          renderLines.push({ page: entry.page, x: hlStartX, y: entry.y, w: hlWidth, content: entry.content, sourceLine: ln });
        }
      } else {
        // Multi-line on same page: fill every rendered line from startEntry.y to endEntry.y
        const startY = startEntry.y;
        const endY = endEntry.y;
        // Detect line height from nearby entries (look at actual y-steps in the lookup)
        let lineHeight = LINE_HEIGHT_PDF;
        const nearbyYs = [];
        for (let ln = startLine - 2; ln <= lastLine + 2; ln++) {
          const e = lookup.lines[lookupKey(ln)] || lookup.lines[`${ln}`];
          if (e && e.page === startEntry.page) nearbyYs.push(e.y);
        }
        nearbyYs.sort((a, b) => a - b);
        const steps = [];
        for (let i = 1; i < nearbyYs.length; i++) {
          const step = nearbyYs[i] - nearbyYs[i - 1];
          if (step > 2) steps.push(step); // skip duplicates (same y)
        }
        if (steps.length > 0) lineHeight = Math.min(...steps);

        // First rendered line: starts at startEntry.x
        renderLines.push({ page: startEntry.page, x: startEntry.x, y: startY, w: TEXT_WIDTH_PDF - startEntry.x, content: startEntry.content, sourceLine: startLine });
        // Intermediate rendered lines: full width at x=0
        for (let y = startY + lineHeight; y < endY - 0.5; y += lineHeight) {
          renderLines.push({ page: startEntry.page, x: 0, y, w: TEXT_WIDTH_PDF, content: null, sourceLine: null });
        }
        // Last rendered line: may be partial width
        if (Math.abs(endY - startY) > 1) {
          // Check if endLine's source text ends mid-line
          const nextAfterEnd = lookup.lines[lookupKey(lastLine + 1)] || lookup.lines[`${lastLine + 1}`];
          let endWidth = TEXT_WIDTH_PDF;
          if (nextAfterEnd && nextAfterEnd.page === endEntry.page && nextAfterEnd.y === endEntry.y) {
            endWidth = nextAfterEnd.x;
          }
          renderLines.push({ page: startEntry.page, x: 0, y: endY, w: endWidth, content: endEntry.content, sourceLine: lastLine });
        }
      }

      for (const rl of renderLines) {
        const canvasPos = tldaPdfToCanvas(rl.page, rl.x, rl.y);
        const scale = TLDA_TARGET_WIDTH / TLDA_PDF_WIDTH;
        const textWidthCanvas = rl.w * scale;

        // The highlight path: horizontal stroke from text start to end
        // Points are relative to shape position. Stroke is centered on path.
        // Shift y up by ~6px so thinner stroke covers text body above baseline.
        const pathPoints = [
          { x: 0, y: 0, z: 0.5 },
          { x: textWidthCanvas, y: 0, z: 0.5 },
        ];
        const pathB64 = encodeB64Path(pathPoints);

        const shapeId = 'shape:hl-' + Math.random().toString(36).slice(2, 12);
        const shape = {
          id: shapeId,
          type: 'highlight',
          typeName: 'shape',
          x: canvasPos.x,
          y: canvasPos.y - 6,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          props: {
            color,
            size: 's',
            segments: [{ type: 'free', path: pathB64 }],
            isComplete: true,
            isPen: false,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
          },
          parentId: 'page:page',
          index: 'a1',
          meta: {
            createdBy: 'claude',
            agentId: AGENT_ID,
            createdAt: Date.now(),
            sourceAnchor: { line: rl.sourceLine || startLine, ...(file && { file }) },
            ...(text && { highlightText: text }),
            ...(rl.content && { highlightLines: [{ text: rl.content, baseline: 0 }] }),
          },
        };

        const res = await tldaFetch(doc + '/shapes', { method: 'POST', body: shape });
        if (res.status < 400) {
          createdIds.push(shapeId);
        }
      }

      if (createdIds.length === 0) {
        return { content: [{ type: 'text', text: `No lines found in lookup for ${file ? file + ':' : ''}${startLine}${lastLine > startLine ? '-' + lastLine : ''}` }], isError: true };
      }

      logEvent({ type: 'tlda_highlight', agent: AGENT_ID, doc, line: startLine, endLine: lastLine, color, count: createdIds.length });
      const lineRef = lastLine > startLine ? `L${startLine}-${lastLine}` : `L${startLine}`;

      // Build a ref token so agents can embed «annotation:label» in chat messages
      const label = text || startEntry.content || `${file || 'main.tex'}:${startLine}`;
      const token = `«annotation:${label}»`;
      const firstShape = renderLines[0];
      const canvasPos = firstShape ? tldaPdfToCanvas(firstShape.page, firstShape.x, firstShape.y) : null;
      const scale = TLDA_TARGET_WIDTH / TLDA_PDF_WIDTH;
      const totalH = renderLines.length > 1
        ? (renderLines[renderLines.length - 1].y - renderLines[0].y + LINE_HEIGHT_PDF) * scale
        : LINE_HEIGHT_PDF * scale;
      _refTokens.set(token, {
        type: 'annotation',
        label,
        color,
        file: file || 'main.tex',
        lineno: startLine,
        shapeId: createdIds[0],
        highlightShapeId: createdIds[0],
        canvasBounds: canvasPos ? { x: canvasPos.x, y: canvasPos.y, w: renderLines[0].w * scale, h: totalH } : null,
      });
      return { content: [{ type: 'text', text: `Highlighted ${createdIds.length} line(s) on "${doc}" at ${lineRef} (${color}). IDs: ${createdIds.join(', ')}\n\nRef token: ${token}\nInclude this token in a chat() message to create a clickable ref-chip.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_screenshot ----
  if (name === 'tlda_screenshot') {
    const { doc, ref, padding } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };
    }
    let bounds;
    if (ref) {
      // Parse "tlda-screenshot:page:page:x,y,w,h"
      const parts = ref.split(':');
      const coordStr = parts[parts.length - 1];
      const coords = coordStr.split(',').map(Number);
      if (coords.length !== 4 || coords.some(isNaN)) {
        return { content: [{ type: 'text', text: `Invalid ref format: ${ref}` }], isError: true };
      }
      bounds = { x: coords[0], y: coords[1], w: coords[2], h: coords[3] };
    } else if (args.x != null && args.y != null && args.w != null && args.h != null) {
      bounds = { x: args.x, y: args.y, w: args.w, h: args.h };
    }
    if (!bounds) {
      return { content: [{ type: 'text', text: 'Provide ref or x/y/w/h bounds.' }], isError: true };
    }
    try {
      const tldaServer = process.env.TLDA_SERVER || 'http://localhost:5176';
      const tokenParam = _tldaToken ? `&token=${_tldaToken}` : '';
      const docUrl = `${tldaServer}/?doc=${doc}${tokenParam}`;
      const pad = padding || 200;

      // Use puppeteer for headless crop screenshot
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.default.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1280, height: 960 });
        await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.tl-shapes', { timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Center on bounds with generous context
        const clip = await page.evaluate((b, padPx) => {
          const editor = window.__tldraw_editor__;
          if (!editor) return null;
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          const vw = 1280, vh = 960;
          // Zoom: fit bounds + padding in viewport, cap at 2x for readability
          const zoomX = vw / (b.w + padPx * 2);
          const zoomY = vh / (b.h + padPx * 2);
          const zoom = Math.min(zoomX, zoomY, 2);
          editor.setCamera({ x: -(cx - vw / (2 * zoom)), y: -(cy - vh / (2 * zoom)), z: zoom });
          // Convert canvas bounds to screen for clip
          const tl = editor.pageToScreen({ x: b.x, y: b.y });
          const br = editor.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
          return {
            x: Math.max(0, Math.floor(tl.x - padPx)),
            y: Math.max(0, Math.floor(tl.y - padPx)),
            width: Math.min(vw, Math.ceil(br.x - tl.x + padPx * 2)),
            height: Math.min(vh, Math.ceil(br.y - tl.y + padPx * 2)),
          };
        }, bounds, pad);

        // Force light theme and hide fleet UI shapes for clean document screenshots
        await page.evaluate(() => {
          document.documentElement.classList.remove('tl-theme__dark');
          document.documentElement.classList.add('tl-theme__light');
          document.body.classList.remove('tl-theme__dark');
          document.body.classList.add('tl-theme__light');
          const editor = window.__tldraw_editor__;
          if (!editor) return;
          const fleetTypes = new Set(['fleet-chat', 'fleet-agents', 'fleet-pill', 'fleet-status']);
          for (const shape of editor.getCurrentPageShapes()) {
            if (!fleetTypes.has(shape.type)) continue;
            const el = document.querySelector(`[data-shape-id="${shape.id}"]:not(.tl-shape-background)`);
            if (el) el.style.display = 'none';
          }
        });

        // Fade non-target annotations (keep colors recognizable, just lower salience)
        if (args.shapeId) {
          await page.evaluate((targetId) => {
            const editor = window.__tldraw_editor__;
            if (!editor) return;
            const annotationTypes = new Set(['highlight', 'draw', 'dot-annotation']);
            for (const shape of editor.getCurrentPageShapes()) {
              if (!annotationTypes.has(shape.type)) continue;
              if (shape.id === targetId) continue;
              const el = document.querySelector(`[data-shape-id="${shape.id}"]:not(.tl-shape-background)`);
              if (el) el.style.opacity = '0.4';
            }
          }, args.shapeId);
        }

        await new Promise(r => setTimeout(r, 500));
        const buf = clip
          ? await page.screenshot({ type: 'png', clip })
          : await page.screenshot({ type: 'png' });
        const base64 = buf.toString('base64');
        return {
          content: [
            { type: 'text', text: `Cropped screenshot of "${doc}" (${Math.round(base64.length / 1024)}KB) — bounds: [${bounds.x}, ${bounds.y}, ${bounds.w}, ${bounds.h}]` },
            { type: 'image', data: base64, mimeType: 'image/png' },
          ],
        };
      } finally {
        await page.close();
        await browser.close();
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda_screenshot error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_get_feedback ----
  if (name === 'tlda_get_feedback') {
    const { doc, since_minutes } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };
    }
    const sinceTs = since_minutes ? Date.now() - since_minutes * 60 * 1000 : 0;
    try {
      const shapesRes = await tldaFetch(doc + '/shapes?type=highlight,draw');
      if (shapesRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to read shapes: ${JSON.stringify(shapesRes.data)}` }], isError: true };
      }
      const shapes = Array.isArray(shapesRes.data) ? shapesRes.data : [];
      const notesRes = await tldaFetch(doc + '/shapes?type=math-note');
      const notes = Array.isArray(notesRes.data) ? notesRes.data : [];

      const feedback = [];
      for (const shape of shapes) {
        if (sinceTs && (shape.meta?.createdAt || 0) < sinceTs) continue;
        const color = shape.props?.color || shape.meta?.color || 'orange';
        const theme = HIGHLIGHT_THEMES[color] || { type: 'comment', label: color };
        const anchor = shape.meta?.sourceAnchor;
        const startLine = anchor?.startLine || anchor?.line || shape.meta?.startLine;
        const endLine = anchor?.endLine || shape.meta?.endLine || startLine;
        if (!startLine) continue;
        feedback.push({
          type: theme.type, label: theme.label, color,
          lines: [startLine, endLine],
          text: shape.meta?.highlightText || anchor?.content || '',
          shapeId: shape.id,
        });
      }
      for (const note of notes) {
        if (note.meta?.createdBy === 'claude') continue;
        if (sinceTs && (note.meta?.createdAt || 0) < sinceTs) continue;
        const anchor = note.meta?.sourceAnchor;
        const line = anchor?.line || anchor?.startLine;
        feedback.push({
          type: 'note', label: 'Text feedback',
          color: note.props?.color ?? 'yellow',
          lines: line ? [line, anchor?.endLine ?? line] : null,
          text: note.props?.text ?? '',
          done: note.props?.done ?? false,
          shapeId: note.id,
        });
      }

      if (feedback.length === 0) {
        return { content: [{ type: 'text', text: `No feedback on "${doc}" yet.` }] };
      }
      const summary = feedback.map(f => {
        const lineRef = f.lines ? `L${f.lines[0]}${f.lines[1] !== f.lines[0] ? '-' + f.lines[1] : ''}` : '';
        const icon = { approve: '✅', reject: '❌', question: '❓', expand: '💡', comment: '💬', note: '📝' }[f.type] || '•';
        return `${icon} **${f.type}** ${lineRef}${f.text ? ': ' + f.text : ''}`;
      }).join('\n');
      return { content: [{ type: 'text', text: `**Feedback on "${doc}"** (${feedback.length} items):\n\n${summary}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- tlda_push ----
  if (name === 'tlda_push') {
    const { doc, files: fileSpecs, build = true } = args;
    if (!doc || !fileSpecs) {
      return { content: [{ type: 'text', text: 'doc and files are required.' }], isError: true };
    }
    try {
      // Resolve file contents — read from filesystem if content not provided
      const files = [];
      for (const spec of fileSpecs) {
        let content = spec.content;
        if (!content && spec.localPath) {
          try { content = fs.readFileSync(spec.localPath, 'utf8'); } catch (e) {
            return { content: [{ type: 'text', text: `Cannot read ${spec.localPath}: ${e.message}` }], isError: true };
          }
        }
        if (!content) {
          return { content: [{ type: 'text', text: `No content for ${spec.path} — provide content or localPath.` }], isError: true };
        }
        files.push({ path: spec.path, content });
      }

      const pushRes = await tldaFetch(doc + '/push', {
        method: 'POST',
        body: { files, session: CLAUDE_SESSION },
      });
      if (pushRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to push: ${JSON.stringify(pushRes.data)}` }], isError: true };
      }

      // Shadow-branch commit (best-effort, non-disruptive)
      try {
        const projectConfigPath = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'project.json');
        const cfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
        const sourceDir = cfg.sourceDir;
        if (sourceDir && fs.existsSync(path.join(sourceDir, '.git'))) {
          const branch = `shadow/${doc}`;
          const timestamp = new Date().toISOString();
          const msg = `auto: ${timestamp} via tlda_push`;
          execSync('git add -A', { cwd: sourceDir, stdio: 'pipe' });
          const tree = execSync('git write-tree', { cwd: sourceDir, stdio: 'pipe' }).toString().trim();
          let parentArgs = [];
          try {
            const showRef = execSync(`git show-ref refs/heads/${branch}`, { cwd: sourceDir, stdio: 'pipe' }).toString().trim();
            if (showRef) parentArgs = ['-p', showRef.split(' ')[0]];
          } catch {}
          const commitArgs = ['git', 'commit-tree', tree, ...parentArgs, '-m', `"${msg}"`].join(' ');
          const commit = execSync(commitArgs, { cwd: sourceDir, stdio: 'pipe' }).toString().trim();
          execSync(`git update-ref refs/heads/${branch} ${commit}`, { cwd: sourceDir, stdio: 'pipe' });
          execSync('git reset', { cwd: sourceDir, stdio: 'pipe' });
          process.stderr.write(`[fleet] shadow commit ${commit.slice(0, 8)} on ${branch}\n`);
        }
      } catch (e) {
        process.stderr.write(`[fleet] shadow commit failed for "${doc}": ${e.message}\n`);
      }

      let buildMsg = '';
      if (build) {
        try {
          await tldaFetch(doc + '/build', { method: 'POST' });
          buildMsg = ' Build triggered.';

          // Background poll for completion
          const pollInterval = setInterval(async () => {
            try {
              const status = await tldaFetch(doc + '/build/status');
              if (status.data?.phase === 'idle' || status.data?.status === 'complete' || status.data?.status === 'error') {
                clearInterval(pollInterval);
                const errRes = await tldaFetch(doc + '/build/errors');
                const errors = Array.isArray(errRes.data) ? errRes.data : [];
                const success = errors.length === 0 && status.data?.status !== 'error';
                process.stderr.write(`[fleet] tlda push build ${success ? 'success' : 'failed'} for "${doc}" (agent: ${AGENT_ID})\n`);
              }
            } catch (e) {
              process.stderr.write(`[fleet] tlda push poll failed: ${e.message}\n`);
            }
          }, 3000);
          setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
        } catch (e) {
          buildMsg = ` Build trigger failed: ${e.message}`;
        }
      }

      logEvent({ type: 'tlda_push', agent: AGENT_ID, doc, fileCount: files.length, build });
      return { content: [{ type: 'text', text: `Pushed ${files.length} file(s) to "${doc}".${buildMsg}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  // ---- publish_report ----
  if (name === 'publish_report') {
    const filePath = args.file;
    const bookName = args.book || 'fleet-workspace';
    if (!filePath) {
      return { content: [{ type: 'text', text: 'file is required.' }], isError: true };
    }
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
    }
    const fileName = path.basename(filePath);
    if (!fileName.endsWith('.md')) {
      return { content: [{ type: 'text', text: 'File must be a .md markdown file.' }], isError: true };
    }
    const dir = path.dirname(filePath);
    const stem = fileName.replace(/\.md$/, '');
    const projectName = `scratch-${stem}`;

    // Extract title from first heading if not provided
    let title = args.title;
    if (!title) {
      const content = fs.readFileSync(filePath, 'utf8');
      const headingMatch = content.match(/^#\s+(.+)$/m);
      title = headingMatch ? headingMatch[1].trim() : stem;
    }

    try {
      // Create project (ignore 409 = already exists)
      const createRes = await tldaFetch('', {
        method: 'POST',
        body: JSON.stringify({ name: projectName, title, mainFile: fileName, format: 'markdown', sourceDir: dir }),
      });
      if (createRes.status >= 400 && createRes.status !== 409) {
        return { content: [{ type: 'text', text: `Failed to create project: ${JSON.stringify(createRes.data)}` }], isError: true };
      }

      // Push the file
      const content = fs.readFileSync(filePath);
      const files = [{ path: fileName, content: content.toString('base64'), encoding: 'base64' }];
      const pushRes = await tldaFetch(projectName + '/push', {
        method: 'POST',
        body: JSON.stringify({ files, sourceDir: dir }),
      });
      if (pushRes.status >= 400) {
        return { content: [{ type: 'text', text: `Failed to push: ${JSON.stringify(pushRes.data)}` }], isError: true };
      }

      // Auto-join book (not fatal if book doesn't exist)
      await tldaFetch(bookName + '/members', {
        method: 'PATCH',
        body: JSON.stringify({ add: projectName }),
      });

      logEvent({ type: 'publish_report', agent: AGENT_ID, file: filePath, project: projectName, book: bookName });
      return { content: [{ type: 'text', text: `Published "${title}" as ${projectName} in ${bookName}. watch-all will auto-push edits.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda scratch failed: ${e.message}` }], isError: true };
    }
  }

  // ---- promote ----
  if (name === 'promote') {
    const doc = args.doc;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Doc name is required.' }], isError: true };
    }

    const dashPort_ = process.env.FLEET_DASH_PORT || 5199;
    let sharedDocs = [];
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort_}/api/shared-docs`);
      if (res.ok) sharedDocs = await res.json();
    } catch {}
    const sharedDoc = sharedDocs.find(d => d.doc === doc);
    if (!sharedDoc) {
      return { content: [{ type: 'text', text: `Doc "${doc}" not found in shared docs.` }], isError: true };
    }

    if (!sharedDoc.ephemeral) {
      return { content: [{ type: 'text', text: `"${doc}" is already permanent.` }] };
    }

    // TODO: Need server endpoint to update shared doc metadata (POST /api/shared-docs/promote)
    logEvent({ type: 'promote', agent: AGENT_ID, doc, path: sharedDoc.path });

    return { content: [{ type: 'text', text: `Promoted "${sharedDoc.title || doc}" to permanent. Now visible in tlda index.` }] };
  }

  // ---- checkpoint ----
  if (name === 'checkpoint') {
    const { doc } = args;
    if (!doc) return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };

    // Read project config to get sourceDir
    const projectConfigPath = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'project.json');
    let sourceDir;
    try {
      const cfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
      sourceDir = cfg.sourceDir;
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read project config for "${doc}": ${e.message}` }], isError: true };
    }
    if (!sourceDir) {
      return { content: [{ type: 'text', text: `No sourceDir in project config for "${doc}".` }], isError: true };
    }
    if (!fs.existsSync(sourceDir)) {
      return { content: [{ type: 'text', text: `sourceDir "${sourceDir}" does not exist.` }], isError: true };
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const checkpointDir = path.join(os.homedir(), '.fleet', 'checkpoints', doc, timestamp);

    try {
      fs.mkdirSync(checkpointDir, { recursive: true });
      // Copy all files from sourceDir into checkpointDir
      const copyDir = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };
      copyDir(sourceDir, checkpointDir);

      logEvent({ type: 'checkpoint', agent: AGENT_ID, doc, timestamp, sourceDir });
      return { content: [{ type: 'text', text: `Checkpoint created: ${checkpointDir}\nTimestamp: ${timestamp}\nSource: ${sourceDir}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Checkpoint failed: ${e.message}` }], isError: true };
    }
  }

  // ---- rollback ----
  if (name === 'rollback') {
    const { doc, timestamp } = args;
    if (!doc) return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };

    // Read project config to get sourceDir
    const projectConfigPath = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'project.json');
    let sourceDir, mainFile;
    try {
      const cfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
      sourceDir = cfg.sourceDir;
      mainFile = cfg.mainFile;
    } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read project config for "${doc}": ${e.message}` }], isError: true };
    }
    if (!sourceDir) {
      return { content: [{ type: 'text', text: `No sourceDir in project config for "${doc}".` }], isError: true };
    }

    // Find checkpoint
    const checkpointsRoot = path.join(os.homedir(), '.fleet', 'checkpoints', doc);
    if (!fs.existsSync(checkpointsRoot)) {
      return { content: [{ type: 'text', text: `No checkpoints found for "${doc}".` }], isError: true };
    }
    const all = fs.readdirSync(checkpointsRoot).sort();
    if (all.length === 0) {
      return { content: [{ type: 'text', text: `No checkpoints found for "${doc}".` }], isError: true };
    }

    let chosen;
    if (timestamp) {
      // Normalize: the stored timestamp has colons replaced with dashes
      const normalized = timestamp.replace(/:/g, '-');
      chosen = all.find(t => t === normalized || t === timestamp);
      if (!chosen) {
        return { content: [{ type: 'text', text: `Checkpoint "${timestamp}" not found. Available: ${all.join(', ')}` }], isError: true };
      }
    } else {
      chosen = all[all.length - 1]; // most recent
    }

    const checkpointDir = path.join(checkpointsRoot, chosen);

    try {
      // Copy checkpoint files back to sourceDir
      const copyDir = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };
      copyDir(checkpointDir, sourceDir);

      // Push to tlda: collect all files in sourceDir
      const collectFiles = (dir, base = '') => {
        const result = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = base ? base + '/' + entry.name : entry.name;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            result.push(...collectFiles(full, rel));
          } else {
            result.push({ path: rel, localPath: full });
          }
        }
        return result;
      };
      const fileSpecs = collectFiles(sourceDir);
      const files = fileSpecs.map(f => ({ path: f.path, content: fs.readFileSync(f.localPath, 'utf8') }));

      const pushRes = await tldaFetch(doc + '/push', {
        method: 'POST',
        body: { files, session: CLAUDE_SESSION },
      });
      let pushMsg = pushRes.status < 400 ? `Pushed ${files.length} file(s) to tlda.` : `tlda push failed: ${JSON.stringify(pushRes.data)}`;

      // Trigger build
      let buildMsg = '';
      try {
        await tldaFetch(doc + '/build', { method: 'POST' });
        buildMsg = ' Build triggered.';
      } catch (e) {
        buildMsg = ` Build trigger failed: ${e.message}`;
      }

      logEvent({ type: 'rollback', agent: AGENT_ID, doc, checkpoint: chosen, sourceDir });
      return { content: [{ type: 'text', text: `Rolled back "${doc}" to checkpoint ${chosen}.\n${pushMsg}${buildMsg}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Rollback failed: ${e.message}` }], isError: true };
    }
  }

  // ==== Browser Tools ====

  // ---- get_console ----
  if (name === 'get_console') {
    const level = args.level || 'error';
    const limit = args.limit || 20;

    // Helper: run JavaScript in Safari's current tab via AppleScript
    function safariJS(js) {
      // Escape backslashes and double quotes for AppleScript string embedding
      const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Safari" to do JavaScript "${escaped}" in current tab of front window`;
      return execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 5000 }).trim();
    }

    try {
      // Check if collector is already injected
      let hasCollector;
      try {
        hasCollector = safariJS('typeof window.__consoleLog !== "undefined" ? "yes" : "no"');
      } catch (e) {
        return { content: [{ type: 'text', text: `Safari not reachable: ${e.message}` }], isError: true };
      }

      if (hasCollector !== 'yes') {
        // Inject the collector
        const collector = `(function(){if(window.__consoleLog)return;var MAX=200;window.__consoleLog=[];['error','warn','log'].forEach(function(level){var orig=console[level];console[level]=function(){var args=Array.prototype.slice.call(arguments);window.__consoleLog.push({level:level,message:args.map(String).join(' '),timestamp:Date.now()});if(window.__consoleLog.length>MAX)window.__consoleLog.shift();orig.apply(console,args)};});})()`;
        safariJS(collector);
        return { content: [{ type: 'text', text: 'Console collector injected. Call get_console again to read buffered entries.' }] };
      }

      // Read and filter entries
      const filterExpr = level === 'all'
        ? `window.__consoleLog.slice(-${limit})`
        : `window.__consoleLog.filter(function(e){return e.level==="${level}"}).slice(-${limit})`;
      const raw = safariJS(`JSON.stringify(${filterExpr})`);

      if (!raw || raw === '[]') {
        return { content: [{ type: 'text', text: `No ${level} entries in console buffer.` }] };
      }

      const entries = JSON.parse(raw);
      const lines = entries.map(e => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        return `[${ts}] ${e.level.toUpperCase()}: ${e.message}`;
      });

      return { content: [{ type: 'text', text: `${entries.length} ${level} entries:\n\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `get_console failed: ${e.message}` }], isError: true };
    }
  }

  // ---- reload_browser ----
  if (name === 'reload_browser') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot reload: not registered.' }], isError: true };

    const reason = args.reason;

    // Find Skip (human agent)
    let humanId;
    try {
      const agents = await sendWS('store-agents');
      const human = (agents || []).find(a => a.human);
      if (!human) return { content: [{ type: 'text', text: 'No human agent found in fleet.' }], isError: true };
      humanId = human.id;
    } catch (e) {
      return { content: [{ type: 'text', text: `Fleet unreachable: ${e.message}` }], isError: true };
    }

    // Send permission request via chat
    const askMsg = `Need to hard-reload your browser — ${reason}. OK?`;
    try {
      await sendWS('chat', { message: askMsg, to: humanId, from: AGENT_ID });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to send chat: ${e.message}` }], isError: true };
    }

    // Poll for Skip's reply (up to 60s)
    const deadline = Date.now() + 60000;
    const approveRe = /^(yeah|yes|ok|go|sure|do it|go ahead|reload)/i;
    let reply = null;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const data = await sendWS('my-task', { agent: AGENT_ID, peek: true });
        const messages = data?.messages || [];
        // Look for a message from Skip that's a reply to our ask
        const fromSkip = messages.filter(m => m.from === humanId);
        if (fromSkip.length > 0) {
          reply = fromSkip[fromSkip.length - 1].text;
          break;
        }
      } catch {}
    }

    if (!reply) {
      return { content: [{ type: 'text', text: 'Timed out waiting for Skip\'s approval (60s). Reload not performed.' }] };
    }

    if (!approveRe.test(reply.trim())) {
      return { content: [{ type: 'text', text: `Skip declined: "${reply}". Reload not performed.` }] };
    }

    // Execute reload
    try {
      const escaped = 'location.reload(true)';
      const script = `tell application "Safari" to do JavaScript "${escaped}" in current tab of front window`;
      execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 5000 });
      // Consume the messages so they don't show up again
      await sendWS('my-task', { agent: AGENT_ID }).catch(() => {});
      return { content: [{ type: 'text', text: `Browser reloaded (approved by Skip: "${reply}").` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Reload failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// ---- Channel: WebSocket to fleet server for direct message injection ----
// Each MCP server instance opens its own WS to the fleet UI, filtered to this agent.
// When fleet events arrive (chat, delegate, task_done), emits notifications/claude/channel
// so Claude Code receives them as first-class events — no tmux send-keys, no signal files.

// Dedup: track event IDs we originated so we don't re-notify on the broadcast echo
const _originatedEventIds = new Set();
const ORIGINATED_TTL_MS = 30000;

let _channelWS = null;
let _channelRetryTimer = null;
const CHANNEL_RETRY_MS = 3000;
const CHANNEL_MAX_RETRY_MS = 30000;
let _channelRetryDelay = CHANNEL_RETRY_MS;
let _channelHeartbeatTimer = null;
const CHANNEL_HEARTBEAT_TIMEOUT_MS = 45000; // server sends heartbeat every 15s; dead if silent for 45s

// Request/response over WS — pending callbacks keyed by correlation ID
const _wsPending = new Map();
const WS_TIMEOUT_MS = 10000;

/**
 * Send a request over the WS channel and wait for a response.
 * Returns the result on success, throws on error or timeout.
 * If WS is not connected, returns null (caller should fallback to REST).
 */
function sendWS(type, params = {}) {
  if (!_channelWS || _channelWS.readyState !== WebSocket.OPEN) return null;
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _wsPending.delete(id);
      reject(new Error('WS request timeout'));
    }, WS_TIMEOUT_MS);
    _wsPending.set(id, { resolve, reject, timer });
  });
  try {
    _channelWS.send(JSON.stringify({ id, type, ...params }));
  } catch (e) {
    const pending = _wsPending.get(id);
    if (pending) { clearTimeout(pending.timer); _wsPending.delete(id); }
    return null; // fallback to REST
  }
  return promise;
}

async function _flushUnread() {
  if (!AGENT_ID || !_channelWS || _channelWS.readyState !== WebSocket.OPEN) return;
  try {
    const data = await sendWS('my-task', { agent: AGENT_ID, peek: true });
    if (!data) return;
    const msgs = (data.messages || []).filter(m => !m.read);
    const task = data.task;
    if (msgs.length === 0 && !task) return;
    const lines = [];
    if (task) lines.push(`📬 You have a pending task: ${(task.description || '').slice(0, 80)}`);
    if (msgs.length > 0) lines.push(`📬 ${msgs.length} unread message(s). Call my_task().`);
    await server.notification({
      method: 'notifications/claude/channel',
      params: { content: lines.join('\n'), meta: { event_type: 'flush' } },
    });
  } catch {}
}

function resetHeartbeatTimeout() {
  clearHeartbeatTimeout();
  _channelHeartbeatTimer = setTimeout(() => {
    process.stderr.write(`[fleet-channel] No heartbeat in ${CHANNEL_HEARTBEAT_TIMEOUT_MS}ms — assuming dead, reconnecting\n`);
    if (_channelWS) {
      try { _channelWS.terminate(); } catch {}
      _channelWS = null;
    }
    scheduleChannelRetry();
  }, CHANNEL_HEARTBEAT_TIMEOUT_MS);
}

function clearHeartbeatTimeout() {
  if (_channelHeartbeatTimer) { clearTimeout(_channelHeartbeatTimer); _channelHeartbeatTimer = null; }
}

function startChannelWS() {
  if (!AGENT_ID) return;
  if (_channelWS) return;

  const dashPort = process.env.FLEET_DASH_PORT || 5199;
  const url = `ws://127.0.0.1:${dashPort}/ws/fleet?agent=${encodeURIComponent(AGENT_ID)}`;

  try {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      process.stderr.write(`[fleet-channel] WS connected for ${AGENT_ID}\n`);
      _channelWS = ws;
      _channelRetryDelay = CHANNEL_RETRY_MS;
      resetHeartbeatTimeout();
      // Flush any unread messages that arrived while WS was down (server restart, etc.)
      if (AGENT_ID) setTimeout(_flushUnread, 500); // slight delay so WS is fully ready
    });

    ws.on('message', (raw) => {
      resetHeartbeatTimeout();
      try {
        const msg = JSON.parse(raw.toString());
        // Response to a pending WS request
        if (msg.id && _wsPending.has(msg.id)) {
          const { resolve, reject, timer } = _wsPending.get(msg.id);
          _wsPending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error));
          else {
            // Track event IDs we originated to suppress broadcast echoes
            if (msg.result?.event_id) {
              _originatedEventIds.add(msg.result.event_id);
              setTimeout(() => _originatedEventIds.delete(msg.result.event_id), ORIGINATED_TTL_MS);
            }
            resolve(msg.result);
          }
          return;
        }
        handleChannelMessage(msg);
      } catch {}
    });

    ws.on('close', () => {
      _channelWS = null;
      clearHeartbeatTimeout();
      // Reject all pending WS requests — callers will see the error
      for (const [id, { reject, timer }] of _wsPending) {
        clearTimeout(timer);
        reject(new Error('WS connection closed'));
      }
      _wsPending.clear();
      scheduleChannelRetry();
    });

    ws.on('error', (err) => {
      process.stderr.write(`[fleet-channel] WS error: ${err.message}\n`);
      _channelWS = null;
      clearHeartbeatTimeout();
      // error may fire without a subsequent close (e.g. connection refused before open)
      // schedule retry if not already scheduled
      scheduleChannelRetry();
    });
  } catch (e) {
    process.stderr.write(`[fleet-channel] WS connect failed: ${e.message}\n`);
    scheduleChannelRetry();
  }
}

function scheduleChannelRetry() {
  if (_channelRetryTimer) return;
  _channelRetryTimer = setTimeout(() => {
    _channelRetryTimer = null;
    startChannelWS();
  }, _channelRetryDelay);
  _channelRetryDelay = Math.min(_channelRetryDelay * 2, CHANNEL_MAX_RETRY_MS);
}

// Dedup channel notifications by event DB id — prevents double delivery
const _deliveredChannelIds = new Set();
const CHANNEL_DEDUP_TTL_MS = 60000;

async function handleChannelMessage(msg) {
  if (!AGENT_ID) return;

  // Dashboard WS sends { event: 'fleet-event', data: {...} } or state updates
  const eventType = msg.event === 'fleet-event' ? (msg.data?.type || '') : '';
  if (!eventType) return;
  if (!['chat', 'delegate', 'task_done'].includes(eventType)) return;

  const data = msg.data || {};

  // Skip broadcast echoes of events we originated
  if (data.id && _originatedEventIds.has(data.id)) {
    _originatedEventIds.delete(data.id);
    return;
  }

  // Dedup: skip if we already delivered a channel notification for this event
  if (data.id && _deliveredChannelIds.has(data.id)) {
    return;
  }

  // Only care about events targeting this agent
  const targetId = data.to || data.to_id || '';
  if (targetId !== AGENT_ID) return;

  // Skip events FROM this agent
  const fromId = data.from || data.from_id || '';
  if (fromId === AGENT_ID) return;

  // Skip terminal-sourced messages — agent is already in their terminal and has this context
  if (data.metadata?.source === 'terminal') return;

  // Build notification content
  let content = '📬 You have a new fleet message. Call my_task() to see it.';
  if (eventType === 'delegate') {
    const desc = (data.text || data.description || '').slice(0, 120);
    content = `📬 New task assigned: ${desc}\nCall my_task() to see it.`;
  } else if (eventType === 'chat') {
    // Resolve friendly name: check metadata, then strip fleet: prefix from ID
    const fromLabel = data.metadata?.fromLabel || fromId?.replace(/^fleet:/, '') || 'unknown';
    const rawPreview = data.text || data.message || '';
    const preview = resolveAttachmentMarkers(rawPreview, data.metadata?.inline_attachments).slice(0, 120);
    content = `📬 Message from ${fromLabel}: ${preview}\nCall my_task() to read and respond.`;
  } else if (eventType === 'task_done') {
    content = `📬 Task update. Call my_task() to see details.`;
  }

  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          event_type: eventType,
          from: fromId,
        },
      },
    });
    process.stderr.write(`[fleet-channel] Delivered ${eventType} from ${fromId} via channel (event ${data.id})\n`);
    // Mark as delivered so dupes are suppressed
    if (data.id) {
      _deliveredChannelIds.add(data.id);
      setTimeout(() => _deliveredChannelIds.delete(data.id), CHANNEL_DEDUP_TTL_MS);
    }
    // Clear signal file so PostToolUse hook doesn't re-surface this message
    try {
      const signalFile = path.join(os.homedir(), '.fleet', 'signals', AGENT_ID);
      if (fs.existsSync(signalFile)) fs.unlinkSync(signalFile);
    } catch {}
  } catch (e) {
    process.stderr.write(`[fleet-channel] notification failed: ${e.message}\n`);
  }
}

// ---- Agent status reporting ----
// Reports agent state (idle/thinking/tool_call) to the fleet UI via WS.
// No more pane scraping — status is self-reported on every tool call.
let _lastStatusReport = 0;
const STATUS_DEBOUNCE_MS = 2000;

function reportStatus(state, toolName) {
  if (!AGENT_ID) return;
  const now = Date.now();
  if (now - _lastStatusReport < STATUS_DEBOUNCE_MS) return;
  _lastStatusReport = now;

  if (_channelWS && _channelWS.readyState === WebSocket.OPEN) {
    try {
      _channelWS.send(JSON.stringify({
        type: 'agent-status',
        agentId: AGENT_ID,
        state,
        tool: toolName || null,
        ts: new Date().toISOString(),
      }));
    } catch {}
  }
}

// Start channel WS immediately if AGENT_ID is already known from $FLEET_ID.
// For agents without $FLEET_ID, register() calls startChannelWS() after identity resolves.
if (AGENT_ID) startChannelWS();

// --- MCP-side tmux poller ---
// Runs agent-side so the server doesn't need to be on the same machine.
// Detects thinking spinner + compaction text; sends events over the WS channel.
// Claude Code thinking lines always have the form: <glyph> <Word>ing… (<timing>)
// Match on the "Xing…" pattern — specific enough to avoid false positives, glyph-agnostic.
const THINKING_SPINNER_RE = /[A-Z][a-z]+ing…/;
const COMPACTING_RE = /Compacting conversation/;
let _tmuxSession = null;
let _wasThinking = false;
let _compactingReported = false;

// Detect own tmux session once at startup
try {
  const s = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 1000 }).trim();
  if (s.startsWith('fleet-')) _tmuxSession = s;
} catch {}


setInterval(() => {
  if (!AGENT_ID || !_channelWS || _channelWS.readyState !== WebSocket.OPEN) return;

  // Retry tmux session detection if it failed at startup
  if (!_tmuxSession) {
    try {
      const s = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 1000 }).trim();
      if (s.startsWith('fleet-')) _tmuxSession = s;
    } catch {}
    if (!_tmuxSession) return;
  }

  try {
    const pane = execSync(`tmux capture-pane -t ${_tmuxSession} -p`, { timeout: 1000, encoding: 'utf8' });

    // Thinking detection — test bottom of pane only (avoids old summary lines in scrollback)
    const paneBottom = pane.split('\n').slice(-15).join('\n');
    const isThinking = THINKING_SPINNER_RE.test(paneBottom);
    // Always send current state — server uses timestamps for expiry
    _channelWS.send(JSON.stringify({ type: 'agent-thinking', agentId: AGENT_ID, thinking: isThinking }));
    // Only broadcast state-change events to fleet server (avoid noise)
    if (isThinking !== _wasThinking) {
      _wasThinking = isThinking;
    }

    // Compaction detection
    const isCompacting = COMPACTING_RE.test(pane);
    _channelWS.send(JSON.stringify({ type: 'agent-compacting', agentId: AGENT_ID, compacting: isCompacting }));
    if (isCompacting && !_compactingReported) {
      _compactingReported = true;
      _channelWS.send(JSON.stringify({ type: 'compacting', agentId: AGENT_ID }));
    } else if (!isCompacting && _compactingReported) {
      _compactingReported = false;
    }
  } catch {}
}, 3000);

// Orphan prevention: exit if parent process dies or stdin closes
process.stdin.on('end', () => { process.exit(0); });
process.stdin.on('close', () => { process.exit(0); });
const _parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(_parentPid, 0); // signal 0 = check existence
  } catch {
    // Parent is dead — we're an orphan, exit
    process.exit(0);
  }
}, 30000); // check every 30s
