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
import { SearchIndex } from './dashboard/search-index.mjs';
// FleetStore import removed — MCP server is a REST client, no direct DB access
import { SessionExtractor, EventExtractor, TldaExtractor } from './playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback, playbackTranscript } from './playback/storage.mjs';
import { ledger } from './identity.mjs';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

// Get the Claude Code process's working directory (the agent's project root).
// process.env.PWD reflects the MCP's own cwd (set to /work/tlda for module
// resolution), NOT the agent's project directory. Instead, read the parent
// process's cwd via lsof — that's the claude process that spawned this MCP.
let _agentCwdCache = null;
function getAgentCwd() {
  if (_agentCwdCache !== null) return _agentCwdCache;
  try {
    const out = execSync(`lsof -a -d cwd -p ${process.ppid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const line = out.trim().split('\n').find(l => /\s+cwd\s+/.test(l));
    if (line) {
      const cwd = line.trim().split(/\s+/).pop();
      if (cwd && cwd.startsWith('/')) {
        _agentCwdCache = cwd;
        return cwd;
      }
    }
  } catch {}
  _agentCwdCache = process.env.PWD || null;
  return _agentCwdCache;
}

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

// Fleet store — REMOVED. MCP server is a REST client; all reads/writes go through the dashboard server.
// getFleetStore() is gone. Use fetch() to the dashboard server instead.

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
  // Broadcast non-handled event types to dashboard via fleet-event endpoint
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

// Most recent tlda doc this agent is working with — set by monitor_add and
// used by chat() to stamp outgoing messages with { doc, version } so the
// recipient knows which document state the sender was reasoning about.
let _currentDoc = null;
let _docVersionCache = { doc: null, version: null, ts: 0 };
const DOC_VERSION_CACHE_MS = 5000;

async function fetchCurrentDocVersion(doc) {
  if (!doc) return null;
  const now = Date.now();
  if (_docVersionCache.doc === doc && now - _docVersionCache.ts < DOC_VERSION_CACHE_MS) {
    return _docVersionCache.version;
  }
  try {
    const tldaPort = process.env.TLDA_PORT || 5176;
    const headers = _tldaToken ? { Authorization: `Bearer ${_tldaToken}` } : {};
    const res = await fetch(`http://127.0.0.1:${tldaPort}/api/projects/${encodeURIComponent(doc)}/history/shadow?limit=1`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data?.versions?.[0];
    const hash = v?.hash || v?.commitHash || v?.id || null;
    const version = typeof hash === 'string' ? hash.slice(0, 12) : null;
    _docVersionCache = { doc, version, ts: now };
    return version;
  } catch {
    return null;
  }
}
// Detect Claude session ID at startup. Claude Code maintains a per-PID
// metadata file at ~/.claude/sessions/<PID>.json that maps the Claude Code
// process PID to its sessionId. Since the fleet MCP runs as a stdio child
// of Claude Code, process.ppid is exactly the Claude Code process whose
// session we belong to — a deterministic lookup, no birthtime guessing,
// no collisions when multiple agents share a cwd.
//
// The previous implementation scanned the project dir for the freshest
// JSONL by birthtime. That heuristic was wrong when multiple agents
// shared a cwd (the freshest JSONL might be another agent's, not ours)
// and was the root cause of the recurring "agent X has my session_id"
// data corruption.
//
// Fallback: if the PID-keyed file is missing for any reason (older
// Claude Code, races at startup, etc.), fall back to the old birthtime
// heuristic so we degrade gracefully rather than refuse to start.
// Detect Claude session ID at startup. Claude Code maintains a per-PID
// metadata file at ~/.claude/sessions/<PID>.json that maps the Claude Code
// process PID to its sessionId. The fleet MCP runs as a stdio child of
// Claude Code, so process.ppid is exactly the Claude Code process whose
// session we belong to — a deterministic lookup, no birthtime guessing,
// no collisions when multiple agents share a cwd.
//
// No fallback. The previous birthtime-scan fallback was the source of
// the recurring "agent X has my session_id" data corruption bug — when
// multiple agents share a cwd, the freshest birthtime is often another
// agent's, not ours. If the PID-keyed file isn't available, return null
// and let register() either pass an explicit session_id or fail loudly.
let CLAUDE_SESSION = (function detectSessionAtStartup() {
  try {
    const ppid = process.ppid;
    if (!ppid || ppid <= 1) return null;
    const sessionFile = path.join(os.homedir(), '.claude', 'sessions', `${ppid}.json`);
    if (!fs.existsSync(sessionFile)) return null;
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (data && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
      return data.sessionId;
    }
    return null;
  } catch (e) {
    process.stderr.write(`[fleet] detectSessionAtStartup error: ${e.message}\n`);
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

// ---- tmux helpers ----

function tmuxHasSession(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch { return false; }
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

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
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
      name: 'reclaim_identity',
      description: 'Reclaim a fleet identity for the current agent. Use when identity detection got it wrong (e.g. after MCP restart in a shared cwd). Sets this agent\'s fleet ID to the specified one.',
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
      name: 'request_terminal',
      description: 'Voluntarily ask the user to look at your terminal — pops a live terminal card in their fleet chat that mirrors your tmux session. Use when you are stuck on something the user needs to do interactively (e.g. a permission prompt that survives `tlda watch start`, an external login). Do NOT use for routine status — that is what `chat()` is for. The user can dismiss the card to freeze a snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short one-line reason that will be shown above the terminal card (e.g. "stuck on permission prompt", "need brew sudo password"). Optional but strongly preferred.' },
        },
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
      name: 'read_terminal',
      description: 'Read an agent\'s tmux terminal pane. Returns the visible output. Pass agent name or ID.',
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
    // ---- tlda document feedback (push channel) ----
    {
      name: 'monitor_add',
      description: 'Subscribe to push notifications for new annotations on a tlda document. When Skip draws a note, highlight, or sends a ping on the doc, you will receive a fleet chat message from "fleet:tlda" between tool calls — same delivery path as normal chat. Idempotent. Persists for the lifetime of this session (cleared on MCP reconnect or tlda server restart).',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman", "survival-draft"). No need to call from a specific cwd.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'monitor_remove',
      description: 'Unsubscribe from feedback notifications for a tlda document. Idempotent — no error if not subscribed.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name to stop monitoring.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'monitor_list',
      description: 'List tlda documents this agent is currently subscribed to for feedback notifications.',
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
      name: 'reassign_identity',
      description: 'Reassign a fleet identity to a different agent. The new agent inherits the old fleet ID, friendly name, tasks, and message history. Use when an agent dies and is replaced by a fresh session. ',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The new agent to receive the identity (session UUID, name, or friendly name)' },
          identity: { type: 'string', description: 'The old fleet ID (or friendly name) to reassign' },
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
      description: 'Set labels on an agent. Labels are tags for filtering and grouping agents in the dashboard. ',
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
      name: 'batch_respawn',
      description: 'Batch respawn dead agents into tmux sessions. Finds dead agents with known session_ids and resumes them in tmux.',
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
    // ---- Checkpoint / Rollback REMOVED ----
    // Use doc_checkout (tldraw-feedback MCP) instead — shadow repo auto-saves on every build.
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Report tool_call status to dashboard (replaces pane scraping for idle detection)
  reportStatus('tool_call', name);

  // ==== Registration & Identity ====

  // ---- register ----
  if (name === 'register' || name === 'register_manager') {
    const isManager = name === 'register_manager' || args.manager === true;
    const agentName = args.name || null;

    // The MCP process is preserved across compactions (it's a stdio child of
    // Claude Code), and Claude Code does NOT create a new JSONL file on
    // compaction — the same session UUID and JSONL file are reused for the
    // lifetime of the MCP. So CLAUDE_SESSION set at startup stays valid; no
    // post-compaction re-detect is needed. (An earlier version did re-scan
    // by birthtime here and stomped *other* agents' freshly-created JSONLs
    // onto this MCP's CLAUDE_SESSION, which then got written into the
    // wrong agent's record by the register handler. That was the source
    // of the long-running "activity cards stop working" bug.)
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
      // preserve compacting for one SSE cycle so the dashboard sees the transition
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
    const _detectedCwd = getAgentCwd();
    if (_detectedCwd) entry.cwd = _detectedCwd;
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

    // Set this process's fleet identity
    AGENT_ID = entry.id;

    // Update the identity ledger
    const cwd = entry.cwd || process.env.PWD || null;
    ledger.upsertAgent(AGENT_ID, claudeSession, cwd, entry.friendly_name);

    // Register via server WS — wait briefly if WS not yet connected.
    // machine_id mirrors fleet-daemon's deriveMachineId(): the short
    // hostname (everything before the first dot). Stable per box, lets
    // the tlda server route RPCs (interrupt / send-key / capture-pane /
    // restart-mcp) to the right per-machine fleet-daemon.
    const machineId = os.hostname().split('.')[0];
    const regBody = {
      id: entry.id,
      name: entry.friendly_name,
      session_id: entry.session_id,
      tmux_session: entry.tmux_session,
      cwd: entry.cwd,
      labels: entry.labels,
      manager: entry.is_manager,
      machine_id: machineId,
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
    msg += '\nChat formatting: dashboard renders markdown (**bold**, `code`, lists, headers) and LaTeX ($inline$, $$display$$). Use them in chat() messages.';

    // Health check: report what's up/down so agent knows communication channels
    const health = [];
    try {
      const tldaPort = process.env.TLDA_PORT || 5176;
      const tldaRes = await fetch(`http://127.0.0.1:${tldaPort}/api/projects`, { signal: AbortSignal.timeout(2000) });
      health.push((tldaRes.ok || tldaRes.status === 401) ? 'tlda: ✔' : 'tlda: ✘ (not responding)');
    } catch {
      health.push('tlda: ✘ (unreachable)');
    }
    health.push(_channelWS && _channelWS.readyState === 1 ? 'fleet WS: ✔' : 'fleet WS: ✘ (not connected)');
    msg += `\n\nHealth: ${health.join(', ')}`;
    if (health.some(h => h.includes('✘'))) {
      msg += '\n⚠ Some services are down. If tlda is down, Skip cannot see fleet chat — use terminal output instead.';
    }

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

  // ---- reclaim_identity ----
  if (name === 'reclaim_identity') {
    const targetFleetId = args.fleet_id;
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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
    const dashPort_ = process.env.FLEET_DASH_PORT || 5176;
    let recipients = [];
    let serverDown = false;
    try {
      const agents = await sendWS('store-agents');
      for (const a of agents) {
        if (a.id === AGENT_ID) continue;
        const labels = [...(a.labels || []), a.friendly_name, a.id].filter(Boolean);
        if (args.filter.to.some(andGroup => andGroup.every(term => labels.includes(term)))) {
          recipients.push(a.id);
        }
      }
    } catch (e) {
      serverDown = true;
    }
    if (serverDown) return { content: [{ type: 'text', text: '⚠ Fleet server is unreachable — message NOT sent. Check if the server is running (fleet-spawn auto-starts it, or: cd ~/work/fleet && node dashboard/server.mjs).' }], isError: true };
    if (recipients.length === 0) return { content: [{ type: 'text', text: 'No agents matched filter.' }], isError: true };

    // Resolve file paths in message text → inline attachments.
    //
    // Skip's rule: backtick-quoted text is a "quote" and must NOT be
    // chipified. That covers single-backtick inline spans and triple-
    // backtick fenced code blocks. Mask both before running the path
    // regex, restore after. Fences are masked first so inline spans
    // inside a fence don't get stripped separately.
    const agentCwd = getAgentCwd();
    let resolvedMessage = message;
    const inlineAttachments = [];
    if (agentCwd) {
      const PATH_EXT = 'md|R|qmd|py|mjs|js|ts|tsx|jsx|css|html|tex|bib|rds|csv|tsv|txt|sh|yml|yaml|json|toml|cfg|log|svg|png|jpg|jpeg|gif|webp|pdf|sql|xml|rs|go|c|h|cpp|hpp|lua|rb|jl|rmd';
      const pathRe = new RegExp(
        `(?<![\\/\\w])(~?\\/[\\w.\\-\\/]+\\.(?:${PATH_EXT})|[\\w][\\w.\\-\\/]*\\.(?:${PATH_EXT}))(?!\\w)`,
        'g'
      );
      // Mask out backtick-quoted regions so the path regex skips over them.
      // SENTINEL uses \x00 which can't appear in agent-authored text.
      const masked = [];
      const maskToken = (kind, raw) => {
        const i = masked.length;
        masked.push(raw);
        return `\x00${kind}${i}\x00`;
      };
      // 1. Triple-backtick fenced code blocks (may contain newlines)
      let working = message.replace(/```[\s\S]*?```/g, (m) => maskToken('F', m));
      // 2. Single-backtick inline spans (no newlines, non-empty interior)
      working = working.replace(/`[^`\n]+`/g, (m) => maskToken('I', m));

      let attIdx = 0;
      working = working.replace(pathRe, (match, filePath) => {
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

      // Restore masked regions (inline spans first, then fences — reverse of masking order)
      working = working.replace(/\x00I(\d+)\x00/g, (_, i) => masked[+i]);
      working = working.replace(/\x00F(\d+)\x00/g, (_, i) => masked[+i]);
      resolvedMessage = working;
    }

    // Upload file attachments to dashboard server so they're accessible via URL
    const dashPortUpload = process.env.FLEET_DASH_PORT || 5176;
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

    // Stamp the message with the agent's current doc context (set by
    // monitor_add). Skip wants every chat tagged with { doc, version } so
    // the recipient can correlate the message to a specific document state.
    let docContext = null;
    if (_currentDoc) {
      const version = await fetchCurrentDocVersion(_currentDoc);
      docContext = { doc: _currentDoc, version: version || null };
    }

    // Single write: send to dashboard server via WS.
    const sent = [];
    const failed = [];
    for (const to of recipients) {
      const chatBody = { message: resolvedMessage, to, from: AGENT_ID };
      if (inlineAttachments.length) chatBody.inline_attachments = inlineAttachments;
      if (refAttachments.length) chatBody.attachments = refAttachments;
      if (docContext) chatBody.context = docContext;
      try {
        const data = await sendWS('chat', chatBody);
        if (data?.ok) sent.push(to);
        else failed.push(to);
      } catch (e) {
        failed.push(`${to} (${e.message})`);
      }
    }

    if (sent.length === 0) return { content: [{ type: 'text', text: `⚠ Send failed — fleet server may be down. No messages delivered. Failed: ${failed.join(', ')}` }], isError: true };

    // Check if tlda is up — if not, Skip can't see the message even though it was delivered
    let tldaDown = false;
    try {
      const tldaPort = process.env.TLDA_PORT || 5176;
      const tldaRes = await fetch(`http://127.0.0.1:${tldaPort}/api/projects`, { signal: AbortSignal.timeout(2000) });
      // 401 means tlda is up but auth is required — that's fine, server is running
      if (!tldaRes.ok && tldaRes.status !== 401) tldaDown = true;
    } catch {
      tldaDown = true;
    }

    let warning = '';
    if (tldaDown) {
      warning = '\n\n⚠ **tlda is down — Skip cannot see this message.** Use terminal output to communicate until tlda is back up.';
    }

    return { content: [{ type: 'text', text: `Message queued for ${sent.join(', ')}.${warning}` }] };
  }

  // ---- request_terminal ----
  // Voluntary terminal-card pop. Hits the tlda server's /api/terminal-card
  // endpoint, which broadcasts a `terminal_card` fleet event to Skip — the
  // browser-side fleet chat opens a live TerminalCard mirroring this agent's
  // tmux session.
  if (name === 'request_terminal') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered. Call register() first.' }], isError: true };
    const { reason } = args || {};
    try {
      const tldaPort = process.env.TLDA_PORT || 5176;
      const res = await fetch(`http://127.0.0.1:${tldaPort}/api/terminal-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: AGENT_ID, reason: reason || null }),
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { content: [{ type: 'text', text: `request_terminal failed: ${data.error || res.statusText}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Terminal card opened for Skip${reason ? ` (reason: ${reason})` : ''}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `request_terminal failed: ${e.message}` }], isError: true };
    }
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

    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

  // ---- read_terminal (read agent's tmux pane) ----
  if (name === 'read_terminal') {
    if (!args.agent) {
      return { content: [{ type: 'text', text: 'Specify agent (name/ID).' }], isError: true };
    }

    // Look up agent via server API
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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
        text += `\n\n${task.message}`;
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
        const ctx = m.metadata?.context;
        const docHint = ctx?.doc
          ? ` [viewing ${ctx.doc}${ctx.version ? '@' + ctx.version : ''}${ctx.page ? ' p' + (Array.isArray(ctx.page) ? ctx.page.join(',') : ctx.page) : ''}]`
          : '';
        return `[from ${fromLabel}${docHint}]${replyHint} ${m.text}`;
      }).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
    }

    return { content: [{ type: 'text', text }] };
  }

  // ---- tlda monitor_add / monitor_remove / monitor_list ----
  // Subscribe/unsubscribe for doc feedback notifications. Delivery is via
  // fleet chat from "fleet:tlda" — the agent sees it exactly like a normal
  // chat message between tool calls. No polling, no PostToolUse hook.
  if (name === 'monitor_add') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered.' }], isError: true };
    if (!args?.doc) return { content: [{ type: 'text', text: 'Missing doc argument.' }], isError: true };
    try {
      const data = await sendWS('tlda-monitor-add', { agentId: AGENT_ID, doc: args.doc });
      if (!data) return { content: [{ type: 'text', text: 'Server unreachable (WS not connected).' }], isError: true };
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      // Remember the most recent doc this agent is watching so chat() can
      // stamp outgoing messages with a docContext (doc + version) without
      // requiring a separate set_doc tool.
      _currentDoc = args.doc;
      return { content: [{ type: 'text', text: `Monitoring "${args.doc}". Current subscriptions: ${subs.join(', ') || '(none)'}.\n\nFeedback will arrive as chat from fleet:tlda between tool calls.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `monitor_add failed: ${e.message}` }], isError: true };
    }
  }
  if (name === 'monitor_remove') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered.' }], isError: true };
    if (!args?.doc) return { content: [{ type: 'text', text: 'Missing doc argument.' }], isError: true };
    try {
      const data = await sendWS('tlda-monitor-remove', { agentId: AGENT_ID, doc: args.doc });
      if (!data) return { content: [{ type: 'text', text: 'Server unreachable (WS not connected).' }], isError: true };
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      return { content: [{ type: 'text', text: `Stopped monitoring "${args.doc}". Remaining subscriptions: ${subs.join(', ') || '(none)'}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `monitor_remove failed: ${e.message}` }], isError: true };
    }
  }
  if (name === 'monitor_list') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not registered.' }], isError: true };
    try {
      const data = await sendWS('tlda-monitor-list', { agentId: AGENT_ID });
      if (!data) return { content: [{ type: 'text', text: 'Server unreachable (WS not connected).' }], isError: true };
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      return { content: [{ type: 'text', text: subs.length ? `Monitoring: ${subs.join(', ')}` : 'Not monitoring any documents.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `monitor_list failed: ${e.message}` }], isError: true };
    }
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

  // ---- reassign_identity ----
  if (name === 'reassign_identity') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

    const fleetSpawnScript = path.join(os.homedir(), 'bin', 'fleet-spawn');
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

    // 3. Summary stats
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
      return { content: [{ type: 'text', text: 'Search index not available. The dashboard server builds the index — make sure it has run at least once.' }], isError: true };
    }

    const query = args.query;
    if (!query || query.length < 2) {
      return { content: [{ type: 'text', text: 'Query must be at least 2 characters.' }], isError: true };
    }

    const limit = Math.min(args.limit || 20, 100);
    const contextWindow = Math.min(Math.max(args.context || 0, 0), 20);
    const beforeTs = args.before || undefined;

    let agentIds;
    if (args.agent) {
      const dashPort_ = process.env.FLEET_DASH_PORT || 5176;
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
    }
    // Search session logs (entries_fts)
    let sessionResults = idx.search(query, { project: args.project || undefined, agent: agentIds, role: args.role || undefined, limit });

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

    // Log search event so dashboard can show what agents searched for
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
      const dashPort = process.env.FLEET_DASH_PORT || 5176;
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/store/events?agent=${encodeURIComponent(agentId)}&limit=${effectiveLimit}`);
      if (!res.ok) return;
      const { events } = await res.json();
      for (const e of (events || [])) {
        const text = e.type === 'delegate'
          ? `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`
          : e.type === 'task_done'
          ? `[DONE] ${e.description || ''}`
          : e.text || e.message || '';
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
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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
    // Restart another agent's fleet MCP by routing through the tlda server's
    // /api/restart-mcp endpoint, which delegates to the fleet-daemon's
    // rpcRestartMcp handler on the target agent's machine. The daemon runs
    // the fleet-mcp-restart script to navigate the /mcp menu via tmux.
    //
    // NOTE: can't restart YOUR OWN MCP this way — if your MCP is
    // disconnected you can't call this tool. For that, bash the
    // fleet-mcp-restart script directly.
    if (!args.agent) return { content: [{ type: 'text', text: 'Specify an agent to restart.' }], isError: true };
    if (args.agent === AGENT_ID) return { content: [{ type: 'text', text: 'Cannot restart your own MCP via this tool (if your MCP is disconnected, calling the tool is impossible). Bash ~/work/fleet/bin/fleet-mcp-restart directly.' }], isError: true };
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/api/restart-mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: args.agent }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { content: [{ type: 'text', text: `Restart failed: HTTP ${res.status}${text ? ' — ' + text.slice(0, 200) : ''}` }], isError: true };
      }
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Restart failed: ${data.error}` }], isError: true };
      const details = [];
      if (data.tmux_session) details.push(`tmux:${data.tmux_session}`);
      if (data.stdout) details.push(`stdout:${String(data.stdout).slice(0, 200)}`);
      if (data.stderr) details.push(`stderr:${String(data.stderr).slice(0, 200)}`);
      return { content: [{ type: 'text', text: `Restart sent to ${args.agent}${details.length ? ' (' + details.join(' | ') + ')' : ''}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Restart failed (server unreachable): ${e.message}` }], isError: true };
    }
  }

  // ==== Fleet Operations ====

  // ---- cleanup ----
  if (name === 'cleanup') {
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

  // ---- batch_respawn ----
  if (name === 'batch_respawn') {
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
    const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

    // Store timer-set event immediately for dashboard countdown display
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
    const dashPort_ = process.env.FLEET_DASH_PORT || 5176;
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
          // Notify dashboard
          const dashPort = process.env.FLEET_DASH_PORT || 5176;
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
    return { content: [{ type: 'text', text: `✓ Shared "${title}"\n${chatMsg}${tldaResult}\n\nUse \`get_highlight_feedback("${docName}")\` (tlda MCP) to read highlight feedback.` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// ---- Channel: WebSocket to dashboard for direct message injection ----
// Each MCP server instance opens its own WS to the dashboard, filtered to this agent.
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

  const dashPort = process.env.FLEET_DASH_PORT || 5176;
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

  // Hard dedup: suppress if same content was sent recently (CC 2.1.97 replays channel notifications)
  if (!handleChannelMessage._lastContent) handleChannelMessage._lastContent = '';
  if (!handleChannelMessage._lastTs) handleChannelMessage._lastTs = 0;

  // Build notification content
  let content = '📬 You have a new fleet message. Call my_task() to see it.';
  // Preview length: long enough to fit a typical voice message in full,
  // with an ellipsis on overflow so Skip doesn't think the system ate
  // Short preview: just enough to know the topic, not enough to act on.
  // Agents MUST call my_task() to get the full message.
  const PREVIEW_MAX = 120;
  const previewOf = (raw) => {
    const s = String(raw || '');
    return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s;
  };
  if (eventType === 'delegate') {
    const desc = previewOf(data.text || data.description);
    content = `📬 New task assigned: ${desc}\nCall my_task() to see it.`;
  } else if (eventType === 'chat') {
    // Resolve friendly name: check metadata, then strip fleet: prefix from ID
    const fromLabel = data.metadata?.fromLabel || fromId?.replace(/^fleet:/, '') || 'unknown';
    const preview = previewOf(data.text || data.message);
    const ctx = data.metadata?.context;
    const docHint = ctx?.doc
      ? ` [viewing ${ctx.doc}${ctx.version ? '@' + ctx.version : ''}]`
      : '';
    content = `📬 Message from ${fromLabel}${docHint}: ${preview}\nCall my_task() to read and respond.`;
  } else if (eventType === 'task_done') {
    content = `📬 Task update. Call my_task() to see details.`;
  }

  // Suppress if identical content within 30s
  const now = Date.now();
  if (content === handleChannelMessage._lastContent && now - handleChannelMessage._lastTs < 30000) {
    process.stderr.write(`[fleet-channel] Suppressed duplicate: ${content.slice(0, 60)}\n`);
    return;
  }
  handleChannelMessage._lastContent = content;
  handleChannelMessage._lastTs = now;

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
// Reports agent state (idle/thinking/tool_call) to the dashboard via WS.
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
// Fallback signal: Claude Code's status bar shows "esc to interrupt" only
// while an operation is running. More reliable than the spinner regex, and
// sits at a fixed distance from the pane bottom regardless of TODO list size.
const INTERRUPT_HINT_RE = /esc to interrupt/;
const COMPACTING_RE = /Compacting conversation/;
// How many lines from the bottom of the tmux pane to scan for the spinner.
// The old 15-line slice missed the spinner when Claude Code showed a TODO
// list above it (the spinner gets pushed up). 40 gives comfortable headroom
// for realistic todo lists + tool output, still tight enough to avoid
// scraping stale "Thinking…" text from scrollback.
const THINKING_SCAN_LINES = 40;
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

    // Thinking detection — test bottom of pane only (avoids old summary lines in scrollback).
    // Accept either the spinner regex (which may be pushed up by a long TODO
    // list) or the "esc to interrupt" hint in the status bar (fixed near the
    // bottom). Either signal means Claude Code has an active operation.
    const paneBottom = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n');
    const isThinking = THINKING_SPINNER_RE.test(paneBottom) || INTERRUPT_HINT_RE.test(paneBottom);
    // Always send current state — server uses timestamps for expiry
    _channelWS.send(JSON.stringify({ type: 'agent-thinking', agentId: AGENT_ID, thinking: isThinking }));
    // Only broadcast state-change events to dashboard (avoid noise)
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
