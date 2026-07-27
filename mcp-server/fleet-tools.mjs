/**
 * Fleet tools module — imported by the unified MCP server (index.mjs).
 * Exports: getFleetTools(), handleFleetTool(), initFleet()
 */
import { execSync, execFileSync, exec } from 'child_process';
import crypto from 'node:crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
// SearchIndex (search-index.sqlite) replaced by server-side fleet-search WS operation.
// FleetStore import removed — MCP server is a REST client, no direct DB access
import { SessionExtractor, EventExtractor, TldaExtractor } from './playback/extractors.mjs';
import { createPlayback, getPlayback, listPlaybacks, editPlayback, playbackTranscript } from './playback/storage.mjs';
import { ledger } from './identity.mjs';
import { formatMessage, formatActivity, formatAnnotationRef } from './format-annotation.mjs';
import { formatDisplayTimestamp, displayZoneOptions } from '../shared/display-time.mjs';
import { formatViewingHint } from './viewing-hint.mjs';
import { parseTimestamp } from './lib/parse-timestamp.mjs';
import { processMessageText } from '../shared/message-processing.mjs';
import { compactPrettyResult, indentPrettyResult, normalizePrettyResult } from '../shared/activity-pretty-result.mjs';
import { resolveFilePath, uploadFileToServer } from '../shared/chat-file-processing.mjs';
import { scanMarkdownDeps } from '../shared/markdown-deps.mjs';
import { extractMarkdownSection } from '../shared/markdown-section.mjs';
import { checkChatRender as checkSharedChatRender } from '../shared/chat-render-check.mjs';
import { formatSpawnModelSummary, validateSpawnModelSelection } from '../shared/spawn-model-validation.mjs';
import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs';
import { formatActivityHealthStatus } from '../shared/activity-health.mjs';
import {
  INBOX_STATUSES,
  INBOX_VIEWS,
  DELIVERY_CHANNELS,
  formatAttentionReceipt,
  normalizeInboxStatus,
  normalizeInboxView,
  parsePriorityPhrase,
  validateInboxStatus,
  validateDeliveryChannel,
} from '../shared/inbox-attention.mjs';
import {
  PENDING_ATTACHMENT_FOOTNOTE,
  formatRecipientAttachmentRef,
  hasPendingAttachmentPlaceholders,
  pendingAttachmentPlaceholder,
  recipientAttachmentRef,
} from '../shared/inbox-reference-materialization.mjs';
import { getActiveEnvName } from '../shared/config.mjs';
import { listModels as listSpawnModels, normalizeSpawnModelKwargs } from '../agent-launch/models.mjs';
import {
  defaultDaemonConfigPath,
  readDaemonConfig,
  withDaemonModelAliases,
} from '../agent-launch/permission-ledger.mjs';
import { classifyLaunder } from '../agent-runtime/launder-classifier.mjs';
import {
  applyNonClaudeRolePack,
  crossLaneBlock,
} from '../shared/task-role-routing.mjs';
import { parseFilter, parseMessageFilter, evalExpr } from '../shared/fleet-labels.mjs';
import { runtimeStatusName } from '../shared/fleet-runtime-status.mjs';
import { normalizeRefNumber as _normalizeRefNumber, refTypeForName as _refTypeForName, buildTheoremRefRegex as _buildTheoremRefRegex } from '../shared/doc-refs.mjs';
import { harnessFromEnv } from './lib/harness-adapters.mjs';
import { shouldSkipOriginatedEvent, shouldSuppressRecentContent } from './lib/timer-channel-delivery.mjs';
import { timerSetEventIdFromAck, timerSetMessage } from './lib/timer-protocol.mjs';
import WebSocket from 'ws';
import {
  FleetTransportOutbox,
  isRetryableTransportError,
  rejectWsRequests,
  resetWsRequestIdleTimers,
  ResilientWS,
  startWsRequest,
  WsReconnectBuffer,
} from '../shared/fleet-transport.mjs';
import { createFleetOperationTransport } from '../shared/fleet-operation-transport.mjs';
import { formatLoginMarker } from '../agent-runtime/daemon-jsonl-hot-path.mjs';

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
  } catch (e) { process.stderr.write(`[fleet] agent cwd detection failed: ${e.message}\n`); }
  _agentCwdCache = process.env.PWD || null;
  return _agentCwdCache;
}

// Resolve a chat/amend message body from the tool args. Two forms:
//   - { message } : an inline string → body = message, no source provenance.
//   - { file, section } : read the markdown file (agent-side — the file is on
//     the agent's machine, not the server's), extract the named pandoc section,
//     and bake its markdown as the body. Stamps source = { file: <abs>, section }
//     so amend can re-extract the same reference after the section is edited.
// Returns { body, source } on success or { error } with a human-readable message.
function resolveChatBody(args, agentCwd) {
  const hasFile = typeof args.file === 'string' && args.file.trim();
  const hasMessage = typeof args.message === 'string' && args.message.length > 0;
  if (hasFile) {
    if (hasMessage) return { error: 'Provide either `message` or `file`+`section`, not both.' };
    const section = typeof args.section === 'string' ? args.section.trim() : '';
    if (!section) return { error: 'The `file` form needs a `section` (a pandoc heading id, e.g. "the-plan").' };
    const abs = resolveFilePath(args.file, agentCwd);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch (e) { return { error: `Could not read ${abs}: ${e.message}` }; }
    const result = extractMarkdownSection(content, section);
    if (!result.found) {
      const avail = result.ids?.length ? `\nSections in this file: ${result.ids.join(', ')}` : '\n(no headings found in this file)';
      return { error: `No section "${section}" in ${path.basename(abs)}.${avail}` };
    }
    return { body: result.body, source: { file: abs, section } };
  }
  if (hasMessage) return { body: args.message, source: null };
  return { error: 'Missing message: provide `message`, or `file`+`section`.' };
}

function isInInlineCode(line, index) {
  let ticks = 0;
  for (let i = 0; i < index; i++) {
    if (line[i] === '`') ticks++;
  }
  return ticks % 2 === 1;
}

function containsLegacySuggestionsBlock(body) {
  const lines = String(body || '').split('\n');
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const openIdx = line.indexOf('<suggestions>');
    if (openIdx >= 0 && !isInInlineCode(line, openIdx)) return true;
    const closeIdx = line.indexOf('</suggestions>');
    if (closeIdx >= 0 && !isInInlineCode(line, closeIdx)) return true;
  }
  return false;
}

// Inline suggestion section — the forget-proof, markdown-native authoring surface
// for chat-authored chips. Written ANYWHERE in a message, a recognized section
// does two things at once:
//   (a) RENDERS AS NORMAL MARKDOWN (bold name + description), left in the body, and
//   (b) is HARVESTED into suggestion chips at the bottom of chat.
// One construct, two effects.
//
// Marker — a `.suggest` class on a section heading (pandoc heading-attribute
// style, the form Skip pictured). The heading TEXT is free; the `.suggest` class
// is the trigger, so a plain "## Suggestions" heading is NEVER harvested by
// accident — only an explicit opt-in fires:
//
//   ## Pick one {.suggest}
//   - **ship it** — proceed with the reviewed change
//   - **hold** — wait for the test rig *​/hold*
//
// Item grammar is PURE MARKDOWN — no pipes:
//   - `**name**`  = the chip label AND the default sent-payload.
//   - anything between the bold name and the command = optional description (chip
//     hover) — the separator is forgiving: a dash, a period, or nothing all work
//     (`**x** — d`, `**x**. d`, `**x** d`, `**x**` all parse).
//   - `*command*` = OPTIONAL explicit command, only when the sent-payload differs
//                   from the name. No italic → clicking sends the name.
//   - no `**bold**` → the FIRST WORD is the name (graceful degrade, never errors).
// NO group field: the GROUP is implicit — **each `.suggest` section is one group**,
// and multiple `.suggest` sections anywhere in the message give multiple groups.
// (This is why inline does NOT share the end-block's `parseSuggestionFields`
// helper — the end-block keeps explicit `label|hover|command|group|target` pipes;
// inline is a different, pure-markdown grammar.)
//
// The pre-pass strips ONLY the `{.suggest}` attribute from the heading — the
// items are already clean markdown and stay as the author wrote them (bold name +
// description). The optional italic `*command*` is stripped from the rendered body
// when INLINE_STRIP_RENDERED_COMMAND is true (kept verbatim otherwise); either way
// it is harvested as the chip's command. A section is the `.suggest` heading plus
// the contiguous list under it (one blank-line gap allowed); it ends at the first
// blank line, non-list line, next heading, or code fence.
const INLINE_SUGGEST_HEADING = /^(#{1,6})\s+(.*?)\s*\{([^}]*)\}\s*$/;
const attrHasSuggest = (attrBlob) => /(?:^|\s)\.suggest(?:\s|$)/.test(attrBlob);
// A single-`*` italic run that is NOT part of a `**bold**` marker.
const INLINE_ITALIC_COMMAND = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/;
const INLINE_BOLD_NAME = /\*\*([^*\n]+?)\*\*/;
// Whether to drop the italic `*command*` from the RENDERED message body (it is
// always harvested into the chip regardless). Skip's eyeball call — flip in one place.
const INLINE_STRIP_RENDERED_COMMAND = false;

// Parse one item's markdown (the text after its `- `) into a chip + the cleaned
// line to render. Returns { suggestion, rendered } or { error }.
function parseInlineItem(content) {
  let work = content;
  // 1. optional explicit command = an italic run (not part of a bold marker).
  let command = null;
  const im = work.match(INLINE_ITALIC_COMMAND);
  if (im) command = im[1].trim();
  // The body either keeps the italic verbatim or drops it (Skip's render call).
  const renderedInner = (INLINE_STRIP_RENDERED_COMMAND && im)
    ? (content.slice(0, im.index) + content.slice(im.index + im[0].length)).replace(/[\s—–-]+$/, '').trimEnd()
    : content.trimEnd();
  // For NAME/description parsing, work off the command-stripped text.
  if (im) work = work.slice(0, im.index) + work.slice(im.index + im[0].length);

  // 2. name = the first **bold** run; else graceful-degrade to the first word.
  let name, rest;
  const bm = work.match(INLINE_BOLD_NAME);
  if (bm) {
    name = bm[1].trim();
    rest = (work.slice(0, bm.index) + work.slice(bm.index + bm[0].length));
  } else {
    const w = work.trim();
    const firstWord = w.split(/\s+/)[0] || '';
    name = firstWord.replace(/[*_`]/g, '').trim();
    rest = w.slice(firstWord.length);
  }
  if (!name) return { error: 'missing a name' };

  // 3. description = whatever's left between name and command, minus a leading
  // separator — a dash, a period, or nothing (Skip: the separator is forgiving).
  const description = rest.replace(/^[\s.—–-]+/, '').replace(/[\s—–-]+$/, '').replace(/\s{2,}/g, ' ').trim();

  const suggestion = { label: name, command: command || name };
  if (description) suggestion.text = description;
  return { suggestion, rendered: renderedInner };
}

export function parseInlineSuggestions(body) {
  const text = String(body || '');
  const lines = text.split('\n');
  const out = [];
  const suggestions = [];
  let inFence = false;
  let sectionN = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    const hm = trimmed.match(INLINE_SUGGEST_HEADING);
    if (!hm || !attrHasSuggest(hm[3])) { out.push(line); continue; }

    // A `.suggest` section. The section IS one implicit group — its items form one
    // disjunctive chip group, distinct from every other section in the message
    // (the `#n` suffix guarantees distinctness even if two sections share a title).
    const headingText = hm[2].trim();
    sectionN += 1;
    const group = `${headingText || 'suggest'}#${sectionN}`;
    out.push(`${hm[1]} ${headingText}`);   // strip the {.suggest} attribute

    // Consume the list under it (allowing one blank-line gap after the heading).
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') { out.push(lines[j]); j++; }
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '' || /^(```|~~~)/.test(t) || /^#{1,6}\s/.test(t)) break;
      const itm = t.match(/^[-*]\s+(.+)$/);
      if (!itm) break;
      const parsed = parseInlineItem(itm[1]);
      if (parsed.error) return { error: `Inline suggestion at line ${j + 1} is ${parsed.error}.` };
      suggestions.push({ ...parsed.suggestion, group });
      const indent = lines[j].slice(0, lines[j].length - lines[j].trimStart().length);
      out.push(`${indent}- ${parsed.rendered}`);
    }
    i = j - 1;
  }

  return { body: out.join('\n'), suggestions };
}

async function postChatAuthoredSuggestions(suggestions, recipients, { messageId = null } = {}) {
  const ts = Date.now();
  const targetId = recipients.length === 1 ? recipients[0] : null;
  const stamped = suggestions.map((s, i) => ({
    id: `${AGENT_ID}:chat:${messageId || ts}:${i}`,
    label: s.label,
    text: s.text || '',
    command: s.command || null,
    kind: s.command ? 'action' : 'info',
    group: s.group || undefined,
    targetId: s.targetId || targetId,
    messageId,
    ts,
  }));
  const prev = await fleetFetch(`${TLDA_FLEET_SERVER}/api/suggestions`, { signal: AbortSignal.timeout(3000) });
  const prevData = await prev.json().catch(() => ({}));
  const retained = (prevData.suggestions || []).filter(s => s.from === AGENT_ID && String(s.messageId || '') !== String(messageId || ''));
  const res = await fleetFetch(`${TLDA_FLEET_SERVER}/api/suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ID, suggestions: [...retained, ...stamped] }),
    signal: AbortSignal.timeout(3000),
  });
  const postData = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(postData.error || res.statusText);
  return stamped.length;
}

// A shared markdown file's images are includes that travel WITH it. They don't
// otherwise exist on the (possibly remote) server, so the renderer 404s them.
// Upload each locally-referenced image to the fleet server (where chat is
// viewed — NOT the doc server, which may be a different machine) and rewrite the
// body's refs to the served URL so they render inline. Resolution is relative to
// the FILE's own directory (its includes are written relative to it), via the
// shared scanMarkdownDeps detector. Returns { body, uploaded, missing }.
// Give a shared file's provenance chip a URL the reader can actually fetch.
//
// `source.file` is an absolute path on the SENDING agent's machine. The reader's
// browser talks to the fleet server, where that path does not exist, so a chip
// carrying only the path is unopenable by construction — which is why clicking a
// shared markdown file did nothing. Uploading the file here gives the chip a URL
// that resolves from anywhere.
//
// Never throws: the body is already baked into the message, so a failed upload
// costs the click-to-open affordance, not the content. The caller warns.
async function withUploadedSourceFile(source, fleetServerUrl) {
  if (!source?.file) return { source, error: null };
  try {
    const { url } = await uploadFileToServer(source.file, fleetServerUrl);
    return { source: { ...source, url }, error: null };
  } catch (e) {
    return { source, error: e.message };
  }
}

async function bundleSharedMarkdownImages(body, sourceFile, fleetServerUrl) {
  const baseDir = path.dirname(sourceFile);
  const deps = scanMarkdownDeps(body, baseDir);
  let out = body;
  const missing = [];
  let uploaded = 0;
  for (const { ref, abs } of deps) {
    if (!abs || !fs.existsSync(abs)) { missing.push(ref); continue; }
    let url;
    try { ({ url } = await uploadFileToServer(abs, fleetServerUrl)); }
    catch { missing.push(ref); continue; }
    // /api/upload returns a server-relative url; make it absolute against the
    // fleet origin so it resolves the same from any viewer (iPad, phone, laptop).
    if (url && !/^https?:/i.test(url)) url = `${fleetServerUrl.replace(/\/$/, '')}${url}`;
    const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Rewrite only in image contexts: `](ref...)` and `<img ... src="ref...">`.
    out = out.replace(new RegExp(`\\]\\(\\s*${esc}(?:[#?][^)]*)?\\s*\\)`, 'g'), `](${url})`);
    out = out.replace(new RegExp(`(<img\\s[^>]*\\bsrc=)(["'])${esc}(?:[#?][^"']*)?\\2`, 'g'), `$1$2${url}$2`);
    uploaded++;
  }
  return { body: out, uploaded, missing };
}

function isMarkdownFileName(name = '') {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function checkSharedMarkdownAttachments(inlineAttachments = [], macros = {}) {
  const warnings = [];
  for (const att of inlineAttachments || []) {
    if (att?.broken || !att?.path || !isMarkdownFileName(att.name || att.path)) continue;
    let body = '';
    try {
      body = fs.readFileSync(att.path, 'utf8');
    } catch (e) {
      warnings.push({
        file: att.path,
        name: att.name || path.basename(att.path),
        issues: [`Could not read markdown file for render check: ${e.message}`],
      });
      continue;
    }
    const { validity } = checkChatRender(body, macros);
    if (validity.length) {
      warnings.push({
        file: att.path,
        name: att.name || path.basename(att.path),
        issues: validity,
      });
    }
  }
  return warnings;
}

// State file eliminated — all data through server REST API
const LOG_FILE = `${os.homedir()}/.claude/agent-messages.jsonl`;

// --- tlda integration ---
import { CONFIG_DIR, getRwToken, getServerUrl, getFleetServerUrl } from '../shared/config.mjs';
import { resolveLoginFleetId } from '../daemon/mint-store.mjs';
import { tldaFetch as _sharedFetch } from '../shared/http-client.mjs';
import { reportDocName, postReportDoc } from './report-doc-post.mjs';
const TLDA_SERVER = getServerUrl();
const TLDA_WS_SERVER = TLDA_SERVER.replace(/^http/, 'ws');
// Fleet/event ops (chat, register, my-task, store-agents, fleet-event, roll-call,
// viewing, terminal-card, suggestions, education) target the GLOBAL event store.
// Doc/source ops (/api/projects/*) stay on TLDA_SERVER (per-resource, local via
// the daemon on the owning machine). When TLDA_FLEET_SERVER is unset this is
// identical to the single-endpoint behavior — set it to the Fly backend to put an
// agent's fleet presence on the shared store while doc work stays local.
const TLDA_FLEET_SERVER = getFleetServerUrl();
const TLDA_FLEET_WS_SERVER = TLDA_FLEET_SERVER.replace(/^http/, 'ws');
const _tldaToken = getRwToken();
let _activeToolEnv = null;
let _fleetTransportDb = null;
let _fleetTransportOutbox = null;
let _fleetTransportAgentId = null;
let _fleetTransportFlushTimer = null;
let _fleetTransportFlushInFlight = null;
const _fleetTransportRecoveredAgents = new Set();

const ENV_SCOPED_TOOL_NAMES = new Set([
  'delegate', 'chat', 'notify',
  'tasks', 'read_terminal', 'inbox',
  'set_inbox_status', 'set_delivery_channel',
  'name_agent', 'reanimate', 'spawn_models',
  'search', 'observe', 'thread', 'get_refs',
  'label_agent', 'interrupt', 'roster', 'viewing_context',
  'timer', 'subscribe', 'subscriptions', 'unsubscribe',
  'report',
]);

function normalizeEnvArg(args = {}) {
  const env = typeof args?.env === 'string' ? args.env.trim() : '';
  return env || null;
}

function activeEnvName() {
  return getActiveEnvName(_activeToolEnv);
}

function activeFleetServerUrl() {
  return _activeToolEnv ? getFleetServerUrl(_activeToolEnv) : TLDA_FLEET_SERVER;
}

function activeStoreServerUrl() {
  return _activeToolEnv ? getServerUrl(_activeToolEnv) : TLDA_SERVER;
}

function rewriteActiveServerUrl(url) {
  if (!_activeToolEnv || typeof url !== 'string') return url;
  if (url.startsWith(TLDA_FLEET_SERVER)) return `${activeFleetServerUrl()}${url.slice(TLDA_FLEET_SERVER.length)}`;
  if (url.startsWith(TLDA_SERVER)) return `${activeStoreServerUrl()}${url.slice(TLDA_SERVER.length)}`;
  return url;
}

function annotateEnvResult(result, envName) {
  if (!result?.content?.length || result.content[0]?.type !== 'text') return result;
  const text = result.content[0].text || '';
  if (text.startsWith('Environment: ')) return result;
  return {
    ...result,
    content: [{ ...result.content[0], text: `Environment: ${envName}\n${text}` }, ...result.content.slice(1)],
  };
}

function sendOneShotWS(envName, type, params = {}, opts = {}) {
  const id = crypto.randomUUID();
  const deadlineMs = opts.deadlineMs ?? opts.idleTimeoutMs ?? WS_REQUEST_IDLE_MS;
  const wsUrl = `${getFleetServerUrl(envName).replace(/^http/, 'ws')}/ws/fleet?agent=${encodeURIComponent(AGENT_ID || '')}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* best-effort cleanup; timeout is already reported */ }
      reject(new Error(`fleet WS request timed out after ${deadlineMs}ms (env=${envName}, type=${type})`));
    }, deadlineMs);
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* best-effort cleanup; original WS result wins */ }
      fn(value);
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type,
        ...params,
        id,
        ...(opts.envelope ? {
          operation_id: params.operation_id || opts.envelope.operation_id,
          fleet_operation: opts.envelope,
        } : {}),
      }));
    });
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.id !== id) return;
      if (msg.error) {
        const detail = typeof msg.error === 'object' && msg.error !== null ? msg.error : { message: msg.error };
        const err = new Error(detail.message || String(msg.error));
        Object.assign(err, detail);
        finish(reject, err);
      } else {
        rememberOriginatedEvents(msg.result);
        finish(resolve, msg.result);
      }
    });
    ws.on('error', err => finish(reject, new Error(`fleet WS ${envName} not reachable: ${err.message}`)));
    ws.on('close', () => {
      if (!settled) finish(reject, new Error(`fleet WS ${envName} closed before ACK (type=${type})`));
    });
  });
}

function fleetTransportOutboxPath(agentId) {
  const digest = crypto.createHash('sha256').update(agentId).digest('hex').slice(0, 20);
  return path.join(CONFIG_DIR, `mcp-fleet-transport-${digest}.sqlite`);
}

function getFleetTransportOutbox(agentId) {
  if (!agentId) throw new Error('fleet transport outbox requires agent identity');
  if (_fleetTransportOutbox) {
    if (_fleetTransportAgentId !== agentId) {
      throw new Error(`fleet transport process is already bound to ${_fleetTransportAgentId}`);
    }
    return _fleetTransportOutbox;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  _fleetTransportDb = new Database(fleetTransportOutboxPath(agentId));
  _fleetTransportOutbox = new FleetTransportOutbox(_fleetTransportDb);
  _fleetTransportAgentId = agentId;
  return _fleetTransportOutbox;
}

// Fleet store — REMOVED. MCP server is a REST client; all reads/writes go through the dashboard server.
// All server fetches go through fleetFetch — adds a timeout so tool handlers
// never hang when the server is down. Without this, Claude Code kills the
// MCP process (SIGKILL) after its own internal timeout.
function fleetFetch(url, opts = {}) {
  const timeoutMs = 10_000;
  if (!opts.signal) opts.signal = AbortSignal.timeout(timeoutMs);
  return fetch(rewriteActiveServerUrl(url), opts);
}

let _spawnModelCatalog = null;
let _spawnModelCatalogAt = 0;
async function getSpawnModelCatalog({ maxAgeMs = 60_000 } = {}) {
  if (_spawnModelCatalog && Date.now() - _spawnModelCatalogAt < maxAgeMs) return _spawnModelCatalog;
  const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR));
  const data = listSpawnModels(withDaemonModelAliases({}, daemonConfig));
  _spawnModelCatalog = data;
  _spawnModelCatalogAt = Date.now();
  return data;
}

function configuredSpawnProfileNames() {
  try {
    const daemonConfig = readDaemonConfig(defaultDaemonConfigPath(CONFIG_DIR));
    const profiles = daemonConfig?.profiles && typeof daemonConfig.profiles === 'object' && !Array.isArray(daemonConfig.profiles)
      ? daemonConfig.profiles
      : {};
    return Object.keys(profiles).sort();
  } catch (e) {
    process.stderr.write(`[fleet] could not read daemon profiles for tool schema: ${e.message}\n`);
    return [];
  }
}

function spawnPermissionDescriptions() {
  const profiles = configuredSpawnProfileNames();
  const profileText = profiles.length
    ? `Configured daemon profiles now: ${profiles.join(', ')}.`
    : 'No daemon profiles are currently configured.';
  return {
    profileNames: profiles,
    permissionRequest: `Configured daemon permission profile/spec. ${profileText} The daemon clamps it to the spawner, project, model, and local box policy.`,
  };
}

async function validateSpawnRequest(opts = {}) {
  const model = opts.model;
  const kind = opts.kind;
  if (!model && !kind) return null;
  const catalog = await getSpawnModelCatalog();
  const result = validateSpawnModelSelection({ model, kind }, catalog);
  if (!result.ok) return result.error;
  const daemonConfig = readDaemonConfig();
  const config = withDaemonModelAliases({}, daemonConfig);
  const reserved = new Set([
    'agent', 'fresh', 'refresh', 'respawn', 'name', 'model', 'cwd', 'permission',
    'permissions', 'policy', 'permissionRequest', 'iLikeToLiveDangerously', 'mode', 'kind',
  ]);
  const kwargs = { ...(opts.modelOptions && typeof opts.modelOptions === 'object' && !Array.isArray(opts.modelOptions) ? opts.modelOptions : {}) };
  for (const [key, value] of Object.entries(opts)) {
    if (!reserved.has(key) && value != null && value !== '') kwargs[key] = value;
  }
  try {
    normalizeSpawnModelKwargs({ model, ...kwargs }, { config });
  } catch (e) {
    return e.message || String(e);
  }
  return null;
}

function spawnModelOptionsFromArgs(opts = {}) {
  const reserved = new Set([
    'agent', 'fresh', 'refresh', 'respawn', 'name', 'model', 'cwd', 'permission',
    'permissions', 'policy', 'iLikeToLiveDangerously', 'mode', 'kind',
  ]);
  const out = { ...(opts.modelOptions && typeof opts.modelOptions === 'object' && !Array.isArray(opts.modelOptions) ? opts.modelOptions : {}) };
  for (const [key, value] of Object.entries(opts)) {
    if (!reserved.has(key) && value != null && value !== '') out[key] = value;
  }
  return out;
}

// Append-only message log (backup). Fleet store writes are handled by
// individual handlers (chat, delegate, task_done, login) to avoid
// double-writes. logEvent only writes JSONL + fleet store for event
// types that DON'T have dedicated handlers.
const _HANDLED_EVENT_TYPES = new Set(['chat', 'delegate', 'task_done', 'login', 'register', 'report']);

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
    mcpFleetTransport.ephemeral('fleet-event', { event_data: eventData })
      .catch(e => process.stderr.write(`[fleet-transport] transient fleet-event send failed before ACK: ${e.message}\n`));
  }
}

// --- Identity ---
// Simple: $FLEET_ID env var = your identity. Spawned agents claim it with login().
// No JSONL scanning, no state file reading, no guessing.
const ALIVE_THRESHOLD_MS = 10 * 60 * 1000;
let AGENT_ID = process.env.FLEET_ID || null;
// Ref tokens created by tlda_highlight — keyed by «annotation:label» token
const _refTokens = new Map();

// Most recent tlda doc this agent is working with — set by monitor_add and
// used by chat() to stamp outgoing messages with { doc, version } so the
// recipient knows which document state the sender was reasoning about.
let _currentDoc = null;
let _inboxStatus = 'available';
let _docVersionCache = { doc: null, version: null, ts: 0 };
const DOC_VERSION_CACHE_MS = 5000;


// Per-doc macro cache. Paper-defined macros (e.g. \E, \chis) must be passed
// to katex.renderToString so the chat linter doesn't false-positive on them.
const _macrosCache = new Map(); // doc → { macros, ts }
const MACROS_CACHE_MS = 5 * 60_000; // 5 min
async function getMacrosForDoc(doc) {
  if (!doc) return {};
  const cached = _macrosCache.get(doc);
  if (cached && Date.now() - cached.ts < MACROS_CACHE_MS) return cached.macros;
  try {
    const url = `${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/macros`;
    const headers = _tldaToken ? { Authorization: `Bearer ${_tldaToken}` } : {};
    const res = await fleetFetch(url, { headers, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return {};
    const body = await res.json();
    const macros = body?.macros || {};
    _macrosCache.set(doc, { macros, ts: Date.now() });
    return macros;
  } catch { return {}; }
}

// Resolve which project an agent "is on" from its working folder: the project
// whose sourceDir contains the agent's cwd (longest match wins). This is the
// document whose macros render/lint the agent's chat — an agent working in
// ~/work/bregman-lower-bound uses bregman's \E, \chis, etc. No tool call or
// human-viewport guessing required; the folder is the source of truth.
let _agentDocCache = { doc: null, ts: 0 };
async function getAgentDoc() {
  if (_agentDocCache.doc !== null && Date.now() - _agentDocCache.ts < MACROS_CACHE_MS) return _agentDocCache.doc;
  const cwd = getAgentCwd();
  if (!cwd) return null;
  try {
    const headers = _tldaToken ? { Authorization: `Bearer ${_tldaToken}` } : {};
    const res = await fleetFetch(`${TLDA_SERVER}/api/projects`, { headers, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    const projects = body?.projects || [];
    let best = null;
    for (const p of projects) {
      if (!p.sourceDir) continue;
      const sd = p.sourceDir.replace(/\/+$/, '');
      if (cwd === sd || cwd.startsWith(sd + '/')) {
        if (!best || sd.length > best.len) best = { name: p.name, len: sd.length };
      }
    }
    const doc = best?.name || null;
    _agentDocCache = { doc, ts: Date.now() };
    return doc;
  } catch { return null; }
}

// An agent's preamble is a *document reference*: by default the project in its
// working folder, but it can point at any document via `set_preamble`. This MCP
// process is per-agent, so a module-level override is per-agent state. (A shadow
// version can be set too; we store it but ignore it on resolution for now — the
// "really fancy" upgrade is to resolve macros from that shadow version with a
// cache. See setAgentPreambleDoc.)
let _agentPreambleDoc = null;        // { doc, version } | null
export function setAgentPreambleDoc(doc, version = null) {
  _agentPreambleDoc = doc ? { doc, version: version || null } : null;
}

// The document whose preamble applies to this agent's chat: an explicit
// set_preamble wins; otherwise the agent's working folder. Used both to lint the
// agent's outgoing math and to stamp `preambleRef` on its messages so every
// reader renders that math with the sender's macros.
async function getAgentPreambleDoc() {
  if (_agentPreambleDoc) return _agentPreambleDoc.doc;
  return getAgentDoc();
}

// Macros for the document the calling agent's preamble points at.
async function getMacrosForAgent() {
  return getMacrosForDoc(await getAgentPreambleDoc());
}

export const checkChatRender = checkSharedChatRender;

export function checkLaunderChatLint(message, recipients = [], { paperContext = false } = {}) {
  const result = classifyLaunder({
    text: message,
    context: { toSkip: recipients.includes('fleet:skip'), paperContext },
  });
  return result.decision === 'flag' ? [result] : [];
}

export function formatLaunderChatWarning(result, eventId = null) {
  const target = eventId != null ? `chat({ amend_id: ${eventId}, message: "…" })` : 'chat({ amend_id: <id>, message: "…" })';
  const span = result.features?.matchedSpan || 'matched wording';
  return `⚠ **Ungrounded notation/term introduction (${result.reasonCode}) — this may be agent-invented notation that will get laundered into later briefs.** Matched: \`${span}\`. Either ground it explicitly (e.g. "notation I'm introducing — not in the paper") or use the paper's notation. Fix it in place with \`${target}\` (edits the message Skip is reading, no new message).`;
}

async function fetchCurrentDocVersion(doc) {
  if (!doc) return null;
  const now = Date.now();
  if (_docVersionCache.doc === doc && now - _docVersionCache.ts < DOC_VERSION_CACHE_MS) {
    return _docVersionCache.version;
  }
  try {
    const headers = _tldaToken ? { Authorization: `Bearer ${_tldaToken}` } : {};
    const res = await fleetFetch(`${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/history/shadow?limit=20`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer most recent git-type entry (has real commitHash) over build-type entries
    const versions = data?.versions || [];
    const gitVersion = versions.find(v => v.type === 'git' && v.commitHash);
    const v = gitVersion || versions[0];
    const hash = v?.commitHash || v?.hash || null;
    const version = typeof hash === 'string' ? hash.slice(0, 7) : null;
    _docVersionCache = { doc, version, ts: now };
    return version;
  } catch {
    return null;
  }
}
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
// and let login() use an explicit session_id or fail loudly.
let CLAUDE_SESSION = (function detectSessionAtStartup() {
  try {
    // Codex gives its rollout/thread identifier to the MCP process directly.
    // Register it so the daemon's roster delta changes when the spawned
    // process claims its shell; otherwise a Codex shell remains indistinct
    // from its pre-launch reservation.
    if (process.env.CODEX_THREAD_ID) return process.env.CODEX_THREAD_ID;
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
    const [agents, tasks] = await Promise.all([mcpFleetTransport.ephemeral('store-agents'), mcpFleetTransport.ephemeral('store-tasks')]);
    return { agents: agents || [], tasks: tasks || [], messages: [] };
  } catch (e) {
    process.stderr.write(`[fleet] loadState failed: ${e.message}\n`);
    return { tasks: [], messages: [], agents: [] };
  }
}

// Like loadState but the agent roster INCLUDES dead agents. Used for name→id
// resolution in history tooling (thread, search): a dead agent must
// stay addressable by name — search is the only handle on it.
async function loadStateAll() {
  try {
    const [agents, tasks] = await Promise.all([mcpFleetTransport.ephemeral('store-agents-all'), mcpFleetTransport.ephemeral('store-tasks')]);
    return { agents: agents || [], tasks: tasks || [], messages: [] };
  } catch (e) {
    process.stderr.write(`[fleet] loadStateAll failed: ${e.message}\n`);
    return { tasks: [], messages: [], agents: [] };
  }
}

async function resolveAgent(query) {
  let data;
  try {
    data = await mcpFleetTransport.ephemeral('resolve-agent', { agent: query });
  } catch (e) {
    throw new Error(`Agent resolution transport failed for "${query}": ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !('agent' in data)) {
    throw new Error(`Agent resolution transport failed for "${query}": no response from fleet server`);
  }
  return data.agent || null;
}

function normalizeThreadFilterExpression(raw) {
  let queryParseError = null;
  try {
    const parsed = parseSearchQuery(raw);
    if (!parsed.query && parsed.filters.filterExpression) return parsed.filters.filterExpression;
  } catch (e) {
    queryParseError = e;
  }
  try {
    parseMessageFilter(raw);
    return raw;
  } catch (e) {
    throw queryParseError || e;
  }
}

// ---- Report linter ----
// Runs on task_done() calls. Returns array of violation objects: { id, pattern, location, text, advice }
export function lintReport(reportText, gitDiff, overrides = []) {
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

function requireManager() {
  if (!AGENT_ID) return 'Cannot identify caller — no session ID detected.';
  return null; // No permission gating — any agent can do anything
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  const idAlias = id && !String(id).startsWith('fleet:') ? `fleet:${id}` : null;
  // Phase is encoded in the friendly name now ("base:day"/"base:dusk"; dawn is
  // the bare base), so a lineage address is a plain name lookup.
  const exact = state.agents.find(a =>
    a.id === id || (idAlias && a.id === idAlias) || a.friendly_name === id ||
    a.session_id === id || (a.session_ids && a.session_ids.includes(id))
  );
  if (exact) return exact;
  // ":dawn" is an alias for the bare base name (dawn carries no suffix).
  if (id.endsWith(':dawn')) {
    const base = id.slice(0, -':dawn'.length);
    return state.agents.find(a => a.friendly_name === base) || null;
  }
  return null;
}

/** Check if an ID belongs to a human agent (by registry lookup, not aliases) */
function isHuman(state, id) {
  const agent = getAgent(state, id);
  return !!(agent?.human);
}

export function classifyTaskAgentHealth(task, agent, options = {}) {
  if (!task || task.synthetic) return null;
  const nowMs = options.nowMs ?? Date.now();
  const aliveThresholdMs = options.aliveThresholdMs ?? ALIVE_THRESHOLD_MS;
  const pickupGraceMs = options.pickupGraceMs ?? 2 * 60 * 1000;
  const delegatedMs = task.delegated_at ? Date.parse(task.delegated_at) : NaN;
  const taskAgeMs = Number.isFinite(delegatedMs) ? Math.max(0, nowMs - delegatedMs) : null;
  const ageMin = taskAgeMs == null ? null : Math.round(taskAgeMs / 60000);

  if (!agent) {
    return {
      level: 'error',
      code: 'missing-agent',
      text: '⚠ target agent is not in the roster',
      managerAction: 'Fix the task target or redelegate.',
    };
  }

  const name = agent.friendly_name || agent.id || task.agent;
  const status = String(runtimeStatusName(agent) || '').toLowerCase();
  if (agent.dead || status === 'dead') {
    return {
      level: 'error',
      code: 'dead-agent',
      text: `⚠ ${name} is marked dead`,
      managerAction: 'Respawn or redelegate; do not wait for this task to finish silently.',
    };
  }

  if (status === 'hibernating') {
    return {
      level: 'warning',
      code: 'hibernating-agent',
      text: `⚠ ${name} is hibernating with an active task`,
      managerAction: 'Wake/respawn the agent or redelegate.',
    };
  }

  const lastSeenMs = agent.last_seen ? Date.parse(agent.last_seen) : NaN;
  if (Number.isFinite(lastSeenMs)) {
    const heartbeatAgeMs = nowMs - lastSeenMs;
    if (heartbeatAgeMs > aliveThresholdMs) {
      return {
        level: 'warning',
        code: 'stale-heartbeat',
        text: `⚠ no heartbeat from ${name} for ${Math.round(heartbeatAgeMs / 60000)}m`,
        managerAction: 'Check terminal/thread; respawn or redelegate if the agent is stalled.',
      };
    }
  } else if (taskAgeMs != null && taskAgeMs > pickupGraceMs) {
    return {
      level: 'warning',
      code: 'no-heartbeat',
      text: `⚠ ${name} has no recorded heartbeat`,
      managerAction: 'Registration may have failed; check terminal/thread before waiting.',
    };
  }

  if (task.status === 'pending' && taskAgeMs != null && taskAgeMs > pickupGraceMs) {
    return {
      level: 'warning',
      code: 'pending-pickup',
      text: `⚠ task still pending ${ageMin}m after delegation`,
      managerAction: 'The agent may not have called inbox(); nudge, inspect, or redelegate.',
    };
  }

  return {
    level: 'ok',
    code: 'healthy',
    text: `ok${Number.isFinite(lastSeenMs) ? `; heartbeat ${Math.max(0, Math.round((nowMs - lastSeenMs) / 60000))}m ago` : ''}`,
  };
}

export function agentSetLabelsForChat(agent) {
  const status = runtimeStatusName(agent);
  const virtualLabels = status === 'awake' ? ['awake'] : status === 'hibernating' ? ['hibernating'] : [];
  return [...(agent?.labels || []), ...virtualLabels, agent?.friendly_name, agent?.id].filter(Boolean);
}

export const TASK_HEALTH_ACTIONABLE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function classifyTaskListHealthBucket(task, health, options = {}) {
  if (!task || task.synthetic || !health || health.level === 'ok') return null;
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? TASK_HEALTH_ACTIONABLE_MAX_AGE_MS;
  const delegatedMs = task.delegated_at ? Date.parse(task.delegated_at) : NaN;
  const taskAgeMs = Number.isFinite(delegatedMs) ? Math.max(0, nowMs - delegatedMs) : null;
  if (taskAgeMs != null && taskAgeMs > staleAfterMs) {
    return {
      kind: 'stale-backlog',
      taskAgeMs,
      health,
    };
  }
  return {
    kind: 'actionable',
    taskAgeMs,
    health,
  };
}

export function summarizeTaskListHealth(tasks = [], agentMap = new Map(), options = {}) {
  const buckets = tasks.map(task => {
    const health = classifyTaskAgentHealth(task, agentMap.get(task.agent), options);
    return classifyTaskListHealthBucket(task, health, options);
  });
  return {
    buckets,
    actionableUnhealthy: buckets.filter(b => b?.kind === 'actionable'),
    staleBacklogUnhealthy: buckets.filter(b => b?.kind === 'stale-backlog'),
  };
}

function formatTaskHealth(health, { includeOk = false, includeAction = false } = {}) {
  if (!health || (health.level === 'ok' && !includeOk)) return '';
  let text = health.text;
  if (includeAction && health.managerAction) text += ` — ${health.managerAction}`;
  return text;
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
  mcpFleetTransport.durable('chat', { message: text, to, from, ...metadata })?.catch(e => {
    process.stderr.write(`[fleet] postMessage failed: ${e.message}\n`);
  });
}

export function startOperationMailbox(kind, meta = {}, options = {}) {
  if (!AGENT_ID) return null;
  const id = `mailbox:mcp-${kind}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  return {
    id,
    kind,
    ownerId: AGENT_ID,
    startedAt: now,
    deadlineAt: now + (options.timeoutMs || 5 * 60_000),
    meta,
  };
}

export function operationMailboxStartedResult(mailbox, { extra = '' } = {}) {
  const label = mailbox?.meta?.label ? ` for ${mailbox.meta.label}` : '';
  const suffix = extra ? `\n${extra}` : '';
  return {
    content: [{
      type: 'text',
      text: `Started ${mailbox.kind}${label}.\nmailbox_id: ${mailbox.id}${suffix}\nCompletion will arrive in fleet chat.`,
    }],
  };
}

export function deliverOperationMailboxCompletion(mailbox, status, detail = {}) {
  if (!mailbox?.ownerId) return;
  const label = detail.label || mailbox.meta?.label || mailbox.kind;
  // Silence on success unless there's a real payload to deliver (a result URL or
  // message the caller asked for). A bare "it completed" is noise. (Skip 7/22)
  if (status === 'completed' && !detail.message && !detail.url) return;
  const text = status === 'completed'
    ? `**${mailbox.kind} mailbox ${mailbox.id} complete**: ${label}\n\n${detail.message || detail.url}`
    : `**${mailbox.kind} mailbox ${mailbox.id} failed**: ${label} — ${detail.error || detail.reason || 'failed'}`;
  postMessage(mailbox.ownerId, AGENT_ID, text, {
    metadata: {
      type: 'mailbox_complete',
      mailbox_id: mailbox.id,
      mailbox_kind: mailbox.kind,
      status,
      detail,
    },
  });
}

async function getUnread(_state, agent) {
  try {
    const data = await mcpFleetTransport.ephemeral('my-task', { agent, peek: true });
    return data?.messages || [];
  } catch (e) { process.stderr.write(`[fleet] getUnread failed: ${e.message}\n`); }
  return [];
}

// ---- tmux helpers ----

// Wake a non-Claude fleet agent by typing a nudge into its tmux pane. Those
// harnesses don't act on Claude's `notifications/claude/channel`, so the adapter
// decides whether to also deliver via send-keys and whether Enter needs a settle
// delay. Single-lined so an embedded newline can't submit the prompt early.
// execFileSync (args array) avoids any shell-escaping of the message content.
function tmuxSendText(sessionName, text) {
  try {
    const line = String(text || '').replace(/\s*\n\s*/g, ' · ').trim();
    if (!line) return false;
    execFileSync('tmux', ['send-keys', '-t', sessionName, '--', line], { timeout: 5000 });
    const settleMs = harnessFromEnv().nudgeSettleMs || 0;
    if (settleMs > 0) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleMs); } catch {}
    }
    execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { timeout: 5000 });
    return true;
  } catch (e) {
    process.stderr.write(`[fleet-harness-nudge] send-keys failed for ${sessionName}: ${e.message}\n`);
    return false;
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

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// ---- Server reference (set by initFleet) ----
let server = null;

export const TLDA_INSTRUCTIONS = 'Fleet messages arrive as <channel source="tlda"> tags. When you see one, call inbox() to get full context and respond via chat().';

const ENV_SCHEMA = {
  type: 'string',
  description: 'Explicit tlda environment name for this fleet call. Defaults to the caller\'s current environment.',
};

export function getFleetTools() {
  const spawnPermissionText = spawnPermissionDescriptions();
  const tools = [
    // ---- Registration & Identity ----
    {
      name: 'login',
      description: 'Log this agent process into an existing server-created shell. Spawned agents call this at session start.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Agent session ID for JSONL/activity lookup' },
          agent_id: { type: 'string', description: 'Existing shell id. Defaults to FLEET_ID.' },
        },
      },
    },
    // ---- Task Management ----
    {
      name: 'delegate',
      description: 'Assign a task to an agent. Pass `task_id` to transfer an existing task by appending `message` and changing its owner. Pass `mint: {}` instead of `agent` to mint a fresh agent and delegate in one call — no name required.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier — session UUID, agent name, or friendly name. Omit when using mint.' },
          task_id: { type: 'string', description: 'Existing task ID to transfer to `agent`. The task keeps its identity and history; `message` is appended as the remaining work.' },
          mint: {
            type: 'object',
            description: 'Mint a fresh agent and delegate in one call. Mutually exclusive with agent.',
            properties: {
              name: { type: 'string', description: 'Agent name (auto-generated if omitted)' },
              cwd: { type: 'string', description: 'Working directory (inherits from caller if omitted)' },
              model: { type: 'string', description: 'Configured daemon model alias. Call spawn_models() for valid values.' },
              effort: { type: 'string', description: 'Effort level: low|medium|high|xhigh|max (default: inherit global config)' },
              permissionRequest: { type: 'string', ...(spawnPermissionText.profileNames.length ? { enum: spawnPermissionText.profileNames } : {}), description: spawnPermissionText.permissionRequest },
            },
	          },
          description: { type: 'string', description: 'Short human-readable description (5-10 words). Auto-derived from message if omitted.' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          friendly_name: { type: 'string', description: 'Rename an EXISTING target agent (two-call form, same as name_agent). Not allowed with mint — a minted agent\'s only name is mint.name.' },
          success_criteria: { type: 'array', items: { type: 'string' }, description: 'Verifiable success criteria. Agent must verify each before marking done.' },
          template: { type: 'string', description: 'Task template name (e.g. "math-edit"). Auto-populates success_criteria; explicit criteria are appended.' },
          requires_approval: { type: 'boolean', description: 'If true, task_done requires an approval_id — the event ID of a message from Skip approving the work. Agent cannot close without it.' },
          operation_id: { type: 'string', description: 'Optional stable idempotency key for retrying the same delegate operation.' },
        },
        required: ['message'],
      },
    },
    // ---- Messaging ----
    {
      name: 'chat',
      description: 'Send a message — or, with `amend_id`, edit one you already sent. `to` is an agent-set expression matching agent name/id/labels: `|` = or, `&` = and, `!` = not, parens group (e.g. "fleet:skip", "awake & reviewers", "mathy & !goose"). A bare name/id sends to that one agent. Omit `to` to send to your manager. Format with markdown.\n\nTwo ways to give the message body: (1) `message` — an inline string (filenames in it auto-become clickable chips); or (2) `file` + `section` — render a section of a markdown file as the message. Use the file form for a report or any longer, proofread-worthy message: write it in a file, then chat the section. The referenced section is the message; the rest of the file is your workspace / extended detail.\n\nTo author clickable choice chips with the chat, add a markdown section whose heading has `.suggest`, e.g. `## Pick one {.suggest}` followed by list items `- label | optional hover text | optional command`. The section stays visible as normal markdown and also posts chips for the single resolved chat recipient.\n\nPass `amend_id` (the id returned by a previous chat()) to edit that message IN PLACE in Skip\'s view instead of posting a new one — fix a lint issue or revise wording rather than sending a follow-up correction. The original text is kept in the message\'s history. With the file form you can edit the section in the file, then chat the same `file`+`section` with its `amend_id` to re-render the update in place. Amend honestly: an amend is for fixing the SAME message, not slipping in a different one.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Agent-set expression over agent names/ids/labels — e.g. "fleet:skip", "skip | guidance", "awake & reviewers". Required for a new message; ignored when amend_id is set.' },
          message: { type: 'string', description: 'Inline message text. Provide this OR (file + section), not both.' },
          file: { type: 'string', description: 'Path to a markdown file (absolute or relative to your cwd). With `section`, the named section is rendered as the message body.' },
          section: { type: 'string', description: 'Pandoc-style section id within `file` (a heading slug, e.g. "the-plan" for "## The plan", or an explicit {#id}). The section runs to the next heading of the same or higher level.' },
          amend_id: { type: 'number', description: 'The id of one of your earlier messages (returned by chat()). When set, this edits that message in place instead of sending a new one — no filter needed.' },
          max_recipients: { type: 'number', description: 'If the resolved recipient list exceeds this count, abort and return an error listing the matched agents. Default: 5. Pass a higher value to explicitly confirm a large broadcast.' },
        },
      },
    },
    {
      name: 'dismiss_skill',
      description: 'Dismiss a required-skill block when you are genuinely sure the skill does not apply to what you are doing (e.g. you are editing a .tex file only to fix a build path, not to write prose). This is the ONE deliberate way past a sticky skill block — the alternative is to actually read the skill with the Skill tool. A reason is REQUIRED and is shown to Skip as a card, so dismiss honestly: if the skill might apply, read it instead. You can dismiss several skills at once. Edit-specific skills are dismissed for the current file; dispositional/tool skills for the session.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this skill does not apply to your current action. Required. Shown to Skip.' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Optional specific skill name(s) to dismiss. Omit to dismiss everything currently blocking you.' },
        },
        required: ['reason'],
      },
    },
    {
      name: 'request_terminal',
      description: 'Voluntarily ask the user to look at your terminal — pops a live terminal card in their fleet chat that mirrors your tmux session. Use when you are stuck on something the user needs to do interactively (e.g. a permission prompt that survives `tlda daemon start`, an external login). Do NOT use for routine status — that is what `chat()` is for. The user can dismiss the card to freeze a snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short one-line reason that will be shown above the terminal card (e.g. "stuck on permission prompt", "need brew sudo password"). Optional but strongly preferred.' },
        },
      },
    },
    {
      name: 'notify',
      description: 'Raise or dismiss an actionable item for the human. Defaults by kind: bounce/mic-death → HUD notification; modal/suggest/task → list task; all items also live in chat.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['raise', 'dismiss'], description: 'Default raise. Use dismiss with id to remove an item.' },
          id: { type: 'string', description: 'Stable item id. Re-raising the same id replaces the existing item.' },
          userId: { type: 'string', description: 'Target human fleet id. Defaults to server owner.' },
          kind: { type: 'string', description: 'bounce, modal, status, task, suggest, info, etc.' },
          title: { type: 'string', description: 'One-line headline.' },
          body: { type: 'string', description: 'Optional detail text.' },
          actions: {
            type: 'array',
            description: 'Action buttons.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                command: { type: 'string' },
                target: { type: 'string' },
                clientAction: { type: 'string' },
              },
              required: ['label'],
            },
          },
          present: {
            type: 'object',
            properties: {
              chat: { type: 'boolean' },
              hud: { type: 'boolean' },
              list: { type: 'boolean' },
            },
          },
          payload: { type: 'object', description: 'Optional payload for later drag/drop consumers.' },
          dropTarget: { type: 'string' },
          ttl: { type: 'number', description: 'Milliseconds before expiry.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
      },
    },
    {
      name: 'tasks',
      description: 'List a page of active (non-done) tasks, plus registered agents. Call at session start. Paginated: the reply always states the whole-fleet total, and gives a cursor to pass back when more pages remain.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Tasks per page (default 50, max 200).' },
          cursor: { type: 'string', description: 'Cursor from a previous tasks() reply. Omit for the first page.' },
        },
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
      name: 'inbox',
      description: 'Show this agent\'s current obligation inbox. View is read-time presentation only; notification status is controlled separately by set_inbox_status().',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: INBOX_VIEWS,
            description: 'Read-time inbox view. default = bounded NOW/BATCHED/BACKGROUND; review = reports/gates/missing evidence; monitoring = blockers/stale/incident/release gates; current-task = active task/thread first; all = broad grouped view.',
          },
          peek: {
            type: 'boolean',
            description: 'Preview without marking included unread messages seen. Default false.',
          },
        },
      },
    },
    {
      name: 'set_inbox_status',
      description: 'Set this agent\'s visible notification status without reading or marking inbox items. Status controls future wake behavior; inbox views are chosen separately when calling inbox().',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: INBOX_STATUSES,
            description: 'Notification status to advertise for this agent.',
          },
          tag: {
            type: 'string',
            description: 'Optional short advisory context, e.g. "spawn broken" or "writing patch". Does not change wake policy.',
          },
        },
        required: ['status'],
      },
    },
    {
      name: 'set_delivery_channel',
      description: 'Set an agent\'s preferred delivery channel for wake pings. Defaults to yourself. You may set another agent only if you are that agent\'s manager/delegator.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Target agent identifier. Omit to set your own delivery channel.',
          },
          channel: {
            type: 'string',
            enum: DELIVERY_CHANNELS,
            description: 'channel = normal fleet/inbox notification channel; tmux = terminal nudge when a tmux route exists.',
          },
        },
        required: ['channel'],
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
      name: 'reanimate',
      description: 'Reanimate a dead agent: clear its dead bit, wake it, and tell it what happened while it was away.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier — session UUID, fleet id, or friendly name' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'spawn_models',
      description: 'List configured daemon fleet spawn model aliases grouped by their daemon-declared harness.',
      inputSchema: {
        type: 'object',
        properties: {
          verified_only: { type: 'boolean', description: 'Only show verified tool-calling models. Default false.' },
        },
      },
    },
    // ---- Search & History ----
    {
      name: 'search',
      description: 'Full-text search across all agent session logs and event history. Returns matching snippets with source info. Powered by FTS5 index (fast). NOTE: this returns snippets, not full conversations. To read a complete conversation thread, use thread(agent) instead.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Unified search query: literal text terms plus event filters such as from:, to:, agent:, cwd:, project:, type:, since:, before:. Agent filters use the fleet expression grammar: |, &, !, parens, labels/names/ids, and me. Use cwd:/path/to/project to list agents who worked in that directory by recency.' },
          project: { type: 'string', description: 'List agents who worked in a project/working directory by chronological recency. Accepts a full cwd path or project basename.' },
          agent: { type: 'string', description: 'Filter to a specific agent selector. Uses the same unified fleet search grammar as the browser search box.' },
          role: { type: 'string', description: 'Filter by role: "user" (human messages), "assistant" (agent responses), "chat", "delegate", "task_done"' },
          limit: { type: 'number', description: 'Max results (default 20, max 100). Ignored when both since and before are set (bounded calls return full range, up to 500).' },
          context: { type: 'number', description: 'Number of surrounding messages to include with each chat match (default 0, max 20). Shows N messages before and after each match.' },
          since: { type: 'string', description: 'ISO timestamp or relative shorthand (e.g. "20m", "2h", "1d") — only return matches after this time.' },
          before: { type: 'string', description: 'ISO timestamp, relative shorthand, or "now" — only return matches before this time. Use for pagination: pass the oldest timestamp from a previous result set.' },
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
      name: 'thread',
      description: 'Read a conversation thread. This is the PRIMARY tool for reading what was said — use it whenever you need to understand a conversation, review what an agent did, or read task history. Returns complete formatted messages in chronological order. Do NOT read JSONL files directly — use this instead.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent selector. Equivalent to filter="agent:<selector>" and resolved by the unified fleet search grammar. Required unless task_id or filter is given.' },
          filter: { type: 'string', description: 'Unified message filter expression, e.g. "from:tabby", "tabby <> permfix", or "from:(chief | tabby) & type:chat".' },
          task_id: { type: 'string', description: 'Task ID — returns all messages related to this task.' },
          since: { type: 'string', description: 'ISO timestamp or relative shorthand (e.g. "20m", "2h", "1d") — only messages after this time.' },
          until: { type: 'string', description: 'ISO timestamp, relative shorthand, or the literal "now" — only messages before this time.' },
          include_delegations: { type: 'boolean', description: 'Include task delegations (default true).' },
          types: { type: 'array', items: { type: 'string' }, description: 'Filter to specific event types. Valid values: chat, delegate, task_done, task_update, report, login, register, lifecycle. Example: ["chat"] returns only chat messages. Omit for all types.' },
          page_size: { type: 'number', description: 'Max messages per page (default 200). To get the next page, call again with `since` set to the last returned timestamp. Ignored when both since and until are set (bounded calls return full range).' },
          project: { type: 'string', description: 'Project name — when provided, each message is annotated with the shadow repo version hash active at that time.' },
        },
      },
    },
    {
      name: 'get_refs',
      description: 'Get pinned reference material — conversation excerpts, files, and other artifacts marked as authoritative. Check this when starting a new task or when you need to understand what the human has approved.',
      inputSchema: { type: 'object', properties: {} },
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
      description: 'Stop an agent through its owning daemon. Sends ESC repeatedly until the agent reaches its prompt (up to 5 attempts, ~12s max). Returns whether the agent was confirmed stopped. Use chat() separately if you need to send a message.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent identifier (UUID, name, or friendly name)' },
        },
        required: ['agent'],
      },
    },
    // ---- Fleet Operations ----
    {
      name: 'roster',
      description: "Fleet roster: whole-fleet awake/hibernating/dead totals plus a row per agent (name, status, last-seen, model, cwd, current activity). Passive read — reads the registry, wakes no one. Filter to a slice with a filter expression (the same one chat uses) so you don't pull the whole fleet: e.g. awake agents, a label, a name, cwd:<path>, or model:<model>.",
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            description: 'Optional filter expression to scope rows: `|` = or, `&` = and, `!` = not, parens group. Tokens are the `awake`/`hibernating` pseudo-labels, agent names, ids, explicit labels, `cwd:<path>`, and `model:<model>`. Examples: "awake" = awake agents; "awake & pickup" = awake AND labelled pickup; "model:gpt-5.5"; "cwd:/Users/skip/work/tlda"; "awake & !goose" = awake but not goose. Omit to list all agents.',
            type: 'string',
          },
          limit: { description: 'Max rows to return (default 50, max 500). Totals are always whole-fleet regardless of limit.', type: 'number' },
        },
      },
    },
    {
      name: 'viewing_context',
      description: "Get the user's current viewing position: which document, page, and source file/line they're scrolled to. Returns structured data so you can read/edit the exact location the user is looking at.",
      inputSchema: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'User fleet ID (default: server owner)' },
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
          to: { type: 'string', description: 'Optional agent target for the timer event. Defaults to the requesting agent.' },
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
    // ---- Report Gate ----
    {
      name: 'subscribe',
      description: 'Create one persisted server-side notification subscription. Two query forms: a fleet label expression, which CCs you on matching chat; or "doc:<name>", which notifies you when someone adds a note or drawing to that document. Delivery is immediate; batch(spec) and hold are stored but not yet enforced.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Required. Either a directional fleet label expression (e.g. "from:skip", "reviewers & !todd") or a single "doc:<name>". Anything else — event:, type:, since:, agent:, to:me, or a doc: term combined with other terms — is rejected.' },
          notification_policy: { type: 'string', description: 'Required: immediate, batch(spec), or hold.' },
          target: { type: 'string', description: 'Target agent to configure. Defaults to this agent; cross-target use requires delegator authority.' },
        },
        required: ['query', 'notification_policy'],
      },
    },
    {
      name: 'subscriptions',
      description: 'List persisted notification subscriptions for a target agent. Defaults to this agent; cross-target inspection requires delegator authority.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    },
    {
      name: 'unsubscribe',
      description: 'Remove one persisted notification subscription by id. Server-side authority checks apply.',
      inputSchema: { type: 'object', properties: { subscription_id: { type: 'number' } }, required: ['subscription_id'] },
    },
    {
      name: 'report',
      description: 'Submit a completed-task report. Defaults to the current task; pass task_id to report or close another task assigned to you, delegated by you, or authorized by human ownership. Messaging is not gated on recipient wake state; delivery queues or bounces at the messaging layer.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional exact task ID to report or close. Defaults to your current active task.' },
          pass: { type: 'boolean', description: 'Legacy self-review mode: set true if self-review passed. Only used when QA is not configured.' },
          summary: { type: 'string', description: 'Structured report summary. Required when close=true.' },
          close: { type: 'boolean', description: 'Close the selected task after posting the report. Replaces task_done().' },
          reason: { type: 'string', description: 'Optional durable task-close reason, e.g. done, canceled, superseded, rejected, or never_should_have_existed.' },
          verified: { type: 'boolean', description: 'Optional assertion that you verified the claims in this report.' },
          approval_id: { type: 'integer', description: 'Event ID of a human approval message. Required when the task requires approval and close=true.' },
          operation_id: { type: 'string', description: 'Optional stable idempotency key for retrying the same report/close operation.' },
          overrides: { type: 'array', items: { type: 'string' }, description: 'Advisory report-lint violation IDs to suppress. Does not affect close semantics.' },
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
  ];
  for (const tool of tools) {
    if (!ENV_SCOPED_TOOL_NAMES.has(tool.name)) continue;
    const schema = tool.inputSchema || { type: 'object', properties: {} };
    schema.properties = { ...(schema.properties || {}), env: ENV_SCHEMA };
    tool.inputSchema = schema;
  }
  return tools;
}

export function formatRecipientStatusSummary(recipients = [], agents = [], receipts = []) {
  const agentMap = new Map((agents || []).map(a => [a.id, a]));
  const receiptMap = new Map((receipts || []).map(r => [r.recipient || r.to, r]));
  return recipients.map(id => {
    const agent = agentMap.get(id);
    const label = agent?.friendly_name || id;
    const status = agent?.metadata?.inboxStatus || null;
    const tag = agent?.metadata?.inboxStatusTag || null;
    const receipt = receiptMap.get(id);
    if (receipt) return formatAttentionReceipt({ recipientLabel: label, ...receipt });
    return status ? `${label} [status:${status}${tag ? ` (${tag})` : ''}]` : label;
  }).join(', ');
}

function inboxTaskSummary(task) {
  if (!task) return null;
  const age = task.delegated_at ? Math.round((Date.now() - new Date(task.delegated_at)) / 60000) : null;
  const nativeSystem = task.metadata?.native_system || task.metadata?.native?.system || null;
  const nativeLabel = nativeSystem === 'claude' ? 'Claude Code' : nativeSystem;
  const lines = [
    `[task:${task.id}] ${task.description || '(untitled task)'}`,
    `State: ${task.status || 'active'}${Number.isFinite(age) ? ` | delegated ${age}m ago` : ''}`,
  ];
  if (task.metadata?.native) lines.push(`Native task in ${nativeLabel || 'native harness'}`);
  if (task.success_criteria?.length) lines.push(`Success criteria: ${task.success_criteria.length}`);
  if (task.metadata?.requires_approval) lines.push('Requires approval before close.');
  return lines.join('\n');
}

function normalizeInboxTasks({ task, tasks }) {
  if (Array.isArray(tasks) && tasks.length) return tasks;
  return task ? [task] : [];
}

function inboxTaskBlocks(tasks) {
  return tasks.map(t => {
    const summary = inboxTaskSummary(t);
    return t?.message ? `${summary}\n\n${t.message}` : summary;
  }).filter(Boolean);
}

function inboxMessageKind(message) {
  if (message.from === 'fleet:skip') return 'user';
  if (message.type === 'delegate') return 'task';
  if (message.metadata?.wiretap_cc?.length) return 'watch';
  return 'message';
}

export async function resolveInboxMessage(message, resolvers) {
  const fromLabel = message.metadata?.fromLabel || message.from;
  const ctx = message.metadata?.context;
  const docHint = formatViewingHint(ctx);
  const { text: chipResolvedText, images: chipImages } = await resolvers.resolveChipTokens(message.text, message.metadata);
  const recipientId = message.to || AGENT_ID;
  let renderedPendingPlaceholder = false;
  const attachmentResolvedText = chipResolvedText.replace(/\{\{att:(\d+)\}\}/g, (token, idx) => {
    const ref = recipientAttachmentRef(message.metadata, recipientId, idx);
    const att = message.metadata?.inline_attachments?.[+idx];
    if (ref?.state === 'pending') {
      renderedPendingPlaceholder = true;
      return pendingAttachmentPlaceholder(ref, att);
    }
    const rendered = formatRecipientAttachmentRef(ref);
    if (rendered) return rendered;
    if (att?.url) return `${att.name || `attachment ${idx}`}: ${att.url}`;
    return token;
  });
  const refResolvedText = resolvers.resolveTheoremRefs(attachmentResolvedText, ctx?.doc, ctx?.version);
  const { text: imgResolvedText, images } = await resolvers.resolveImages(refResolvedText);
  images.push(...chipImages);
  const reminder = message.metadata?.chatReminder ? `\n⚠️ ${message.metadata.chatReminder}` : '';
  const pendingFootnote = renderedPendingPlaceholder || hasPendingAttachmentPlaceholders(message.metadata, recipientId)
    ? `\n\n${PENDING_ATTACHMENT_FOOTNOTE}`
    : '';
  const idHint = message.id ? `, id:${message.id}` : '';
  return {
    id: message.id,
    from: message.from,
    fromLabel,
    kind: inboxMessageKind(message),
    priority: message.metadata?.priority || 'normal',
    inboxDelivery: message.metadata?.inbox_delivery || 'notified',
    inboxStatus: message.metadata?.inbox_status || null,
    inboxStatusTag: message.metadata?.inbox_status_tag || null,
    notifyBy: message.metadata?.notify_by || null,
    images,
    // Markdown-formatted so the inbox renders cleanly in Skip's chat (which
    // markdown-renders tool output) AND reads well as raw text for agents:
    // a bold-sender metadata line, then the message on its own line. Every
    // field is preserved (sender, id, viewing/machine, reply target) — this is
    // a formatter, not a filter (Skip: "show me what you experience, nicely
    // formatted… written in proper markdown"). `\n` renders as a line break
    // (marked `breaks:true`).
    line: `**${fromLabel}**${idHint}${docHint}  ·  reply \`chat(to: "${message.from}")\`\n${imgResolvedText}${pendingFootnote}${reminder}`,
  };
}

function isPastNotifyBy(message, now = Date.now()) {
  if (!message.notifyBy) return false;
  const ts = Date.parse(message.notifyBy);
  return Number.isFinite(ts) && ts <= now;
}

function inboxDefaultBucket(message, now = Date.now()) {
  if (message.inboxDelivery === 'batched' && !isPastNotifyBy(message, now)) return 'batched';
  if (message.inboxDelivery === 'queued') return 'background';
  if (message.kind === 'watch') return 'background';
  return 'now';
}

function inboxTimingHint(message, now = Date.now()) {
  if (message.inboxDelivery === 'batched' && message.notifyBy) {
    const ts = Date.parse(message.notifyBy);
    if (Number.isFinite(ts)) {
      const seconds = Math.max(0, Math.ceil((ts - now) / 1000));
      if (seconds > 0) return ` [delivers in ${seconds}s]`;
      return ' [delivery due]';
    }
  }
  return '';
}

function inboxPriorityHint(message) {
  return message.priority && message.priority !== 'normal' ? ` [${message.priority}]` : '';
}

function inboxStatusHint(message) {
  if (!message.inboxStatus) return '';
  const tag = message.inboxStatusTag ? ` (${message.inboxStatusTag})` : '';
  return ` [recipient was ${message.inboxStatus}${tag}]`;
}

function inboxDefaultLine(message, now = Date.now()) {
  return `${message.line}${inboxPriorityHint(message)}${inboxTimingHint(message, now)}${inboxStatusHint(message)}`;
}

function groupedInboxLines(messages) {
  const groups = [
    ['user', 'USER / SKIP'],
    ['task', 'TASK UPDATES'],
    ['message', 'DIRECT MESSAGES'],
    ['watch', 'WATCH / WIRETAP'],
  ];
  const lines = [];
  for (const [kind, label] of groups) {
    const rows = messages.filter(m => m.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${label}`);
    pushInboxEntries(lines, rows, m => m.line);
    lines.push('');
  }
  return lines;
}

// Push numbered message entries with a blank line between them, so each reads
// as its own block in the markdown-rendered inbox (clear separation on the
// reading surface — the message lines are two-line markdown).
function pushInboxEntries(lines, rows, fmt) {
  rows.forEach((m, i) => {
    if (i > 0) lines.push('');
    lines.push(`[${i + 1}] ${fmt(m)}`);
  });
}

export function formatInboxText({ mode, task, tasks, messages, counts = null, now = Date.now() }) {
  const activeTasks = normalizeInboxTasks({ task, tasks });
  const taskBlocks = inboxTaskBlocks(activeTasks);
  const lines = [];
  const count = messages.length;
  lines.push(`**INBOX MODE:** ${mode}`);
  if (counts?.tasks_truncated || counts?.messages_truncated) {
    const parts = [];
    if (counts.tasks_truncated) parts.push(`${activeTasks.length}/${counts.tasks} active tasks shown`);
    if (counts.messages_truncated) parts.push(`${messages.length}/${counts.messages} unread messages shown`);
    lines.push(`Page-limited: ${parts.join('; ')}.`);
  }

  if (mode === 'default') {
    const nowRows = messages.filter(m => inboxDefaultBucket(m, now) === 'now');
    const batchedRows = messages.filter(m => inboxDefaultBucket(m, now) === 'batched');
    const backgroundRows = messages.filter(m => inboxDefaultBucket(m, now) === 'background');

    lines.push('');
    lines.push('## NOW');
    if (!activeTasks.length && !nowRows.length) lines.push('- Clear. No active task or immediate unread messages.');
    pushInboxEntries(lines, nowRows, m => inboxDefaultLine(m, now));
    if (taskBlocks.length) {
      lines.push('');
      lines.push('## ACTIVE WORK');
      lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
    }

    lines.push('');
    lines.push('## BATCHED');
    if (!batchedRows.length) lines.push('- Nothing waiting for the batch window.');
    pushInboxEntries(lines, batchedRows, m => inboxDefaultLine(m, now));

    lines.push('');
    lines.push('## BACKGROUND');
    if (!backgroundRows.length) lines.push('- No queued or watch items.');
    pushInboxEntries(lines, backgroundRows, m => inboxDefaultLine(m, now));

    return lines.join('\n');
  }

  if (mode === 'current-task') {
    const directRows = messages.filter(m => m.kind !== 'watch');
    const watchRows = messages.filter(m => m.kind === 'watch');
    lines.push('');
    lines.push('## CURRENT TASK');
    if (!taskBlocks.length) lines.push('- No active task assigned.');
    if (taskBlocks.length) lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
    lines.push('');
    lines.push('## RELATED UNREAD');
    if (!directRows.length) lines.push('- No direct unread messages.');
    pushInboxEntries(lines, directRows, m => m.line);
    // Reading the inbox marks these rows read, so a count is a lost delivery:
    // the agent never sees the content and the row never comes back. Render
    // them like every other view does.
    if (watchRows.length) {
      lines.push('');
      lines.push('## BACKGROUND');
      pushInboxEntries(lines, watchRows, m => m.line);
    }
    return lines.join('\n');
  }

  if (mode === 'monitoring') {
    lines.push('');
    lines.push('## WAITING ON ME');
    const waiting = messages.filter(m => m.kind === 'user' || m.kind === 'task' || m.kind === 'message');
    if (!waiting.length) lines.push('- Nothing currently waiting on this agent.');
    pushInboxEntries(lines, waiting, m => m.line);
    if (taskBlocks.length) {
      lines.push('');
      lines.push('## OWNED WORK');
      lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
    }
    const watch = messages.filter(m => m.kind === 'watch');
    if (watch.length) {
      lines.push('');
      lines.push('## WATCHLIST CHANGES');
      pushInboxEntries(lines, watch, m => m.line);
    }
    return lines.join('\n');
  }

  if (mode === 'review') {
    lines.push('');
    lines.push('## REVIEW / GATES');
    const reviewRows = messages.filter(m => m.kind === 'task' || /report|review|qa|gate|evidence|approve|reject/i.test(m.line));
    if (!reviewRows.length && !taskBlocks.length) lines.push('- No review or gate item is currently pending.');
    pushInboxEntries(lines, reviewRows, m => m.line);
    if (taskBlocks.length) {
      lines.push('');
      lines.push('## OWNED REVIEW WORK');
      lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
    }
    const other = messages.filter(m => !reviewRows.includes(m));
    if (other.length) {
      lines.push('');
      lines.push(`## OTHER INBOX ITEMS (${other.length})`);
      pushInboxEntries(lines, other, m => m.line);
    }
    return lines.join('\n');
  }

  if (mode === 'all') {
    lines.push('');
    lines.push('## ALL ACTIVE INBOX');
    if (!activeTasks.length && count === 0) lines.push('- Clear. No active task or unread messages.');
    if (taskBlocks.length) {
      lines.push('## TASKS');
      lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
      lines.push('');
    }
    lines.push(...groupedInboxLines(messages));
    return lines.join('\n').trimEnd();
  }

  lines.push('');
  lines.push('## ACTIONABLE QUEUE');
  if (!activeTasks.length && count === 0) lines.push('- Clear. No active task or unread messages.');
  if (taskBlocks.length) {
    lines.push('TASKS');
    lines.push(...taskBlocks.flatMap((block, i) => i ? ['', block] : [block]));
    lines.push('');
  }
  lines.push(...groupedInboxLines(messages));
  return lines.join('\n').trimEnd();
}

export function inboxViewForArgs(args = {}) {
  return normalizeInboxView(args?.view || 'default');
}

export async function handleFleetTool(name, args) {
  const requestedEnv = normalizeEnvArg(args);
  if (requestedEnv && ENV_SCOPED_TOOL_NAMES.has(name) && !_activeToolEnv) {
    const scopedArgs = { ...args };
    delete scopedArgs.env;
    const previous = _activeToolEnv;
    _activeToolEnv = requestedEnv;
    try {
      const resolvedEnv = activeEnvName();
      const result = await handleFleetTool(name, scopedArgs);
      return annotateEnvResult(result, resolvedEnv);
    } finally {
      _activeToolEnv = previous;
    }
  }
  // Report tool_call status to dashboard (replaces pane scraping for idle detection)
  reportStatus('tool_call', name);

  try {
    await flushFleetTransportOpportunistically(name);

  // ==== Registration & Identity ====

  // ---- login ----
  if (name === 'login') {
    const localAgentId = process.env.FLEET_MINT_ID || process.env.FLEET_LOCAL_ID || null;
    const shellId = resolveLoginFleetId({
      explicitFleetId: args.agent_id || AGENT_ID || process.env.FLEET_ID || null,
      mintId: localAgentId,
      storeFile: path.join(CONFIG_DIR, 'daemon-mints.sqlite'),
    });
    const boundFleetId = process.env.FLEET_ID || null;
    if (boundFleetId && shellId !== boundFleetId) {
      return { content: [{ type: 'text', text: `Login rejected: requested ${shellId} but this process is bound to ${boundFleetId}.` }], isError: true };
    }
    if (AGENT_ID && shellId !== AGENT_ID) {
      return { content: [{ type: 'text', text: `Login rejected: session already bound to ${AGENT_ID}, cannot relogin as ${shellId}.` }], isError: true };
    }
    if (args.session_id) CLAUDE_SESSION = args.session_id;

    let detectedTmux = process.env.FLEET_TMUX_SESSION || null;
    if (!detectedTmux && process.env.TMUX) {
      try {
        const tmuxSession = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 3000 }).trim();
        if (tmuxSession.startsWith('fleet-')) detectedTmux = tmuxSession;
      } catch {
        // Tmux auto-detection is optional; login still proceeds without a tmux name.
      }
    }

    const cwd = getAgentCwd() || process.env.PWD || null;
    const labels = [];
    if (cwd) {
      const project = path.basename(cwd);
      if (project && project !== '~') labels.push(project);
    }
    const machineId = process.env.TLDA_MACHINE_ID || os.hostname().split('.')[0];
    const envName = getActiveEnvName();
    const daemonKey = process.env.FLEET_DAEMON_KEY || (machineId && envName ? `${machineId}:${envName}` : null);
    const currentHarness = harnessFromEnv();
    const localMarker = extra => formatLoginMarker({
      mint_id: process.env.FLEET_MINT_ID || localAgentId || shellId,
      local_agent_id: localAgentId || undefined,
      fleet_id: shellId || boundFleetId || undefined,
      friendly_name: process.env.FLEET_NAME || undefined,
      session_id: args.session_id || CLAUDE_SESSION || undefined,
      daemon_key: daemonKey || undefined,
      machine_id: machineId,
      env_name: envName,
      harness_kind: currentHarness.kind,
      tmux_session: detectedTmux || undefined,
      cwd: cwd || undefined,
      ...extra,
    });
    if (!shellId) {
      if (!localAgentId) {
        return { content: [{ type: 'text', text: 'No local or server agent identity is available.' }], isError: true };
      }
      return { content: [{ type: 'text', text: [
        localMarker({ fleet_id: undefined }),
        `Fleet seat is not recorded yet for mint ${localAgentId}.`,
      ].join('\n') }], isError: true };
    }
    AGENT_ID = shellId;
    const loginBody = {
      agent_id: shellId,
      session_id: args.session_id || CLAUDE_SESSION || undefined,
      tmux_session: detectedTmux || undefined,
      cwd: cwd || undefined,
      labels,
      machine_id: machineId,
      env_name: envName,
      metadata: { kind: currentHarness.kind },
    };

    if (!_channelRWS?.connected) {
      startChannelWS();
      const deadline = Date.now() + 2000;
      while (!_channelRWS?.connected && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    const serverResult = await mcpFleetTransport.durable('login', loginBody)?.catch(e => ({ error: e.message }));
    if (!serverResult) {
      return { content: [{ type: 'text', text: [
        localMarker({}),
        'Login failed: fleet WS did not connect before the request deadline.',
      ].join('\n') }], isError: true };
    }
    if (serverResult.error) {
      return { content: [{ type: 'text', text: [
        localMarker({}),
        `Login rejected by server: ${serverResult.error}`,
      ].join('\n') }], isError: true };
    }
    await flushFleetTransport({ limit: 100 }).catch(e => {
      process.stderr.write(`[fleet-transport] login flush failed: ${e.message}\n`);
    });

    const agent = serverResult.agent || {};
    const friendly = agent.friendly_name || shellId;
    ledger.upsertAgent(shellId, args.session_id || CLAUDE_SESSION, cwd, friendly);
    const msg = [
      localMarker({ fleet_id: shellId, friendly_name: friendly }),
      `Logged in ${shellId}.`,
      `Your name: "${friendly}" — other agents and the user know you by this name.`,
      '',
      'After login: call inbox() to check for a task. If nothing, just keep working — you\'ll see 📬 when a task or message arrives.',
      'When you see 📬 as input, call inbox() — it means you have a new task or message.',
      'Chat formatting: dashboard renders markdown (**bold**, `code`, lists, headers) and LaTeX ($inline$, $$display$$). Use them in chat() messages.',
    ].join('\n');
    return { content: [{ type: 'text', text: msg }] };
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

  async function harnessKindForDelegateTarget(agent, spawnOpts) {
    if (!agent) return null;
    try {
      const agents = await mcpFleetTransport.ephemeral('store-agents');
      const target = Array.isArray(agents)
        ? agents.find(a => a.id === agent || a.friendly_name === agent)
        : null;
      return target?.metadata?.kind || null;
    } catch (e) {
      process.stderr.write(`[fleet] could not resolve delegate target harness: ${e.message}\n`);
      return null;
    }
  }

  async function getRoster() {
    const agents = await mcpFleetTransport.ephemeral('store-agents');
    return Array.isArray(agents) ? agents : [];
  }

  function agentMatches(agent, id) {
    return !!agent && (agent.id === id || agent.friendly_name === id || agent.session_id === id);
  }

  async function recentDirectInbound(fromId, toId) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const data = await mcpFleetTransport.ephemeral('store-events', { agent: fromId, since, limit: 100 });
      return (data.events || []).some(e =>
        e.type === 'chat' &&
        e.from === toId &&
        e.to === fromId
      );
    } catch (e) {
      process.stderr.write(`[fleet] recent direct-reply check failed: ${e.message}\n`);
      return false;
    }
  }

  async function requireInLaneAction(targetAgentId, { action, message, directReply = false } = {}) {
    const agents = await getRoster();
    const fromAgent = agents.find(a => a.id === AGENT_ID) || { id: AGENT_ID, cwd: getAgentCwd() };
    const toAgent = agents.find(a => agentMatches(a, targetAgentId));
    if (!toAgent) return null;
    const block = crossLaneBlock({ fromAgent, toAgent, action, message, directReply });
    return block?.text || null;
  }

  // ==== Task Management ====

  // ---- delegate ----
  if (name === 'delegate') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot delegate: not logged in. Call login() first.' }], isError: true };

    if (args.agent && args.mint) {
      return { content: [{ type: 'text', text: 'Provide agent or mint, not both.' }], isError: true };
    }
    if (args.task_id && args.mint) {
      return { content: [{ type: 'text', text: 'Transfer an existing task to an existing agent; provide agent, not mint.' }], isError: true };
    }

    if (!args.agent && !args.mint) {
      return { content: [{ type: 'text', text: 'Missing agent (or mint).' }], isError: true };
    }

    // One name, enforced: on the mint path the mint name is the single source
    // of identity (shell reservation, FLEET_NAME, the login prompt, and the
    // roster all key off it). A separate `friendly_name` would rename the row to
    // a second string after mint — the exact desync that produces ghost rows
    // (a never-seen "math-historian" stub beside a live "math historian"). So
    // forbid it: put the name in `mint.name`. friendly_name remains valid only
    // for the two-call form (delegating to an existing `agent`).
    if (args.mint && args.friendly_name) {
      return { content: [{ type: 'text', text: 'Do not pass friendly_name with mint — the mint name is the agent\'s only name. Put the name in mint.name.' }], isError: true };
    }

    const { message } = args;
    if (!message) return { content: [{ type: 'text', text: 'Missing message.' }], isError: true };

    // Auto-derive description from message if not provided
    let description = args.description;
    if (!description) {
      const firstSentence = message.match(/^[^.!?\n]{5,60}[.!?]/);
      description = firstSentence ? firstSentence[0] : message.slice(0, 60).trimEnd();
    }

    // Merge template + explicit criteria
    const templateCriteria = args.template ? (TASK_TEMPLATES[args.template] || []) : [];
    if (args.template && !TASK_TEMPLATES[args.template]) {
      return { content: [{ type: 'text', text: `Unknown template "${args.template}". Available: ${Object.keys(TASK_TEMPLATES).join(', ')}` }], isError: true };
    }
    const criteria = [...templateCriteria, ...(args.success_criteria || [])];
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    async function delegateToResolvedAgent(targetAgent, targetSpawnedInfo = null, opts = {}) {
      const laneBlock = await requireInLaneAction(targetAgent, {
        action: 'delegate',
        message,
      });
      if (laneBlock) throw new Error(laneBlock);
      const harnessKind = await harnessKindForDelegateTarget(targetAgent, args.mint);
      const routedMessage = applyNonClaudeRolePack(message, {
        template: args.template,
        description,
        successCriteria: criteria,
        harnessKind,
      });

      const operationId = args.operation_id || `${AGENT_ID}:mcp-delegate:${crypto.randomUUID()}`;
      const delegateBody = { from: AGENT_ID, agent: targetAgent, task_id: args.task_id || undefined, description, message: routedMessage, success_criteria: criteria.length ? criteria : undefined, blocked_by: blockedBy.length ? blockedBy : undefined, requires_approval: args.requires_approval || undefined, allow_pending_agent: opts.allowPendingAgent || undefined, operation_id: operationId };
      const data = await mcpFleetTransport.durable('delegate', delegateBody, { operationId });
      rememberOriginatedEvents(data);
      if (!data.ok) throw new Error(`Delegate failed: ${JSON.stringify(data)}`);
      if (data.queued && !data.task_id) return { data, spawnedInfo: targetSpawnedInfo, queued: true, operationId };

      // Set friendly name if provided (two-call form only; mint form already has the name set)
      if (args.friendly_name) {
        await mcpFleetTransport.durable('rename', { agent: targetAgent, name: args.friendly_name })?.catch(e => process.stderr.write(`[fleet] rename failed: ${e.message}\n`));
      }
      return { data, spawnedInfo: targetSpawnedInfo };
    }

    let agent = args.agent;
    let spawnedInfo = null;

    // Combined mint+delegate: mint a fresh agent, then delegate to its fleet ID
    if (args.mint) {
      const spawnOpts = args.mint;
      const agentName = spawnOpts.name || `agent-${Date.now().toString(36).slice(-4)}`;
      const agentCwd = spawnOpts.cwd || getAgentCwd();
      let spawnResult = null;

      try {
        const modelError = await validateSpawnRequest(spawnOpts);
        if (modelError) return { content: [{ type: 'text', text: modelError }], isError: true };
        spawnResult = await mcpFleetTransport.durable('spawn', {
          fresh: true,
          name: agentName,
          model: spawnOpts.model,
          modelOptions: spawnModelOptionsFromArgs(spawnOpts),
          effort: spawnOpts.effort,
          cwd: agentCwd,
          permissionRequest: spawnOpts.permissionRequest,
        });
        if (spawnResult?.ok === false || spawnResult?.error) {
          return { content: [{ type: 'text', text: `mint failed before delegation: ${spawnResult.error || JSON.stringify(spawnResult)}` }], isError: true };
        }
      } catch (e) {
        const msg = (e.message || '').trim();
        return { content: [{ type: 'text', text: `mint failed before delegation: ${msg}` }], isError: true };
      }

      const shellAgentId = spawnResult?.agent_id || spawnResult?.agentId || spawnResult?.agent?.id;
      if (!shellAgentId) {
        return { content: [{ type: 'text', text: `mint accepted for ${agentName}, but returned no shell agent id. Not delegating.` }], isError: true };
      }

      try {
        const { data, queued, operationId } = await delegateToResolvedAgent(shellAgentId, { agent_id: shellAgentId, friendly_name: agentName }, { allowPendingAgent: true });
        if (queued) {
          return { content: [{ type: 'text', text: `Mint requested for ${agentName}; delegation queued durably for shell ${shellAgentId}: ${description}\noperation_id: ${data.operation_id || operationId}\nmint_mailbox_id: ${spawnResult.mailbox_id || '(none)'}\nagent_id: ${shellAgentId}\nfriendly_name: ${agentName}\nMint completion or failure will arrive from the server mailbox.` }] };
        }
        return {
          content: [{
            type: 'text',
            text: `Mint requested for ${agentName}; delegated [${data.task_id}] to shell ${shellAgentId}: ${description}\nmint_mailbox_id: ${spawnResult.mailbox_id || '(none)'}\nagent_id: ${shellAgentId}\nfriendly_name: ${agentName}\nMint completion or failure will arrive from the server mailbox.`,
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `mint reserved ${agentName} (${shellAgentId}), but durable delegation failed: ${e.message}` }], isError: true };
      }
    }

    try {
      const { data, queued, operationId } = await delegateToResolvedAgent(agent, spawnedInfo);
      if (queued) {
        return { content: [{ type: 'text', text: `Delegate queued durably for ${agent}: ${description}\noperation_id: ${data.operation_id || operationId}` }] };
      }

      if (spawnedInfo) {
        return { content: [{ type: 'text', text: `Spawned ${spawnedInfo.friendly_name} (${spawnedInfo.agent_id}) and delegated [${data.task_id}]: ${description}\nagent_id: ${spawnedInfo.agent_id}\nfriendly_name: ${spawnedInfo.friendly_name}` }] };
      }
      const verb = args.task_id ? 'Transferred' : 'Delegated';
      return { content: [{ type: 'text', text: `${verb} to ${agent} [${data.task_id}]: ${description}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Delegate failed before transport ACK: ${e.message}` }], isError: true };
    }
  }

  // ==== Messaging ====

  if (name === 'dismiss_skill') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot dismiss: not logged in. Call login() first.' }], isError: true };
    const reason = (args.reason || '').trim();
    if (!reason) return { content: [{ type: 'text', text: 'A reason is required to dismiss a skill. Say why it does not apply — or read the skill instead.' }], isError: true };
    const skills = Array.isArray(args.skills) ? args.skills.filter(Boolean) : null;
    try {
      const res = await fleetFetch(`${TLDA_FLEET_SERVER}/api/education/dismiss/${encodeURIComponent(AGENT_ID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, ...(skills ? { skills } : {}) }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { content: [{ type: 'text', text: `Dismiss failed: HTTP ${res.status}${text ? ' — ' + text.slice(0, 200) : ''}` }], isError: true };
      }
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `Dismiss failed: ${data.error}` }], isError: true };
      if (!data.dismissed || data.dismissed.length === 0) {
        return { content: [{ type: 'text', text: data.note || 'Nothing is currently blocking you — no skills dismissed.' }] };
      }
      const names = data.dismissed.map(d => d.skill).join(', ');
      return { content: [{ type: 'text', text: `Dismissed ${names}. The block is lifted; you can proceed. (Logged for Skip with your reason.)` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Dismiss failed: ${e.message}` }], isError: true };
    }
  }

  if (name === 'chat') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Cannot send chat: not logged in. Call login() first.' }], isError: true };

    // Resolve the message body — either an inline `message` string or a
    // `file`+`section` markdown reference (extracted agent-side).
    const agentCwd = getAgentCwd();
    const resolvedBody = resolveChatBody(args, agentCwd);
    if (resolvedBody.error) return { content: [{ type: 'text', text: resolvedBody.error }], isError: true };
    if (containsLegacySuggestionsBlock(resolvedBody.body)) {
      return { content: [{ type: 'text', text: 'Message NOT sent — `<suggestions>` blocks have been removed. Use a markdown `.suggest` section, e.g. `## Pick one {.suggest}` followed by `- label | hover text | command` list items.' }], isError: true };
    }
    // Inline `.suggest` section(s): harvested to chips AND left in the (cleaned)
    // body so they render as a normal heading + list.
    const inlineSuggestions = parseInlineSuggestions(resolvedBody.body);
    if (inlineSuggestions.error) return { content: [{ type: 'text', text: `Message NOT sent — ${inlineSuggestions.error}` }], isError: true };
    let { body: message, source } = { body: inlineSuggestions.body, source: resolvedBody.source };
    let sharedFileUploadError = null;
    const authoredSuggestions = inlineSuggestions.suggestions || [];
    const macros = await getMacrosForAgent();
    // Two classes, surfaced differently: render-VALIDITY prominently with the
    // amend affordance (Skip will see garbage if it doesn't render), STYLE
    // hints quietly. No register/completion gate — that was deleted.
    const renderCheck = checkChatRender(message, macros);
    const sharedMarkdownFile = source?.file || null;
    const renderIssues = sharedMarkdownFile ? [] : renderCheck.validity;
    const fileRenderIssues = sharedMarkdownFile ? renderCheck.validity : [];
    const styleHints = renderCheck.style;

    // ---- amend branch: edit an already-sent message in place ----
    // `amend_id` present → route to the server's amend handler (same body forms,
    // same keep/clear-`source` semantics) instead of posting a new message.
    if (args.amend_id != null) {
      // Inline `.suggest` sections are fine on amend — the body is already cleaned
      // (heading + list, attr stripped) so it re-renders correctly — but the chips
      // were posted on the original send and are NOT re-harvested here.
      try {
        let resolvedMessage, inlineAttachments = [];
        if (source?.file) {
          const r = await bundleSharedMarkdownImages(message, source.file, activeFleetServerUrl());
          resolvedMessage = r.body;
          // An amend re-bakes the body from the file, so it must re-upload too —
          // otherwise the amended message shows the new text behind a chip that
          // opens the version sent the first time, or nothing at all.
          ({ source, error: sharedFileUploadError } = await withUploadedSourceFile(source, activeFleetServerUrl()));
        } else {
          ({ resolvedMessage, inlineAttachments } = await processMessageText(message, agentCwd, activeFleetServerUrl()));
        }
        const inlineMarkdownFileIssues = checkSharedMarkdownAttachments(inlineAttachments, macros);
        const body = { from: AGENT_ID, message: resolvedMessage, event_id: args.amend_id };
        if (inlineAttachments?.length) body.inline_attachments = inlineAttachments;
        if (source) body.source = source;
        const data = await mcpFleetTransport.durable('amend', body);
        if (!data?.ok) return { content: [{ type: 'text', text: `Amend failed: ${data?.error || `no message of yours matched id ${args.amend_id}`}` }], isError: true };
        let extra = '';
        if (renderIssues.length > 0) {
          extra += `\n\n⚠ **Still won't render (${renderIssues.length}):**\n${renderIssues.map(l => `- ${l}`).join('\n')}\nFix and re-chat \`amend_id: ${data.event_id}\` again — Skip is reading this message.`;
        }
        if (fileRenderIssues.length > 0) {
          const fileLabel = path.basename(sharedMarkdownFile);
          extra += `\n\n⚠ **Shared markdown file won't render properly (${fileRenderIssues.length} issue${fileRenderIssues.length > 1 ? 's' : ''}): \`${fileLabel}\`.** The problem is in the file, not the chat wrapper. Edit the markdown file; the shared surface should update from the file:\n${fileRenderIssues.map(l => `- ${l}`).join('\n')}`;
        }
        for (const fileIssue of inlineMarkdownFileIssues) {
          extra += `\n\n⚠ **Shared markdown file won't render properly (${fileIssue.issues.length} issue${fileIssue.issues.length > 1 ? 's' : ''}): \`${fileIssue.name}\`.** The problem is in the file, not the chat wrapper. Edit the markdown file; the shared surface should update from the file:\n${fileIssue.issues.map(l => `- ${l}`).join('\n')}`;
        }
        if (styleHints.length > 0) {
          extra += `\n\nStyle (optional): ${styleHints.join(' ')}`;
        }
        if (inlineSuggestions.suggestions?.length) {
          extra += `\n\nNote: the inline \`.suggest\` section rendered cleanly, but its chips were NOT re-posted (amend edits the message text, not its already-posted chips).`;
        }
        if (sharedFileUploadError) {
          extra += `\n\n⚠ **Shared file upload failed — the amended text is live, but its file chip won't open** (${sharedFileUploadError}).`;
        }
        return { content: [{ type: 'text', text: `Amended message ${data.event_id} in place.${extra}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Amend failed: ${e.message}` }], isError: true };
      }
    }

    // Resolve recipients from the agent-set expression.
    // `to` is a string like "fleet:skip", "skip | guidance", or "awake & reviewers".
    // Parse it once, then test each agent's label set — no event-filter object
    // and no nested arrays, so any agent (incl. goose-backed) can emit it.
    if (args.filter) {
      return { content: [{ type: 'text', text: 'Missing to — chat recipients are now an agent-set string, e.g. to: "fleet:skip" or to: "skip | guidance". Do not wrap it in filter.to.' }], isError: true };
    }
    if (!args.to) return { content: [{ type: 'text', text: 'Missing to — specify recipients as an agent-set expression, e.g. "fleet:skip" or "awake & reviewers".' }], isError: true };
    let filterAst;
    try { filterAst = parseFilter(args.to); } catch (e) { return { content: [{ type: 'text', text: `⚠ Message NOT sent — bad to expression "${args.to}": ${e.message}` }], isError: true }; }
    if (!filterAst) return { content: [{ type: 'text', text: '⚠ Message NOT sent — empty to expression.' }], isError: true };
    let recipients = [];
    let agents = [];
    let rosterUnavailable = false;
    // Short-circuit: a bare literal agent id (fleet:…) needs no roster lookup —
    // send straight to the id (avoids fetching the whole fleet for the common
    // { to: "fleet:<id>" } case).
    const bareId = filterAst.t === 'lit' && /^fleet:/.test(filterAst.v) ? filterAst.v : null;
    if (bareId) {
      if (bareId !== AGENT_ID) recipients.push(bareId);
    } else {
      try {
        agents = (await mcpFleetTransport.ephemeral('store-agents')) || [];
        if (agents.length === 0) {
          rosterUnavailable = true;
        } else {
          for (const a of agents) {
            if (a.id === AGENT_ID) continue;
            const labels = agentSetLabelsForChat(a);
            if (evalExpr(filterAst, labels)) {
              recipients.push(a.id);
            }
          }
        }
      } catch (e) {
        rosterUnavailable = true;
      }
    }
    recipients = [...new Set(recipients)];
    // Target validator: report empty/unresolved honestly and distinctly from "server down".
    // A transient roster miss must never block a direct (exact-id) send.
    if (recipients.length === 0) {
      if (rosterUnavailable) return { content: [{ type: 'text', text: "⚠ Message NOT sent — couldn't fetch the agent roster to resolve a label filter (transient). Retry shortly." }], isError: true };
      return { content: [{ type: 'text', text: `⚠ Message NOT sent — no agent matched "${args.to}". Check the name/label — this is a targeting miss, not a server problem.` }], isError: true };
    }
    const maxRecipients = args.max_recipients ?? 5;
    if (recipients.length > maxRecipients) {
      const names = recipients.map(id => { const a = agents?.find(x => x.id === id); return a?.friendly_name || id; });
      return { content: [{ type: 'text', text: `Broadcast to ${recipients.length} agents exceeds max_recipients=${maxRecipients}. Matched: ${names.join(', ')}. Pass max_recipients=${recipients.length} to confirm.` }], isError: true };
    }
    if (authoredSuggestions.length && recipients.length !== 1) {
      return { content: [{ type: 'text', text: '`.suggest` sections currently require exactly one resolved chat recipient. Narrow `to` to one agent, or send the message without suggestions.' }], isError: true };
    }
    if (authoredSuggestions.some(s => s.targetId && !recipients.includes(s.targetId))) {
      return { content: [{ type: 'text', text: 'A `.suggest` item has a target that is not one of this chat\'s resolved recipients.' }], isError: true };
    }
    const laneBlocks = [];
    for (const to of recipients) {
      const directReply = await recentDirectInbound(AGENT_ID, to);
      const laneBlock = await requireInLaneAction(to, {
        action: 'chat',
        message,
        directReply,
      });
      if (laneBlock) laneBlocks.push(laneBlock);
    }
    if (laneBlocks.length) {
      return { content: [{ type: 'text', text: `Message NOT sent.\n${laneBlocks.map(b => `- ${b}`).join('\n')}` }], isError: true };
    }

    // Resolve the body's file references → uploads. Two modes:
    //  - file-share (source.file): the body is a markdown file's content; bundle
    //    its image includes (upload + rewrite refs inline) so they render for
    //    every viewer. Don't chipify a shared file's prose.
    //  - inline message: detect bare file paths / image URLs → inline attachments.
    // Uploads target the FLEET server (where chat is viewed), not the doc server
    // (TLDA_SERVER), which post-cutover may be a different machine.
    let resolvedMessage, inlineAttachments = [], brokenPaths = [];
    if (source?.file) {
      const r = await bundleSharedMarkdownImages(message, source.file, activeFleetServerUrl());
      resolvedMessage = r.body;
      // Upload the shared file itself, not only its images, so its chip opens.
      ({ source, error: sharedFileUploadError } = await withUploadedSourceFile(source, activeFleetServerUrl()));
    } else {
      ({ resolvedMessage, inlineAttachments, brokenPaths } = await processMessageText(
        message, agentCwd, activeFleetServerUrl()
      ));
    }
    const inlineMarkdownFileIssues = checkSharedMarkdownAttachments(inlineAttachments, macros);

    // We don't bounce a message. Ever. Warn, don't bounce: deliver it and at most
    // append a warning so the sender can amend in place. (Here, processMessageText
    // already rewrote the refs it could resolve; any leftover path-looking tokens
    // just stay as plain text and the message still goes.)

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

    // Sender's preamble reference: the document whose macros this agent's math
    // should render with, stamped on every message so each reader renders it with
    // the sender's preamble (not the reader's). { doc, version } — version is
    // captured for the future but ignored on resolution today.
    let preambleRef = null;
    const preambleDoc = await getAgentPreambleDoc();
    if (preambleDoc) {
      const pv = await fetchCurrentDocVersion(preambleDoc);
      preambleRef = { doc: preambleDoc, version: pv || null };
    }

    // Single write: send to dashboard server via WS.
    const sent = [];
    const failed = [];
    const receipts = [];
    const queued = [];
    let lastEventId = null;
    const priority = parsePriorityPhrase(resolvedMessage) || 'normal';
    for (const to of recipients) {
      const chatBody = { message: resolvedMessage, to, from: AGENT_ID, metadata: { priority }, _tempId: `${AGENT_ID}:mcp-chat:${crypto.randomUUID()}` };
      if (inlineAttachments.length) chatBody.inline_attachments = inlineAttachments;
      if (refAttachments.length) chatBody.attachments = refAttachments;
      if (docContext) chatBody.context = docContext;
      if (preambleRef) chatBody.preambleRef = preambleRef;
      if (source) chatBody.source = source;
      try {
        const data = await mcpFleetTransport.durable('chat', chatBody, { operationId: chatBody._tempId });
        if (data?.queued) {
          sent.push(to);
          queued.push({ to, operationId: data.operation_id || chatBody._tempId });
        } else if (data?.ok) {
          sent.push(to);
          if (data.event_ids?.length) lastEventId = data.event_ids[0];
          if (Array.isArray(data.receipts)) receipts.push(...data.receipts);
        }
        else failed.push(to);
      } catch (e) {
        failed.push(`${to} (${e.message})`);
      }
    }

    if (sent.length === 0) return { content: [{ type: 'text', text: `⚠ Send failed — no recipient send was accepted or queued. Failed: ${failed.join(', ')}` }], isError: true };

    let warning = '';
    let suggestionNotice = '';
    if (authoredSuggestions.length && lastEventId != null) {
      try {
        const count = await postChatAuthoredSuggestions(authoredSuggestions, sent, { messageId: lastEventId });
        suggestionNotice = ` Posted ${count} suggestion chip(s).`;
      } catch (e) {
        warning += `\n\n⚠ **Suggestion chips were not posted:** ${e.message}`;
      }
    }

    const brokenFiles = inlineAttachments.filter(a => a.broken).map(a => a.path);
    if (brokenFiles.length) {
      warning += `\n\n⚠ **File(s) not uploaded** (not found or upload failed — removed from message):\n${brokenFiles.map(p => `- ${p}`).join('\n')}`;
    }
    // Path-looking tokens that didn't resolve to a real file: the message was
    // delivered with them left as plain text (warn, don't bounce). If one was
    // meant to be a shared artifact, re-send it with a real path.
    if (brokenPaths.length) {
      warning += `\n\n⚠ **Sent as text — these look like file paths but didn't resolve to a file** (if you meant to share one, resend with a real path):\n${brokenPaths.map(p => `- ${p}`).join('\n')}`;
    }
    // The shared file's content was delivered (it is the message body), but the
    // upload that makes its chip openable failed, so clicking it will do nothing.
    if (sharedFileUploadError) {
      warning += `\n\n⚠ **Shared file uploaded failed — the message was delivered, but its file chip won't open** (${sharedFileUploadError}).`;
    }

    // Render-VALIDITY: prominent — Skip sees broken output unless the agent
    // amends. This is the "warn so they can amend their shit" check (Skip 6/19).
    if (renderIssues.length > 0) {
      const target = lastEventId != null ? `chat({ amend_id: ${lastEventId}, message: "…" })` : 'chat({ amend_id: <id>, message: "…" })';
      warning += `\n\n⚠ **Won't render properly (${renderIssues.length} issue${renderIssues.length > 1 ? 's' : ''}) — Skip will see broken output.** Fix it in place with \`${target}\` (edits the message Skip is reading, no new message):\n${renderIssues.map(l => `- ${l}`).join('\n')}`;
    }
    if (fileRenderIssues.length > 0) {
      const fileLabel = path.basename(sharedMarkdownFile);
      warning += `\n\n⚠ **Shared markdown file won't render properly (${fileRenderIssues.length} issue${fileRenderIssues.length > 1 ? 's' : ''}): \`${fileLabel}\`.** The problem is in the file, not the chat wrapper. Edit the markdown file; the shared surface should update from the file:\n${fileRenderIssues.map(l => `- ${l}`).join('\n')}`;
    }
    for (const fileIssue of inlineMarkdownFileIssues) {
      warning += `\n\n⚠ **Shared markdown file won't render properly (${fileIssue.issues.length} issue${fileIssue.issues.length > 1 ? 's' : ''}): \`${fileIssue.name}\`.** The problem is in the file, not the chat wrapper. Edit the markdown file; the shared surface should update from the file:\n${fileIssue.issues.map(l => `- ${l}`).join('\n')}`;
    }
    const launderIssues = checkLaunderChatLint(message, sent, { paperContext: Object.keys(macros).length > 0 });
    if (launderIssues.length > 0) {
      warning += `\n\n${launderIssues.map(issue => formatLaunderChatWarning(issue, lastEventId)).join('\n')}`;
    }
    // STYLE: quiet, optional — never a gate.
    if (styleHints.length > 0) {
      warning += `\n\nStyle (optional): ${styleHints.join(' ')}`;
    }
    if (queued.length) {
      warning += `\n\nQueued for durable delivery; no server ACK yet:\n${queued.map(q => `- ${q.to}: ${q.operationId}`).join('\n')}`;
      if (authoredSuggestions.length) {
        warning += '\nSuggestion chips were not posted yet because the chat message has not received a server id.';
      }
    }

    const amendHint = lastEventId != null ? ` (message id ${lastEventId} — chat({ amend_id: ${lastEventId} }) to edit it in place)` : '';
    const sentSummary = formatRecipientStatusSummary(sent, agents, receipts);
    const deliveryText = receipts.length
      ? `.\n${sentSummary.split(', ').join('\n')}`
      : ` for ${sentSummary || sent.join(', ')}.`;
    return { content: [{ type: 'text', text: `Message queued${deliveryText}${suggestionNotice}${amendHint}${warning}` }] };
  }

  // ---- request_terminal ----
  // Voluntary terminal-card pop. Hits the tlda server's /api/terminal-card
  // endpoint, which broadcasts a `terminal_card` fleet event to Skip — the
  // browser-side fleet chat opens a live TerminalCard mirroring this agent's
  // tmux session.
  if (name === 'request_terminal') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    const { reason } = args || {};
    try {
      const res = await fleetFetch(`${TLDA_FLEET_SERVER}/api/terminal-card`, {
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

  // ---- notify ----
  if (name === 'notify') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    const action = args?.action || 'raise';
    if (action === 'dismiss' && !args?.id) return { content: [{ type: 'text', text: 'notify dismiss requires `id`.' }], isError: true };
    if (action !== 'dismiss' && !args?.title) return { content: [{ type: 'text', text: 'notify raise requires `title`.' }], isError: true };
    const item = action === 'dismiss' ? null : {
      id: args.id || `${AGENT_ID}:${args.kind || 'info'}:${Date.now()}`,
      kind: args.kind || 'info',
      from: AGENT_ID,
      title: args.title,
      body: args.body || '',
      actions: Array.isArray(args.actions) ? args.actions : [],
      present: args.present || undefined,
      payload: args.payload || undefined,
      dropTarget: args.dropTarget || undefined,
      ttl: Number.isFinite(args.ttl) ? args.ttl : undefined,
      priority: args.priority || undefined,
    };
    try {
      const data = await mcpFleetTransport.durable('notify', action === 'dismiss'
        ? { action: 'dismiss', id: args.id, userId: args.userId }
        : { action: 'raise', userId: args.userId, item }, { deadlineMs: 3000 });
      return { content: [{ type: 'text', text: action === 'dismiss' ? `Dismissed item ${args.id}.` : `Raised ${data.item?.kind || item.kind} item ${data.item?.id || item.id}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `notify failed before transport ACK: ${e.message}` }], isError: true };
    }
  }


  // ---- tasks ----
  if (name === 'tasks') {
    // Paged, and it says so. This tool used to take the first 100 rows the
    // transport happened to return and present them as the whole list — which is
    // how the open-task count drifted from "501" to 851 with nobody noticing.
    // Every reply now carries the whole-fleet total, and a cursor when the page
    // does not cover it, so the surface can never imply completeness it lacks.
    const requestedLimit = Number(args.limit);
    const pageLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
    let agents, page;
    try {
      [agents, page] = await Promise.all([
        mcpFleetTransport.ephemeral('store-agents'),
        mcpFleetTransport.ephemeral('tasks-page', { limit: pageLimit, cursor: args.cursor || null }),
      ]);
      if (agents.error) return { content: [{ type: 'text', text: `tasks failed: ${agents.error}` }], isError: true };
      if (page.error) return { content: [{ type: 'text', text: `tasks failed: ${page.error}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `tasks failed before transport ACK: ${e.message}` }], isError: true };
    }
    const active = page.tasks || [];
    const total = Number.isFinite(page.total) ? page.total : active.length;

    let text = '';

    // Show registered agents
    if (agents.length > 0) {
      const agentLines = agents.map(a => {
        let label = a.friendly_name ? `"${a.friendly_name}"` : a.id;
        if (a.friendly_name) label += ` [${a.id}]`;
        if (a.dead) label += ' [dead]';
        if (a.human) label += ' [human]';
        if (a.metadata?.inboxStatus) {
          label += ` [status:${a.metadata.inboxStatus}${a.metadata.inboxStatusTag ? ` (${a.metadata.inboxStatusTag})` : ''}]`;
        }
        if (a.metadata?.deliveryChannel && a.metadata.deliveryChannel !== 'channel') {
          label += ` [delivery:${a.metadata.deliveryChannel}]`;
        }
        // No manager label
        if (a.tmux_session) label += ` tmux:${a.tmux_session}`;
        return label;
      });
      text += `Agents: ${agentLines.join(', ')}\n\n`;
    }

    if (!active.length) {
      text += args.cursor ? `No further active tasks (${total} total).` : 'No active tasks.';
      return { content: [{ type: 'text', text }] };
    }

    const hasMore = !!page.nextCursor;
    text += hasMore || active.length < total
      ? `Showing ${active.length} of ${total} open tasks, newest first.\n\n`
      : `${total} open task(s).\n\n`;

    const showOwner = false;

    const sortedActive = [...active].sort((a, b) => {
      const an = a.metadata?.native ? 1 : 0;
      const bn = b.metadata?.native ? 1 : 0;
      if (an !== bn) return bn - an;
      return new Date(b.delegated_at || 0) - new Date(a.delegated_at || 0);
    });
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const taskHealthSummary = summarizeTaskListHealth(sortedActive, agentMap);
    const lines = sortedActive.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      const taskAgent = agentMap.get(t.agent);
      const health = classifyTaskAgentHealth(t, taskAgent);
      const healthBucket = classifyTaskListHealthBucket(t, health);
      const includeHealthAction = healthBucket?.kind !== 'stale-backlog';
      const healthNote = formatTaskHealth(health, { includeAction: includeHealthAction });
      let status = t.status;
      const nativeSystem = t.metadata?.native_system || t.metadata?.native?.system || null;
      const nativeLabel = nativeSystem === 'claude' ? 'Claude Code' : nativeSystem;
      if (t.synthetic) status = `📬 ${t.priority || 'normal'}`;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if (t.metadata?.native) status += ` | Native task in ${nativeLabel || 'native harness'}`;
      if (!t.synthetic && (t.status === 'pending' || t.status === 'working') && age > 1440) {
        status += ` [stale — ${Math.round(age / 60)}h]`;
      }
      let owner = '';
      if (showOwner && t.delegated_by) {
        const ownerAgent = agentMap.get(t.delegated_by);
        const ownerLabel = ownerAgent?.friendly_name || t.delegated_by;
        owner = ` | by:${ownerLabel}`;
      }
      return `[${t.id}] ${t.agent} | ${status} | ${t.description} | ${age}m ago${owner}${healthNote ? ` | ${healthNote}` : ''}`;
    });

    text += lines.join('\n');

    const working = sortedActive.filter(t => t.status === 'working');
    const pending = sortedActive.filter(t => t.status === 'pending');
    const idle = sortedActive.filter(t => t.status === 'idle');
    const blocked = sortedActive.filter(t => t.status === 'blocked');
    const { actionableUnhealthy, staleBacklogUnhealthy } = taskHealthSummary;

    const unread = AGENT_ID ? await getUnread(null, AGENT_ID) : [];

    let nudge = '';
    if (hasMore) {
      nudge += `\n\n${total - active.length} more open task(s) not shown. Next page: tasks({ cursor: "${page.nextCursor}"${pageLimit === 50 ? '' : `, limit: ${pageLimit}`} }).`;
    }
    // These counts describe THIS PAGE, not the fleet — say so whenever the page
    // is not the whole list, so a partial count is never read as a total.
    const scope = hasMore ? ' on this page' : '';
    if (unread.length > 0) nudge += `\n\n📬 ${unread.length} unread message(s). Check them.`;
    if (idle.length > 0) nudge += `\n\n${idle.length} idle${scope} — review and delegate or mark done.`;
    if (working.length > 0) nudge += `\n\n${working.length} working${scope}.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending${scope} (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked${scope}.`;
    if (actionableUnhealthy.length > 0) nudge += `\n\n⚠ ${actionableUnhealthy.length} active task(s)${scope} have actionable agent-health warnings — inspect or redelegate instead of waiting silently.`;
    if (staleBacklogUnhealthy.length > 0) nudge += `\n\n${staleBacklogUnhealthy.length} stale backlog task(s)${scope} have non-actionable agent-health warnings older than the Todd kick window — owner cleanup should delete/archive/redelegate; they are not counted as live liveness failures.`;
    return { content: [{ type: 'text', text: text + nudge }] };
  }

  // ---- report (QA-aware report gate) ----
  if (name === 'report') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };

    const targetTaskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    let task = null;
    if (!targetTaskId) {
      let taskData;
      try {
        taskData = await mcpFleetTransport.ephemeral('my-task', { agent: AGENT_ID, peek: true });
      } catch (e) {
        return { content: [{ type: 'text', text: `Fleet transport failed before ACK. Active task lookup was not completed: ${e.message}` }], isError: true };
      }
      task = taskData.task;
      if (!task) return { content: [{ type: 'text', text: 'No active task to report on.' }], isError: true };
    } else if (!args.summary) {
      return { content: [{ type: 'text', text: 'Pass summary when reporting on a task_id.' }], isError: true };
    }

    const cwd = getAgentCwd() || process.env.PWD || null;

    // ---- Durable report / close path ----
    if (args.summary) {
      const closeRequested = args.close === true || args.pass === true;
      if (closeRequested && !targetTaskId && task.metadata?.requires_approval && !args.approval_id) {
        return { content: [{ type: 'text', text: `This task requires Skip's approval to close. Get approval in chat, then call report({ summary: "...", close: true, approval_id: <id> }) with the message ID shown in brackets (e.g. id:332656).` }] };
      }

      const _lintOverrides = Array.isArray(args.overrides) ? args.overrides : [];
      const violations = lintReport(args.summary, null, _lintOverrides);
      const lintAdvisory = violations.length > 0
        ? `\n\n⚠️ Report-text notes (advisory — did not block ${closeRequested ? 'close' : 'report'}):\n${formatLintViolations(violations)}`
        : '';
      const summaryHash = crypto.createHash('sha256').update(String(args.summary)).digest('hex').slice(0, 16);
      const reportTaskId = targetTaskId || task.id;
      const operationId = args.operation_id || `${AGENT_ID}:mcp-report:${reportTaskId}:${closeRequested ? 'close' : 'report'}:${summaryHash}`;
      const friendlyName = process.env.FLEET_NAME || AGENT_ID.slice(0, 8);

      const docName = reportDocName(reportTaskId);
      let tldaMsg = '';

      let data;
      try {
        data = await mcpFleetTransport.durable('report-close', {
          agent: AGENT_ID,
          task_id: reportTaskId,
          summary: args.summary,
          close: closeRequested,
          reason: args.reason || undefined,
          approval_id: args.approval_id || undefined,
          operation_id: operationId,
        }, { operationId });
        rememberOriginatedEvents(data);
      } catch (e) {
        return { content: [{ type: 'text', text: `report failed: ${e.message}` }], isError: true };
      }

      const taskDescription = data?.task_description || task?.description || reportTaskId;
      const closeCompleted = closeRequested && Boolean(data?.close_event_id);
      const reportStatus = closeCompleted ? 'closed' : 'reported';
      const reportContent = `# ${taskDescription}\n\n**Agent:** ${friendlyName}  \n**Status:** ${reportStatus}  \n**Filed:** ${formatDisplayTimestamp(Date.now())}\n\n---\n\n${args.summary}`;

      try {
        await postReportDoc({
          reportTaskId,
          taskDescription,
          reportContent,
          cwd: cwd || process.env.PWD || '/tmp',
          session: CLAUDE_SESSION,
          fetchImpl: _sharedFetch,
          server: activeStoreServerUrl(),
        });
        tldaMsg = `\n📄 Report pushed to tlda as **${docName}** [${reportStatus}]`;
        logEvent({ type: 'report_share', agent: AGENT_ID, doc: docName, task_id: reportTaskId, status: reportStatus });
      } catch (e) {
        tldaMsg = `\n⚠ Report share to tlda failed (${e.message}) — report recorded in chat.`;
      }

      if (closeCompleted) logEvent({ type: 'task_done', agent: AGENT_ID, task_id: reportTaskId, description: taskDescription });
      logEvent({ type: 'report', agent: AGENT_ID, task_id: reportTaskId, summary: args.summary });

      let msg = data?.queued
        ? `Report queued durably for ${taskDescription}. Operation: ${data.operation_id || operationId}.`
        : closeCompleted
          ? `Report accepted. Closed task: ${taskDescription}.`
          : closeRequested
            ? `Report accepted; task remains open: the close request was not accepted.`
          : `Report accepted for task: ${taskDescription}.`;
      msg += tldaMsg;
      msg += lintAdvisory;
      if (closeCompleted) msg += '\n\nKeep working or use timer() — you\'ll see 📬 when the next task arrives.';
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

    // `state` was never defined here, so this whole block threw a ReferenceError
    // and the self-review gate has been dead for every agent. taskContextBlock
    // never read state — it only uses task.message / description / success_criteria.
    //
    // The human-message half is deleted rather than repaired: findRelatedHumanMessages
    // returns [] unless state.messages is populated, and loadState() hardcodes
    // `messages: []`, so it could never have produced output even without the crash.
    const contextSection = taskContextBlock(task);

    const reviewPrompt = `## Self-Review Gate

**Task:** ${task.description}
**Working directory:** ${cwd || 'unknown'}
**Diff:** ${diffLines} lines

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

Do NOT report "looks good" without reading and describing the screenshots.

If you find issues: fix them now, then call \`report()\` again.
If it's clean and the task should close: call \`report(summary="...", close=true, verified=true)\` with a structured summary including screenshot verification.
If it should remain open: call \`report(summary="...")\` with the current evidence and remaining work.`;

    return { content: [{ type: 'text', text: reviewPrompt }] };
  }

  // ---- read_terminal (read agent's tmux pane) ----
  if (name === 'read_terminal') {
    if (!args.agent) {
      return { content: [{ type: 'text', text: 'Specify agent (name/ID).' }], isError: true };
    }

    // Look up agent via server API
    let agents;
    try {
      agents = await mcpFleetTransport.ephemeral('store-agents');
      if (!agents || agents.error) return { content: [{ type: 'text', text: `task_check failed: ${agents?.error || 'no response'}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `task_check failed before transport ACK: ${e.message}` }], isError: true };
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

    try {
      const res = await fleetFetch(`${TLDA_FLEET_SERVER}/api/capture-pane`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentEntry.id || args.agent, lines: 200 }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.pane === 'string') {
        result = { ok: true, text: data.pane };
        targetLabel = `server:${activeFleetServerUrl()}/api/capture-pane`;
      } else {
        const detail = data.error || data.message || `HTTP ${res.status}`;
        result = { ok: false, error: `server capture-pane failed: ${detail}` };
      }
    } catch (e) {
      result = { ok: false, error: `server capture-pane failed: ${e.message}` };
    }

    if (!result?.ok) {
      return { content: [{ type: 'text', text: `Cannot read terminal for ${agentEntry.friendly_name || agentEntry.id}: ${result?.error || 'daemon capture route unavailable'}. Agent was not marked dead by read_terminal.` }], isError: true };
    }
    idle = tmuxIsIdle(result.text);

    // Fetch tasks to find active task for this agent
    let tasks;
    try {
      tasks = await mcpFleetTransport.ephemeral('store-tasks', { active: true });
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

  // ---- theorem/label reference resolution ----
  const _refCache = new Map()
  function loadRefIndex(doc) {
    if (_refCache.has(doc)) return _refCache.get(doc)
    const projectDir = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'output')
    const projJson = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'project.json')
    let texBase = 'main'
    try {
      const pj = JSON.parse(fs.readFileSync(projJson, 'utf8'))
      if (pj.mainFile) texBase = pj.mainFile.replace(/\.tex$/, '')
    } catch { /* project.json missing — use default texBase */ }

    let labels = []
    let labelRegions = {}
    let pageIndex = {}

    const smPath = path.join(projectDir, `${texBase}-source-map.json`)
    if (fs.existsSync(smPath)) {
      const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'))
      labels = sm.labels || []
      pageIndex = sm.pages || {}
    }

    const piPath = path.join(projectDir, `${texBase}-proof-info.json`)
    if (fs.existsSync(piPath)) {
      const pi = JSON.parse(fs.readFileSync(piPath, 'utf8'))
      labelRegions = pi.labelRegions || {}
    }

    if (!labels.length) {
      _refCache.set(doc, null)
      setTimeout(() => _refCache.delete(doc), 30000)
      return null
    }

    const index = { labels, labelRegions, pageIndex, texBase }
    _refCache.set(doc, index)
    setTimeout(() => _refCache.delete(doc), 60000)
    return index
  }

  function findSourceLine(index, label, page) {
    const region = index.labelRegions[label]
    const yTarget = region?.yTop
    if (yTarget == null) return null
    const pageEntries = index.pageIndex[String(page)]
    if (!pageEntries?.length) return null
    let best = null
    let bestDist = Infinity
    for (const entry of pageEntries) {
      const dist = Math.abs(entry.y - yTarget)
      if (dist < bestDist) { bestDist = dist; best = entry }
    }
    return best
  }

  // Detection (env-name table, number pattern, normalization) is shared with
  // the client linkifier via ../shared/doc-refs.mjs so the two contexts can't
  // disagree on what counts as a reference. The idempotence guard
  // `(?!\])(?! \[)` is server-only — it stops us re-annotating text we already
  // injected a " [label → …]" into.
  const _REF_REGEX = _buildTheoremRefRegex(undefined, '(?!\\])(?! \\[)')

  function resolveTheoremRefs(text, doc, version) {
    if (!text || !doc) return text
    _REF_REGEX.lastIndex = 0
    if (!_REF_REGEX.test(text)) return text
    _REF_REGEX.lastIndex = 0
    const index = loadRefIndex(doc)
    if (!index) return text

    return text.replace(_REF_REGEX, (match, typeName, rawNumber) => {
      const normalizedNumber = _normalizeRefNumber(rawNumber)

      const typeInfo = _refTypeForName(typeName)
      if (!typeInfo) return match

      const entry = index.labels.find(l =>
        typeInfo.types.includes(l.type) && l.number === normalizedNumber
      )
      if (!entry) return match

      const srcLine = findSourceLine(index, entry.label, entry.page)
      const filePart = srcLine ? `${srcLine.file}:${srcLine.line}` : `p${entry.page}`
      const versionPart = version ? ` @${version.slice(0, 7)}` : ''
      return `${match} [${entry.label} → ${filePart}${versionPart}]`
    })
  }

  // ---- image resolution ----
  // Extract image URLs from markdown, resolve to local paths, return as
  // { text, images } where images are { path, mimeType } objects.
  async function resolveImages(text) {
    if (!text) return { text, images: [] }
    const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g
    const images = []
    let cleaned = text

    for (const match of [...text.matchAll(imgPattern)]) {
      const [full, alt, url] = match
      let localPath = null

      // Direct local path in URL query param: /api/file?path=/tmp/...
      const pathMatch = url.match(/[?&]path=([^&]+)/)
      if (pathMatch) {
        localPath = decodeURIComponent(pathMatch[1])
      }

      // If the referenced file is not readable locally (common with Fly-hosted
      // /api/file?path=/tmp/... links), download the image into a local temp.
      if (localPath) {
        try {
          const fs = await import('fs')
          if (!fs.existsSync(localPath)) localPath = null
        } catch {
          localPath = null
        }
      }
      if (!localPath && url.startsWith('http')) {
        try {
          const fs = await import('fs')
          const path = await import('path')
          const resp = await fleetFetch(url)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            const ext = path.extname(new URL(url).pathname) || '.png'
            localPath = `/tmp/fleet-img-${Date.now()}${ext}`
            fs.writeFileSync(localPath, buf)
          }
        } catch {}
      }

      if (localPath) {
        const ext = localPath.split('.').pop()?.toLowerCase() || 'png'
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
        images.push({ path: localPath, mimeType: mimeMap[ext] || 'image/png', alt: alt || '' })
        cleaned = cleaned.replace(full, alt ? `[image attached: ${alt}]` : '[image attached]')
      }
    }
    return { text: cleaned, images }
  }

  // ---- chip token resolution ----
  // Resolve «type:label#id» tokens in message text by looking up the referenced
  // content. Handles: msg, activity, tool, annotation, highlight chip types.
  // metadata: optional message metadata (for annotation/highlight ref lookup via attachments)
  async function resolveChipTokens(text, metadata) {
    if (!text || !text.includes('«')) return { text, images: [] }
    const chipPattern = /«(.+?)»/g
    const chips = [...text.matchAll(chipPattern)]
    if (chips.length === 0) return { text, images: [] }

    let resolved = text
    const chipImages = []
    for (const match of chips) {
      const inner = match[1]
      const colonIdx = inner.indexOf(':')
      if (colonIdx < 0) continue
      const type = inner.slice(0, colonIdx)

      if (type === 'annotation' || type === 'highlight') {
        // Token format: «annotation:label#shape:shapeId» or «highlight:label#shape:shapeId»
        // Ref data is embedded in message metadata.attachments by the sender's chat() call.
        const token = match[0]
        const attachments = metadata?.attachments || []
        const refData = attachments.find(a => a.token === token)
        if (refData) {
          const formatted = formatAnnotationRef(refData)
          if (formatted) resolved = resolved.replace(token, '\n' + formatted + '\n')
          // Include screenshot for unresolved highlights
          if (refData.unresolved && refData.screenshotDataUrl) {
            const base64 = refData.screenshotDataUrl.replace(/^data:image\/png;base64,/, '')
            chipImages.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } })
          }
        }
        // No API fallback — ref data must be in attachments (embedded by sender)
      }

      if (type === 'msg') {
        // Token format: «msg:displayLabel#msg:from:isoTimestamp»
        // The # suffix contains the structured value: msg:agentId:timestamp
        const hashIdx = inner.lastIndexOf('#')
        const structuredData = hashIdx >= 0 ? inner.slice(hashIdx + 1) : ''

        // Parse structured data — either "msg:eventId" or "msg:fleet:agentName:2026-04-18T..."
        const valueParts = structuredData.startsWith('msg:') ? structuredData.slice(4) : structuredData
        const evIdMatch = valueParts.match(/^(\d+)/)

        if (evIdMatch) {
          // Event ID path
          try {
            const data = await mcpFleetTransport.ephemeral('store-events', { after: evIdMatch[1] - 1, limit: 1 })
            const events = (data.events || []).filter(e => e.type === 'chat')
            const ev = events[0]
            if (ev) {
              let agents = []
              try {
                const stateData = await mcpFleetTransport.ephemeral('store-agents')
                agents = Array.isArray(stateData) ? stateData : []
              } catch {}
              resolved = resolved.replace(match[0], '\n' + formatMessage(ev, agents) + '\n')
            }
          } catch {}
        }
      }

      if (type === 'activity') {
        // Token format: «activity:displayLabel#activity:eventId» or «activity:displayLabel#activity:agentId:isoTimestamp»
        const hashIdx = inner.lastIndexOf('#')
        const structuredData = hashIdx >= 0 ? inner.slice(hashIdx + 1) : ''
        const valueParts = structuredData.startsWith('activity:') ? structuredData.slice(9) : structuredData

        // Try event ID first (pure numeric), then fall back to agentId:timestamp
        const evIdMatch = valueParts.match(/^(\d+)/)
        let activities = []

        if (evIdMatch) {
          // Event ID — look up this event and surrounding activity events (±60s)
          try {
            const data = await mcpFleetTransport.ephemeral('store-events', { after: evIdMatch[1] - 1, limit: 1 })
            const anchor = (data.events || [])[0]
            if (anchor) {
              const since = new Date(new Date(anchor.timestamp).getTime() - 60000).toISOString()
              const until = new Date(new Date(anchor.timestamp).getTime() + 60000).toISOString()
              const agentId = anchor.from
              const data2 = await mcpFleetTransport.ephemeral('store-events', { agent: agentId, since, until, limit: 50 })
              activities = (data2.events || []).filter(e => e.type === 'activity')
            }
          } catch {}
        } else {
          const dateMatch = valueParts.match(/:(\d{4}-\d{2}-\d{2}T.+)$/)
          let agentId = '', isoTs = ''
          if (dateMatch) {
            agentId = valueParts.slice(0, valueParts.length - dateMatch[0].length)
            isoTs = dateMatch[1]
          }
          if (agentId && isoTs) {
            try {
              const since = new Date(new Date(isoTs).getTime() - 60000).toISOString()
              const until = new Date(new Date(isoTs).getTime() + 60000).toISOString()
              const data = await mcpFleetTransport.ephemeral('store-events', { agent: agentId, since, until, limit: 50 })
              activities = (data.events || []).filter(e => e.type === 'activity')
            } catch (e) { process.stderr.write(`[fleet] activity fetch failed: ${e.message}\n`); }
          }
        }

        // Parse metadata strings (events API returns raw DB rows)
        for (const ev of activities) {
          if (typeof ev.metadata === 'string') {
            try { ev.metadata = JSON.parse(ev.metadata) } catch (e) { process.stderr.write(`[fleet] metadata parse failed for event ${ev.id}: ${e.message}\n`); }
          }
        }

        if (activities.length > 0) {
          const resolvedAgentId = activities[0]?.from || activities[0]?.to || ''
          let agents = []
          try {
            const stateData = await mcpFleetTransport.ephemeral('store-agents')
            agents = Array.isArray(stateData) ? stateData : []
          } catch (e) { process.stderr.write(`[fleet] store-agents fetch failed: ${e.message}\n`); }
          resolved = resolved.replace(match[0], '\n' + formatActivity(activities, agents) + '\n')
        }
      }

      if (type === 'tool') {
        // Token format: «tool:ToolName#activity:eventId»
        const hashIdx = inner.lastIndexOf('#')
        const structuredData = hashIdx >= 0 ? inner.slice(hashIdx + 1) : ''
        const displayLabel = inner.slice(colonIdx + 1, hashIdx >= 0 ? hashIdx : undefined)

        // Parse: "activity:22663" or "activity:22683:line3" → event ID
        const evIdMatch = structuredData.match(/activity:(\d+)/)
        if (evIdMatch) {
          const eventId = evIdMatch[1]
          try {
            const data = await mcpFleetTransport.ephemeral('store-events', { after: eventId - 1, limit: 1 })
            const ev = (data.events || [])[0]
            if (ev) {
              let meta = ev.metadata
              if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch (e) { process.stderr.write(`[fleet] event metadata parse failed: ${e.message}\n`); } }
              meta = meta || {}
              const tool = meta.tool || ev.text || displayLabel
              const arg = meta.arg || ''
              const prettyResult = meta.prettyResult ? normalizePrettyResult(meta.prettyResult) : ''

              // Resolve agent name
              let agentName = (ev.from || '').replace('fleet:', '')
              try {
                const agents = await mcpFleetTransport.ephemeral('store-agents')
                const a = (Array.isArray(agents) ? agents : []).find(a => a.id === ev.from)
                if (a) agentName = a.friendly_name || a.name || agentName
              } catch {}

              const ts = new Date(ev.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...displayZoneOptions() })
              let replacement = `\n[${agentName} → ${tool}, ${ts}]:`
              if (arg) replacement += `\n  ${arg}`
              if (prettyResult) replacement += `\n  ${prettyResult.slice(0, 500).split('\n').join('\n  ')}`
              resolved = resolved.replace(match[0], replacement + '\n')
            }
          } catch {}
        }
      }
    }
    return { text: resolved, images: chipImages }
  }

  async function resolveInboxChipTokens(text, metadata) {
    if (!text || !text.includes('«')) return { text, images: [] }
    let resolved = text
    const chipImages = []
    for (const match of [...text.matchAll(/«(.+?)»/g)]) {
      const inner = match[1]
      const colonIdx = inner.indexOf(':')
      if (colonIdx < 0) continue
      const type = inner.slice(0, colonIdx)
      if (type === 'annotation' || type === 'highlight') {
        const attachments = metadata?.attachments || []
        const refData = attachments.find(a => a.token === match[0])
        if (refData) {
          const formatted = formatAnnotationRef(refData)
          if (formatted) resolved = resolved.replace(match[0], '\n' + formatted + '\n')
          continue
        }
      }
      resolved = resolved.replace(match[0], `${match[0]} [reference not pre-materialized]`)
    }
    return { text: resolved, images: chipImages }
  }

  async function resolveInboxImages(text) {
    if (!text) return { text, images: [] }
    const cleaned = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, url) => {
      const label = alt ? `image: ${alt}` : 'image'
      return `[${label} not pre-materialized: ${url}]`
    })
    return { text: cleaned, images: [] }
  }

  // ---- inbox ----
  if (name === 'inbox') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const view = inboxViewForArgs(args);

    let data;
    try {
      data = await mcpFleetTransport.ephemeral('my-task', { agent: AGENT_ID, peek: !!args?.peek });
    } catch (e) {
      return { content: [{ type: 'text', text: `Fleet transport failed before ACK. This read was not completed: ${e.message}` }], isError: true };
    }

    const messages = await Promise.all((data.messages || []).map(m => resolveInboxMessage(m, {
      resolveChipTokens: resolveInboxChipTokens,
      resolveTheoremRefs,
      resolveImages: resolveInboxImages,
    })));
    const text = formatInboxText({ mode: view, task: data.task || null, tasks: data.tasks || null, messages, counts: data.counts || null });
    return { content: [{ type: 'text', text }] };
  }

  // ---- set_inbox_status ----
  if (name === 'set_inbox_status') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const status = validateInboxStatus(args?.status);
    if (!status) return { content: [{ type: 'text', text: `Bad inbox status: ${args?.status || '(missing)'}. Use one of: ${INBOX_STATUSES.join(', ')}.` }], isError: true };
    const tag = typeof args?.tag === 'string' && args.tag.trim() ? args.tag.trim().slice(0, 80) : null;
    _inboxStatus = status;
    try {
      await mcpFleetTransport.durable('inbox-status', { agent: AGENT_ID, status, tag });
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not publish inbox status "${status}" to tlda (${e.message}).` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Inbox status set to ${status}${tag ? ` (${tag})` : ''}. Future wake behavior will use this status; choose presentation separately with inbox(view: ...).` }] };
  }

  // ---- set_delivery_channel ----
  if (name === 'set_delivery_channel') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'No session ID detected.' }], isError: true };
    const channel = validateDeliveryChannel(args?.channel);
    if (!channel) return { content: [{ type: 'text', text: `Bad delivery channel: ${args?.channel || '(missing)'}. Use one of: ${DELIVERY_CHANNELS.join(', ')}.` }], isError: true };
    const agent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : AGENT_ID;
    try {
      const data = await mcpFleetTransport.durable('delivery-channel', { caller: AGENT_ID, agent, channel });
      if (data?.error) return { content: [{ type: 'text', text: `Could not set delivery channel: ${data.error}` }], isError: true };
      const target = data.target_label || data.agent || agent;
      const ownerNote = data.self ? '' : ' as their manager';
      return { content: [{ type: 'text', text: `Delivery channel for ${target} set to ${channel}${ownerNote}. Future notified messages for that agent will ping that channel; senders still use chat().` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not publish delivery channel "${channel}" to tlda (${e.message}).` }], isError: true };
    }
  }

  // ==== Agent Lifecycle ====

  // ---- name_agent ----
  if (name === 'name_agent') {
    try {
      const data = await mcpFleetTransport.durable('rename', { agent: args.agent, name: args.friendly_name });
      if (data.error) return { content: [{ type: 'text', text: `Rename failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Named ${args.agent}: "${args.friendly_name}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Rename failed: ${e.message}` }], isError: true };
    }
  }

  // ---- reanimate ----
  if (name === 'reanimate') {
    try {
      const data = await mcpFleetTransport.durable('reanimate', { agent: args.agent });
      if (data.error) return { content: [{ type: 'text', text: `Reanimate failed: ${data.error}` }], isError: true };
      const label = data.agent || data.agent_id || args.agent;
      return { content: [{ type: 'text', text: `Reanimated ${label}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Reanimate failed: ${e.message}` }], isError: true };
    }
  }

  // ---- spawn_models ----
  if (name === 'spawn_models') {
    try {
      const catalog = await getSpawnModelCatalog({ maxAgeMs: 0 });
      const text = formatSpawnModelSummary(catalog, {
        verifiedOnly: !!args.verified_only,
      });
      const defaultModel = catalog?.defaultAlias ? `\nDefault: ${catalog.defaultAlias}` : '';
      return { content: [{ type: 'text', text: `${text}${defaultModel}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `spawn_models failed: ${e.message}` }], isError: true };
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
          lifecycleEvents.map(e => `- **${new Date(e.time).toLocaleTimeString(undefined, displayZoneOptions())}** ${e.type}: ${e.agent}${e.detail ? ` (${e.detail})` : ''}`).join('\n'));
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
          `- **${new Date(e.time).toLocaleTimeString(undefined, displayZoneOptions())}** ${e.type}: ${e.agent} — ${e.task}${e.summary ? `\n  Summary: ${e.summary}` : ''}`
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

    const summary = `## Fleet Summary\n\n- **Live agents:** ${liveAgents.length}\n- **Dead agents:** ${deadAgents.length}\n- **Active tasks:** ${activeTasks.length}\n- **Completed tasks (in state):** ${doneTasks.length}\n- **Period:** since ${new Date(sinceMs).toLocaleString(undefined, displayZoneOptions())}`;
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

  // ---- search ----
  if (name === 'search') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    const rawQuery = args.query;
    if (!rawQuery || rawQuery.length < 2) {
      return { content: [{ type: 'text', text: 'Query must be at least 2 characters.' }], isError: true };
    }

    let parsedSearch;
    let searchFilters;
    try {
      parsedSearch = parseSearchQuery(args.agent ? `agent:(${args.agent}) ${rawQuery}` : rawQuery);
      searchFilters = buildFleetSearchFilters(parsedSearch.filters);
    } catch (e) {
      return { content: [{ type: 'text', text: `Search failed: ${e.message}` }], isError: true };
    }
    const query = parsedSearch.query;
    const sinceTs = parseTimestamp(args.since) || searchFilters.since || undefined;
    const beforeTs = parseTimestamp(args.before) || searchFilters.before || undefined;
    const isBoundedSearch = !!(sinceTs && beforeTs);
    const limit = isBoundedSearch ? Math.min(args.limit || 500, 500) : Math.min(args.limit || 20, 100);
    const contextWindow = Math.min(Math.max(args.context || 0, 0), 20);

    // Query the server's unified search (fleet events + session JSONL text)
    let results = [];
    let contextMap = {};
    try {
      const contextTimestamps = [];
      const searchParams = {
        query,
        limit,
        me: AGENT_ID,
        role: args.role || searchFilters.role || undefined,
        since: sinceTs,
        before: beforeTs,
        agent: searchFilters.agent,
        agentQuery: searchFilters.agentQuery,
        filterExpression: searchFilters.filterExpression,
        eventType: searchFilters.eventType,
        cwd: searchFilters.cwd,
        project: args.project || searchFilters.project,
      };
      const data = await mcpFleetTransport.ephemeral('fleet-search', searchParams);
      results = data?.results || [];

      // Fetch context for chat results if requested
      if (contextWindow > 0) {
        for (const r of results) {
          if (r.source === 'fleet' && r.timestamp) contextTimestamps.push(r.timestamp);
        }
        if (contextTimestamps.length > 0) {
          const ctxSearchParams = { ...searchParams, context_timestamps: contextTimestamps.slice(0, 10), context_window: contextWindow };
          const ctxData = await mcpFleetTransport.ephemeral('fleet-search', ctxSearchParams);
          contextMap = ctxData?.context || {};
        }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Search failed: ${e.message}` }], isError: true };
    }

    if (results.length === 0) {
      const selector = args.agent || searchFilters.agent || searchFilters.agentResolve?.fragment || null;
      if (selector) {
        let agent = null;
        try { agent = await resolveAgent(selector); } catch { agent = null; }
        if (agent) {
          return {
            content: [{
              type: 'text',
              text: `No results for "${rawQuery}". Selector "${selector}" resolves to ${agent.id}, but no indexed fleet messages/session entries matched in environment "${activeEnvName()}". Pass env explicitly to search another environment.`,
            }],
          };
        }
      }
      return { content: [{ type: 'text', text: `No results for "${rawQuery}".` }] };
    }

    // Name-provenance tag: the name the agent held AT the event's time (period
    // name, server-resolved as `*Name`) paired with the durable fleet id, plus
    // `→now:X` when it has since rotated. The server owns name stamping; this
    // formatter must not load the full historical roster on every search.
    const tag = (id, periodName, nowName) => {
      if (!id) return '';
      const nm = periodName === undefined ? null : periodName;
      let s = `${nm || '(nameless)'} ${id}`;
      if (nowName != null && nowName !== nm) s += ` →now:${nowName}`;
      return s;
    };

    // Same `M/D h:mm AM/PM` shape as before, but pinned to the display zone and
    // labelled with it. The getHours()/getMinutes() version read whatever zone
    // this process happened to be in, which is UTC on a Fly-hosted agent box.
    const fmtTs = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      const p = {};
      for (const part of new Intl.DateTimeFormat('en-US', {
        month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
        ...displayZoneOptions(),
      }).formatToParts(d)) p[part.type] = part.value;
      return `${p.month}/${p.day} ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
    };

    const fmtCtxMsg = (c) => {
      const cFrom = tag(c.from_id || c.from, c.fromName, c.fromNameNow);
      const cTo = tag(c.to_id || c.to, c.toName, c.toNameNow);
      const cDir = cTo ? `${cFrom} → ${cTo}` : cFrom;
      const text = (c.text || '').length > 300 ? c.text.slice(0, 300) + '...' : (c.text || '');
      return `  [${fmtTs(c.timestamp)}] ${cDir}: ${text}`;
    };

    const parseEventMetadata = (metadata) => {
      if (!metadata) return {};
      if (typeof metadata === 'object') return metadata;
      if (typeof metadata === 'string') {
        try { return JSON.parse(metadata) || {}; } catch { return {}; }
      }
      return {};
    };

    const compactForSearch = (value, max = 600) => {
      if (value == null || value === '') return '';
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > max ? `${text.slice(0, max)}... [truncated ${text.length - max} chars]` : text;
    };

    const indentForSearch = (value, prefix = '  ') =>
      String(value).split('\n').map(line => `${prefix}${line}`).join('\n');

    const formatActivityForSearch = (r, fallbackSnippet) => {
      const metadata = parseEventMetadata(r.metadata);
      const tool = metadata.tool || r.text || fallbackSnippet || 'activity';
      if (tool === '_text') return r.text || metadata.arg || fallbackSnippet || '';

      const description = metadata.input?.description || metadata.description || '';
      let arg = '';
      if (metadata.arg != null && metadata.arg !== '') arg = compactForSearch(metadata.arg);
      else if (metadata.input?.command) arg = compactForSearch(metadata.input.command);
      else if (metadata.input != null) arg = compactForSearch(metadata.input);

      const lines = [`[activity${r.id ? ` #${r.id}` : ''}] ${tool}${description ? ` — ${description}` : ''}`];
      if (arg) lines.push(indentForSearch(arg));
      if (metadata.prettyResult) {
        lines.push('  result:');
        lines.push(indentPrettyResult(compactPrettyResult(metadata.prettyResult, 600), '    '));
      }
      return lines.join('\n');
    };

    const formatProjectAgentForSearch = (r) => {
      const row = r.agent_id ? r : r.projectActivityRow || {};
      const agent = tag(row.agent_id, row.friendly_name, row.friendly_name);
      const status = row.status?.dead ? 'dead/hibernated' : 'current/live';
      const lines = [
        `${agent}`,
        `  cwd: ${row.cwd || '(unknown)'}`,
        `  project: ${row.project || '(unknown)'}`,
        `  status: ${status}`,
        `  last relevant: ${row.latest_relevant_at ? `${fmtTs(row.latest_relevant_at)} (${row.latest_relevant_at})` : '(none indexed)'}`,
        `  source: ${row.latest_activity?.source || 'agent_seat'}${row.latest_activity?.type ? ` / ${row.latest_activity.type}` : ''}${row.latest_activity?.event_id ? ` #${row.latest_activity.event_id}` : ''}`,
        `  thread: ${row.thread?.query || `thread(agent: "${row.agent_id}")`}`,
      ];
      if (row.latest_activity?.session_id) lines.push(`  session: ${row.latest_activity.session_id}`);
      const summary = (row.latest_activity?.summary || '').trim();
      if (summary) lines.push(`  activity: ${summary.length > 240 ? `${summary.slice(0, 240)}...` : summary}`);
      return lines.join('\n');
    };

    const formatted = results.map(r => {
      const snippet = (r.snippet || '').replace(/⟨⟨/g, '**').replace(/⟩⟩/g, '**');

      if (r.source === 'fleet') {
        if (r.type === 'project_agent') {
          return { timestamp: r.timestamp, text: formatProjectAgentForSearch(r) };
        }
        const from = tag(r.from, r.fromName, r.fromNameNow);
        const to = tag(r.to, r.toName, r.toNameNow);
        const direction = to ? `${from} → ${to}` : from;
        const display = r.type === 'activity' ? formatActivityForSearch(r, snippet) : snippet;
        let text;
        if (contextWindow > 0 && r.timestamp && contextMap[r.timestamp]) {
          const ctx = contextMap[r.timestamp];
          const matchLine = `  [${fmtTs(r.timestamp)}] ${direction}: ${display.replace(/\n/g, '\n    ')}  ← MATCH`;
          text = `=== Match ===\n${ctx.before.map(fmtCtxMsg).join('\n')}`;
          if (ctx.before.length > 0) text += '\n';
          text += matchLine;
          if (ctx.after.length > 0) text += '\n' + ctx.after.map(fmtCtxMsg).join('\n');
        } else {
          const parts = [];
          if (r.timestamp) parts.push(new Date(r.timestamp).toLocaleString(undefined, displayZoneOptions()));
          parts.push(`[fleet] [${r.type}] ${direction}`);
          parts.push(display);
          text = parts.join(' | ');
        }
        return { timestamp: r.timestamp, text };
      } else {
        // session source
        const agentName = tag(r.agentId, r.agentName, r.agentNameNow) || r.agentId || '';
        const parts = [];
        if (r.timestamp) parts.push(new Date(r.timestamp).toLocaleString(undefined, displayZoneOptions()));
        parts.push(`[session] [${r.role}] ${agentName}`);
        parts.push(snippet);
        return { timestamp: r.timestamp, text: parts.join(' | ') };
      }
    });

    // For bounded calls, error if results hit the limit (would be silently truncated)
    if (isBoundedSearch && results.length >= limit) {
      return {
        content: [{ type: 'text', text: `Bounded query returned ≥${limit} results — too many to return in one call. Narrow your time range.` }],
        isError: true,
      };
    }

    // Log search event
    const filters = [];
    if (args.agent) filters.push(`agent=${args.agent}`);
    if (args.role || searchFilters.role) filters.push(`role=${args.role || searchFilters.role}`);
    if (searchFilters.filterExpression) filters.push(`filter=${searchFilters.filterExpression}`);
    if (searchFilters.eventType) filters.push(`type=${searchFilters.eventType}`);
    if (searchFilters.cwd) filters.push(`cwd=${searchFilters.cwd}`);
    if (args.project || searchFilters.project) filters.push(`project=${args.project || searchFilters.project}`);
    if (sinceTs) filters.push(`since=${sinceTs}`);
    if (beforeTs) filters.push(`before=${beforeTs}`);
    if (contextWindow > 0) filters.push(`context=${contextWindow}`);
    logEvent({
      type: 'search',
      from: AGENT_ID || 'unknown',
      query: rawQuery,
      filters: filters.join(', '),
      resultCount: results.length,
      snippets: results.slice(0, 5).map(r => (r.snippet || '').replace(/⟨⟨/g, '').replace(/⟩⟩/g, '')),
    });

    const fleetCount = results.filter(r => r.source === 'fleet').length;
    const sessionCount = results.filter(r => r.source === 'session').length;
    const projectAgentCount = results.filter(r => r.type === 'project_agent').length;
    let header = projectAgentCount > 0
      ? `${projectAgentCount} project-agent result${projectAgentCount === 1 ? '' : 's'} in chronological recency order`
      : `${results.length} results (${fleetCount} fleet, ${sessionCount} session)`;
    if (sinceTs) header += ` — since ${sinceTs}`;
    if (beforeTs) header += ` — before ${beforeTs}`;
    if (contextWindow > 0) header += ` — with ${contextWindow} context messages`;

    // Apply byte budget so Claude Code never truncates to a JSON file
    const SEARCH_MAX_BYTES = 25_000;
    const searchLines = [];
    let searchBytes = 0;
    let searchTruncated = false;
    for (const r of formatted) {
      const entryBytes = Buffer.byteLength(r.text + '\n\n', 'utf8');
      if (searchBytes + entryBytes > SEARCH_MAX_BYTES && searchLines.length > 0) {
        searchTruncated = true;
        break;
      }
      searchLines.push(r.text);
      searchBytes += entryBytes;
    }
    if (searchTruncated) {
      header += `\n⚠️ Output truncated (showing ${searchLines.length} of ${formatted.length} results). For full conversation context, use thread(agent) — search returns snippets, not complete conversations.`;
    }

    return { content: [{ type: 'text', text: `${header}\n\n${searchLines.join('\n\n')}` }] };
  }

  // ---- thread ----
  if (name === 'thread') {
    const tasks = args.task_id ? ((await mcpFleetTransport.ephemeral('store-tasks')) || []) : [];
    const resolvedAgents = new Map();
    let filtered = [];
    let overflow = false;

    const resolvedSince = parseTimestamp(args.since);
    const resolvedUntil = parseTimestamp(args.until);
    // When both bounds are set the caller committed to a finite range, so grab
    // the whole window in one shot; otherwise page in 200s.
    const isBounded = !!(resolvedSince && resolvedUntil);
    const pageSize = isBounded ? 10_000 : (args.page_size || 200);

    const parseEventMetadata = (metadata) => {
      if (!metadata) return {};
      if (typeof metadata === 'object') return metadata;
      if (typeof metadata === 'string') {
        try { return JSON.parse(metadata) || {}; } catch { return {}; }
      }
      return {};
    };

    const compactForThread = (value, max = 1200) => {
      if (value == null || value === '') return '';
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > max ? `${text.slice(0, max)}... [truncated ${text.length - max} chars]` : text;
    };

    const indentForThread = (value, prefix = '  ') =>
      String(value).split('\n').map(line => `${prefix}${line}`).join('\n');

    const formatActivityForThread = (e, metadata) => {
      const tool = metadata.tool || e.text || 'activity';
      if (tool === '_text') return e.text || metadata.arg || '';

      const description = metadata.input?.description || metadata.description || '';
      let arg = '';
      if (metadata.arg != null && metadata.arg !== '') arg = compactForThread(metadata.arg);
      else if (metadata.input?.command) arg = compactForThread(metadata.input.command);
      else if (metadata.input != null) arg = compactForThread(metadata.input);

      const lines = [`[activity${e.id ? ` #${e.id}` : ''}] ${tool}${description ? ` — ${description}` : ''}`];
      if (arg) lines.push(indentForThread(arg));
      if (metadata.prettyResult) {
        lines.push('  result:');
        lines.push(indentPrettyResult(compactPrettyResult(metadata.prettyResult, 1000), '    '));
      }
      return lines.join('\n');
    };

    const fetchEventsForAgent = async (agentId) => {
      // Fetch one extra row so we can detect "there's more" without a COUNT.
      const params = { agent: agentId, limit: pageSize + 1 };
      if (resolvedSince) params.since = resolvedSince;
      if (resolvedUntil) params.until = resolvedUntil;
      if (args.types?.length) params.event_types = args.types;
      const data = await mcpFleetTransport.ephemeral('store-events', params);
      if (!data) return;
      for (const e of (data.events || [])) {
        const metadata = parseEventMetadata(e.metadata);
        const text = e.type === 'activity'
          ? formatActivityForThread(e, metadata)
          : e.type === 'delegate'
          ? `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`
          : e.type === 'task_done'
          ? `[DONE] ${e.description || ''}`
          : e.text || e.message || '';
        filtered.push({
          id: e.id, type: e.type, metadata,
          from: e.from_id || e.from, to: e.to_id || e.to, text, timestamp: e.timestamp,
          fromName: e.fromName, toName: e.toName, fromNameNow: e.fromNameNow, toNameNow: e.toNameNow,
        });
      }
    };

    const fetchEventsForFilter = async (filterExpression) => {
      // Fetch one extra row so we can detect "there's more" without a COUNT.
      const params = {
        query: '',
        limit: pageSize + 1,
        filterExpression,
        historyOnly: true,
        eventOnly: true,
      };
      if (resolvedSince) params.since = resolvedSince;
      if (resolvedUntil) params.before = resolvedUntil;
      if (args.types?.length === 1) params.eventType = args.types[0];
      else if (args.types?.length > 1) params.eventTypes = args.types;
      const data = await mcpFleetTransport.ephemeral('fleet-search', params);
      if (!data) return;
      for (const e of (data.results || []).filter(r => r.source === 'fleet')) {
        if (args.types?.length > 1 && !args.types.includes(e.type)) continue;
        const metadata = parseEventMetadata(e.metadata);
        const text = e.type === 'activity'
          ? formatActivityForThread(e, metadata)
          : e.type === 'delegate'
          ? `[DELEGATE] ${e.description || ''}\n${e.message || e.text || ''}`
          : e.type === 'task_done'
          ? `[DONE] ${e.description || ''}`
          : e.text || e.message || '';
        filtered.push({
          id: e.id, type: e.type, metadata,
          from: e.from_id || e.from, to: e.to_id || e.to, text, timestamp: e.timestamp,
          fromName: e.fromName, toName: e.toName, fromNameNow: e.fromNameNow, toNameNow: e.toNameNow,
        });
      }
    };

    let primaryId = null;
    if (args.task_id) {
      const task = tasks.find(t => t.id === args.task_id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${args.task_id} not found.` }], isError: true };
      }
      let taskAgent = null;
      try {
        taskAgent = await resolveAgent(task.agent);
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
      if (taskAgent) resolvedAgents.set(taskAgent.id, taskAgent);
      primaryId = taskAgent?.id || task.agent;
      try { await fetchEventsForAgent(task.agent); } catch (e) {
        process.stderr.write(`[fleet] thread DB fetch failed: ${e.message}\n`);
      }
    } else if (args.agent || args.filter) {
      // Reject Claude Code session UUIDs (8-4-4-4-12 hex). These are an
      // internal Claude Code identifier and have no place in fleet — the
      // primary key for agents is the agent name or fleet:UUID. Catching
      // them with a specific error stops agents from inventing workarounds
      // (raw JSONL reads, search misuse) when "Agent not found" looks
      // ambiguous.
      const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (args.agent && SESSION_UUID.test(args.agent)) {
        return {
          content: [{
            type: 'text',
            text: `"${args.agent}" looks like a Claude Code session UUID. Session IDs are not accepted in fleet — use the agent identifier (name like "pb" or "fleet:UUID"). If you don't know which agent ran a session, look at the JSONL's first message or use roster.`,
          }],
          isError: true,
        };
      }
      try {
        if (args.agent) {
          const agent = await resolveAgent(args.agent).catch(() => null);
          const agentId = agent?.id || args.agent;
          if (agent) resolvedAgents.set(agent.id, agent);
          primaryId = agentId;
          await fetchEventsForAgent(agentId);
        } else {
          const rawThreadFilter = args.filter;
          let filterExpression;
          try {
            filterExpression = normalizeThreadFilterExpression(rawThreadFilter);
          } catch (e) {
            return { content: [{ type: 'text', text: `Bad thread filter "${rawThreadFilter}": ${e.message}` }], isError: true };
          }
          if (!filterExpression) {
            return { content: [{ type: 'text', text: `thread filter "${rawThreadFilter}" did not produce a message filter. Use agent:name, from:name, to:name, or the agent argument.` }], isError: true };
          }
          await fetchEventsForFilter(filterExpression);
        }
      } catch (e) {
        process.stderr.write(`[fleet] thread fetch failed: ${e.message}\n`);
      }
    } else {
      return { content: [{ type: 'text', text: 'Provide agent, filter, or task_id.' }], isError: true };
    }

    // Sort by time and deduplicate (server already filters by since/until)
    filtered.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    const seen = new Set();
    filtered = filtered.filter(m => {
      const key = m.id != null ? `id:${m.id}` : `${m.timestamp}|${m.from}|${m.type || ''}|${(m.text ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const m of filtered) {
      for (const id of [m.from, m.to]) {
        if (!id || resolvedAgents.has(id)) continue;
        const agent = await resolveAgent(id).catch(() => null);
        if (agent) resolvedAgents.set(agent.id, agent);
      }
    }
    if (!primaryId && args.agent) {
      const first = filtered.find(m => m.from || m.to);
      primaryId = first?.from || first?.to || null;
    }

    if (filtered.length === 0) {
      if (args.agent && primaryId) {
        return { content: [{ type: 'text', text: `No messages found for the given criteria. Selector "${args.agent}" resolves to ${primaryId}, but no indexed fleet messages were found in environment "${activeEnvName()}". Pass env explicitly to read another environment.` }] };
      }
      return { content: [{ type: 'text', text: `No messages found for the given criteria in environment "${activeEnvName()}". Pass env explicitly to read another environment.` }] };
    }

    // We fetched pageSize+1 — if we got more than a page, there's another page.
    // Trim to the page and flag it so the header tells the caller how to continue.
    if (filtered.length > pageSize) {
      overflow = true;
      filtered = filtered.slice(0, pageSize);
    }

    // Build header with forward-pagination hint
    const fmtShort = (ts) => ts ? new Date(ts).toLocaleString(undefined, displayZoneOptions()) : '';
    const oldest = filtered[0]?.timestamp;
    const newest = filtered[filtered.length - 1]?.timestamp;
    const rangeStr = oldest && newest ? ` (${fmtShort(oldest)} → ${fmtShort(newest)})` : '';

    // Name-provenance trail for the primary agent: the distinct names it held
    // over the course of THIS thread (from the period names stamped on its own
    // messages), ending in its current name + durable id. Surfaces a rename like
    // "conc4 → concentration · fleet:bbc9ad25" so the reader knows the agent the
    // old name referred to is the same one reachable now by id.
    let provenanceNote = '';
    if (primaryId) {
      const trail = [];
      for (const m of filtered) {
        if (m.from !== primaryId) continue;
        const nm = m.fromName === undefined ? null : m.fromName;
        const label = nm || '(nameless)';
        if (trail[trail.length - 1] !== label) trail.push(label);
      }
      const current = resolvedAgents.get(primaryId)?.friendly_name || null;
      if (current && trail[trail.length - 1] !== current) trail.push(current);
      if (trail.length > 1) provenanceNote = `\n↳ ${trail.join(' → ')} · ${primaryId}`;
    }

    const nextPageArg = args.task_id
      ? `task_id: "${args.task_id}"`
      : `agent: "${args.agent || ''}"`;
    const untilHint = resolvedUntil ? `, until: "${args.until}"` : '';

    let header;
    if (overflow) {
      header = `Showing the first ${filtered.length} message(s)${rangeStr}\n` +
        `⚠️ More messages exist after this page. Continue with ` +
        `\`thread(${nextPageArg}, since: "${newest}"${untilHint})\``;
    } else {
      header = `${filtered.length} messages${rangeStr}`;
    }

    // Fetch shadow commit log if project parameter provided
    let shadowCommits = [];
    if (args.project) {
      try {
        const sRes = await fleetFetch(`${TLDA_SERVER}/api/projects/${encodeURIComponent(args.project)}/shadow/log`);
        if (sRes.ok) {
          const sData = await sRes.json();
          shadowCommits = (sData.commits || []).map(c => ({ ...c, ms: new Date(c.timestamp).getTime() }));
        }
      } catch {}
    }

    // Binary search: find latest shadow commit at or before a given timestamp
    const versionAt = (tsStr) => {
      if (!shadowCommits.length || !tsStr) return null;
      const ms = new Date(tsStr).getTime();
      // Commits are newest-first from git log
      for (const c of shadowCommits) {
        if (c.ms <= ms) return c.hash;
      }
      return null;
    };

    // Format as readable thread, stopping at a byte budget so Claude Code
    // never truncates the result to an unreadable JSON file.
    const MAX_BYTES = 25_000;
    const SEP = '\n\n---\n\n';
    const lines = [];
    let totalBytes = 0;
    let truncatedAt = null; // timestamp where we stopped

    // Name-provenance tag: period name (held at the event's time) + durable
    // fleet id, with `→now:X` when the agent has since rotated. See search.
    const tag = (id, periodName, nowName) => {
      if (!id) return '';
      const nm = periodName === undefined ? (resolvedAgents.get(id)?.friendly_name || null) : periodName;
      let s = `${nm || '(nameless)'} ${id}`;
      if (nowName != null && nowName !== nm) s += ` →now:${nowName}`;
      return s;
    };

    for (const m of filtered) {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString(undefined, displayZoneOptions()) : '';
      const from = tag(m.from, m.fromName, m.fromNameNow);
      const to = tag(m.to, m.toName, m.toNameNow);
      const ver = args.project ? versionAt(m.timestamp) : null;
      const verStr = ver ? ` @${ver}` : '';
      const line = `[${ts}${verStr}] ${from} → ${to}\n${m.text}`;
      const lineBytes = Buffer.byteLength(line + SEP, 'utf8');

      if (totalBytes + lineBytes > MAX_BYTES && lines.length > 0) {
        truncatedAt = m.timestamp;
        break;
      }
      lines.push(line);
      totalBytes += lineBytes;
    }

    // Rewrite header if we hit the byte limit
    if (truncatedAt) {
      const shown = lines.length;
      const remaining = filtered.length - shown;
      const lastShownTs = filtered[shown - 1]?.timestamp;
      header = `Showing messages 1–${shown} of ${filtered.length}${overflow ? '+' : ''}${rangeStr}\n` +
        `⚠️ ${remaining}+ more — get the next page:\n` +
        `\`thread(${nextPageArg}, since: "${lastShownTs}"${untilHint})\``;
    }

    return { content: [{ type: 'text', text: `${header}${provenanceNote}\n\n${lines.join(SEP)}` }] };
  }

  // ==== Labels & Interrupts ====

  // ---- label_agent ----
  if (name === 'label_agent') {
    try {
      const data = await mcpFleetTransport.durable('label', { agent: args.agent, labels: args.labels || [] });
      if (data.error) return { content: [{ type: 'text', text: `Label failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Labels for ${data.agent}: ${(data.labels || []).join(', ') || '(none)'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Label failed before transport ACK: ${e.message}` }], isError: true };
    }
  }

  // ---- interrupt ----
  if (name === 'interrupt') {
    const { agent } = args;
    if (!agent) return { content: [{ type: 'text', text: 'Specify an agent to interrupt.' }], isError: true };

    try {
      const data = await mcpFleetTransport.durable('interrupt', { agent });
      if (data.error) return { content: [{ type: 'text', text: `Interrupt failed: ${data.error}` }], isError: true };
      const status = data.stopped ? 'confirmed stopped' : `not confirmed after ${data.attempts} attempts`;
      return { content: [{ type: 'text', text: `${data.agent || agent}: ${status}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Interrupt failed before transport ACK: ${e.message}` }], isError: true };
    }
  }

  // ==== Fleet Operations ====

  // ---- viewing_context ----
  if (name === 'viewing_context') {
    try {
      const userId = args.user
      if (!userId) return { content: [{ type: 'text', text: 'Missing user — pass the fleet ID of the person whose viewport you want (e.g. "fleet:skip").' }], isError: true }
      const url = `${TLDA_FLEET_SERVER}/api/fleet/viewing?user=${encodeURIComponent(userId)}`
      const res = await fleetFetch(url)
      const data = await res.json()
      if (data.error) return { content: [{ type: 'text', text: `No viewing context for ${userId}. They may not have scrolled recently.` }] }
      const parts = [`Document: ${data.doc || '(none)'}`, `Version: ${data.version || '(unknown)'}`]
      if (data.page) parts.push(`Page: ${Array.isArray(data.page) ? data.page.join(', ') : data.page}`)
      if (data.sourceLine) {
        const sl = data.sourceLine
        parts.push(`Source: ${sl.file}:${sl.startLine}${sl.endLine && sl.endLine !== sl.startLine ? '-' + sl.endLine : ''}`)
      }
      if (data.updatedAt) parts.push(`Updated: ${Math.round((Date.now() - data.updatedAt) / 1000)}s ago`)
      return { content: [{ type: 'text', text: parts.join('\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
    }
  }

  // ---- roster ----
  if (name === 'roster') {
    try {
      const qs = new URLSearchParams();
      if (args.filter) qs.set('filter', args.filter);
      if (args.limit) qs.set('limit', String(args.limit));
      const res = await fleetFetch(`${TLDA_FLEET_SERVER}/api/fleet-table${qs.toString() ? `?${qs}` : ''}`);
      const data = await res.json();
      if (data.error) return { content: [{ type: 'text', text: `roster failed: ${data.error}` }], isError: true };

      const t = data.totals || { awake: 0, hibernating: 0, dead: 0, total: 0 };
      const rows = data.agents || [];
      const header = `Fleet: ${t.awake} awake · ${t.hibernating} hibernating · ${t.dead} dead · ${t.total} total`;
      const scope = data.matched != null && data.matched !== t.total
        ? `  (filter matched ${data.matched}${data.shown < data.matched ? `, showing ${data.shown}` : ''})`
        : '';
      const formatCountSummary = (items = []) => items
        .slice(0, 8)
        .map(item => `${item.value}${item.count > 1 ? ` x${item.count}` : ''}`)
        .join(', ');
      const summaryLines = [];
      const modelSummary = formatCountSummary(data.summary?.models);
      const statusSummary = formatCountSummary(data.summary?.inbox_statuses);
      const channelSummary = formatCountSummary(data.summary?.delivery_channels);
      const cwdSummary = formatCountSummary(data.summary?.working_dirs);
      if (modelSummary) summaryLines.push(`Models: ${modelSummary}`);
      if (statusSummary) summaryLines.push(`Inbox statuses: ${statusSummary}`);
      if (channelSummary) summaryLines.push(`Delivery channels: ${channelSummary}`);
      if (cwdSummary) summaryLines.push(`Working dirs: ${cwdSummary}`);
      const summaryText = summaryLines.length ? `\n${summaryLines.join('\n')}` : '';

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `${header}${scope}${summaryText}\n(no agents match)` }] };
      }

      // Compact aligned table.
      const fmt = (a) => {
        const seen = a.last_seen_ago_s == null ? 'never' : a.last_seen_ago_s < 90 ? `${a.last_seen_ago_s}s` : a.last_seen_ago_s < 5400 ? `${Math.round(a.last_seen_ago_s / 60)}m` : `${Math.round(a.last_seen_ago_s / 3600)}h`;
        const act = a.activity ? `${a.activity}${a.tool ? `:${a.tool}` : ''}` : '';
        const health = formatActivityHealthStatus(a.activity_health, { idleText: act });
        return { name: a.name, status: a.status, seen, inbox: a.inbox_status || '', delivery: a.delivery_channel || '', model: a.model || '', cwd: a.cwd || '', act: health || act };
      };
      const f = rows.map(fmt);
      const w = (k) => Math.max(k.length, ...f.map(r => String(r[k]).length));
      const wn = w('name'), ws = w('status'), wsa = Math.max(4, ...f.map(r => r.seen.length));
      const wi = w('inbox');
      const wc = w('delivery');
      const wm = w('model');
      const lines = f.map(r =>
        `${r.name.padEnd(wn)}  ${r.status.padEnd(ws)}  ${r.seen.padStart(wsa)}  ${r.inbox.padEnd(wi)}  ${r.delivery.padEnd(wc)}  ${r.model.padEnd(wm)}  ${r.act ? r.act.padEnd(14) : '              '}  ${r.cwd}`.trimEnd()
      );
      const colHead = `${'agent'.padEnd(wn)}  ${'status'.padEnd(ws)}  ${'seen'.padStart(wsa)}  ${'inbox'.padEnd(wi)}  ${'delivery'.padEnd(wc)}  ${'model'.padEnd(wm)}  ${'activity'.padEnd(14)}  cwd`;
      return { content: [{ type: 'text', text: `${header}${scope}${summaryText}\n\n${colHead}\n${lines.join('\n')}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `roster failed before transport ACK: ${e.message}` }], isError: true };
    }
  }

  // ==== Utilities ====

  if (name === 'subscribe') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    try {
      const data = await mcpFleetTransport.durable('subscribe', { caller: AGENT_ID, target: args.target || AGENT_ID, query: args.query, notification_policy: args.notification_policy });
      if (data?.error) return { content: [{ type: 'text', text: `subscribe failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Subscribed #${data.subscription_id} for ${data.owner}: ${data.query} (${data.notification_policy}).` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `subscribe failed: ${e.message}` }], isError: true };
    }
  }

  if (name === 'subscriptions') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    try {
      const rows = await mcpFleetTransport.ephemeral('subscriptions', { caller: AGENT_ID, target: args.target || AGENT_ID });
      if (rows?.error) return { content: [{ type: 'text', text: `subscriptions failed: ${rows.error}` }], isError: true };
      if (!rows.length) return { content: [{ type: 'text', text: 'No subscriptions.' }] };
      return { content: [{ type: 'text', text: rows.map(r => `#${r.subscription_id} ${r.owner}: ${r.query} (${r.notification_policy})`).join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `subscriptions failed: ${e.message}` }], isError: true };
    }
  }

  if (name === 'unsubscribe') {
    if (!AGENT_ID) return { content: [{ type: 'text', text: 'Not logged in. Call login() first.' }], isError: true };
    try {
      const data = await mcpFleetTransport.durable('unsubscribe', { caller: AGENT_ID, subscription_id: args.subscription_id });
      if (data?.error) return { content: [{ type: 'text', text: `unsubscribe failed: ${data.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Unsubscribed #${data.subscription_id}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `unsubscribe failed: ${e.message}` }], isError: true };
    }
  }

  // ---- timer (non-blocking) ----
  if (name === 'timer') {
    const seconds = Math.min(Math.max(args.seconds || 10, 1), 600);
    const message = args.message || 'Timer fired';
    const fireAt = new Date(Date.now() + seconds * 1000).toISOString();

    // Store timer-set event immediately; the server owns scheduling, restart
    // recovery, and terminal fire/cancel delivery from the persisted row.
    let timerEventId = null;
    try {
      timerEventId = timerSetEventIdFromAck(await mcpFleetTransport.durable('timer-set', timerSetMessage({ agentId: AGENT_ID, message, fireAt, to: args.to })));
    } catch (e) {
      return { content: [{ type: 'text', text: `timer failed: ${e.message}` }], isError: true };
    }

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
      return `**${pb.title}** (${pb.id.slice(0, 8)})\n  ${pb.event_count} events (${types}) | ${(pb.duration_ms / 1000).toFixed(0)}s | ${new Date(pb.created).toLocaleString(undefined, displayZoneOptions())}`;
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

  return null;

  } catch (err) {
    process.stderr.write(`[fleet] tool ${name} threw: ${err?.message || err}\n${err?.stack || ''}\n`);
    return { content: [{ type: 'text', text: `Fleet MCP error (${name}): ${err?.message || err}` }], isError: true };
  }
}

// ---- Channel: WebSocket to dashboard for direct message injection ----
// Each MCP server instance opens its own WS to the dashboard, filtered to this agent.
// When fleet events arrive (chat, delegate, task_done), emits notifications/claude/channel
// so Claude Code receives them as first-class events — no tmux send-keys, no signal files.

// Dedup: track event IDs we originated so we don't re-notify on the broadcast echo
const _originatedEventIds = new Set();
const ORIGINATED_TTL_MS = 30000;
function rememberOriginatedEvents(result) {
  const ids = [];
  if (result?.event_id != null) ids.push(result.event_id);
  if (Array.isArray(result?.event_ids)) ids.push(...result.event_ids);
  for (const id of ids) {
    _originatedEventIds.add(id);
    setTimeout(() => _originatedEventIds.delete(id), ORIGINATED_TTL_MS);
  }
}

let _channelRWS = null;  // ResilientWS instance

// Request/response over WS — pending callbacks keyed by correlation ID
const _wsPending = new Map();
const WS_REQUEST_IDLE_MS = 45_000;
const _reconnectBuffer = new WsReconnectBuffer({ isConnected: () => !!_channelRWS?.connected });

/**
 * Send a request over the WS channel and wait for a response.
 * Returns the server ACK result on success and throws on error or timeout.
 * Feature callers use mcpFleetTransport and must choose durable or ephemeral.
 * This function is the private one-attempt adapter beneath that boundary.
 */
function _sendWSOnce(type, params = {}, opts = {}) {
  if (!_channelRWS?.connected) return null;
  const id = crypto.randomUUID();
  const idleTimeoutMs = opts.idleTimeoutMs ?? WS_REQUEST_IDLE_MS;
  const deadlineMs = opts.deadlineMs;
  return startWsRequest({
    pending: _wsPending,
    id,
    type,
    idleTimeoutMs,
    deadlineMs,
    send: () => _channelRWS.send({
      type,
      ...params,
      id,
      ...(opts.envelope ? {
        operation_id: params.operation_id || opts.envelope.operation_id,
        fleet_operation: opts.envelope,
      } : {}),
    }),
  });
}

// Buffer transient disconnects before reporting the server as down. If a tool
// call starts while ResilientWS is between close→reopen, keep the request in
// this process and put it on the wire as soon as the reconnect opens. This is
// deliberately lighter than the daemon's SQLite outbox: MCP losslessness only
// needs to cover a live tool call's brief reconnect window, bounded by the
// request deadline/idle timeout.
async function sendFleetRequestAttempt(type, params = {}, opts = {}) {
  if (_activeToolEnv) return sendOneShotWS(_activeToolEnv, type, params, opts);
  const startedAt = Date.now();
  const deadlineMs = opts.deadlineMs ?? opts.idleTimeoutMs ?? WS_REQUEST_IDLE_MS;
  while (Date.now() - startedAt < deadlineMs) {
    const result = _sendWSOnce(type, params, opts);
    if (result !== null) return await result;
    const remaining = Math.max(0, deadlineMs - (Date.now() - startedAt));
    const connected = await _reconnectBuffer.waitForConnection(Math.min(remaining, 5_000));
    if (!connected && !_channelRWS?.connected && Date.now() - startedAt >= deadlineMs) break;
  }
  throw new Error(`fleet WS request was not accepted before deadline after ${deadlineMs}ms (type=${type})`);
}

function currentTransportSessionId() {
  return CLAUDE_SESSION || process.env.CLAUDE_SESSION || null;
}

function scheduleFleetTransportFlush(delayMs = 1000) {
  if (_fleetTransportFlushTimer) return;
  _fleetTransportFlushTimer = setTimeout(() => {
    _fleetTransportFlushTimer = null;
    flushFleetTransport({ limit: 50 }).catch(e => {
      process.stderr.write(`[fleet-transport] scheduled flush failed: ${e.message}\n`);
    });
  }, Math.max(0, delayMs));
}

async function flushFleetTransport({ operationId = null, limit = 50, deadlineMs = 5000, agentId = AGENT_ID } = {}) {
  if (!agentId) return null;
  if (_activeToolEnv) return null;
  if (_fleetTransportFlushInFlight && !operationId) return _fleetTransportFlushInFlight;

  const run = async () => {
    const outbox = getFleetTransportOutbox(agentId);
    if (!_fleetTransportRecoveredAgents.has(agentId)) {
      outbox.recoverInflight({ agentId });
      _fleetTransportRecoveredAgents.add(agentId);
    }
    const rows = outbox.dueRows({
      agentId,
      sessionId: currentTransportSessionId(),
      operationId,
      limit,
    });
    let targetResult = null;
    for (const row of rows) {
      outbox.markAttempt(row.operationId);
      try {
        const result = await sendFleetRequestAttempt(row.type, row.params, { deadlineMs });
        if (result) {
          outbox.markAccepted(row.operationId, result);
          if (!operationId || row.operationId === operationId) targetResult = result;
        } else {
          const updated = outbox.markFailure(row.operationId, new Error('fleet WS send returned no result'), { retryable: true });
          if (updated?.status === 'retrying') scheduleFleetTransportFlush(1000);
        }
      } catch (e) {
        const retryable = isRetryableTransportError(e);
        const updated = outbox.markFailure(row.operationId, e, { retryable });
        if (retryable && updated?.status === 'retrying') scheduleFleetTransportFlush(1000);
        if (!retryable && operationId && row.operationId === operationId) throw e;
      }
    }
    return targetResult;
  };

  if (operationId) return run();
  _fleetTransportFlushInFlight = run().finally(() => {
    _fleetTransportFlushInFlight = null;
  });
  return _fleetTransportFlushInFlight;
}

async function sendDurableFleet(type, params = {}, opts = {}) {
  const transportAgentId = opts.agentId || AGENT_ID;
  if (!transportAgentId) throw new Error(`cannot send durable ${type}: no transport identity`);
  if (_activeToolEnv) return sendFleetRequestAttempt(type, params, opts);
  const outbox = getFleetTransportOutbox(transportAgentId);
  const operationId = opts.operationId || params?._tempId || `${transportAgentId}:mcp-${type}:${crypto.randomUUID()}`;
  const row = outbox.enqueue({
    operationId,
    agentId: transportAgentId,
    sessionId: currentTransportSessionId(),
    type,
    params: {
      ...params,
      operation_id: params.operation_id || operationId,
      fleet_operation: opts.envelope,
    },
    mode: 'durable',
  });
  if (row.status === 'accepted') return row.result || { ok: true, operation_id: operationId };
  if (row.status === 'failed' || row.status === 'dead') {
    throw new Error(row.lastError || `durable ${type} ${row.status}`);
  }

  const result = await flushFleetTransport({ operationId, agentId: transportAgentId });
  const latest = outbox.get(operationId);
  if (latest?.status === 'accepted') return latest.result || result || { ok: true, operation_id: operationId };
  if (latest?.status === 'failed' || latest?.status === 'dead') {
    throw new Error(latest.lastError || `durable ${type} ${latest.status}`);
  }
  scheduleFleetTransportFlush(1000);
  return { ok: true, queued: true, operation_id: operationId };
}

const mcpFleetTransport = createFleetOperationTransport({
  name: 'mcp-fleet',
  sendEphemeral: sendFleetRequestAttempt,
  sendDurable: sendDurableFleet,
  resolveSender: () => AGENT_ID,
  resolveDestination: ({ payload }) => (
    payload.to || payload.agent || payload.agent_id || payload.target || payload.filter || null
  ),
  observe: event => {
    if (event.stage === 'terminal' && !event.ok) {
      process.stderr.write(`[fleet-transport] ${event.mode} ${event.operation} failed: ${event.error}\n`);
    }
  },
})

async function flushFleetTransportOpportunistically(toolName) {
  if (!AGENT_ID || toolName === 'login') return;
  try {
    await flushFleetTransport({ limit: 20, deadlineMs: 1500 });
  } catch (e) {
    process.stderr.write(`[fleet-transport] opportunistic flush before ${toolName} failed: ${e.message}\n`);
  }
}

async function _flushUnread() {
  if (!AGENT_ID || !_channelRWS?.connected) return;
  let sourceEventId = null;
  let notificationError = null;
  try {
    const data = await mcpFleetTransport.ephemeral('my-task', { agent: AGENT_ID, peek: true });
    if (!data) return;
    const msgs = (data.messages || []).filter(m => !m.read);
    const task = data.task;
    // Unread is the whole trigger. This runs on every socket reconnect, and an
    // agent's task stays open for its whole working life — announcing it again
    // is not news, it is a 📬 on every WS flap. A task assigned while the
    // socket was down arrives as an unread message, so real news still fires.
    if (msgs.length === 0) return;
    sourceEventId = msgs[0]?.id || msgs[0]?.event_id || null;
    const label = _inboxStatus[0].toUpperCase() + _inboxStatus.slice(1);
    const content = `📬 ${label}: ${msgs.length} unread item(s). ${inboxCallText('triage')}`;
    let delivered = false;
    if (harnessFromEnv().channelNudge) {
      const sess = process.env.FLEET_TMUX_SESSION;
      if (sess) delivered = tmuxSendText(sess, content) || delivered;
    }
    await Promise.race([
      server.notification({
        method: 'notifications/claude/channel',
        params: { content, meta: { event_type: 'flush' } },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('notification timeout')), 1000)),
    ]);
    delivered = true;
    await reportNotificationAttempt({
      agentId: AGENT_ID,
      reason: task ? 'task' : 'chat',
      sourceEventId,
      sourceTaskId: task?.id || null,
      priority: 'normal',
      intendedSurface: harnessFromEnv().channelNudge ? 'tmux' : 'channel',
      policy: _inboxStatus === 'available' ? 'immediate' : _inboxStatus,
      outcome: 'delivered',
      evidence: {
        eventType: 'flush',
        unreadCount: msgs.length,
        hasTask: !!task,
        deliveryPath: harnessFromEnv().channelNudge ? 'tmux-or-channel' : 'channel',
      },
      nextAction: 'none',
    });
  } catch (e) {
    notificationError = e;
    process.stderr.write(`[fleet-channel] unread flush notification failed: ${e.message}\n`);
    await reportNotificationAttempt({
      agentId: AGENT_ID,
      reason: 'chat',
      sourceEventId,
      priority: 'normal',
      intendedSurface: harnessFromEnv().channelNudge ? 'tmux' : 'channel',
      policy: _inboxStatus === 'available' ? 'immediate' : _inboxStatus,
      outcome: 'send-failed',
      evidence: {
        eventType: 'flush',
        error: notificationError.message,
        stack: notificationError.stack,
      },
      nextAction: 'retry-on-reconnect',
    });
  }
}

let _channelHasOpened = false;

function startChannelWS({ bootstrap = false } = {}) {
  if (!AGENT_ID && !bootstrap) return;
  if (_channelRWS) return;

  _channelRWS = new ResilientWS({
    url: () => AGENT_ID
      ? `${TLDA_FLEET_WS_SERVER}/ws/fleet?agent=${encodeURIComponent(AGENT_ID)}`
      : `${TLDA_FLEET_WS_SERVER}/ws/fleet`,
    label: 'fleet-channel',
    heartbeatTimeoutMs: 45000,
    log: (s) => process.stderr.write(s + '\n'),
    onOpen: () => {
      _reconnectBuffer.resolveConnected();
      const reconnect = _channelHasOpened;
      _channelHasOpened = true;
      if (!AGENT_ID || !reconnect) return;
      const loginBody = {
        agent_id: AGENT_ID,
        session_id: currentTransportSessionId() || undefined,
        tmux_session: _tmuxSession || undefined,
        cwd: getAgentCwd() || process.cwd(),
        machine_id: process.env.TLDA_MACHINE_ID || os.hostname().split('.')[0],
        env_name: getActiveEnvName(),
      };
      mcpFleetTransport.durable('login', loginBody)
        ?.then(() => flushFleetTransport({ limit: 100 }))
        ?.catch(e => process.stderr.write(`[fleet-channel] re-login/flush failed: ${e.message}\n`));
      process.stderr.write(`[fleet-channel] re-logged-in ${AGENT_ID}\n`);
      setTimeout(_flushUnread, 500);
    },
    onActivity: () => {
      resetWsRequestIdleTimers(_wsPending);
    },
    onMessage: (msg) => {
      if (msg.id && _wsPending.has(msg.id)) {
        const { resolve, reject } = _wsPending.get(msg.id);
        if (msg.error) {
          const detail = typeof msg.error === 'object' && msg.error !== null ? msg.error : { message: msg.error };
          const err = new Error(detail.message || String(msg.error));
          Object.assign(err, detail);
          reject(err);
        }
        else {
          rememberOriginatedEvents(msg.result);
          resolve(msg.result);
        }
        return;
      }
      handleChannelMessage(msg);
    },
    onClose: () => {
      rejectWsRequests(_wsPending, ({ type }) => new Error(`WS connection closed (type=${type})`));
    },
  });
  _channelRWS.connect();
}

// Dedup channel notifications by event DB id — prevents double delivery
const _deliveredChannelIds = new Set();
const CHANNEL_DEDUP_TTL_MS = 60000;

function inboxCallText(action = 'see it') {
  return `Call inbox() to ${action}.`;
}

function formatStatusSummary({ eventType, fromLabel, docHint = '', preview = '', truncNote = '', reminder = '' }) {
  const source = fromLabel ? ` from ${fromLabel}${docHint}` : '';
  const kind = eventType === 'delegate' ? 'task' : eventType === 'task_done' ? 'update' : 'message';
  const label = _inboxStatus[0].toUpperCase() + _inboxStatus.slice(1);
  return `📬 ${label} ${kind}${source}: ${preview}${truncNote}\n${inboxCallText(eventType === 'chat' ? 'read and respond' : 'see it')}${reminder}`;
}

async function reportNotificationAttempt(attempt) {
  try {
    const result = await mcpFleetTransport.durable('notification-attempt', { attempt }, { deadlineMs: 5000 });
    return true;
  } catch (e) {
    process.stderr.write(`[fleet-channel] failed to report notification attempt for ${attempt.agentId} (${attempt.outcome}): ${e.message}\n`);
    return false;
  }
}

async function handleChannelMessage(msg) {
  if (!AGENT_ID) return;

  // Dashboard WS sends { event: 'fleet-event', data: {...} } for new mailbox
  // items. Fired timers are same-row `event-update`s because the timer event is
  // first created as pending, then becomes unread again when it fires.
  const eventType = msg.event === 'fleet-event' || msg.event === 'event-update'
    ? (msg.data?.type || '')
    : '';
  if (!eventType) return;
  if (!['chat', 'delegate', 'task_done', 'timer'].includes(eventType)) return;

  const data = msg.data || {};
  const isTimerFire = eventType === 'timer' && data.metadata?.state === 'fired';
  if (msg.event === 'event-update' && !isTimerFire) return;
  if (eventType === 'timer' && !isTimerFire) return;

  // Skip broadcast echoes of events we originated
  if (shouldSkipOriginatedEvent({ eventId: data.id, originatedEventIds: _originatedEventIds, isTimerFire })) return;

  // Dedup: skip if we already delivered a channel notification for this event
  if (data.id && _deliveredChannelIds.has(data.id)) {
    return;
  }

  // Check if this agent is a direct target OR a wiretap CC recipient
  const targetId = data.to || data.to_id || '';
  const wiretapCc = data.metadata?.wiretap_cc || [];
  const isDirectTarget = targetId === AGENT_ID;
  const isWiretapTarget = wiretapCc.includes(AGENT_ID);
  if (!isDirectTarget && !isWiretapTarget) return;

  // Skip events FROM this agent
  const fromId = data.from || data.from_id || '';
  if (fromId === AGENT_ID && !isTimerFire) return;

  // Skip terminal-sourced messages — agent is already in their terminal and has this context
  if (data.metadata?.source === 'terminal') return;

  // Hard dedup: suppress if same content was sent recently (CC 2.1.97 replays channel notifications)
  if (!handleChannelMessage._lastContent) handleChannelMessage._lastContent = '';
  if (!handleChannelMessage._lastTs) handleChannelMessage._lastTs = 0;

  // Build notification content
  let content = '📬 You have a new fleet message. Call inbox() to see it.';
  // Preview length: long enough to fit a typical voice message in full,
  // with an ellipsis on overflow so Skip doesn't think the system ate
  // Short preview: just enough to know the topic, not enough to act on.
  // Agents MUST call inbox() to get the full message.
  const PREVIEW_MAX = 120;
  const previewOf = (raw) => {
    const s = String(raw || '');
    return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s;
  };
  const isTruncated = (raw) => String(raw || '').length > PREVIEW_MAX;
  const fromLabel = data.metadata?.fromLabel || fromId?.replace(/^fleet:/, '') || 'unknown';
  const toLabel = (data.to || data.to_id || '')?.replace(/^fleet:/, '') || '';

  if (isWiretapTarget && !isDirectTarget) {
    // Wiretap: format identically to thread entries so the agent can
    // concatenate wiretap output with thread history seamlessly.
    const ts = data.timestamp ? new Date(data.timestamp).toLocaleString(undefined, displayZoneOptions()) : '';
    const text = eventType === 'delegate'
      ? `[DELEGATE] ${data.description || ''}\n${data.message || data.text || ''}`
      : eventType === 'task_done'
      ? `[DONE] ${data.description || ''}`
      : eventType === 'activity'
      ? (data.metadata?.tool || data.text || '')
      : data.text || data.message || '';
    content = `[${ts}] ${fromLabel} → ${toLabel}\n${text}`;
  } else {
    // Direct target: use the existing notification format
    if (eventType === 'delegate') {
      const desc = previewOf(data.text || data.description);
      const rawDesc = data.text || data.description || '';
      const truncNote = isTruncated(rawDesc) ? `\n(TRUNCATED — showing ${PREVIEW_MAX}/${rawDesc.length} chars. You MUST call inbox() for the full text before responding)` : '';
      content = formatStatusSummary({ eventType, fromLabel, preview: desc, truncNote })
        || `📬 New task assigned: ${desc}${truncNote}\nCall inbox() to see it.`;
    } else if (eventType === 'chat') {
      const rawText = data.text || data.message || '';
      const preview = previewOf(rawText);
      const ctx = data.metadata?.context;
      const docHint = formatViewingHint(ctx, { terse: true });
      const truncNote = isTruncated(rawText) ? `\n(TRUNCATED — showing ${PREVIEW_MAX}/${rawText.length} chars. You MUST call inbox() for the full text before responding)` : '';
      const reminder = data.metadata?.chatReminder ? `\n⚠️ ${data.metadata.chatReminder}` : '';
      content = formatStatusSummary({ eventType, fromLabel, docHint, preview, truncNote, reminder })
        || `📬 Message from ${fromLabel}${docHint}: ${preview}${truncNote}\nCall inbox() to read and respond.${reminder}`;
    } else if (eventType === 'task_done') {
      content = formatStatusSummary({ eventType, fromLabel, preview: data.description || data.text || 'Task update' })
        || `📬 Task update. Call inbox() to see details.`;
    } else if (eventType === 'timer') {
      const rawText = data.text || data.message || data.metadata?.message || 'Timer fired';
      const preview = previewOf(rawText);
      const truncNote = isTruncated(rawText) ? `\n(TRUNCATED — showing ${PREVIEW_MAX}/${rawText.length} chars. You MUST call inbox() for the full text before responding)` : '';
      content = `📬 ${_inboxStatus[0].toUpperCase() + _inboxStatus.slice(1)} timer: ${preview}${truncNote}\n${inboxCallText('triage')}`;
    }
  }

  // Suppress if identical content within 30s
  const now = Date.now();
  if (shouldSuppressRecentContent({
    isTimerFire,
    content,
    lastContent: handleChannelMessage._lastContent,
    lastTs: handleChannelMessage._lastTs,
    now,
  })) {
    process.stderr.write(`[fleet-channel] Suppressed duplicate: ${content.slice(0, 60)}\n`);
    return;
  }
  if (!isTimerFire) {
    handleChannelMessage._lastContent = content;
    handleChannelMessage._lastTs = now;
  }

  let delivered = false;
  let notificationError = null;
  // Harness adapter decides whether Claude-channel delivery needs a tmux nudge.
  // Do this before the Claude notification: Codex/Goose may not support that
  // notification method, and some clients can leave the notification pending.
  if (isDirectTarget && harnessFromEnv().channelNudge) {
    const sess = process.env.FLEET_TMUX_SESSION;
    if (sess) {
      delivered = tmuxSendText(sess, content) || delivered;
    } else {
      process.stderr.write('[fleet-channel] no FLEET_TMUX_SESSION for harness nudge\n');
    }
  }

  try {
    await Promise.race([
      server.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            event_type: isWiretapTarget && !isDirectTarget ? 'wiretap' : eventType,
            from: fromId,
          },
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('notification timeout')), 1000)),
    ]);
    delivered = true;
    process.stderr.write(`[fleet-channel] Delivered ${eventType} from ${fromId} via channel (event ${data.id})\n`);
  } catch (e) {
    notificationError = e;
    process.stderr.write(`[fleet-channel] notification failed: ${e.message}\n`);
  }

  await reportNotificationAttempt({
    agentId: AGENT_ID,
    reason: eventType,
    sourceEventId: data.id || data.event_id || null,
    sourceTaskId: data.task_id || data.taskId || null,
    priority: data.metadata?.priority || 'normal',
    intendedSurface: harnessFromEnv().channelNudge ? 'tmux' : 'channel',
    policy: _inboxStatus === 'available' ? 'immediate' : _inboxStatus,
    attemptedAt: new Date(now).toISOString(),
    outcome: delivered ? 'delivered' : 'send-failed',
    evidence: {
      from: fromId,
      eventType,
      deliveryPath: harnessFromEnv().channelNudge ? 'tmux-or-channel' : 'channel',
      error: notificationError?.message || null,
      stack: notificationError?.stack || null,
    },
    nextAction: delivered ? 'none' : 'retry-on-reconnect',
  });

  if (delivered) {
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

  mcpFleetTransport.ephemeral('agent-status', {
    agentId: AGENT_ID,
    state,
    tool: toolName || null,
    ts: new Date().toISOString(),
  }).catch((error) => {
    console.error(`[fleet-transport] agent-status failed: ${error.message}`);
  });
}

// --- Tmux session detection (for registration only) ---
let _tmuxSession = process.env.FLEET_TMUX_SESSION || null;
if (!_tmuxSession) {
  try {
    const s = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8', timeout: 1000 }).trim();
    if (s.startsWith('fleet-')) _tmuxSession = s;
  } catch {}
}

export function initFleet(serverInstance) {
  server = serverInstance;
  if (AGENT_ID) startChannelWS();
}
