#!/usr/bin/env node
/**
 * Unified MCP Server — tlda doc tools + fleet agent tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  deliverOperationMailboxCompletion,
  getFleetTools,
  handleFleetTool,
  initFleet,
  operationMailboxStartedResult,
  setAgentPreambleDoc,
  startOperationMailbox,
  TLDA_INSTRUCTIONS,
} from './fleet-tools.mjs';
import http from 'http';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectSSE } from '../shared/sse-parser.mjs';
import { WebSocketServer } from 'ws';
import { getIndexAbove } from '@tldraw/utils';
import { findRenderedText } from './svg-text.mjs';
import { initDataSource, readJsonSync, readJson, readManifestSync, readManifest, localDocDir, isRemote } from './data-source.mjs';
import { resolveToken } from './resolve-token.mjs';
import { formatHighlight, formatNote } from './format-annotation.mjs';
import { formatDisplayTimestamp } from '../shared/display-time.mjs';
import { stageNote, stageHighlight } from './lib/annotate.mjs';
import {
  isHtmlDoc, docToCanvas, canvasToDoc, getPageWidth,
  pdfToCanvas, canvasToPdf, htmlToCanvas, canvasToHtml, loadHtmlLayout,
  PDF_WIDTH, PDF_HEIGHT, PAGE_WIDTH, PAGE_HEIGHT, PAGE_GAP,
} from './lib/formatCoords.mjs';
import { harnessFromEnv } from './lib/harness-adapters.mjs';

import { getFleetServerUrl, getServerUrl, DEFAULT_PORT } from '../shared/config.mjs'
import { tldaFetch as _tldaFetch } from '../shared/http-client.mjs'
import { uploadFileToServer } from '../shared/chat-file-processing.mjs'
import { pushMcpSourceFiles } from './source-push-orchestration.mjs'

const TLDA_TOKEN = resolveToken();
const TLDA_AUTH_HEADERS = TLDA_TOKEN ? { 'Authorization': `Bearer ${TLDA_TOKEN}` } : {};
const TLDA_SERVER = getServerUrl();
// Separate sync server for shapes/signals (e.g. Fly.io); defaults to the active
// store server when no split-sync override is configured.
const TLDA_SYNC_SERVER = process.env.TLDA_SYNC_SERVER || TLDA_SERVER;
const STORE_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(TLDA_SERVER);
const ALLOW_LOCAL_DOC_DISK = !!process.env.TLDA_SYNC_SERVER || STORE_IS_LOCAL;
const FLEET_ONLY_MCP = process.env.TLDA_MCP_FLEET_ONLY === '1';
// ---- REST API helpers (shape CRUD via @tldraw/sync rooms) ----

async function serverFetch(urlPath, options = {}) {
  return _tldaFetch(urlPath, {
    method: options.method,
    body: options.body,
    headers: options.headers,
    server: TLDA_SYNC_SERVER,
  });
}

async function fetchShapes(docName, typeFilter) {
  const qs = typeFilter ? `?type=${typeFilter}` : '';
  return serverFetch(`/api/projects/${docName}/shapes${qs}`);
}

async function fetchShape(docName, shapeId) {
  const id = shapeId.startsWith('shape:') ? shapeId : `shape:${shapeId}`;
  return serverFetch(`/api/projects/${docName}/shapes/${encodeURIComponent(id)}`);
}

/** Get the next available shape index (above all existing shapes). */
async function getNextShapeIndex(docName) {
  let maxIndex = 'a1';
  try {
    const allShapes = await fetchShapes(docName);
    for (const s of allShapes) {
      if (s.typeName === 'shape' && s.index && s.index > maxIndex) {
        maxIndex = s.index;
      }
    }
  } catch (e) { process.stderr.write(`[mcp] shape index scan failed: ${e.message}\n`); }
  return getIndexAbove(maxIndex);
}

async function createShapeRest(docName, shape) {
  return serverFetch(`/api/projects/${docName}/shapes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shape),
  });
}

async function updateShapeRest(docName, shapeId, updates) {
  const id = shapeId.startsWith('shape:') ? shapeId : `shape:${shapeId}`;
  return serverFetch(`/api/projects/${docName}/shapes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

async function deleteShapeRest(docName, shapeId) {
  const id = shapeId.startsWith('shape:') ? shapeId : `shape:${shapeId}`;
  return serverFetch(`/api/projects/${docName}/shapes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

async function broadcastSignalRest(docName, key, data) {
  return serverFetch(`/api/projects/${docName}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, ...data }),
  });
}

async function readSignalRest(docName, key) {
  try {
    return await serverFetch(`/api/projects/${docName}/signal/${encodeURIComponent(key)}`);
  } catch {
    return null;
  }
}

const UNDERSTANDING_RIBBON_ID = 'shape:understanding-ribbon';
const UNDERSTANDING_COALESCE_GAP_PX = 1.5;

function shortText(value, max = 160) {
  if (value == null) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function understandingIdentityKey(seg) {
  return [
    seg.status,
    seg.approvedAtCommit ?? '',
    seg.stale ? 1 : 0,
    seg.staleAt ?? '',
    seg.checkedById ?? '',
    seg.checkedByName ?? '',
    seg.checkedAt ?? '',
    seg.reason ?? '',
    seg.method ?? '',
    seg.taskId ?? '',
    seg.eventId ?? '',
  ].join('\u0000');
}

function normalizeUnderstandingSegments(segments) {
  const colored = segments
    .filter(s => s.status !== 'unchecked' && s.y2 - s.y1 > 0)
    .sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2 ||
      (understandingIdentityKey(a) < understandingIdentityKey(b) ? -1 :
        understandingIdentityKey(a) > understandingIdentityKey(b) ? 1 : 0));

  const out = [];
  for (const seg of colored) {
    const last = out[out.length - 1];
    if (last && understandingIdentityKey(last) === understandingIdentityKey(seg) &&
        seg.y1 <= last.y2 + UNDERSTANDING_COALESCE_GAP_PX) {
      if (seg.y2 > last.y2) {
        last.y2 = seg.y2;
        last.endLine = seg.endLine;
        last.endFile = seg.endFile;
      }
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function mergeUnderstandingSegment(existing, newSeg) {
  const result = [];
  for (const seg of existing) {
    if (seg.y2 <= newSeg.y1 || seg.y1 >= newSeg.y2) {
      result.push(seg);
      continue;
    }
    if (seg.y1 < newSeg.y1) {
      result.push({ ...seg, y2: newSeg.y1, endLine: newSeg.startLine, endFile: newSeg.startFile });
    }
    if (seg.y2 > newSeg.y2) {
      result.push({ ...seg, y1: newSeg.y2, startLine: newSeg.endLine, startFile: newSeg.endFile });
    }
  }
  if (newSeg.status !== 'unchecked') result.push(newSeg);
  result.sort((a, b) => a.y1 - b.y1);
  return normalizeUnderstandingSegments(result);
}

function understandingProvenanceFromArgs(args) {
  const checkedById = shortText(args.userId || process.env.FLEET_ID, 120);
  const checkedByName = shortText(args.displayName || process.env.FLEET_NAME, 120);
  return {
    ...(checkedById ? { checkedById } : {}),
    ...(checkedByName ? { checkedByName } : {}),
    checkedAt: Date.now(),
    ...(shortText(args.reason) ? { reason: shortText(args.reason) } : {}),
    ...(shortText(args.method, 80) ? { method: shortText(args.method, 80) } : {}),
    ...(shortText(args.taskId, 120) ? { taskId: shortText(args.taskId, 120) } : {}),
    ...(shortText(args.eventId, 120) ? { eventId: shortText(args.eventId, 120) } : {}),
  };
}

function formatUnderstandingRange(seg) {
  const lo = Math.min(seg.startLine, seg.endLine);
  const hi = Math.max(seg.startLine, seg.endLine);
  const file = seg.startFile || seg.endFile || '';
  return `${file ? `${file}:` : ''}${lo}-${hi}`;
}

function formatUnderstandingProvenance(seg) {
  const bits = [];
  const checker = seg.checkedByName || seg.checkedById;
  if (checker) bits.push(`checked by ${checker}`);
  if (typeof seg.checkedAt === 'number') bits.push(formatDisplayTimestamp(seg.checkedAt));
  if (seg.method) bits.push(`method: ${seg.method}`);
  if (seg.taskId) bits.push(`task: ${seg.taskId}`);
  if (seg.eventId) bits.push(`event: ${seg.eventId}`);
  if (seg.reason) bits.push(`reason: ${shortText(seg.reason, 100)}`);
  return bits.join('; ');
}

function formatUnderstandingSummary(segments) {
  const sorted = [...segments].sort((a, b) =>
    Math.min(a.startLine, a.endLine) - Math.min(b.startLine, b.endLine));
  const groups = new Map();
  for (const seg of sorted) {
    const checker = seg.checkedByName || seg.checkedById || 'unknown checker';
    const stale = seg.stale ? 'stale' : 'fresh';
    const reason = seg.reason ? shortText(seg.reason, 80) : '';
    const key = `${seg.status}\u0000${stale}\u0000${checker}\u0000${reason}`;
    const cur = groups.get(key) || { status: seg.status, stale, checker, reason, count: 0 };
    cur.count += 1;
    groups.set(key, cur);
  }

  let summary = `${sorted.length} segment(s)\n`;
  summary += 'Grouped:\n';
  for (const g of [...groups.values()].sort((a, b) =>
    a.status.localeCompare(b.status) || a.stale.localeCompare(b.stale) || a.checker.localeCompare(b.checker))) {
    summary += `  ${g.status}/${g.stale} by ${g.checker}: ${g.count}`;
    if (g.reason) summary += ` - ${g.reason}`;
    summary += '\n';
  }
  summary += 'Segments:\n';
  for (const seg of sorted) {
    const stale = seg.stale ? 'stale' : 'fresh';
    const prov = formatUnderstandingProvenance(seg);
    summary += `  ${formatUnderstandingRange(seg)}: ${seg.status} (${stale})`;
    if (prov) summary += ` - ${prov}`;
    summary += '\n';
  }
  return summary;
}

/**
 * Connect to signal SSE stream. Returns { close() }.
 * Calls onSignal(signal) for each signal broadcast ({key, ...data, timestamp}).
 */
function connectSignalStream(docName, onSignal) {
  const stream = connectSSE({
    url: `${TLDA_SYNC_SERVER}/api/projects/${docName}/signal/stream`,
    headers: TLDA_AUTH_HEADERS,
    onEvent: onSignal,
    onEnd() {
      console.error(`[SSE] Signal stream ${docName} ended, reconnecting...`);
      setTimeout(() => stream.reconnect(), 3000);
    },
    onError() {
      console.error(`[SSE] Signal stream ${docName} error, reconnecting...`);
      setTimeout(() => stream.reconnect(), 5000);
    },
  });
  return stream;
}

/**
 * Connect to shape change SSE stream. Returns { close() }.
 * Calls onChange() whenever shapes change in the sync room.
 */
function connectShapeStream(docName, onChange) {
  const stream = connectSSE({
    url: `${TLDA_SYNC_SERVER}/api/projects/${docName}/shapes/stream`,
    headers: TLDA_AUTH_HEADERS,
    onEvent: onChange,
    onEnd() {
      console.error(`[SSE] Shape stream ${docName} ended, reconnecting...`);
      setTimeout(() => stream.reconnect(), 3000);
    },
    onError() {
      console.error(`[SSE] Shape stream ${docName} error, reconnecting...`);
      setTimeout(() => stream.reconnect(), 5000);
    },
  });
  return stream;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = '/tmp/tldraw-snapshot.json';
const SCREENSHOT_PATH = '/tmp/annotated-view.png';

/** Check if a document has built pages. Returns { ok, pages, buildStatus } or { ok: false, reason }. */
async function checkDocBuildStatus(docName) {
  const sUrl = getServerUrl();
  try {
    const res = await fetch(`${sUrl}/api/projects/${docName}`, { headers: TLDA_AUTH_HEADERS });
    if (res.ok) {
      const info = await res.json();
      if (!info.pages || info.pages === 0) {
        const status = info.buildStatus || 'unknown';
        if (status === 'building') return { ok: false, reason: `Document "${docName}" is currently building — no pages available yet` };
        return { ok: false, reason: `Document "${docName}" has no built pages (build status: ${status})` };
      }
      return { ok: true, pages: info.pages, buildStatus: info.buildStatus };
    }
    if (ALLOW_LOCAL_DOC_DISK) return checkDocBuildStatusDisk(docName);
    return { ok: false, reason: `Document "${docName}" status check failed on ${sUrl}: HTTP ${res.status}` };
  } catch (e) {
    if (ALLOW_LOCAL_DOC_DISK) {
      const diskResult = checkDocBuildStatusDisk(docName);
      if (diskResult.ok) return diskResult;
      if (e?.cause?.code === 'ECONNREFUSED' || e?.code === 'ECONNREFUSED') {
        if (process.env.TLDA_SYNC_SERVER) return diskResult;
        return { ok: false, reason: `Server is not running (connection refused on port ${DEFAULT_PORT}). Start it with "tlda server start"` };
      }
      return diskResult;
    }
    if (e?.cause?.code === 'ECONNREFUSED' || e?.code === 'ECONNREFUSED') {
      return { ok: false, reason: `Document "${docName}" status check failed: ${sUrl} is unreachable` };
    }
    return { ok: false, reason: `Document "${docName}" status check failed on ${sUrl}: ${e.message}` };
  }
}

/** Local-store status check: read project.json directly when disk mode is allowed. */
function checkDocBuildStatusDisk(docName) {
  const projDir = path.join(PROJECT_ROOT, 'server', 'projects', docName);
  const projJson = path.join(projDir, 'project.json');
  try {
    const info = JSON.parse(fs.readFileSync(projJson, 'utf8'));
    if (!info.pages || info.pages === 0) {
      const status = info.buildStatus || 'unknown';
      if (status === 'building') return { ok: false, reason: `Document "${docName}" is currently building — no pages available yet` };
      return { ok: false, reason: `Document "${docName}" has no built pages (build status: ${status})` };
    }
    return { ok: true, pages: info.pages, buildStatus: info.buildStatus };
  } catch {
    return { ok: false, reason: `Project "${docName}" not found on server. Run "tlda doc status ${docName}" or "tlda doc errors ${docName}" to investigate.` };
  }
}

// Doc-asset source: fetch over HTTP from the active config's STORE when that
// store is a remote origin; read disk otherwise. Derived from store.http (config),
// NOT a raw TLDA_SERVER env — so the asset origin can't diverge from the fleet the
// agent joined (a spawned remote agent on the Mini has no local output/ to read, so
// it must HTTP from store). Disk mode is preserved for a local store (localhost,
// same-machine dev) and the internal harness-projected room transport
// (TLDA_SYNC_SERVER — not a user-facing config selector; named configs remain
// the public configuration surface for database/store selection). The published
// triage clone reads assets from disk while shapes sync elsewhere).
initDataSource(PROJECT_ROOT, ALLOW_LOCAL_DOC_DISK ? null : TLDA_SERVER);

// ---- Lookup.json support ----

function loadLookup(docName) {
  return readJsonSync(docName, 'lookup.json');
}

async function loadLookupAsync(docName) {
  return await readJson(docName, 'lookup.json');
}

function lookupLine(docName, lineNum, file) {
  const lookup = loadLookup(docName);
  if (!lookup?.lines) return null;
  return _lookupLineInData(lookup, lineNum, file);
}

async function lookupLineAsync(docName, lineNum, file) {
  const lookup = await loadLookupAsync(docName);
  if (!lookup?.lines) return null;
  return _lookupLineInData(lookup, lineNum, file);
}

function _lookupLineInData(lookup, lineNum, file) {
  let entry = null;
  if (file) {
    const fname = path.basename(file);
    entry = lookup.lines[`${fname}:${lineNum}`];
  }
  if (!entry) entry = lookup.lines[lineNum.toString()];
  if (!entry) return null;
  return { page: entry.page, x: entry.x, y: entry.y, content: entry.content, texFile: lookup.meta?.texFile };
}

// Find the source (file, 1-based line) where `\label{label}` is written. The
// .aux-derived source map has the label's page/number but not its line; the
// label's true line is its definition site in the .tex. Scans the doc's real
// build files — the distinct .tex files synctex recorded in the source map's
// `pages` index (so junk/old .tex in the source dir are ignored) — plus the
// main file. Returns { file, line } or null. `\label{ }` whitespace tolerated.
function findLabelLine(sourceDir, sourceMap, mainFile, label) {
  const files = new Set();
  for (const entries of Object.values(sourceMap?.pages || {})) {
    for (const e of entries) if (e?.file && e.file.endsWith('.tex')) files.add(e.file);
  }
  if (mainFile) files.add(mainFile);
  const exact = `\\label{${label}}`;
  const reLabel = new RegExp('\\\\label\\{\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}');
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(sourceDir, rel), 'utf8'); } catch { continue; }
    let idx = text.indexOf(exact);
    if (idx === -1) { const m = text.match(reLabel); if (m) idx = m.index; }
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    return { file: rel, line };
  }
  return null;
}

// ---- education gate for non-Claude agents ----
//
// Mirrors Claude's PreToolUse skill mandate at the MCP boundary. Claude agents
// are gated by their harness hook and never reach this path. Goose/DeepSeek
// agents have no such hook, so we enforce the SAME qualifications rules here,
// against the tlda server's existing /api/education/check endpoint. On a gated
// call we BLOCK and name the owed skill(s). Goose clears that by loading the
// skill with native Summon; other non-Claude agents clear it by reading the
// SKILL.md natively. Any agent may instead call
// `dismiss_skill(skills:[…], reason:"…")` if it judges one irrelevant, which
// records the dismissal and shows Skip the reason. The block is sticky: the
// server re-derives the owed set each call, so it lifts only once the agent has
// loaded/read or dismissed every required skill, exactly like the Claude gate.
//
// Fail-OPEN by design: if the endpoint is down/unreachable the gate returns null
// so a tool is never broken by it. That is not a silent fallback — the gate is
// advisory infrastructure, not the tool's output — and every fail-open is logged
// to stderr so an outage is visible rather than swallowed.
//
// `chat` is deliberately NOT gated: it is the accessibility-critical channel to
// Skip, and a dropped retry there would lose a message. Only the producing tools
// (report/input_scratch), where a missed retry is harmless, gate.
const GATED_MCP_TOOLS = {
  report:        { tool: 'tlda/report' },
  input_scratch: { tool: 'tlda/input_scratch' },
};

async function eduCheckOwedSkills(toolNorm, { file = '', content = '' } = {}) {
  const agentId = process.env.FLEET_ID;
  if (!agentId || !TLDA_SERVER) return [];
  try {
    const qs = new URLSearchParams({ tool: toolNorm });
    if (file) qs.set('file', file);
    if (content) qs.set('content', content.slice(0, 2000));
    const res = await fetch(`${TLDA_SERVER}/api/education/check/${encodeURIComponent(agentId)}?${qs}`, { headers: TLDA_AUTH_HEADERS, signal: AbortSignal.timeout(3000) });
    if (!res.ok) { process.stderr.write(`[education-gate] check returned ${res.status} for ${toolNorm} — failing open\n`); return []; }
    const j = await res.json();
    if (Array.isArray(j?.skills) && j.skills.length) return j.skills;
    if (j?.skill) return [j.skill];
    return [];
  } catch (e) {
    process.stderr.write(`[education-gate] check unreachable for ${toolNorm} (${e.message}) — failing open\n`);
    return [];
  }
}

async function eduCreditSkillRead(skillName) {
  const agentId = process.env.FLEET_ID;
  if (!agentId || !TLDA_SERVER || !skillName) return;
  try {
    await fetch(`${TLDA_SERVER}/api/education/check/${encodeURIComponent(agentId)}?tool=Skill&skill=${encodeURIComponent(skillName)}`, { headers: TLDA_AUTH_HEADERS, signal: AbortSignal.timeout(3000) });
  } catch (e) {
    process.stderr.write(`[education-gate] credit failed for ${skillName} (${e.message})\n`);
  }
}

// Returns a blocked-tool result (named owed skills + read-or-dismiss instructions)
// or null to proceed.
async function educationGate(name, args) {
  const harness = harnessFromEnv();
  if (!harness.educationGate) return null;          // claude has its own hook; never double-gate
  const spec = GATED_MCP_TOOLS[name];
  if (!spec) return null;
  const input = { file: spec.file ? spec.file(args) : '', content: spec.content ? spec.content(args) : '' };
  const owed = await eduCheckOwedSkills(spec.tool, input);
  if (!owed.length) return null;
  const list = owed.map(s => `\`${s}\``).join(', ');
  const dismissArg = owed.map(s => `"${s}"`).join(', ');
  const isGoose = harness.kind === 'goose';
  // Each harness reads skills from its OWN natural place (harness.skillsDir) — not
  // a hardcoded checkout path on one machine. '~/' expands to the agent's home; a
  // relative dir (goose) stays workspace-relative.
  const skillsDir = harness.skillsDir.startsWith('~/')
    ? path.join(os.homedir(), harness.skillsDir.slice(2))
    : harness.skillsDir;
  const skillPath = s => `${skillsDir}/${s}/SKILL.md`;
  const satisfyLines = isGoose
    ? [
        `• Load each named skill with Goose Summon from \`${harness.skillsDir}/<name>/SKILL.md\`.`,
        `  Example: ask Summon to load ${owed.map(s => `"${s}"`).join(', ')}.`,
      ]
    : [
        `• Read each skill's markdown with your native file reader:`,
        `  ${owed.map(skillPath).join('\n  ')}`,
      ];
  const text = [
    `⚠️ Before \`${name}\`, you must clear ${owed.length} required skill(s): ${list}.`,
    `These are the same playbook(s) a Claude agent is force-gated into here.`,
    ``,
    `Do ONE of these for each, then call \`${name}\` again:`,
    ...satisfyLines,
    `• Or, if it genuinely does not apply to what you are doing, decline it —`,
    `  dismiss_skill(skills: [${dismissArg}], reason: "<why it does not apply>").`,
    `  A reason is required and is shown to Skip.`,
    ``,
    `The block lifts once every required skill is loaded/read or dismissed.`,
  ].join('\n');
  return { content: [{ type: 'text', text }], isError: true };
}

// ---- @label cross-reference validation ----

const AT_REF_PATTERN = /(?<![\\@\w])@([\w:.-]+)/g

function validateRefs(text, docName) {
  if (!text) return { warnings: [], refs: [] }
  const refs = []
  let match
  const re = new RegExp(AT_REF_PATTERN.source, 'g')
  while ((match = re.exec(text)) !== null) {
    refs.push(match[1])
  }
  if (refs.length === 0) return { warnings: [], refs: [] }

  const sm = readJsonSync(docName, 'source-map.json')
  const labels = sm?.labels || []
  const labelSet = new Set(labels.map(e => e.label))

  const warnings = []
  const resolved = []
  for (const ref of refs) {
    if (labelSet.has(ref)) {
      const entry = labels.find(e => e.label === ref)
      resolved.push({ ref, entry })
    } else {
      const similar = labels
        .filter(e => e.label.includes(ref.split(':').pop()) || ref.includes(e.label.split(':').pop()))
        .slice(0, 3)
        .map(e => e.label)
      warnings.push({ ref, similar })
    }
  }
  return { warnings, refs: resolved }
}

function formatRefWarnings(validation) {
  if (validation.warnings.length === 0) return ''
  const lines = validation.warnings.map(w => {
    const hint = w.similar.length > 0 ? ` (similar: ${w.similar.join(', ')})` : ''
    return `@${w.ref}${hint}`
  })
  return `\n⚠️ Broken refs: ${lines.join(', ')}`
}

// Coordinate mapping now lives in lib/formatCoords.mjs (imported above)

function findNearbyLines(docName, canvasBBox) {
  const lookup = loadLookup(docName);
  if (!lookup?.lines) return [];

  // Convert bbox corners to doc-local coordinates
  const topLeft = canvasToDoc(docName, canvasBBox.minX, canvasBBox.minY);
  const bottomRight = canvasToDoc(docName, canvasBBox.maxX, canvasBBox.maxY);
  const page = topLeft.page; // assume stroke doesn't span pages

  // Y margin: generous to catch lines near the stroke
  const yMargin = 15; // PDF points
  // X matching: only require overlap if stroke is wide (horizontal).
  // For vertical strokes (brackets, margin marks), match by Y only.
  const strokeW = bottomRight.pdfX - topLeft.pdfX;
  const useXFilter = strokeW > 50; // only filter X for wide horizontal strokes

  const matches = [];
  for (const [lineNum, entry] of Object.entries(lookup.lines)) {
    if (entry.page !== page) continue;
    if (entry.y < topLeft.pdfY - yMargin || entry.y > bottomRight.pdfY + yMargin) continue;
    if (useXFilter && (entry.x > bottomRight.pdfX + 20 || entry.x < topLeft.pdfX - 20)) continue;
    matches.push({ line: parseInt(lineNum), content: entry.content, x: entry.x, y: entry.y });
  }
  matches.sort((a, b) => a.line - b.line);
  return matches;
}

// ---- HTML search index text extraction ----

function loadSearchIndex(docName) {
  return readJsonSync(docName, 'search-index.json');
}

function findHtmlRenderedText(docName, canvasBBox) {
  const searchIndex = loadSearchIndex(docName);
  if (!searchIndex) return [];

  // Find which page the bbox center is on
  const centerX = (canvasBBox.minX + canvasBBox.maxX) / 2;
  const centerY = (canvasBBox.minY + canvasBBox.maxY) / 2;
  const pos = canvasToHtml(docName, centerX, centerY);
  if (!pos) return [];

  // Find the search index entry for this page
  const entry = searchIndex.find(e => e.page === pos.page);
  if (!entry?.text) return [];

  // Return a ~200-char excerpt from the page text
  const text = entry.text.replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return [text];
  // Try to return the portion near the vertical position
  const fraction = Math.max(0, Math.min(1, pos.localY / 600));
  const start = Math.floor(fraction * Math.max(0, text.length - 200));
  return [text.slice(start, start + 200)];
}

function getRenderedText(docName, bbox) {
  if (isHtmlDoc(docName)) {
    const texts = findHtmlRenderedText(docName, bbox);
    if (texts.length === 0) return '';
    let joined = texts.join(' | ');
    if (joined.length > 200) joined = joined.slice(0, 200) + '…';
    return joined;
  }
  const texts = findRenderedText(docName, bbox, PROJECT_ROOT);
  if (texts.length === 0) return '';
  // Truncate to ~200 chars total for readability
  let joined = texts.join(' | ');
  if (joined.length > 200) joined = joined.slice(0, 200) + '…';
  return joined;
}

// ---- Page-relative position description ----
// Converts a canvas bbox center into "page N, upper-right" style description.
function describePagePosition(docName, canvasBBox) {
  const cx = (canvasBBox.minX + canvasBBox.maxX) / 2;
  const cy = (canvasBBox.minY + canvasBBox.maxY) / 2;
  const doc = canvasToDoc(docName, cx, cy);
  const pw = isHtmlDoc(docName) ? getPageWidth(docName) : PDF_WIDTH;
  const ph = isHtmlDoc(docName) ? 600 : PDF_HEIGHT;

  // Horizontal zone
  const xFrac = doc.pdfX / pw;
  let hz;
  if (xFrac < 0.08) hz = 'left margin';
  else if (xFrac > 0.92) hz = 'right margin';
  else if (xFrac < 0.35) hz = 'left';
  else if (xFrac > 0.65) hz = 'right';
  else hz = 'center';

  // Vertical zone
  const yFrac = doc.pdfY / ph;
  let vz;
  if (yFrac < 0.15) vz = 'top';
  else if (yFrac > 0.85) vz = 'bottom';
  else if (yFrac < 0.4) vz = 'upper';
  else if (yFrac > 0.6) vz = 'lower';
  else vz = 'mid';

  // Combine — simplify when one dimension is "center"/"mid"
  let position;
  if (hz === 'center' && vz === 'mid') position = 'center';
  else if (hz === 'center') position = vz;
  else if (vz === 'mid') position = hz;
  else if (hz === 'left margin' || hz === 'right margin') position = `${vz}, ${hz}`;
  else position = `${vz}-${hz}`;

  return { page: doc.page, position, description: `page ${doc.page}, ${position}` };
}

function classifyGesture(bbox) {
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const ratio = w / Math.max(h, 1);

  if (w < 20 && h < 20) return 'dot';
  if (ratio > 4) return 'strikethrough';
  if (ratio > 2) return 'underline';
  if (ratio < 0.3) return 'vertical-line';
  if (ratio < 0.5) return 'bracket';
  return 'circle';
}

// Decode TLDraw v4 delta-encoded base64 path into points.
// Format: first point = 3 Float32 LE (12 bytes), deltas = 3 Float16 LE (6 bytes each).
function decodeB64Path(b64) {
  if (!b64 || b64.length === 0) return [];
  const buf = Buffer.from(b64, 'base64');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 12) return [];

  const points = [];
  // First point: Float32 LE
  let x = dv.getFloat32(0, true);
  let y = dv.getFloat32(4, true);
  let z = dv.getFloat32(8, true);
  points.push({ x, y, z });

  // Subsequent points: Float16 LE deltas
  for (let off = 12; off + 5 < buf.length; off += 6) {
    x += float16(dv.getUint16(off, true));
    y += float16(dv.getUint16(off + 2, true));
    z += float16(dv.getUint16(off + 4, true));
    points.push({ x, y, z });
  }
  return points;
}

// Decode a 16-bit float (IEEE 754 half-precision)
function float16(bits) {
  const sign = bits >> 15;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) {
    const val = frac * (Math.pow(2, -14) / 1024);
    return sign ? -val : val;
  }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  const val = Math.pow(2, exp - 15) * (1 + frac / 1024);
  return sign ? -val : val;
}

function getDrawShapeBBox(shape) {
  const segments = shape.props?.segments;
  if (!segments || segments.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    // TLDraw v4: segments have .path (base64 string), not .points
    const points = seg.path ? decodeB64Path(seg.path) : (seg.points || []);
    for (const pt of points) {
      const absX = shape.x + pt.x;
      const absY = shape.y + pt.y;
      if (absX < minX) minX = absX;
      if (absY < minY) minY = absY;
      if (absX > maxX) maxX = absX;
      if (absY > maxY) maxY = absY;
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

// ---- Arrow shape helpers ----

function getArrowEndpoints(shape) {
  const start = shape.props?.start;
  const end = shape.props?.end;
  if (!start || !end) return null;
  return {
    start: { x: shape.x + start.x, y: shape.y + start.y },
    end: { x: shape.x + end.x, y: shape.y + end.y },
  };
}

function getArrowBBox(shape) {
  const ep = getArrowEndpoints(shape);
  if (!ep) return null;
  return {
    minX: Math.min(ep.start.x, ep.end.x),
    minY: Math.min(ep.start.y, ep.end.y),
    maxX: Math.max(ep.start.x, ep.end.x),
    maxY: Math.max(ep.start.y, ep.end.y),
  };
}

// ---- Geo / text / line shape helpers ----

function getGeoBBox(shape) {
  const w = shape.props?.w;
  const h = shape.props?.h;
  if (w == null || h == null) return null;
  return {
    minX: shape.x,
    minY: shape.y,
    maxX: shape.x + w,
    maxY: shape.y + h,
  };
}

function getTextBBox(shape) {
  const w = shape.props?.w || 200;
  // Rough height estimate from text content
  const text = shape.props?.text || '';
  const lineCount = Math.max(1, text.split('\n').length);
  const fontSize = shape.props?.size === 's' ? 16 : shape.props?.size === 'l' ? 28 : 22;
  const h = lineCount * fontSize * 1.4;
  return {
    minX: shape.x,
    minY: shape.y,
    maxX: shape.x + w,
    maxY: shape.y + h,
  };
}

// ---- Collect & describe all drawn shapes ----

/**
 * Fetch all drawn shapes (pen, highlight, arrow, geo, text, line) and process
 * them into a uniform array with page position, source lines, rendered text, etc.
 * Also includes math-note shapes for context building.
 */
async function collectDrawnShapes(docName) {
  const allRecords = await fetchShapes(docName);
  const shapes = [];

  for (const record of allRecords) {
    if (!record || record.typeName !== 'shape') continue;
    const id = record.id;
    const shapeType = record.type;
    const color = record.props?.color || 'black';
    const createdAt = record.meta?.createdAt || null;

    if (shapeType === 'draw' || shapeType === 'highlight') {
      const bbox = getDrawShapeBBox(record);
      if (!bbox) continue;
      const tool = shapeType === 'highlight' ? 'highlighter' : 'pen';
      const gesture = classifyGesture(bbox);
      const nearbyLines = findNearbyLines(docName, bbox);
      const pos = describePagePosition(docName, bbox);
      const rendered = getRenderedText(docName, bbox);
      // Magic highlighter metadata
      const highlightText = record.meta?.highlightText || null;
      const highlightLines = record.meta?.highlightLines || null;
      const sourceLine = record.meta?.sourceAnchor?.line || record.meta?.sourceLine || null;
      // Handwriting recognition metadata
      const transcription = record.meta?.transcription || null;
      const transcriptionVerified = record.meta?.transcriptionVerified || false;
      shapes.push({ id, shapeType: tool, color, gesture, page: pos.page, position: pos.description,
        bbox, lines: nearbyLines, rendered, createdAt, highlightText, highlightLines, sourceLine,
        transcription, transcriptionVerified });
      continue;
    }

    if (shapeType === 'arrow') {
      const ep = getArrowEndpoints(record);
      const bbox = getArrowBBox(record);
      if (!ep || !bbox) continue;
      const pdfStart = canvasToDoc(docName, ep.start.x, ep.start.y);
      const pdfEnd = canvasToDoc(docName, ep.end.x, ep.end.y);
      const startLines = findNearbyLines(docName, { minX: ep.start.x - 10, minY: ep.start.y - 10, maxX: ep.start.x + 10, maxY: ep.start.y + 10 });
      const endLines = findNearbyLines(docName, { minX: ep.end.x - 10, minY: ep.end.y - 10, maxX: ep.end.x + 10, maxY: ep.end.y + 10 });
      const label = record.props?.text || '';
      const startBound = record.props?.start?.boundShapeId || null;
      const endBound = record.props?.end?.boundShapeId || null;
      const rendered = getRenderedText(docName, bbox);
      const pos = describePagePosition(docName, bbox);
      shapes.push({
        id, shapeType: 'arrow', color, label, page: pos.page, position: pos.description, bbox,
        startPage: pdfStart.page, endPage: pdfEnd.page,
        startLines, endLines, startBound, endBound, rendered, createdAt,
      });
      continue;
    }

    if (shapeType === 'geo') {
      const bbox = getGeoBBox(record);
      if (!bbox) continue;
      const geo = record.props?.geo || 'rectangle';
      const nearbyLines = findNearbyLines(docName, bbox);
      const pos = describePagePosition(docName, bbox);
      const label = record.props?.text || '';
      const rendered = getRenderedText(docName, bbox);
      shapes.push({ id, shapeType: 'geo', geo, color, label, page: pos.page, position: pos.description,
        bbox, lines: nearbyLines, rendered, createdAt });
      continue;
    }

    if (shapeType === 'text') {
      const bbox = getTextBBox(record);
      const text = record.props?.text || '';
      if (!text.trim()) continue;
      const pos = describePagePosition(docName, bbox);
      const nearbyLines = findNearbyLines(docName, bbox);
      const rendered = getRenderedText(docName, bbox);
      shapes.push({ id, shapeType: 'text', color, text, page: pos.page, position: pos.description,
        bbox, lines: nearbyLines, rendered, createdAt });
      continue;
    }

    if (shapeType === 'line') {
      const handles = record.props?.handles;
      if (!handles) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const h of Object.values(handles)) {
        const ax = record.x + (h.x || 0);
        const ay = record.y + (h.y || 0);
        if (ax < minX) minX = ax;
        if (ay < minY) minY = ay;
        if (ax > maxX) maxX = ax;
        if (ay > maxY) maxY = ay;
      }
      if (!isFinite(minX)) continue;
      const bbox = { minX, minY, maxX, maxY };
      const nearbyLines = findNearbyLines(docName, bbox);
      const pos = describePagePosition(docName, bbox);
      const rendered = getRenderedText(docName, bbox);
      shapes.push({ id, shapeType: 'line', color, page: pos.page, position: pos.description,
        bbox, lines: nearbyLines, rendered, createdAt });
      continue;
    }

    if (shapeType === 'math-note') {
      const anchor = record.meta?.sourceAnchor;
      const text = record.props?.text || '';
      const page = anchor ? null : null; // will compute below
      let pos;
      if (record.x != null && record.y != null) {
        const fakeBBox = { minX: record.x, minY: record.y, maxX: record.x + 10, maxY: record.y + 10 };
        pos = describePagePosition(docName, fakeBBox);
      }
      shapes.push({
        id, shapeType: 'note', color, text,
        page: pos?.page || null, position: pos?.description || null,
        anchor: anchor ? `${anchor.file}:${anchor.line}` : null,
        anchorLine: anchor?.line || null,
        createdAt,
      });
      continue;
    }
  }

  return shapes;
}

/**
 * Build a per-page summary of shapes for context.
 * Returns a string like:
 *   Page 3: 4 marks (2 pen, 1 highlighter, 1 note)
 *   Page 7: 1 mark (1 arrow)
 */
function buildPageSummary(shapes) {
  const byPage = new Map();
  for (const s of shapes) {
    if (!s.page) continue;
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page).push(s);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const lines = [];
  for (const p of pages) {
    const group = byPage.get(p);
    const counts = {};
    for (const s of group) {
      const t = s.shapeType;
      counts[t] = (counts[t] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([t, n]) => `${n} ${t}`);
    lines.push(`Page ${p}: ${group.length} mark${group.length === 1 ? '' : 's'} (${parts.join(', ')})`);
  }
  return lines.join('\n');
}

/**
 * Cluster shapes by temporal + spatial proximity.
 *
 * Two shapes are in the same cluster if:
 *   - created within TIME_GAP_MS of each other, AND
 *   - on the same page (or within PAGE_DISTANCE pages)
 *
 * A new cluster starts when either the time gap or the page distance exceeds
 * the threshold. Shapes without createdAt go into a separate "undated" cluster.
 *
 * Returns clusters sorted newest-first, each with { shapes, minTime, maxTime, pages }.
 */
const CLUSTER_TIME_GAP_MS = 3 * 60 * 1000; // 3 minutes
const CLUSTER_PAGE_DISTANCE = 2;

function clusterShapes(shapes) {
  // Separate dated from undated
  const dated = shapes.filter(s => s.createdAt != null);
  const undated = shapes.filter(s => s.createdAt == null);

  // Sort by creation time
  dated.sort((a, b) => a.createdAt - b.createdAt);

  const clusters = [];
  let current = null;

  for (const s of dated) {
    if (!current) {
      current = { shapes: [s], minTime: s.createdAt, maxTime: s.createdAt, pages: new Set([s.page]) };
      continue;
    }

    const timeGap = s.createdAt - current.maxTime;
    const pageDistance = s.page != null ? Math.min(...[...current.pages].filter(p => p != null).map(p => Math.abs(p - s.page))) : 0;

    if (timeGap > CLUSTER_TIME_GAP_MS || (pageDistance > CLUSTER_PAGE_DISTANCE && timeGap > 30000)) {
      // Start new cluster — either big time gap, or moderate time gap + big spatial jump
      clusters.push(current);
      current = { shapes: [s], minTime: s.createdAt, maxTime: s.createdAt, pages: new Set([s.page]) };
    } else {
      current.shapes.push(s);
      current.maxTime = s.createdAt;
      if (s.page != null) current.pages.add(s.page);
    }
  }
  if (current) clusters.push(current);

  // Undated shapes as one cluster (legacy shapes without timestamps)
  if (undated.length > 0) {
    clusters.push({ shapes: undated, minTime: null, maxTime: null, pages: new Set(undated.map(s => s.page).filter(Boolean)) });
  }

  // Newest first
  clusters.sort((a, b) => (b.maxTime || 0) - (a.maxTime || 0));
  return clusters;
}

/** Format a cluster's age as a human-readable label. */
function describeClusterAge(cluster) {
  if (!cluster.maxTime) return 'undated';
  const age = Date.now() - cluster.maxTime;
  if (age < 60000) return 'just now';
  if (age < 3600000) return `${Math.round(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.round(age / 3600000)}h ago`;
  return `${Math.round(age / 86400000)}d ago`;
}

/**
 * Build a compact context string describing nearby shapes relative to a trigger shape.
 * Uses temporal clustering to group shapes into review passes.
 * Shows shapes on the same page and ±1 adjacent pages, excluding the trigger itself.
 */
function buildNearbyContext(allShapes, triggerShapeId, triggerPage) {
  const nearby = allShapes.filter(s =>
    s.id !== triggerShapeId && s.page != null && Math.abs(s.page - triggerPage) <= 1
  );
  if (nearby.length === 0) return '';

  const clusters = clusterShapes(nearby);
  const lines = [];

  for (const cluster of clusters.slice(0, 3)) {
    const age = describeClusterAge(cluster);
    const descriptions = [];
    for (const s of cluster.shapes.slice(0, 4)) {
      let desc = s.shapeType;
      if (s.lines?.length > 0) {
        desc += ` line ${s.lines[0].line}`;
      } else if (s.anchorLine) {
        desc += ` line ${s.anchorLine}`;
      }
      if (s.page !== triggerPage) desc += ` (p${s.page})`;
      descriptions.push(desc);
    }
    const extra = cluster.shapes.length > 4 ? ` +${cluster.shapes.length - 4} more` : '';
    lines.push(`  [${age}] ${descriptions.join(', ')}${extra}`);
  }
  const moreCount = clusters.length > 3 ? clusters.length - 3 : 0;
  let result = 'nearby:\n' + lines.join('\n');
  if (moreCount > 0) result += `\n  (+${moreCount} older groups)`;
  return result;
}

/** Format a single processed shape (from collectDrawnShapes) into detail lines. */
function formatShapeDetail(s) {
  let out = `${s.id}\n`;

  if (s.shapeType === 'pen' || s.shapeType === 'highlighter') {
    const sentiment = s.shapeType === 'highlighter' ? 'attention' : 'correction';
    out += `  ${s.shapeType} (${s.color}) → ${s.gesture} [${sentiment}]\n`;
    out += `  ${s.position}\n`;
    if (s.lines?.length > 0) {
      const lineRange = s.lines.length === 1
        ? `line ${s.lines[0].line}`
        : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
      out += `  covers ${lineRange}\n`;
      out += `  first: "${s.lines[0].content}"\n`;
      if (s.lines.length > 1) out += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
    } else {
      out += `  (no matching document lines)\n`;
    }
    if (s.rendered) out += `  rendered: "${s.rendered}"\n`;
  }

  else if (s.shapeType === 'arrow') {
    out += `  arrow (${s.color})`;
    if (s.label) out += ` label: "${s.label}"`;
    out += '\n';
    if (s.startLines?.length > 0) {
      out += `  from: page ${s.startPage}, line ${s.startLines[0].line} "${s.startLines[0].content}"\n`;
    } else if (s.startBound) {
      out += `  from: ${s.startBound}\n`;
    } else {
      out += `  from: page ${s.startPage} (no matching line)\n`;
    }
    if (s.endLines?.length > 0) {
      out += `  to:   page ${s.endPage}, line ${s.endLines[0].line} "${s.endLines[0].content}"\n`;
    } else if (s.endBound) {
      out += `  to:   ${s.endBound}\n`;
    } else {
      out += `  to:   page ${s.endPage} (no matching line)\n`;
    }
    if (s.rendered) out += `  rendered: "${s.rendered}"\n`;
  }

  else if (s.shapeType === 'geo') {
    out += `  ${s.geo} (${s.color})`;
    if (s.label) out += ` label: "${s.label}"`;
    out += '\n';
    out += `  ${s.position}\n`;
    if (s.lines?.length > 0) {
      const lineRange = s.lines.length === 1
        ? `line ${s.lines[0].line}`
        : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
      out += `  encloses ${lineRange}\n`;
      out += `  first: "${s.lines[0].content}"\n`;
      if (s.lines.length > 1) out += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
    } else {
      out += `  (no matching document lines)\n`;
    }
    if (s.rendered) out += `  rendered: "${s.rendered}"\n`;
  }

  else if (s.shapeType === 'text') {
    out += `  text (${s.color}): "${s.text}"\n`;
    out += `  ${s.position}\n`;
    if (s.lines?.length > 0) {
      out += `  near line ${s.lines[0].line}: "${s.lines[0].content}"\n`;
    }
    if (s.rendered) out += `  rendered: "${s.rendered}"\n`;
  }

  else if (s.shapeType === 'line') {
    out += `  line (${s.color})\n`;
    out += `  ${s.position}\n`;
    if (s.lines?.length > 0) {
      const lineRange = s.lines.length === 1
        ? `line ${s.lines[0].line}`
        : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
      out += `  covers ${lineRange}\n`;
      out += `  first: "${s.lines[0].content}"\n`;
      if (s.lines.length > 1) out += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
    }
    if (s.rendered) out += `  rendered: "${s.rendered}"\n`;
  }

  else if (s.shapeType === 'note') {
    out += `  note (${s.color})`;
    if (s.anchor) out += ` at ${s.anchor}`;
    out += '\n';
    if (s.text) out += `  "${s.text.slice(0, 80)}${s.text.length > 80 ? '...' : ''}"\n`;
  }

  return out;
}

// ---- Signal writers ----

function writeAgentAttention(docName, x, y, agent) {
  broadcastSignalRest(docName, 'signal:agent-attention', { x, y, timestamp: Date.now(), agent })
    .catch(e => console.warn('[Attention] Failed to write:', e.message));
}

function writeAgentHeartbeat(docName, state, agent) {
  broadcastSignalRest(docName, 'signal:agent-heartbeat', { state, timestamp: Date.now(), agent })
    .catch(e => console.warn('[Heartbeat] Failed to write:', e.message));
}

function generateShapeId() {
  return 'shape:' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

/**
 * Encode an array of {x, y, z} points into TLDraw v4's base64 delta-encoded path format.
 * First point: 3x Float32 LE (12 bytes). Subsequent: 3x Float16 LE deltas (6 bytes each).
 */
function encodeB64Path(points) {
  if (points.length === 0) return '';
  const firstBytes = 12;
  const deltaBytes = (points.length - 1) * 6;
  const buf = Buffer.alloc(firstBytes + deltaBytes);

  // First point: Float32 LE
  buf.writeFloatLE(points[0].x, 0);
  buf.writeFloatLE(points[0].y, 4);
  buf.writeFloatLE(points[0].z ?? 0.5, 8);

  // Subsequent points: Float16 LE deltas
  let prevX = points[0].x, prevY = points[0].y, prevZ = points[0].z ?? 0.5;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prevX;
    const dy = points[i].y - prevY;
    const dz = (points[i].z ?? 0.5) - prevZ;
    const off = 12 + (i - 1) * 6;
    buf.writeUInt16LE(toFloat16(dx), off);
    buf.writeUInt16LE(toFloat16(dy), off + 2);
    buf.writeUInt16LE(toFloat16(dz), off + 4);
    // Advance prev using decoded values (to match decoder's accumulated rounding)
    prevX += float16(toFloat16(dx));
    prevY += float16(toFloat16(dy));
    prevZ += float16(toFloat16(dz));
  }
  return buf.toString('base64');
}

/** Encode a JavaScript number to IEEE 754 half-precision (16 bits). */
function toFloat16(value) {
  if (value === 0) return 0;
  if (!isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00;
  const sign = value < 0 ? 1 : 0;
  value = Math.abs(value);
  // Clamp to float16 range
  if (value > 65504) return sign ? 0xfc00 : 0x7c00;
  if (value < 5.96e-8) return sign << 15; // underflow to zero
  const log2 = Math.log2(value);
  let exp = Math.floor(log2);
  let frac = value / Math.pow(2, exp) - 1;
  if (exp < -14) {
    // Subnormal
    frac = value / Math.pow(2, -14);
    return (sign << 15) | Math.round(frac * 1024);
  }
  exp += 15;
  if (exp >= 31) return sign ? 0xfc00 : 0x7c00;
  return (sign << 15) | (exp << 10) | Math.round(frac * 1024);
}

// ---- Shared action functions (used by both HTTP and MCP) ----

async function scrollToLine(doc, line, file) {
  // For markdown/HTML docs: use element ID scrolling (no synctex lookup)
  const linePos = lookupLine(doc, line, file);
  if (!linePos) {
    // Try element-based scroll for markdown docs
    const elementId = `line-${line}`;
    try {
      await broadcastSignalRest(doc, 'signal:scroll-to-element', {
        id: elementId, timestamp: Date.now(),
      });
      return { ok: true, elementId, method: 'scroll-to-element' };
    } catch (e) {
      return { ok: false, error: `Line ${line}${file ? ' in ' + path.basename(file) : ''} not found in lookup.json for doc "${doc}". Element scroll also failed: ${e.message}` };
    }
  }

  const canvasPos = docToCanvas(doc, linePos.page, linePos.x, linePos.y);

  try {
    await broadcastSignalRest(doc, 'signal:forward-scroll', {
      x: canvasPos.x, y: canvasPos.y, timestamp: Date.now(),
    });
  } catch (e) {
    broadcast({ type: 'scroll', x: canvasPos.x, y: canvasPos.y });
  }

  return { ok: true, page: linePos.page, x: canvasPos.x, y: canvasPos.y };
}

async function highlightLine(doc, file, line) {
  // If no doc given, infer from manifest texFile paths
  if (!doc) {
    const manifest = readManifestSync();
    if (manifest?.documents) {
      for (const [name, entry] of Object.entries(manifest.documents)) {
        if (entry.texFile && file.includes(path.basename(entry.texFile, '.tex'))) {
          doc = name;
          break;
        }
      }
    }
    if (!doc) doc = path.basename(file, '.tex');
  }

  async function sendHighlightSignal(x, y, page) {
    try {
      await broadcastSignalRest(doc, 'signal:forward-highlight', {
        x, y, page, timestamp: Date.now(),
      });
    } catch {
      broadcastHighlight(x, y, page);
    }
  }

  const linePos = lookupLine(doc, line, file);
  if (linePos) {
    const canvasPos = docToCanvas(doc, linePos.page, linePos.x, linePos.y);
    await sendHighlightSignal(canvasPos.x, canvasPos.y, linePos.page);
    return { ok: true, page: linePos.page, x: canvasPos.x, y: canvasPos.y };
  }

  // Fall back to synctex-reverse.mjs
  try {
    const result = execSync(
      `node "${path.join(PROJECT_ROOT, 'synctex-reverse.mjs')}" "${file}" ${line}`,
      { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const jsonMatch = result.match(/JSON: ({.*})/);
    if (jsonMatch) {
      const coords = JSON.parse(jsonMatch[1]);
      await sendHighlightSignal(coords.tldrawX, coords.tldrawY, coords.page);
      return { ok: true, page: coords.page, x: coords.tldrawX, y: coords.tldrawY };
    }
  } catch (e) { process.stderr.write(`[mcp] synctex flash lookup failed: ${e.message}\n`); }

  return { ok: false, error: `Line ${line} not found in lookup or synctex` };
}

/**
 * Parse a markdown options file into { text, choices } for an `add_note`
 * call. Each H2 (`## Label`) becomes a choice; the label is everything after
 * `## ` on that line, and the body (until the next H2 or EOF) becomes that
 * option's preview content. The combined `text` stacks every option header +
 * body so the math note renders all options inline, while `choices` provides
 * the tappable button labels.
 *
 * Supports inline `$math$` and display `$$math$$` since the math-note render
 * path uses the same KaTeX pipeline as the document.
 *
 * @param {string} filepath — absolute, ~-prefixed, or cwd-relative
 * @returns {{ text: string, choices: string[] }}
 * @throws if the file is missing or contains no H2 sections
 */
function parseOptionsFile(filepath) {
  let resolved = filepath
  if (resolved.startsWith('~/')) resolved = path.join(os.homedir(), resolved.slice(2))
  if (!path.isAbsolute(resolved)) resolved = path.resolve(process.cwd(), resolved)
  if (!fs.existsSync(resolved)) throw new Error(`options file not found: ${resolved}`)

  const raw = fs.readFileSync(resolved, 'utf8')
  const lines = raw.split('\n')

  /** @type {Array<{ label: string, body: string[] }>} */
  const sections = []
  let current = null
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.+?)\s*$/)
    if (m) {
      if (current) sections.push(current)
      current = { label: m[1], body: [] }
    } else if (current) {
      current.body.push(ln)
    }
    // Lines before the first H2 are ignored.
  }
  if (current) sections.push(current)
  if (sections.length === 0) {
    throw new Error(`no \`## Option\` sections found in ${resolved}`)
  }

  const text = sections
    .map(s => `**${s.label}**\n${s.body.join('\n').trim()}`)
    .join('\n\n')
  const choices = sections.map(s => s.label)
  return { text, choices }
}

// Size presets for math notes. Agents pass `size: 'sm'|'md'|'lg'|'a5'`
// instead of guessing pixel dimensions. Explicit `width`/`height` still
// override. Default is 'md' (paragraph + math) — the old 200×150 was too
// cramped for typical content. options_file path bumps to 'lg' since
// multi-section notes are inherently bigger.
const SIZE_PRESETS = {
  sm: { width: 250, height: 100 },
  md: { width: 450, height: 200 },
  lg: { width: 650, height: 400 },
  a5: { width: 559, height: 794 }, // A5 at 96dpi (148×210mm)
}

function resolveSize({ size, width, height }) {
  const preset = (size && SIZE_PRESETS[size]) || SIZE_PRESETS.md
  return {
    width: typeof width === 'number' ? width : preset.width,
    height: typeof height === 'number' ? height : preset.height,
  }
}

// Note staging now lives in the shared lib (mcp-server/lib/annotate.mjs) so the
// drill teacher bot stages notes through the same code path — one source of
// truth. This stays a thin wrapper pinned to TLDA_SYNC_SERVER (the room target).
async function addAnnotation(doc, line, text, opts = {}) {
  return stageNote(doc, line, text, { ...opts, server: TLDA_SYNC_SERVER });
}

async function sendNote(doc, line, text, color = 'orange', file, choices) {
  // Create persistent math-note via Yjs — syncs to all viewers automatically
  const result = await addAnnotation(doc, line, text, { color, file, choices });
  if (!result.ok) return result;

  // Also scroll viewer to the note location
  await scrollToLine(doc, line, file);

  return { ok: true, shapeId: result.shapeId, page: result.page, x: result.x, y: result.y };
}

async function listAnnotations(doc) {
  const shapes = await fetchShapes(doc, 'math-note');
  const annotations = [];

  for (const record of shapes) {
    if (!record || record.type !== 'math-note') continue;
    const anchor = record.meta?.sourceAnchor;
    // Document position: prefer the stored source anchor; otherwise derive the
    // line from the note's canvas position (canvas → tex mapping), the same way
    // drawn shapes resolve their line. A note with no derivable line stays null.
    let line = anchor?.line ?? null;
    if (line == null && record.x != null && record.y != null) {
      const fakeBBox = { minX: record.x, minY: record.y, maxX: record.x + 10, maxY: record.y + 10 };
      const nearby = findNearbyLines(doc, fakeBBox);
      line = nearby?.[0]?.line ?? null;
    }
    const ann = {
      id: record.id,
      x: Math.round(record.x || 0),
      y: Math.round(record.y || 0),
      color: record.props?.color,
      text: record.props?.text || '',
      anchor: anchor ? `${anchor.file}:${anchor.line}` : null,
      content: anchor?.content || null,
      line,
      createdAt: record.meta?.createdAt ?? null,
    };
    if (record.props?.choices?.length) {
      ann.choices = record.props.choices;
      ann.selectedChoice = record.props.selectedChoice ?? -1;
    }
    // Tab info (single-shape threading)
    const tabs = record.props?.tabs;
    if (tabs && tabs.length > 1) {
      ann.tabCount = tabs.length;
      ann.activeTab = record.props?.activeTab || 0;
      ann.tabs = tabs;
    }
    annotations.push(ann);
  }

  return { ok: true, annotations };
}

async function replyAnnotation(doc, id, text) {
  const fullId = id.startsWith('shape:') ? id : `shape:${id}`;
  let record;
  try {
    record = await fetchShape(doc, fullId);
  } catch {
    return { ok: false, error: `Annotation not found: ${fullId}` };
  }

  // Single-shape tab model: add a tab to the existing shape
  const currentTabs = record.props?.tabs || [record.props?.text || ''];
  const activeTab = record.props?.activeTab || 0;

  // Save current text into current tab slot, then add new tab
  const updatedTabs = [...currentTabs];
  updatedTabs[activeTab] = record.props?.text || '';
  updatedTabs.push(text);
  const newActiveTab = updatedTabs.length - 1;

  await updateShapeRest(doc, fullId, {
    props: {
      ...record.props,
      tabs: updatedTabs,
      activeTab: newActiveTab,
      text: text,
    },
  });

  return { ok: true, id: fullId, tabIndex: newActiveTab, tabCount: updatedTabs.length };
}

async function deleteAnnotation(doc, id) {
  const fullId = id.startsWith('shape:') ? id : `shape:${id}`;
  try {
    await deleteShapeRest(doc, fullId);
    return { ok: true, id: fullId };
  } catch (e) {
    if (e.message.includes('404')) return { ok: false, error: `Annotation not found: ${fullId}` };
    throw e;
  }
}

// Track snapshot state
let lastSnapshotTime = 0;
let waitingResolvers = [];
let lastRenderOutput = ''; // Capture viewer output for MCP tools

// Render snapshot to screenshot
async function renderSnapshot() {
  return new Promise((resolve, reject) => {
    const viewer = spawn('node', [path.join(PROJECT_ROOT, 'view-snapshot.mjs')], {
      cwd: PROJECT_ROOT,
    });

    let output = '';
    viewer.stdout.on('data', (data) => output += data);
    viewer.stderr.on('data', (data) => output += data);

    viewer.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Viewer exited with code ${code}: ${output}`));
      }
    });
  });
}

// HTTP server for receiving snapshots
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /health — service status + available docs
  if (req.method === 'GET' && req.url === '/health') {
    let docs = {};
    const manifest = readManifestSync();
    if (manifest?.documents) docs = manifest.documents;

    const status = {
      ok: true,
      http: { port: HTTP_PORT },
      websocket: { port: WS_PORT, clients: wsClients.size },
      sync: { server: TLDA_SYNC_SERVER, docAssets: TLDA_SERVER },
      docs: Object.fromEntries(
        Object.entries(docs).map(([name, config]) => [name, {
          name: config.name,
          pages: config.pages,
          format: config.format || 'svg',
        }])
      ),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (req.method === 'POST' && req.url === '/snapshot') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        fs.writeFileSync(SNAPSHOT_PATH, body);
        lastSnapshotTime = Date.now();

        // Auto-render and capture output
        try {
          lastRenderOutput = await renderSnapshot();
          fs.writeFileSync('/tmp/tldraw-render-output.txt', lastRenderOutput);
        } catch (e) {
          lastRenderOutput = `Render error: ${e.message}`;
          fs.writeFileSync('/tmp/tldraw-render-output.txt', lastRenderOutput);
        }

        // Notify any waiting resolvers
        const resolvers = waitingResolvers;
        waitingResolvers = [];
        resolvers.forEach(resolve => resolve());

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Viewport screenshot from frontend ping
  if (req.method === 'POST' && req.url === '/viewport-screenshot') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(SCREENSHOT_PATH, buf);
        console.error(`[Screenshot] Saved ${buf.length} bytes to ${SCREENSHOT_PATH}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: buf.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: just scroll (no marker)
  if (req.method === 'POST' && req.url === '/scroll') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y } = JSON.parse(body);
        const message = JSON.stringify({ type: 'scroll', x, y });
        for (const client of wsClients) {
          if (client.readyState === 1) client.send(message);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: highlight a location in TLDraw
  if (req.method === 'POST' && req.url === '/highlight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y, page } = JSON.parse(body);
        console.error(`Highlighting: page ${page}, coords (${x}, ${y})`);
        broadcastHighlight(x, y, page);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: send a note (text) to TLDraw
  if (req.method === 'POST' && req.url === '/note') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y, text } = JSON.parse(body);
        console.error(`Note at (${x}, ${y}): ${text.slice(0, 50)}...`);
        broadcastNote(x, y, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: reply to an existing note
  if (req.method === 'POST' && req.url === '/reply') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shapeId, text } = JSON.parse(body);
        console.error(`Reply to ${shapeId}: ${text.slice(0, 50)}...`);
        broadcastReply(shapeId, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ---- Line-level endpoints (shared logic with MCP tools) ----

  // POST /scroll-to-line { doc, line }
  if (req.method === 'POST' && req.url === '/scroll-to-line') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, line } = JSON.parse(body);
        const result = await scrollToLine(doc, line);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /highlight-line { doc, file, line }
  if (req.method === 'POST' && req.url === '/highlight-line') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, file, line } = JSON.parse(body);
        const result = await highlightLine(doc, file, line);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /send-note { doc, line, text, color? }
  if (req.method === 'POST' && req.url === '/send-note') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, line, text, color } = JSON.parse(body);
        const result = await sendNote(doc, line, text, color);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /add-annotation { doc, line, text, color?, width?, height?, side? }
  if (req.method === 'POST' && req.url === '/add-annotation') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, line, text, color, width, height, side } = JSON.parse(body);
        const result = await addAnnotation(doc, line, text, { color, width, height, side });
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /reply-annotation { doc, id, text }
  if (req.method === 'POST' && req.url === '/reply-annotation') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, id, text } = JSON.parse(body);
        const result = await replyAnnotation(doc, id, text);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /delete-annotation { doc, id }
  if (req.method === 'POST' && req.url === '/delete-annotation') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { doc, id } = JSON.parse(body);
        const result = await deleteAnnotation(doc, id);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /annotations?project=<name>
  if (req.method === 'GET' && req.url?.startsWith('/annotations')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const project = url.searchParams.get('project');
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: project' }));
      return;
    }
    try {
      const result = await listAnnotations(project);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /shapes?project=<name> — read all shapes from sync room + signals from Yjs
  if (req.method === 'GET' && req.url?.startsWith('/shapes')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const projectName = url.searchParams.get('project');
    if (!projectName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: project' }));
      return;
    }
    try {
      // Shapes from @tldraw/sync room via REST
      const records = await fetchShapes(projectName);
      const shapes = records.filter(r => r.id?.startsWith('shape:') || r.id?.startsWith('binding:'));

      // Signals from cache (no longer in Yjs)
      const signals = {};

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ shapes, signals, total: shapes.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Start HTTP server (skip if port in use — collab mode may already have it)
const HTTP_PORT = 5174;
let httpRunning = false;
if (!FLEET_ONLY_MCP) {
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${HTTP_PORT} in use — skipping HTTP server (collab instance likely running)`);
      return;
    }
    throw err;
  });
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    httpRunning = true;
    console.error(`Feedback HTTP server running on port ${HTTP_PORT}`);
  });
}

// WebSocket server for forward sync (Claude → iPad)
const WS_PORT = 5175;
let wss = null;
const wsClients = new Set();

if (!FLEET_ONLY_MCP) {
  try {
    wss = new WebSocketServer({ port: WS_PORT });
    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${WS_PORT} in use — skipping WebSocket server (collab instance likely running)`);
        wss = null;
        return;
      }
      throw err;
    });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Port ${WS_PORT} in use — skipping WebSocket server`);
    } else {
      throw err;
    }
  }
}

if (wss) {
  wss.on('connection', (ws) => {
    console.error('TLDraw client connected via WebSocket');
    wsClients.add(ws);

    ws.on('close', () => {
      wsClients.delete(ws);
      console.error('TLDraw client disconnected');
    });
    ws.on('error', (err) => {
      console.error('TLDraw client WebSocket error:', err.message);
      wsClients.delete(ws);
    });
  });

  console.error(`WebSocket server running on port ${WS_PORT}`);
}

// Send a WebSocket message to connected viewers, or proxy via HTTP if no local WS
function broadcast(message) {
  const msg = typeof message === 'object' ? JSON.stringify(message) : message;
  if (wsClients.size > 0) {
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      } else if (client.readyState > 1) {
        // CLOSING or CLOSED — clean up zombie
        wsClients.delete(client);
      }
    }
  } else if (!httpRunning) {
    // Proxy to collab instance's HTTP raw endpoint
    const data = typeof message === 'object' ? message : JSON.parse(message);
    const endpoint = `/${data.type}`; // /scroll, /highlight, /note, /reply
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: 'localhost', port: HTTP_PORT, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', (err) => {
      console.error(`[broadcast] HTTP proxy error: ${err.message}`);
    });
    req.end(body);
  }
}

function broadcastHighlight(tldrawX, tldrawY, page) {
  broadcast({ type: 'highlight', x: tldrawX, y: tldrawY, page });
}

function broadcastNote(tldrawX, tldrawY, text) {
  broadcast({ type: 'note', x: tldrawX, y: tldrawY, text });
}

function broadcastReply(shapeId, text) {
  broadcast({ type: 'reply', shapeId, text });
}

// MCP Server
const SERVER_CAPABILITIES = { tools: {} };
if ((process.env.FLEET_HARNESS || '').toLowerCase() === 'claude') {
  SERVER_CAPABILITIES.experimental = {
    'claude/channel': {},
  };
}

const server = new Server(
  { name: 'tlda', version: '1.0.0' },
  {
    capabilities: SERVER_CAPABILITIES,
    instructions: TLDA_INSTRUCTIONS,
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: FLEET_ONLY_MCP ? getFleetTools() : [
    {
      name: 'screenshot',
      description: 'Capture an image of part of the viewer. Specify a target — viewport (current scroll position), screen (the user\'s entire visible area), an annotation region (via screenshotRef from a read_annotations result), or explicit canvas bounds. Always passes through the viewer\'s capture mechanism. There is no default — pick a target intentionally.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          target: {
            type: 'string',
            enum: ['viewport', 'screen'],
            description: '"viewport" = the document area currently scrolled into view. "screen" = the user\'s entire visible viewport including UI chrome.',
          },
          ref: {
            type: 'string',
            description: 'Screenshot ref from an annotation attachment (format: "tlda-screenshot:page:page:x,y,w,h"). Captures that region.',
          },
          page: {
            type: 'number',
            description: 'Page number to scroll to before capturing. Used with target="viewport".',
          },
          x: { type: 'number', description: 'Canvas X of crop region (with y, w, h — explicit bounds capture).' },
          y: { type: 'number', description: 'Canvas Y of crop region.' },
          w: { type: 'number', description: 'Width of crop region.' },
          h: { type: 'number', description: 'Height of crop region.' },
          padding: { type: 'number', description: 'Extra pixels around the region (default: 200). Applied to ref or x/y/w/h captures.' },
          shapeId: { type: 'string', description: 'Shape ID of target annotation — other annotations desaturated to make this one stand out.' },
          shapeTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Render ONLY shapes of these types and frame them (e.g. ["fleet-chat"] to capture the fleet chat). The document pages are not rendered unless you include "svg-page" — this is also what makes the capture fast. Combine with shapeIds.',
          },
          shapeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Render ONLY these specific shapes (by id) and frame them. Combine with shapeTypes.',
          },
        },
        required: ['doc'],
      },
    },
    {
      name: 'add_note',
      description: 'Add a math note annotation to the document at a specific source line. The note appears in the TLDraw canvas and syncs to all viewers. Supports @label cross-references (e.g. @thm:bias-decomp) — broken refs are reported in the response. For multiple-choice options with long LaTeX content, prefer `options_file` over inline `text`+`choices` — the file format avoids escaping pain and gives the options a durable artifact.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to anchor the note to. Required unless page is given.' },
          page: { type: 'number', description: 'Page number to place the note on (use when no source line is available).' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$). Required unless `options_file` or `file` is given.' },
          text_anchor: { type: 'string', description: 'Specific text to anchor near (uses synctex to position near rendered text)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: orange). Convention: orange=claude, green=todd, violet=user.' },
          size: { type: 'string', enum: ['sm', 'md', 'lg', 'a5'], description: 'Size preset: sm (250×100, one-line), md (450×200, default — paragraph + math), lg (650×400, multi-paragraph / derivations), a5 (559×794, A5 paper). options_file defaults to lg.' },
          width: { type: 'number', description: 'Explicit width in pixels (overrides size preset).' },
          height: { type: 'number', description: 'Explicit height in pixels (overrides size preset).' },
          side: { type: 'string', description: 'Place note to "left" or "right" of page (default: right)' },
          file: { type: 'string', description: 'Path to a file whose content becomes the note text. Also used as source file path for multi-file projects (e.g. "appendix.tex").' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Multiple-choice options rendered as tappable buttons. User selection readable via read_annotations. Mutually exclusive with `options_file`.' },
          options_file: { type: 'string', description: 'Path to a markdown file whose `## Label` H2 sections become the choices. Each section body (LaTeX, prose, $math$, $$display$$) becomes that option\'s preview content. Renders with the document preamble macros — what you see is what gets pasted. Supports absolute paths, ~/ expansion, and cwd-relative paths.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'read_doc',
      description: 'Read a tlda document\'s SOURCE (read-only) — document- and version-aware. Resolves the doc name to its source file and reads a paginated line window (default 400 lines). Pass `version` (a git hash) to read a PAST version from the doc\'s history, or `ref` (a label/theorem number like "thm:main" or "2.1") to jump straight to that location. Header reports the window + total lines, with a hint to page. For annotations use read_annotations.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman").' },
          file: { type: 'string', description: 'Source file within the doc (default: the doc\'s main file).' },
          startLine: { type: 'number', description: '1-based start line for a plain read (optional).' },
          endLine: { type: 'number', description: 'Explicit end line (optional; otherwise a window of `lines` is read).' },
          lines: { type: 'number', description: 'Window height: how many lines to read (default 400 for a plain read, 80 for a ref).' },
          version: { type: 'string', description: 'Git hash to read a past version of the source (optional).' },
          ref: { type: 'string', description: 'Label or theorem number to jump to, e.g. "thm:main" or "2.1" (optional).' },
          before: { type: 'number', description: 'With `ref`: how many lines above the anchor to start (default 3).' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'read_annotations',
      description: 'Read all annotations in a document: math notes, highlighter strokes, pen strokes, arrows, rectangles/ellipses. Returns formatted text with highlighted regions marked using ⟦⟧ brackets. Sorted by document position (default) or time.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          type: {
            type: 'array',
            items: { type: 'string', enum: ['note', 'highlight', 'draw', 'arrow', 'geo', 'text', 'line'] },
            description: 'Filter by annotation type(s). Omit to list all types.',
          },
          sort: { type: 'string', enum: ['document', 'time'], description: 'Sort order: "document" (by page/line, default) or "time" (newest first)' },
          since: { type: 'number', description: 'Only return annotations created in the last N minutes' },
          startLine: { type: 'number', description: 'Only return annotations at or after this source line' },
          endLine: { type: 'number', description: 'Only return annotations at or before this source line' },
          unaddressed_only: { type: 'boolean', description: 'Only return unaddressed annotations (where meta.addressed is not true). Default: false.' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'reply_note',
      description: 'Reply to a note by appending text to it. Adds a separator and the reply text below the existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          id: { type: 'string', description: 'Shape ID to reply to (e.g. "shape:abc123")' },
          text: { type: 'string', description: 'Reply text (supports $math$)' },
        },
        required: ['doc', 'id', 'text'],
      },
    },
    {
      name: 'delete_annotation',
      description: 'Delete an annotation by its shape ID.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          id: { type: 'string', description: 'Shape ID (e.g. "shape:abc123")' },
        },
        required: ['doc', 'id'],
      },
    },
    {
      name: 'draw_highlight',
      description: 'Draw a highlighter stroke over source lines on the canvas. Creates a visible highlight mark (like a physical highlighter) spanning the given line range.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          startLine: { type: 'number', description: 'First source line to highlight' },
          endLine: { type: 'number', description: 'Last source line to highlight (same as startLine for single line). Optional when text is provided.' },
          color: { type: 'string', description: 'Highlight color: yellow, light-blue, light-green, light-violet, light-red, orange (default: orange)' },
          file: { type: 'string', description: 'Source file path or name (for multi-file projects). Omit for main file.' },
          text: { type: 'string', description: 'Specific text to highlight (substring from the source). When provided, highlights just this text instead of full lines. startLine is used as a hint for where to search.' },
        },
        required: ['doc', 'startLine'],
      },
    },
    {
      name: 'draw_arrow',
      description: 'Draw a curved arrow on the canvas connecting two source locations. The arrow bends through the margin so it does not obscure the text. Use for cross-references, connecting related passages, or pointing from a note to a specific location.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          fromLine: { type: 'number', description: 'Source line where the arrow starts' },
          toLine: { type: 'number', description: 'Source line where the arrow ends' },
          label: { type: 'string', description: 'Optional text label on the arrow' },
          color: { type: 'string', description: 'Arrow color: red, blue, green, violet, orange, yellow, black (default: orange)' },
          file: { type: 'string', description: 'Source file for fromLine (for multi-file projects). Omit for main file.' },
          toFile: { type: 'string', description: 'Source file for toLine (if different from file). Omit if same file.' },
          side: { type: 'string', enum: ['left', 'right'], description: 'Which margin to place the arrow in (default: left)' },
        },
        required: ['doc', 'fromLine', 'toLine'],
      },
    },
    {
      name: 'set_understanding',
      description: 'Set understanding map status for a range of source lines. Used to pre-populate understanding from provenance (e.g. mark author lines as "understood") or to record reading progress.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name' },
          startLine: { type: 'number', description: 'First source line' },
          endLine: { type: 'number', description: 'Last source line' },
          status: { type: 'string', enum: ['approved', 'understood', 'unchecked'], description: 'Understanding status' },
          userId: { type: 'string', description: 'User ID (defaults to FLEET_ID env)' },
          displayName: { type: 'string', description: 'Display name (defaults to FLEET_NAME env)' },
          reason: { type: 'string', description: 'Short reason for this check, stored on the segment' },
          method: { type: 'string', description: 'Short check method/source, e.g. review, proof-pass, self-check' },
          taskId: { type: 'string', description: 'Optional fleet task ID that prompted this check' },
          eventId: { type: 'string', description: 'Optional fleet event/message ID linked to this check' },
          file: { type: 'string', description: 'Source file path or name for the range. Omit for main file.' },
        },
        required: ['doc', 'startLine', 'endLine', 'status'],
      },
    },
    {
      name: 'get_understanding',
      description: 'Get the understanding map for a document — all users\' line-level statuses.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'scroll_to_line',
      description: 'Scroll the viewer to a source line. DISRUPTIVE — moves the user\'s viewport. Prefer mentioning a label or line number in chat (auto-links to hoverable reference). Only use scroll_to_line when the user explicitly asks to be shown something.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to scroll to' },
          file: { type: 'string', description: 'Source file path or name (for multi-file projects, e.g. "appendix.tex"). Omit for main file.' },
        },
        required: ['doc', 'line'],
      },
    },
    {
      name: 'set_chat_target',
      description: 'Change which agent a fleet chat panel targets. Used for hands-free layout — Skip says "give me historian" and the agent calls this to reconfigure the panel. Pass chatShapeId from the message context to target the specific panel the user is chatting in.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (room for the signal)' },
          agent: { type: 'string', description: 'Agent friendly name or fleet ID to target (e.g. "historian", "fleet:e7175365")' },
          chatShapeId: { type: 'string', description: 'Shape ID of the chat panel to update (from message context.chatShapeId). Targets the exact panel the user spoke in.' },
          panel: { type: 'string', description: 'Fallback: "left" or "right" (by canvas x-position). Use chatShapeId instead when available.' },
        },
        required: ['doc', 'agent'],
      },
    },
    {
      name: 'doc_version',
      description: 'List the history of a document. Each successful build becomes a version. Returns recent versions with their hash and timestamp, or the version active at a given time.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          timestamp: { type: 'number', description: 'Unix ms timestamp — returns the version active at that time (latest version before). Omit to list all recent versions.' },
          limit: { type: 'number', description: 'Max entries to return (default: 20)' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'build',
      description: 'Trigger a build (LaTeX/markdown compilation) for a tlda document. If a build is already in progress, polls and returns its status instead of triggering a new one. Returns build status including any errors.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Project/document name in tlda' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'push',
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
      name: 'lookup_theorem',
      description: 'Look up any labeled item in a tlda document — theorems, lemmas, equations, sections, figures, etc. Query by number ("4.3", "B.2") or label ("thm:rate-main", "eq:modulus-as-dual", "sec:intro"). Returns label, type, number, page, source line, and title.',
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
      name: 'input_scratch',
      description: 'Inject a scratch section into a document at a specific location. Use this ONCE to place a new scratch section. After placement, edit your scratch file directly — the watcher detects changes and rebuilds automatically. Never create version-suffixed files (v2, v3); git handles versioning. Never write to .tlda/ directly. Accepts .tex or .md/.qmd. Write plain content — no \\begin{scratch} wrapper. Requires exactly one of: after, before, replace. If the build fails, you will receive an automatic fleet chat with the LaTeX errors.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          content_path: { type: 'string', description: 'Local path to .tex or .md/.qmd file containing the scratch content. Markdown files are preserved as-is and converted at build time.' },
          label: { type: 'string', description: 'Label for this scratch section. Convention: "scratch:descriptive-name" (e.g. "scratch:thm-bias-alt"). Used for cross-referencing and as the visible header.' },
          after: { type: 'string', description: 'Insert after this existing label (e.g. "thm:bias-decomp") or "line:N". Exclusive with before/replace.' },
          before: { type: 'string', description: 'Insert before this existing label or "line:N". Exclusive with after/replace.' },
          replace: { type: 'string', description: 'Label of an existing scratch section to overwrite in-place. Content is replaced; the \\inputscratch{} in main.tex stays. Exclusive with after/before.' },
        },
        required: ['doc', 'content_path', 'label'],
      },
    },
    {
      name: 'inline_scratch',
      description: 'Promote a polished scratch section into the document proper. Replaces the \\inputscratch{}{}{} line in main.tex with the raw content from the scratch file. Use this when a scratch section is ready to become real document content.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          label: { type: 'string', description: 'Label of the scratch section to inline (same label used when it was created with input_scratch)' },
        },
        required: ['doc', 'label'],
      },
    },
    {
      name: 'extract_to_scratch',
      description: 'Extract a range of source lines from the document into a markdown scratch note. Converts LaTeX to markdown via pandoc (\\ref{} → @label). Creates a backed math note on the canvas at the extracted region, and writes the .md file to the scratch directory.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name' },
          startLine: { type: 'number', description: 'First source line to extract' },
          endLine: { type: 'number', description: 'Last source line to extract' },
          name: { type: 'string', description: 'Name for the scratch file (e.g. "bias-rework"). Creates scratch/{name}.md' },
          file: { type: 'string', description: 'Source file (for multi-file projects). Omit for main file.' },
        },
        required: ['doc', 'startLine', 'endLine', 'name'],
      },
    },
    {
      name: 'set_preamble',
      description: 'Point your chat preamble at a document. Your math in chat is rendered (and linted) with that document\'s macros, and every message you send carries the reference so readers see it rendered with your preamble — not theirs. By default your preamble is the project in your working directory; use this to override it to any document (e.g. when you are not working inside a paper\'s source dir). Physics-package commands (\\norm, \\qty, …) are always available regardless.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document/project name whose macros to use (e.g. "bregman").' },
          version: { type: 'string', description: 'Optional shadow version (build hash). Accepted and stored for future use; macro resolution currently uses the document\'s latest macros regardless.' },
        },
        required: ['doc'],
      },
    },
    ...getFleetTools(),
  ],
}));

// Track last ping timestamp (consumed by get_feedback)
let lastPingTimestamp = 0;

async function summarizeAnnotations(docName) {
  try {
    const shapes = await fetchShapes(docName, 'math-note');
    const annotations = [];
    for (const record of shapes) {
      if (!record || record.type !== 'math-note') continue;
      const anchor = record.meta?.sourceAnchor;
      const loc = anchor ? `${anchor.file}:${anchor.line}` : `(${record.x?.toFixed(0)}, ${record.y?.toFixed(0)})`;
      annotations.push(`- [${record.props?.color || '?'}] ${loc}: ${record.props?.text || '(empty)'}`);
    }
    if (annotations.length === 0) return 'No annotations.';
    return `${annotations.length} annotation(s):\n${annotations.join('\n')}`;
  } catch (e) {
    return `(Failed to fetch annotations: ${e.message})`;
  }
}

async function formatPing(ping, docName) {
  const vp = ping.viewport ? `Viewport: (${ping.viewport.x?.toFixed(0)}, ${ping.viewport.y?.toFixed(0)})` : '';
  const summary = await summarizeAnnotations(docName);
  return `Ping received! ${vp}\n\n${summary}`;
}

/** Format a stroke result (draw/highlight/arrow/geo/text/line) for MCP response.
 *  Returns { content, page } where page is used for nearby-context lookup. */
function formatStrokeResult(r, docName, prefix, entry, agent) {
  const color = r.props?.color || 'black';

  if (r.type === 'arrow') {
    const ep = getArrowEndpoints(r);
    if (ep) {
      const pdfStart = canvasToDoc(docName, ep.start.x, ep.start.y);
      const pdfEnd = canvasToDoc(docName, ep.end.x, ep.end.y);
      const startLines = findNearbyLines(docName, { minX: ep.start.x - 10, minY: ep.start.y - 10, maxX: ep.start.x + 10, maxY: ep.start.y + 10 });
      const endLines = findNearbyLines(docName, { minX: ep.end.x - 10, minY: ep.end.y - 10, maxX: ep.end.x + 10, maxY: ep.end.y + 10 });
      const label = r.props?.text || '';
      let text = `${prefix}Arrow (${color})`;
      if (label) text += ` "${label}"`;
      if (startLines.length > 0) text += `\n  from: page ${pdfStart.page}, line ${startLines[0].line} "${startLines[0].content}"`;
      else text += `\n  from: page ${pdfStart.page}`;
      if (endLines.length > 0) text += `\n  to:   page ${pdfEnd.page}, line ${endLines[0].line} "${endLines[0].content}"`;
      else text += `\n  to:   page ${pdfEnd.page}`;
      const arrowBBox = getArrowBBox(r);
      if (arrowBBox) {
        const rendered = getRenderedText(docName, arrowBBox);
        if (rendered) text += `\n  rendered: "${rendered}"`;
      }
      writeAgentAttention(docName, (ep.start.x + ep.end.x) / 2, (ep.start.y + ep.end.y) / 2, agent);
      return { content: [{ type: 'text', text }], page: pdfStart.page };
    }
  }

  if (r.type === 'geo') {
    const bbox = getGeoBBox(r);
    const geo = r.props?.geo || 'rectangle';
    const label = r.props?.text || '';
    let text = `${prefix}${geo} (${color})`;
    if (label) text += ` "${label}"`;
    let page = null;
    if (bbox) {
      const pos = describePagePosition(docName, bbox);
      page = pos.page;
      const nearbyLines = findNearbyLines(docName, bbox);
      text += `\n  ${pos.description}`;
      if (nearbyLines.length > 0) {
        const lineRange = nearbyLines.length === 1
          ? `line ${nearbyLines[0].line}`
          : `lines ${nearbyLines[0].line}–${nearbyLines[nearbyLines.length - 1].line}`;
        text += `\n  encloses ${lineRange}`;
        text += `\n  first: "${nearbyLines[0].content}"`;
        if (nearbyLines.length > 1) text += `\n  last:  "${nearbyLines[nearbyLines.length - 1].content}"`;
      }
      const rendered = getRenderedText(docName, bbox);
      if (rendered) text += `\n  rendered: "${rendered}"`;
    }
    if (bbox) writeAgentAttention(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, agent);
    return { content: [{ type: 'text', text }], page };
  }

  if (r.type === 'text') {
    const textContent = r.props?.text || '';
    const bbox = getTextBBox(r);
    const pos = describePagePosition(docName, bbox);
    const nearbyLines = findNearbyLines(docName, bbox);
    let text = `${prefix}Text (${color}): "${textContent}"`;
    text += `\n  ${pos.description}`;
    if (nearbyLines.length > 0) text += `\n  near line ${nearbyLines[0].line}: "${nearbyLines[0].content}"`;
    const rendered = getRenderedText(docName, bbox);
    if (rendered) text += `\n  rendered: "${rendered}"`;
    return { content: [{ type: 'text', text }], page: pos.page };
  }

  // Draw / highlight
  const bbox = getDrawShapeBBox(r);
  const tool = r.type === 'highlight' ? 'highlighter' : 'pen';

  // Magic highlighter: has extracted text metadata from SVG
  if (r.type === 'highlight' && r.meta?.highlightText) {
    const pos = bbox ? describePagePosition(docName, bbox) : null;
    const lines = r.meta.highlightLines || [r.meta.highlightText];
    let text = `${prefix}Highlight (${color})`;
    if (pos) text += ` ${pos.description}`;
    if (r.meta.sourceLine) text += `, near line ${r.meta.sourceLine}`;
    if (lines.length === 1) {
      text += `\n  text: "${lines[0]}"`;
    } else {
      text += `\n  text (${lines.length} lines):`;
      for (const line of lines) text += `\n    "${line}"`;
    }
    text += `\n  NOTE: edge lines and first/last words may bleed from adjacent text`;
    if (bbox) writeAgentAttention(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, agent);
    return { content: [{ type: 'text', text }], page: pos?.page || null };
  }

  // Handwriting recognition: has LaTeX transcription from MyScript
  if (r.type === 'draw' && r.meta?.transcription) {
    const pos = bbox ? describePagePosition(docName, bbox) : null;
    let text = `${prefix}Handwriting (${color})`;
    if (pos) text += ` ${pos.description}`;
    text += `\n  transcription: "${r.meta.transcription}"`;
    if (!r.meta.transcriptionVerified) text += ` (unverified)`;
    if (bbox) writeAgentAttention(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, agent);
    return { content: [{ type: 'text', text }], page: pos?.page || null };
  }

  const sentiment = tool === 'highlighter' ? 'attention' : 'correction';
  const gesture = bbox ? classifyGesture(bbox) : 'unknown';
  const nearbyLines = bbox ? findNearbyLines(docName, bbox) : [];
  const pos = bbox ? describePagePosition(docName, bbox) : null;

  let text = `${prefix}Stroke: ${tool} (${color}) → ${gesture} [${sentiment}]`;
  if (pos) text += `\n  ${pos.description}`;
  if (nearbyLines.length > 0) {
    const lineRange = nearbyLines.length === 1
      ? `line ${nearbyLines[0].line}`
      : `lines ${nearbyLines[0].line}–${nearbyLines[nearbyLines.length - 1].line}`;
    text += `\n  covers ${lineRange}`;
    text += `\n  first: "${nearbyLines[0].content}"`;
    if (nearbyLines.length > 1) text += `\n  last:  "${nearbyLines[nearbyLines.length - 1].content}"`;
  }
  const rendered = bbox ? getRenderedText(docName, bbox) : '';
  if (rendered) text += `\n  rendered: "${rendered}"`;
  if (bbox) writeAgentAttention(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, agent);
  return { content: [{ type: 'text', text }], page: pos?.page || null };
}

// Tools that need built document pages to work
const TOOLS_NEEDING_BUILD = new Set([
  'screenshot',
  'add_note',
  'scroll_to_line', 'read_annotations',
  'draw_highlight', 'draw_arrow',
  'set_understanding', 'get_understanding',
  'lookup_theorem', 'extract_to_scratch',
]);

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Pre-check: tools that depend on built pages should fail fast with a diagnostic
  if (TOOLS_NEEDING_BUILD.has(name)) {
    const docName = args?.doc;
    if (docName) {
      const buildCheck = await checkDocBuildStatus(docName);
      if (!buildCheck.ok) {
        return { content: [{ type: 'text', text: `${buildCheck.reason}. Run "tlda doc status ${docName}" or "tlda doc errors ${docName}" to investigate.` }], isError: true };
      }
    }
  }

  // Education gate for non-Claude agents — no-op for claude.
  {
    const gated = await educationGate(name, args);
    if (gated) return gated;
  }


  if (name === 'read_doc') {
    // Document- and version-aware source read. Resolves a doc to its source
    // file, reads a paginated line window, supports reading a past version (git
    // show) and jumping to a label/theorem via the source map.
    const doc = args?.doc;
    if (!doc) return { content: [{ type: 'text', text: 'read_doc: `doc` is required.' }], isError: true };
    const projDir = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8')); }
    catch { return { content: [{ type: 'text', text: `read_doc: unknown doc "${doc}" (no project.json).` }], isError: true }; }
    const sourceDir = cfg.sourceDir;
    if (!sourceDir || !fs.existsSync(sourceDir)) return { content: [{ type: 'text', text: `read_doc: doc "${doc}" has no source dir on this machine.` }], isError: true };
    const mainFile = cfg.mainFile || cfg.main;
    const file = args.file || mainFile;
    if (!file) return { content: [{ type: 'text', text: `read_doc: no file given and doc "${doc}" has no mainFile.` }], isError: true };
    let relFile = (path.basename(file) === file) ? file : path.relative(sourceDir, path.resolve(sourceDir, file));

    // ref/label shorthand → anchor line. The source map's labels come from the
    // .aux file, which records page/number/title but NOT the source line — so we
    // resolve the line from ground truth: the actual `\label{...}` location in
    // the doc's source. We scan the doc's real build files (the distinct .tex
    // files synctex recorded in the source map's `pages` index, which excludes
    // junk/old .tex lying around the source dir). This also resolves a ref that
    // lives in an \input'd file to the right file to read.
    let anchorLine = 0;
    let refNote = '';
    if (args.ref && !(args.startLine > 0)) {
      const texBase = String(mainFile || 'main').replace(/\.tex$/, '');
      const smPath = path.join(projDir, 'output', `${texBase}-source-map.json`);
      let sm;
      try { sm = JSON.parse(fs.readFileSync(smPath, 'utf8')); }
      catch { return { content: [{ type: 'text', text: `read_doc: ref lookup unavailable for ${doc} (no source map — build the doc first).` }], isError: true }; }
      const q = String(args.ref).trim();
      const e = (sm.labels || []).find(x => x.label === q || x.number === q)
            || (sm.labels || []).find(x => x.label?.includes(q) || x.number?.includes(q));
      if (!e) return { content: [{ type: 'text', text: `read_doc: ref "${q}" not found in ${doc}'s source map.` }], isError: true };
      const found = findLabelLine(sourceDir, sm, mainFile, e.label);
      if (!found) return { content: [{ type: 'text', text: `read_doc: ref "${q}" matched label ${e.label} (p.${e.page}) but its \\label{} line wasn't found in the source files — the doc may need a rebuild.` }], isError: true };
      anchorLine = found.line;
      relFile = found.file;   // read the file the label actually lives in
      refNote = ` (ref "${q}" → ${e.number || e.label} @ ${found.file}:${found.line})`;
    }

    // Read content — current version (fs) or a past version (git show).
    let data, versionNote = '';
    if (args.version) {
      if (!fs.existsSync(path.join(sourceDir, '.git'))) return { content: [{ type: 'text', text: `read_doc: "${doc}" source has no git history for versioned reads.` }], isError: true };
      try { data = execFileSync('git', ['show', `${args.version}:${relFile}`], { cwd: sourceDir, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); versionNote = ` @${args.version}`; }
      catch (e) { return { content: [{ type: 'text', text: `read_doc: couldn't read ${relFile} @${args.version}: ${String(e.message).split('\n')[0]}` }], isError: true }; }
    } else {
      try { data = fs.readFileSync(path.join(sourceDir, relFile), 'utf8'); }
      catch (e) { return { content: [{ type: 'text', text: `read_doc: ${e.code === 'ENOENT' ? 'no such file' : e.message}: ${relFile}` }], isError: true }; }
    }

    const allLines = data.split('\n');
    const total = allLines.length;
    // Window: a ref anchors a focused window (a few lines above + ~80 tall); a
    // plain read uses startLine + a 400-line page. `before`/`lines` override.
    let off, count;
    if (anchorLine > 0) {
      const before = args.before >= 0 ? args.before : 3;
      off = Math.max(0, anchorLine - 1 - before);
      count = args.lines > 0 ? args.lines : 80;
    } else {
      off = args.startLine > 0 ? args.startLine - 1 : 0;
      count = args.lines > 0 ? args.lines : 400;
    }
    const end = args.endLine > 0 ? Math.min(args.endLine, total) : Math.min(off + count, total);
    let body = allLines.slice(off, end).join('\n');
    let capNote = '';
    const MAX = 60000;
    if (body.length > MAX) { body = body.slice(0, MAX); capNote = `\n→ output capped at ${MAX} chars — narrow the range with endLine.`; }
    const pageNote = end < total ? `\n→ ${total - end} more lines — call again with startLine=${end + 1}.` : '';
    const header = `${doc}/${relFile}${versionNote}${refNote} — lines ${off + 1}–${end} of ${total}:`;
    return { content: [{ type: 'text', text: `${header}\n${body}${capNote}${pageNote}` }] };
  }

  if (name === 'screenshot') {
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing doc parameter' }], isError: true };
    }

    // Resolve target → signal payload.
    let bounds = null;
    let mode = args?.target || null; // 'viewport' | 'screen' | null
    let labelTag = '';

    if (args?.ref) {
      // tlda-screenshot:<pageId>:<x>,<y>,<w>,<h>
      const parts = args.ref.split(':');
      const coordStr = parts[parts.length - 1];
      const coords = coordStr.split(',').map(Number);
      if (coords.length !== 4 || coords.some(isNaN)) {
        return { content: [{ type: 'text', text: `Invalid ref format: ${args.ref}` }], isError: true };
      }
      bounds = { x: coords[0], y: coords[1], w: coords[2], h: coords[3] };
      labelTag = ' (annotation region)';
    } else if (args?.x != null && args?.y != null && args?.w != null && args?.h != null) {
      bounds = { x: args.x, y: args.y, w: args.w, h: args.h };
      labelTag = ' (bounds)';
    } else if (mode === 'screen') {
      labelTag = ' (screen)';
    } else {
      // Default to viewport when no other target is given.
      mode = mode || 'viewport';
      labelTag = mode === 'viewport' ? ' (viewport)' : ` (${mode})`;
    }

    const signalData = { timestamp: Date.now() };
    if (bounds) signalData.bounds = bounds;
    if (mode) signalData.mode = mode;
    if (args?.page) signalData.page = args.page;
    if (args?.shapeId) signalData.shapeId = args.shapeId;
    if (Array.isArray(args?.shapeTypes) && args.shapeTypes.length) signalData.shapeTypes = args.shapeTypes;
    if (Array.isArray(args?.shapeIds) && args.shapeIds.length) signalData.shapeIds = args.shapeIds;
    if (args?.padding != null) signalData.padding = args.padding;

    const mailbox = startOperationMailbox('screenshot', { doc: docName, label: `${docName}${labelTag}` });
    if (!mailbox) return { content: [{ type: 'text', text: 'Screenshot mailbox requires fleet login. Call login() first.' }], isError: true };

    (async () => {
      try {
        const reqTs = signalData.timestamp;
        await broadcastSignalRest(docName, 'signal:screenshot-request', signalData);
        // The viewer captures and POSTs its reply back to the server, which caches
        // it (signalCache). Poll that cache for a reply newer than our request,
        // rather than relying on catching the live SSE signal — the reply can
        // arrive (~0.8s) before an SSE listener finishes registering, and the cache
        // is the authoritative copy either way.
        let result = null;
        // The viewer's capture can take ~15–20s for a content-heavy region, so the
        // old 8s timeout gave up before the (cached, valid) reply ever landed.
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 350));
          let cached = null;
          try {
            cached = await serverFetch(`/api/projects/${docName}/signal/signal:screenshot`);
          } catch {
            cached = null; // 404 until the viewer replies — keep polling
          }
          if (cached?.data && (cached.timestamp || 0) >= reqTs) { result = cached; break; }
        }
        if (!result?.data) {
          deliverOperationMailboxCompletion(mailbox, 'failed', {
            label: `${docName}${labelTag}`,
            error: 'No viewer responded — open the document in a browser first',
          });
          return;
        }

        let tmpDir = null;
        let uploaded = null;
        try {
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-screenshot-mailbox-'));
          const tmpFile = path.join(tmpDir, `${docName}-${mailbox.id.replace(/[^a-zA-Z0-9_-]/g, '-')}.png`);
          fs.writeFileSync(tmpFile, Buffer.from(result.data, 'base64'));
          uploaded = await uploadFileToServer(tmpFile, getFleetServerUrl());
        } finally {
          if (tmpDir) {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (cleanupError) {
              process.stderr.write(`[mcp] screenshot mailbox cleanup failed: ${cleanupError.message}\n`);
            }
          }
        }
        const kb = Math.round(result.data.length / 1024);
        deliverOperationMailboxCompletion(mailbox, 'completed', {
          label: `${docName}${labelTag}`,
          doc: docName,
          bytes_base64: result.data.length,
          mimeType: result.mimeType || 'image/png',
          url: uploaded.url,
          message: `Screenshot${labelTag} (${kb}KB)\n\n![screenshot](${uploaded.url})`,
        });
      } catch (e) {
        deliverOperationMailboxCompletion(mailbox, 'failed', {
          label: `${docName}${labelTag}`,
          error: e.message || String(e),
        });
      }
    })();

    return operationMailboxStartedResult(mailbox, { extra: `doc: ${docName}` });
  }

  if (name === 'add_note') {
    const { doc, line, page: pageNum, color, size, width, height, side, text_anchor, options_file: optionsFile } = args;
    let { text, choices, file } = args;
    let effectiveSize = size;
    if (!doc || (!line && !pageNum)) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, (line or page)' }], isError: true };
    }
    // If file param points to a readable file, use its content as note text
    if (file && !text && !optionsFile) {
      const filePath = file.startsWith('~') ? file.replace('~', os.homedir()) : (path.isAbsolute(file) ? file : path.resolve(file));
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          text = fs.readFileSync(filePath, 'utf8');
          // Don't pass file as source anchor since it was used for content
          file = undefined;
        }
      } catch (e) { process.stderr.write(`[mcp] file read for annotation failed: ${e.message}\n`); }
    }
    if (optionsFile) {
      if (text || choices) {
        return { content: [{ type: 'text', text: '`options_file` is mutually exclusive with inline `text` / `choices`' }], isError: true };
      }
      try {
        const parsed = parseOptionsFile(optionsFile);
        text = parsed.text;
        choices = parsed.choices;
        // Multi-section options notes are inherently bigger than single-text
        // notes — bump the default to `lg` unless the agent explicitly asked
        // for a different size.
        if (!effectiveSize) effectiveSize = 'lg';
      } catch (e) {
        return { content: [{ type: 'text', text: `Error parsing options_file: ${e.message}` }], isError: true };
      }
    }
    if (!text) {
      return { content: [{ type: 'text', text: 'Missing required parameter: text (or options_file or file)' }], isError: true };
    }
    try {
      const result = await addAnnotation(doc, line, text, { color, size: effectiveSize, width, height, side, file, choices, page: pageNum });
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      const choicesNote = choices?.length ? `\n  choices: ${choices.join(' | ')}` : '';
      const refValidation = validateRefs(text, doc);
      const refWarning = formatRefWarnings(refValidation);
      return { content: [{ type: 'text', text: `Created ${result.shapeId}\n  ${line ? `line ${line}` : `page ${pageNum}`} → page ${result.page}, canvas (${result.x.toFixed(0)}, ${result.y.toFixed(0)})\n  "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"${choicesNote}${refWarning}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'read_annotations') {
    const { doc } = args;
    const typeFilter = args.type || null;
    const sortOrder = args.sort || 'document';
    const sinceMinutes = args.since || args.since_minutes || null;
    const startLine = args.startLine || null;
    const endLine = args.endLine || null;
    const unaddressedOnly = args.unaddressed_only || false;
    if (!doc) return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    try {
      const items = [];
      const sinceTs = sinceMinutes ? Date.now() - sinceMinutes * 60 * 1000 : null;

      // Notes (math-note shapes)
      if (!typeFilter || typeFilter.includes('note')) {
        const result = await listAnnotations(doc);
        for (const a of result.annotations) {
          if (unaddressedOnly && a.addressed) continue;
          if (sinceTs && a.createdAt && a.createdAt < sinceTs) continue;
          const noteLine = a.line || a.sourceLine || null;
          // A line-range query asks "what's in this section" — an annotation
          // with no document line can't be in it, so exclude it from the range.
          if ((startLine || endLine) && !noteLine) continue;
          if (startLine && noteLine < startLine) continue;
          if (endLine && noteLine > endLine) continue;
          items.push({ ...a, annotationType: 'note', sortLine: noteLine || 0, sortTime: a.createdAt || 0 });
        }
      }

      // Drawn shapes (highlights, pen strokes, arrows, geo, text, lines)
      const drawTypes = ['highlight', 'draw', 'arrow', 'geo', 'text', 'line'];
      if (!typeFilter || typeFilter.some(t => drawTypes.includes(t))) {
        const drawnShapes = await collectDrawnShapes(doc);
        for (const s of drawnShapes) {
          if (s.shapeType === 'note') continue;
          const aType = s.shapeType === 'highlighter' ? 'highlight' : (s.shapeType || 'draw');
          if (typeFilter && !typeFilter.includes(aType)) continue;
          if (unaddressedOnly && s.meta?.addressed) continue;
          if (sinceTs && s.createdAt && s.createdAt < sinceTs) continue;
          const shapeLine = s.sourceLine || s.lines?.[0]?.line || 0;
          if ((startLine || endLine) && !shapeLine) continue;
          if (startLine && shapeLine < startLine) continue;
          if (endLine && shapeLine > endLine) continue;
          items.push({
            id: s.id,
            annotationType: aType,
            color: s.color,
            page: s.page,
            lines: s.lines,
            highlightText: s.highlightText || null,
            highlightedText: s.meta?.highlightedText || s.meta?.highlightText || null,
            text: s.text || null,
            addressed: s.meta?.addressed || false,
            sortLine: shapeLine,
            sortTime: s.createdAt || 0,
          });
        }
      }

      // Sort
      if (sortOrder === 'time') {
        items.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));
      } else {
        items.sort((a, b) => (a.page || 0) - (b.page || 0) || (a.sortLine || 0) - (b.sortLine || 0));
      }

      if (items.length === 0) return { content: [{ type: 'text', text: 'No annotations found.' }] };

      // Format output
      let out = `${doc} — ${items.length} annotation(s)\n\n`;
      for (const a of items) {
        if (a.annotationType === 'highlight' || a.annotationType === 'highlighter') {
          out += formatHighlight(a) + `\n  id: ${a.id}\n`;
        } else if (a.annotationType === 'note') {
          out += formatNote(a) + `\n  id: ${a.id}\n`;
        } else if (a.annotationType === 'draw' || a.annotationType === 'pen') {
          const lineRef = a.sortLine ? `L${a.sortLine}` : (a.page ? `p${a.page}` : '');
          out += `[pen] ${a.color} ${lineRef}\n  id: ${a.id}\n`;
          if (a.lines?.length > 0) out += `  near: "${a.lines[0].content?.substring(0, 60)}"\n`;
        } else if (a.annotationType === 'arrow') {
          const lineRef = a.sortLine ? `L${a.sortLine}` : (a.page ? `p${a.page}` : '');
          out += `[arrow] ${a.color} ${lineRef}\n  id: ${a.id}\n`;
        } else {
          const lineRef = a.sortLine ? `L${a.sortLine}` : (a.page ? `p${a.page}` : '');
          out += `[${a.annotationType}] ${a.color} ${lineRef}\n  id: ${a.id}\n`;
          if (a.text) out += `  "${a.text}"\n`;
        }
        out += '\n';
      }

      return { content: [{ type: 'text', text: out }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'reply_note') {
    const { doc, id, text } = args;
    if (!doc || !id || !text) return { content: [{ type: 'text', text: 'Missing required parameters: doc, id, text' }], isError: true };
    try {
      const fullId = id.startsWith('shape:') ? id : `shape:${id}`;
      const shape = await fetchShape(doc, fullId);
      if (!shape || shape.type !== 'math-note') {
        return { content: [{ type: 'text', text: `Note not found: ${fullId}` }], isError: true };
      }
      const existing = shape.props?.text || '';
      const agentName = process.env.FLEET_NAME || process.env.FLEET_ID || 'agent';
      const newText = existing + '\n\n---\n\n' + text + ` — *${agentName}*`;
      await updateShapeRest(doc, fullId, {
        props: { text: newText },
        opacity: 0.3,
        meta: { addressed: true },
      });
      return { content: [{ type: 'text', text: `Reply appended to ${fullId} (marked addressed)` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'delete_annotation') {
    const { doc, id } = args;
    if (!doc || !id) return { content: [{ type: 'text', text: 'Missing required parameters: doc, id' }], isError: true };
    try {
      const result = await deleteAnnotation(doc, id);
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      return { content: [{ type: 'text', text: `Deleted: ${result.id}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'set_chat_target') {
    const { doc, agent, panel, chatShapeId } = args;
    if (!doc || !agent) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, agent' }], isError: true };
    }
    try {
      await broadcastSignalRest(doc, 'signal:set-chat-target', {
        agent, panel: panel || undefined, chatShapeId: chatShapeId || undefined, timestamp: Date.now(),
      });
      return { content: [{ type: 'text', text: `Chat panel now targets "${agent}"${chatShapeId ? ` (shape ${chatShapeId})` : ''}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to set chat target: ${e.message}` }], isError: true };
    }
  }

  if (name === 'scroll_to_line') {
    const { doc, line, file } = args;
    if (!doc || !line) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, line' }], isError: true };
    }
    const result = await scrollToLine(doc, line, file);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    if (result.method === 'scroll-to-element') {
      return { content: [{ type: 'text', text: `Scrolled to element #${result.elementId} in "${doc}"` }] };
    }
    const tok = resolveToken();
    const tokParam = tok ? `&token=${tok}` : '';
    const viewUrl = `${getServerUrl()}/?project=${encodeURIComponent(doc)}&cx=${(-result.x).toFixed(0)}&cy=${(-result.y).toFixed(0)}&cz=1${tokParam}`;
    return { content: [{ type: 'text', text: `Scrolled to line ${line} → page ${result.page} (${result.x.toFixed(0)}, ${result.y.toFixed(0)})\nView: ${viewUrl}` }] };
  }

  if (name === 'draw_highlight') {
    const { doc, startLine, endLine: endLineArg, color = 'orange', file, text } = args;
    if (!doc || startLine == null) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, startLine' }], isError: true };
    }
    // endLine is required unless text is provided
    const endLine = endLineArg ?? startLine;

    try {
      // --- Text-based highlighting: find exact text position and narrow the highlight ---
      if (text) {
        // Read source file from the server
        const sourceFile = file || null;
        const sourceFileName = sourceFile ? path.basename(sourceFile) : null;
        let sourceContent;
        try {
          const srcUrl = sourceFileName
            ? `${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/source/${encodeURIComponent(sourceFileName)}`
            : `${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/source/main`;
          const srcRes = await fetch(srcUrl, { headers: TLDA_AUTH_HEADERS });
          if (!srcRes.ok) {
            // If 'main' didn't work, try getting project info for the actual main file name
            if (!sourceFileName) {
              const projRes = await fetch(`${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}`, { headers: TLDA_AUTH_HEADERS });
              if (projRes.ok) {
                const projData = await projRes.json();
                const mainFile = projData.mainFile || projData.main;
                if (mainFile) {
                  const srcRes2 = await fetch(`${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/source/${encodeURIComponent(mainFile)}`, { headers: TLDA_AUTH_HEADERS });
                  if (srcRes2.ok) sourceContent = await srcRes2.text();
                }
              }
            }
            if (!sourceContent) {
              return { content: [{ type: 'text', text: `Could not read source file for ${doc}` }], isError: true };
            }
          } else {
            sourceContent = await srcRes.text();
          }
        } catch (e) {
          return { content: [{ type: 'text', text: `Error reading source: ${e.message}` }], isError: true };
        }

        const sourceLines = sourceContent.split('\n');
        // Search for text near startLine (±10 lines)
        const searchStart = Math.max(0, startLine - 11); // 0-indexed
        const searchEnd = Math.min(sourceLines.length, startLine + 10);
        const searchRegion = sourceLines.slice(searchStart, searchEnd).join('\n');

        const matchIdx = searchRegion.indexOf(text);
        if (matchIdx === -1) {
          return { content: [{ type: 'text', text: `Text "${text.slice(0, 50)}..." not found near line ${startLine}` }], isError: true };
        }

        // Convert matchIdx back to line number and column
        const beforeMatch = searchRegion.slice(0, matchIdx);
        const matchStartLine = searchStart + beforeMatch.split('\n').length; // 1-indexed
        const matchStartCol = beforeMatch.split('\n').pop().length; // 0-indexed column in that line

        const matchEndOffset = matchIdx + text.length;
        const beforeEnd = searchRegion.slice(0, matchEndOffset);
        const matchEndLine = searchStart + beforeEnd.split('\n').length; // 1-indexed
        const matchEndCol = beforeEnd.split('\n').pop().length; // 0-indexed column past end

        const pageW = getPageWidth(doc);
        const segments = [];
        let hlLeft = Infinity, hlRight = -Infinity;
        let hlTop = Infinity, hlBottom = -Infinity;

        // Use synctex x-records for precise positioning
        let synctexData = null;
        try {
          // Load synctex data from disk — parse the .synctex.gz directly
          const { createReadStream, readdirSync } = await import('fs');
          const { createGunzip } = await import('zlib');
          const { createInterface } = await import('readline');
          const srcDir = localDocDir(doc)?.replace(/\/output$/, '/source') || '';
          const synctexFiles = srcDir ? readdirSync(srcDir).filter(f => f.endsWith('.synctex.gz')) : [];
          if (synctexFiles.length > 0) {
            const synctexPath = path.join(srcDir, synctexFiles[0]);
            const inputMap = new Map();
            let sUnit = 1, sMag = 1000, curPage = 0;
            const records = [];
            const rl = createInterface({ input: createReadStream(synctexPath).pipe(createGunzip()), crlfDelay: Infinity });
            for await (const line of rl) {
              if (line.startsWith('Input:')) { const m = line.match(/^Input:(\d+):(.+)$/); if (m) inputMap.set(parseInt(m[1]), m[2]); continue; }
              if (line.startsWith('Unit:')) { sUnit = parseInt(line.slice(5)) || 1; continue; }
              if (line.startsWith('Magnification:')) { sMag = parseInt(line.slice(14)) || 1000; continue; }
              if (line.startsWith('{')) { curPage = parseInt(line.slice(1)) || 0; continue; }
              if (line[0] !== 'x' || curPage === 0) continue;
              const ci = line.indexOf(':'), cm = line.indexOf(',');
              if (ci === -1 || cm === -1 || cm > ci) continue;
              const iid = parseInt(line.slice(1, cm)), ln2 = parseInt(line.slice(cm + 1, ci));
              if (isNaN(iid) || isNaN(ln2) || ln2 <= 0) continue;
              const fp = inputMap.get(iid);
              if (!fp || !fp.endsWith('.tex')) continue;
              const coords = line.slice(ci + 1).split(',');
              const scale = sUnit * sMag / 1000 / 65536;
              records.push({ line: ln2, page: curPage, x: parseInt(coords[0]) * scale, y: parseInt(coords[1]) * scale });
            }
            synctexData = { records };
          }
        } catch (e) {
          console.error('[draw_highlight] synctex load failed:', e.message);
        }

        for (let ln = matchStartLine; ln <= matchEndLine; ln++) {
          const pos = await lookupLineAsync(doc, ln, file);
          if (!pos) continue;
          const canvas = pdfToCanvas(pos.page, pos.x, pos.y);
          const lineText = sourceLines[ln - 1] || '';
          const lineLen = lineText.length || 1;

          // Determine column range for this line within the match
          let colStart = 0;
          let colEnd = lineLen;
          if (ln === matchStartLine) colStart = matchStartCol;
          if (ln === matchEndLine) colEnd = matchEndCol;

          let xStart, xEnd;

          if (synctexData) {
            // Use synctex x-records: find all records for this line on this page,
            // sort by x, map column fraction to actual PDF x-positions
            const lineRecs = synctexData.records.filter(r => r.line === ln && r.page === pos.page);
            if (lineRecs.length >= 2) {
              const sorted = [...lineRecs].sort((a, b) => a.x - b.x);
              const lineXMin = sorted[0].x;
              const lineXMax = sorted[sorted.length - 1].x;
              const lineXRange = lineXMax - lineXMin;
              if (lineXRange > 0) {
                const pdfXStart = lineXMin + (colStart / lineLen) * lineXRange;
                const pdfXEnd = lineXMin + (colEnd / lineLen) * lineXRange;
                const csStart = pdfToCanvas(pos.page, pdfXStart, pos.y);
                const csEnd = pdfToCanvas(pos.page, pdfXEnd, pos.y);
                xStart = csStart.x;
                xEnd = csEnd.x;
              }
            }
          }

          if (xStart === undefined) {
            // Fallback: proportional mapping
            const fullLeft = canvas.x;
            const fullRight = pageW * 0.9;
            const fullWidth = fullRight - fullLeft;
            xStart = fullLeft + (colStart / lineLen) * fullWidth;
            xEnd = fullLeft + (colEnd / lineLen) * fullWidth;
          }

          hlLeft = Math.min(hlLeft, xStart);
          hlRight = Math.max(hlRight, xEnd);
          hlTop = Math.min(hlTop, canvas.y - 3);
          hlBottom = Math.max(hlBottom, canvas.y + 3);
        }

        if (hlLeft === Infinity) {
          return { content: [{ type: 'text', text: `No lookup entries found for matched lines ${matchStartLine}–${matchEndLine}` }], isError: true };
        }

        const width = hlRight - hlLeft;
        const height = hlBottom - hlTop;
        const numLines = matchEndLine - matchStartLine + 1;
        const lineH = numLines > 1 ? height / numLines : 0;

        for (let i = 0; i < numLines; i++) {
          const ln = matchStartLine + i;
          const pos = await lookupLineAsync(doc, ln, file);
          if (!pos) continue;
          const canvas = pdfToCanvas(pos.page, pos.x, pos.y);
          const lineText = sourceLines[ln - 1] || '';
          const lineLen = lineText.length || 1;

          const fullLeft = canvas.x;
          const fullRight = pageW * 0.9;
          const fullWidth = fullRight - fullLeft;

          let colStart = 0;
          let colEnd = lineLen;
          if (ln === matchStartLine) colStart = matchStartCol;
          if (ln === matchEndLine) colEnd = matchEndCol;

          const xStart = fullLeft + (colStart / lineLen) * fullWidth;
          const xEnd = fullLeft + (colEnd / lineLen) * fullWidth;

          // Segment coordinates are relative to the shape's (hlLeft, hlTop)
          const segLeft = xStart - hlLeft;
          const segRight = xEnd - hlLeft;
          const y = (canvas.y - 3) - hlTop + (numLines <= 1 ? 0 : 0);
          segments.push({ type: 'free', path: encodeB64Path([
            { x: segLeft, y, z: 0.5 },
            { x: segRight, y, z: 0.5 },
          ])});
        }

        const shapeId = generateShapeId();
        const shapeIndex = await getNextShapeIndex(doc);
        const firstPos = await lookupLineAsync(doc, matchStartLine, file);
        const shape = {
          id: shapeId,
          type: 'highlight',
          x: hlLeft,
          y: hlTop,
          index: shapeIndex,
          rotation: 0,
          isLocked: false,
          opacity: 0.7,
          props: {
            segments,
            color,
            size: 's',
            isComplete: true,
            isPen: false,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
          },
          meta: {
            createdAt: Date.now(),
            createdBy: 'claude',
            sourceAnchor: { file: file || './' + (firstPos?.texFile || 'main.tex'), line: matchStartLine },
            highlightedText: text,
            ...(process.env.FLEET_ID ? { fleet_id: process.env.FLEET_ID } : {}),
            ...(process.env.FLEET_NAME ? { friendly_name: process.env.FLEET_NAME } : {}),
          },
          parentId: 'page:page',
          typeName: 'shape',
        };

        await createShapeRest(doc, shape);
        return { content: [{ type: 'text', text: `Highlight drawn: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}" at lines ${matchStartLine}–${matchEndLine}, page ${firstPos?.page}, ${color} (${shapeId})` }] };
      }

      // --- Full-line highlighting (original behavior) ---
      // Staging now lives in the shared lib (mcp-server/lib/annotate.mjs) so the
      // drill teacher stages line-range highlights through the same code path.
      const r = await stageHighlight(doc, startLine, endLine, { color, file, server: TLDA_SYNC_SERVER });
      if (!r.ok) return { content: [{ type: 'text', text: r.error }], isError: true };
      return { content: [{ type: 'text', text: `Highlight drawn: lines ${startLine}–${endLine}, page ${r.page}, ${color} (${r.shapeId})` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'draw_arrow') {
    const { doc, fromLine, toLine, label, color = 'orange', file, toFile, side = 'left' } = args;
    if (!doc || fromLine == null || toLine == null) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, fromLine, toLine' }], isError: true };
    }

    try {
      const fromPos = lookupLine(doc, fromLine, file);
      const toPos = lookupLine(doc, toLine, toFile || file);
      if (!fromPos) return { content: [{ type: 'text', text: `Line ${fromLine} not found in lookup` }], isError: true };
      if (!toPos) return { content: [{ type: 'text', text: `Line ${toLine} not found in lookup` }], isError: true };

      const fromCanvas = pdfToCanvas(fromPos.page, fromPos.x, fromPos.y);
      const toCanvas = pdfToCanvas(toPos.page, toPos.x, toPos.y);

      // Place in margin: tips near text, belly curves away from text
      const pageW = getPageWidth(doc);
      const useRightMargin = side === 'right';
      const startX = useRightMargin ? pageW + 15 : -15;
      const startY = fromCanvas.y;
      const endX = useRightMargin ? pageW + 15 : -15;
      const endY = toCanvas.y;

      const shapeX = Math.min(startX, endX);
      const shapeY = Math.min(startY, endY);

      const dy = Math.abs(endY - startY);
      const bendMagnitude = Math.min(80, Math.max(25, dy * 0.1));
      // For downward arrows (startY < endY): negative bend → curves right (toward text)
      // We want the opposite: belly away from text
      // Left margin: belly goes left (negative x direction)
      // Right margin: belly goes right (positive x direction)
      const goingDown = startY < endY;
      // In TLDraw: for downward arrow, negative bend = curve right, positive = curve left
      // Left margin wants curve left (away from text) = positive bend for downward
      // Right margin wants curve right (away from text) = negative bend for downward
      const sign = useRightMargin
        ? (goingDown ? -1 : 1)
        : (goingDown ? 1 : -1);
      const bend = sign * bendMagnitude;

      const shapeId = generateShapeId();
      const shapeIndex = await getNextShapeIndex(doc);
      const shape = {
        id: shapeId,
        type: 'arrow',
        x: shapeX,
        y: shapeY,
        index: shapeIndex,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        props: {
          start: { x: startX - shapeX, y: startY - shapeY },
          end: { x: endX - shapeX, y: endY - shapeY },
          bend,
          color,
          size: 's',
          dash: 'draw',
          fill: 'none',
          arrowheadStart: 'none',
          arrowheadEnd: 'arrow',
          kind: 'arc',
          labelColor: 'black',
          labelPosition: 0.5,
          font: 'draw',
          scale: 1,
          elbowMidPoint: 0.5,
          richText: label ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] } : { type: 'doc', content: [] },
        },
        meta: {
          createdAt: Date.now(),
          createdBy: 'claude',
          sourceAnchor: { file: file || './' + (fromPos.texFile || 'main.tex'), line: fromLine },
          ...(process.env.FLEET_ID ? { fleet_id: process.env.FLEET_ID } : {}),
          ...(process.env.FLEET_NAME ? { friendly_name: process.env.FLEET_NAME } : {}),
        },
        parentId: 'page:page',
        typeName: 'shape',
      };

      await createShapeRest(doc, shape);
      const desc = fromPos.page === toPos.page
        ? `Arrow drawn: line ${fromLine} → ${toLine}, page ${fromPos.page}`
        : `Arrow drawn: line ${fromLine} (p${fromPos.page}) → ${toLine} (p${toPos.page})`;
      return { content: [{ type: 'text', text: `${desc}, ${color} (${shapeId})` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'set_understanding') {
    const { doc, startLine, endLine, status, file } = args;
    if (!doc || startLine == null || endLine == null || !status) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, startLine, endLine, status' }], isError: true };
    }
    try {
      // Look up canvas positions for start and end lines
      const startPos = await lookupLineAsync(doc, startLine, file);
      const endPos = await lookupLineAsync(doc, endLine, file);
      if (!startPos) return { content: [{ type: 'text', text: `Line ${startLine} not found in lookup` }], isError: true };
      if (!endPos) return { content: [{ type: 'text', text: `Line ${endLine} not found in lookup` }], isError: true };

      const startCanvas = pdfToCanvas(startPos.page, startPos.x, startPos.y);
      const endCanvas = pdfToCanvas(endPos.page, endPos.x, endPos.y);

      // Find or create the ribbon shape
      let ribbon;
      try {
        const shapes = await fetchShapes(doc, 'understanding-line');
        ribbon = shapes.find(s => s.id === UNDERSTANDING_RIBBON_ID);
      } catch (e) { process.stderr.write(`[mcp] ribbon shape fetch failed: ${e.message}\n`); }

      if (!ribbon) {
        // Create the ribbon shape — the viewer will resize it on load
        const shapeIndex = await getNextShapeIndex(doc);
        ribbon = {
          id: UNDERSTANDING_RIBBON_ID,
          type: 'understanding-line',
          typeName: 'shape',
          x: 0,
          y: Math.min(startCanvas.y, endCanvas.y),
          rotation: 0,
          isLocked: true,
          opacity: 1,
          index: shapeIndex,
          props: { w: 6, h: Math.abs(endCanvas.y - startCanvas.y) + 100, segments: '[]' },
          meta: { createdAt: Date.now() },
          parentId: 'page:page',
        };
        await createShapeRest(doc, ribbon);
      }

      const ribbonY = ribbon.y;
      const segments = JSON.parse(ribbon.props?.segments || '[]');
      const y1 = Math.min(startCanvas.y, endCanvas.y) - ribbonY;
      const y2 = Math.max(startCanvas.y, endCanvas.y) - ribbonY;

      // Anchor the stamp to the build currently in the room (doc-version sentinel),
      // so the server can later diff it forward and decide if the source moved.
      let approvedAtCommit;
      try {
        const dvShapes = await fetchShapes(doc, 'doc-version');
        const sentinel = dvShapes.find(s => s.id === 'shape:doc-version--sentinel');
        const h = sentinel?.props?.commitHash;
        if (h && h !== 'unknown') approvedAtCommit = String(h);
      } catch (e) { process.stderr.write(`[mcp] doc-version fetch failed: ${e.message}\n`); }

      const fileKey = file || '';
      const newSeg = {
        startLine,
        endLine,
        startFile: fileKey,
        endFile: fileKey,
        status,
        y1,
        y2,
        ...(approvedAtCommit ? { approvedAtCommit } : {}),
        ...(status !== 'unchecked' ? understandingProvenanceFromArgs(args) : {}),
      };
      const merged = mergeUnderstandingSegment(segments, newSeg);

      await updateShapeRest(doc, UNDERSTANDING_RIBBON_ID, { props: { ...ribbon.props, segments: JSON.stringify(merged) } });

      const lineCount = Math.abs(endLine - startLine) + 1;
      const checker = newSeg.checkedByName || newSeg.checkedById;
      const reason = newSeg.reason ? `; reason: ${newSeg.reason}` : '';
      const by = checker ? ` by ${checker}` : '';
      return { content: [{ type: 'text', text: `Understanding: ${lineCount} line(s) ${fileKey ? `${fileKey}:` : ''}${startLine}-${endLine} -> "${status}"${by}${reason}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'get_understanding') {
    const { doc } = args;
    if (!doc) return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    try {
      const shapes = await fetchShapes(doc, 'understanding-line');
      const ribbon = shapes.find(s => s.id === UNDERSTANDING_RIBBON_ID);
      if (!ribbon) {
        return { content: [{ type: 'text', text: 'No understanding map data.' }] };
      }
      const segments = JSON.parse(ribbon.props?.segments || '[]');
      if (segments.length === 0) {
        return { content: [{ type: 'text', text: 'No understanding map data.' }] };
      }
      return { content: [{ type: 'text', text: formatUnderstandingSummary(segments) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'doc_version') {
    const doc = args?.doc;
    if (!doc) return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    try {
      const ts = args?.timestamp;
      const limit = args?.limit || 20;

      if (ts) {
        // Find the active version at that time
        const { version } = await serverFetch(`/api/projects/${doc}/history/shadow?timestamp=${ts}`);
        if (!version) return { content: [{ type: 'text', text: 'No version found at that time' }] };
        const date = formatDisplayTimestamp(version.timestamp);
        return { content: [{ type: 'text', text: `${date}  ${version.hash.slice(0, 7)}  ${version.message}` }] };
      }

      const { versions } = await serverFetch(`/api/projects/${doc}/history/shadow?limit=${limit}`);
      if (!versions || versions.length === 0) return { content: [{ type: 'text', text: 'No shadow repo history. Versions are recorded after each build.' }] };

      const lines = versions.map(v => {
        const date = formatDisplayTimestamp(v.timestamp);
        return `${date}  ${v.hash.slice(0, 7)}  ${v.message}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'build') {
    const { doc } = args;
    if (!doc) return { content: [{ type: 'text', text: 'doc is required.' }], isError: true };
    try {
      // Check current status first
      const status = await serverFetch(`/api/projects/${doc}/build/status`);
      const isBuilding = status.phase === 'building' || status.status === 'building';

      // If not already building (and not just a status check), trigger a new build
      if (!isBuilding && name !== 'build_status') {
        await serverFetch(`/api/projects/${doc}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }

      // Poll until build completes (or if already building, wait for it)
      if (!isBuilding && name !== 'build_status') {
        // Background poll for build completion
        const pollInterval = setInterval(async () => {
          try {
            const s = await serverFetch(`/api/projects/${doc}/build/status`);
            if (s.phase === 'idle' || s.status === 'complete' || s.status === 'error') {
              clearInterval(pollInterval);
              process.stderr.write(`[tlda] build ${s.status !== 'error' ? 'success' : 'failed'} for "${doc}"\n`);
            }
          } catch (e) {
            process.stderr.write(`[tlda] build poll failed: ${e.message}\n`);
          }
        }, 3000);
        setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
      }

      // Return current status with errors
      let errData = [];
      let errorsWarning = '';
      try {
        errData = await serverFetch(`/api/projects/${doc}/build/errors`);
      } catch (e) {
        errorsWarning = `**Errors**: diagnostics unavailable (${e.message})`;
        process.stderr.write(`[mcp] build error fetch failed for "${doc}": ${e.message}\n`);
      }
      const errors = Array.isArray(errData) ? errData : [];
      // Check viewer version vs latest build
      let viewerInfo = '';
      try {
        const viewerSig = await serverFetch(`/api/projects/${doc}/signal/signal:viewer-version`);
        const shadowHistory = await serverFetch(`/api/projects/${doc}/history/shadow`);
        const latestVersions = shadowHistory?.versions || shadowHistory || [];
        const latestHash = latestVersions[0]?.hash;
        const viewerHash = viewerSig?.data?.hash;
        if (latestHash && viewerHash) {
          if (viewerHash.startsWith(latestHash.slice(0, 7)) || latestHash.startsWith(viewerHash.slice(0, 7))) {
            viewerInfo = `**Viewer**: up to date (${viewerHash.slice(0, 7)})`;
          } else {
            const viewerTs = viewerSig?.data?.timestamp;
            const latestTs = latestVersions[0]?.timestamp;
            const ageMins = (viewerTs && latestTs) ? Math.round((latestTs - viewerTs) / 60000) : '?';
            viewerInfo = `**Viewer**: stale — showing ${viewerHash.slice(0, 7)}, latest is ${latestHash.slice(0, 7)} (${ageMins} min behind). User may need to reload.`;
          }
        }
      } catch (e) { process.stderr.write(`[mcp] viewer stale check failed: ${e.message}\n`); }
      const triggered = (!isBuilding && name !== 'build_status') ? '**Build triggered.**\n' : (isBuilding ? '**Build already in progress.**\n' : '');
      const summary = [
        triggered,
        `**Phase**: ${status.phase || 'unknown'}`,
        `**Status**: ${status.status || 'unknown'}`,
        errorsWarning || (errors.length > 0 ? `**Errors** (${errors.length}):\n${errors.map(e => `  • ${e.message || e}`).join('\n')}` : '**Errors**: none'),
        viewerInfo,
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'push') {
    const { doc, files: fileSpecs, build = true } = args;
    if (!doc || !fileSpecs) return { content: [{ type: 'text', text: 'doc and files are required.' }], isError: true };
    try {
      const files = [];
      for (const spec of fileSpecs) {
        let content = spec.content;
        if (!content && spec.localPath) {
          try { content = fs.readFileSync(spec.localPath, 'utf8'); } catch (e) {
            return { content: [{ type: 'text', text: `Cannot read ${spec.localPath}: ${e.message}` }], isError: true };
          }
        }
        if (!content) return { content: [{ type: 'text', text: `No content for ${spec.path} — provide content or localPath.` }], isError: true };
        files.push({ path: spec.path, content });
      }
      await pushMcpSourceFiles({ doc, files, session: process.env.CLAUDE_SESSION, serverFetch });

      // Shadow-branch commit (best-effort)
      try {
        const projectConfigPath = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects', doc, 'project.json');
        const cfg = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
        const sourceDir = cfg.sourceDir;
        if (sourceDir && fs.existsSync(path.join(sourceDir, '.git'))) {
          const branch = `shadow/${doc}`;
          const timestamp = new Date().toISOString();
          const msg = `auto: ${timestamp} via push`;
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
          process.stderr.write(`[tlda] shadow commit ${commit.slice(0, 8)} on ${branch}\n`);
        }
      } catch (e) {
        process.stderr.write(`[tlda] shadow commit failed for "${doc}": ${e.message}\n`);
      }

      let buildMsg = '';
      if (build) {
        try {
          await serverFetch(`/api/projects/${doc}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          buildMsg = ' Build triggered.';
          const pollInterval = setInterval(async () => {
            try {
              const status = await serverFetch(`/api/projects/${doc}/build/status`);
              if (status.phase === 'idle' || status.status === 'complete' || status.status === 'error') {
                clearInterval(pollInterval);
                process.stderr.write(`[tlda] push build ${status.status !== 'error' ? 'success' : 'failed'} for "${doc}"\n`);
              }
            } catch (e) {
              process.stderr.write(`[tlda] push poll failed: ${e.message}\n`);
            }
          }, 3000);
          setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
        } catch (e) {
          buildMsg = ` Build trigger failed: ${e.message}`;
        }
      }
      return { content: [{ type: 'text', text: `Pushed ${files.length} file(s) to "${doc}".${buildMsg}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `tlda server error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'lookup_theorem') {
    const { doc, query } = args;
    if (!doc || !query) return { content: [{ type: 'text', text: 'doc and query are required.' }], isError: true };
    try {
      const tldaProjectsDir = path.join(os.homedir(), 'work', 'tlda', 'server', 'projects');
      const q = query.trim();
      let entry = null;

      // Resolve texBase from project.json for prefixed output files
      let texBase = 'main';
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(tldaProjectsDir, doc, 'project.json'), 'utf8'));
        if (pj.mainFile) texBase = pj.mainFile.replace(/\.tex$/, '');
      } catch {}

      const smPath = path.join(tldaProjectsDir, doc, 'output', `${texBase}-source-map.json`);

      if (fs.existsSync(smPath)) {
        const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'));
        const labels = sm.labels || [];
        entry = labels.find(e => e.label === q || e.number === q);
        if (!entry) entry = labels.find(e => e.label.includes(q) || e.number.includes(q));
      } else {
        return { content: [{ type: 'text', text: `lookup_theorem: source map unavailable for ${doc} (build the doc first).` }], isError: true };
      }

      if (!entry) {
        let available = '';
        if (fs.existsSync(smPath)) {
          const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'));
          const named = (sm.labels || []).filter(e => ['thm','lem','prop','cor','def','ass'].includes(e.type));
          available = named.map(e => `${e.number} (${e.label})`).join(', ');
        }
        return { content: [{ type: 'text', text: `No match for "${q}" in ${doc}.${available ? '\nAvailable: ' + available : ''}` }] };
      }
      const typeName = { thm: 'THM', lem: 'LEM', prop: 'PROP', cor: 'COR', def: 'DEF', ass: 'ASS', eq: 'EQ', sec: 'SEC', fig: 'FIG' }[entry.type] || entry.type.toUpperCase();
      const lines = [
        `**${typeName} ${entry.number}** — ${entry.title || '(no title)'}`,
        `Label: \`${entry.label}\``,
        `Page: ${entry.page}`,
        entry.file ? `Source: ${entry.file}:${entry.line}` : 'Source: unknown',
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `lookup_theorem error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'input_scratch') {
    const { doc, content_path, label, after, before, replace } = args;
    if (!doc || !content_path || !label) {
      return { content: [{ type: 'text', text: 'doc, content_path, and label are required.' }], isError: true };
    }
    if (!after && !before && !replace) {
      return { content: [{ type: 'text', text: 'One of after, before, or replace is required.' }], isError: true };
    }
    const resolved = path.resolve(content_path);
    // .tlda/scratch/ is fully tlda-managed. Block content_path pointing inside
    // it to prevent self-referential symlinks that destroy the file.
    if (/(^|\/)\.tlda\/scratch(\/|$)/.test(resolved)) {
      return { content: [{ type: 'text', text: `content_path "${resolved}" is inside the tlda-managed .tlda/scratch/ directory. Keep your scratch source elsewhere (e.g. a scratch/ dir) and pass that path — tlda owns .tlda/scratch/ and will create the link itself.` }], isError: true };
    }
    let content;
    try { content = fs.readFileSync(resolved, 'utf8'); } catch (e) {
      return { content: [{ type: 'text', text: `Cannot read ${resolved}: ${e.message}` }], isError: true };
    }
    const isMd = resolved.endsWith('.md') || resolved.endsWith('.qmd');
    try {
      const agentId = process.env.FLEET_ID || null;
      const agentName = process.env.FLEET_NAME || null;
      // Relativize content_path to sourceDir for display in \inputscratch
      const projectInfo = await serverFetch(`/api/projects/${doc}`);
      const relContentPath = projectInfo.sourceDir ? path.relative(projectInfo.sourceDir, resolved) : path.basename(resolved);
      const result = await serverFetch(`/api/projects/${doc}/input-scratch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, label, after, before, replace, agentId, agentName, format: isMd ? 'md' : 'tex', contentPath: relContentPath }),
      });
      const { scratchPath, wrappedContent, scratchTemplatePath, scratchTemplateContent, mainFile, mainContent, targetFile, targetContent, sourceDir } = result;
      if (!sourceDir) {
        return { content: [{ type: 'text', text: `Error: project "${doc}" has no sourceDir — run the file watcher first so the server knows the local project path.` }], isError: true };
      }
      // Write files to the local source directory; the watcher will push them and trigger the build
      const scratchDir = path.join(sourceDir, path.dirname(scratchPath));
      fs.mkdirSync(scratchDir, { recursive: true });
      // Auto-add .tlda/ to .gitignore
      const gitignorePath = path.join(sourceDir, '.gitignore');
      try {
        const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        if (!existing.split('\n').some(l => l.trim() === '.tlda/' || l.trim() === '.tlda')) {
          const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
          fs.writeFileSync(gitignorePath, existing + suffix + '.tlda/\n', 'utf8');
        }
      } catch {}
      // .tlda/scratch/ is fully tlda-managed — agents never edit it. Rewrite
      // the template whenever it doesn't match the current canonical content.
      if (scratchTemplatePath && scratchTemplateContent) {
        const templateAbsPath = path.join(sourceDir, scratchTemplatePath);
        const existing = fs.existsSync(templateAbsPath) ? fs.readFileSync(templateAbsPath, 'utf8') : null;
        if (existing !== scratchTemplateContent) fs.writeFileSync(templateAbsPath, scratchTemplateContent, 'utf8');
      }
      const scratchAbsPath = path.join(sourceDir, scratchPath);
      if (!isMd) fs.writeFileSync(scratchAbsPath, wrappedContent, 'utf8');
      if (result.sourcePath) {
        const symlinkPath = path.join(sourceDir, result.sourcePath);
        // Belt-and-suspenders: don't self-link
        if (path.resolve(symlinkPath) !== resolved) {
          try { fs.unlinkSync(symlinkPath); } catch {}
          fs.symlinkSync(resolved, symlinkPath);
        }
      }
      if (mainContent) {
        fs.writeFileSync(path.join(sourceDir, mainFile), mainContent, 'utf8');
      }
      if (targetFile && targetContent) {
        fs.writeFileSync(path.join(sourceDir, targetFile), targetContent, 'utf8');
      }
      const refValidation = validateRefs(content, doc);
      const refWarning = formatRefWarnings(refValidation);
      const lang = isMd ? 'markdown' : 'latex';
      const contentLines = content.split('\n');
      const preview = contentLines.length > 30
        ? contentLines.slice(0, 30).join('\n') + `\n… (${contentLines.length - 30} more lines)`
        : content;
      const contentBlock = `\n\n**Content written:**\n\`\`\`${lang}\n${preview}\n\`\`\``;
      if (result.action === 'replaced') {
        return { content: [{ type: 'text', text: `Replaced scratch section "${replace}". Your file: \`${resolved}\`. Watcher will rebuild on edits.${refWarning}${contentBlock}` }] };
      }
      const loc = after ? `after "${after}"` : `before "${before}"`;
      return { content: [{ type: 'text', text: `Inserted scratch section "${label}" ${loc}. Your file: \`${resolved}\`. Watcher will rebuild on edits.${refWarning}${contentBlock}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'inline_scratch') {
    const { doc, label } = args;
    if (!doc || !label) {
      return { content: [{ type: 'text', text: 'doc and label are required.' }], isError: true };
    }
    try {
      const result = await serverFetch(`/api/projects/${doc}/inline-scratch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const { mainFile, mainContent, scratchPath, sourceDir } = result;
      if (!sourceDir) {
        return { content: [{ type: 'text', text: `Error: project "${doc}" has no sourceDir — run the file watcher first.` }], isError: true };
      }
      fs.writeFileSync(path.join(sourceDir, mainFile), mainContent, 'utf8');
      const scratchAbsPath = path.join(sourceDir, scratchPath);
      try { fs.unlinkSync(scratchAbsPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { content: [{ type: 'text', text: `Inlined "${label}" into ${path.join(sourceDir, mainFile)} and removed ${scratchAbsPath}. Watcher will sync and rebuild.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'extract_to_scratch') {
    const { doc, startLine, endLine, name: scratchName, file: sourceFile } = args;
    if (!doc || !startLine || !endLine || !scratchName) {
      return { content: [{ type: 'text', text: 'doc, startLine, endLine, and name are required.' }], isError: true };
    }
    try {
      const projectInfo = await serverFetch(`/api/projects/${doc}`);
      if (!projectInfo) return { content: [{ type: 'text', text: `Document "${doc}" not found.` }], isError: true };
      const sourceDir = projectInfo.sourceDir;
      if (!sourceDir) return { content: [{ type: 'text', text: `No sourceDir for "${doc}".` }], isError: true };

      const texFile = sourceFile || projectInfo.mainFile || 'main.tex';
      const texPath = path.join(sourceDir, texFile);
      const texContent = fs.readFileSync(texPath, 'utf8');
      const lines = texContent.split('\n');
      const extracted = lines.slice(startLine - 1, endLine).join('\n');

      // Generate three format views
      let mdContent;
      try {
        mdContent = execSync('pandoc -f latex -t markdown --wrap=none', { input: extracted, encoding: 'utf8', timeout: 10000 });
      } catch (e) {
        return { content: [{ type: 'text', text: `pandoc conversion failed: ${e.message}` }], isError: true };
      }
      mdContent = mdContent.replace(/\\ref\{([\w:.-]+)\}/g, '@$1');

      const texView = extracted;

      // Outline: extract structural elements (environments, labels, refs, section commands)
      const outlineLines = [];
      for (const l of extracted.split('\n')) {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('%')) continue;
        const beginM = trimmed.match(/\\begin\{(\w+)\}(?:\[([^\]]*)\])?(?:\{([^}]*)\})?/);
        if (beginM) { outlineLines.push(`- **${beginM[1]}**${beginM[2] ? ` [${beginM[2]}]` : ''}${beginM[3] ? ` {${beginM[3]}}` : ''}`); continue; }
        const secM = trimmed.match(/\\(section|subsection|paragraph)\*?\{([^}]+)\}/);
        if (secM) { outlineLines.push(`- **${secM[1]}**: ${secM[2]}`); continue; }
        const labelM = trimmed.match(/\\label\{([^}]+)\}/);
        if (labelM) { outlineLines.push(`  - label: \`${labelM[1]}\``); continue; }
        const eqM = trimmed.match(/\\(eqref|ref)\{([^}]+)\}/g);
        if (eqM) { outlineLines.push(`  - refs: ${eqM.map(r => '`' + r + '`').join(', ')}`); }
      }
      const outlineView = outlineLines.length > 0 ? outlineLines.join('\n') : '(no structural elements found)';

      const scratchDir = path.join(sourceDir, 'scratch');
      fs.mkdirSync(scratchDir, { recursive: true });
      const mdPath = path.join(scratchDir, `${scratchName}.md`);
      fs.writeFileSync(mdPath, mdContent, 'utf8');

      const result = await addAnnotation(doc, startLine, mdContent, {
        color: 'violet', size: 'lg', side: 'right',
      });

      // Add format tabs to the created note
      if (result.ok) {
        try {
          const fullId = result.shapeId.startsWith('shape:') ? result.shapeId : `shape:${result.shapeId}`;
          await updateShapeRest(doc, fullId, {
            props: {
              tabs: [mdContent, texView, outlineView],
              activeTab: 0,
            },
          });
        } catch (e) {
          process.stderr.write(`[mcp] failed to add format tabs: ${e.message}\n`);
        }
      }

      const refValidation = validateRefs(mdContent, doc);
      const refWarning = formatRefWarnings(refValidation);
      return { content: [{ type: 'text', text: `Extracted lines ${startLine}–${endLine} to ${mdPath}${result.ok ? ` (note ${result.shapeId})` : ''}. Format tabs: prose / tex / outline.${refWarning}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'set_preamble') {
    const doc = args.doc;
    const version = args.version || null;
    if (!doc) {
      return { content: [{ type: 'text', text: 'doc is required (the document/project name whose macros to use).' }], isError: true };
    }
    // Best-effort: fetch the doc's macros only to report the count back to the
    // agent. A network failure here is non-fatal — we still set the preamble doc;
    // the count just shows 0. (True boundary: the macros endpoint may be down.)
    let macros = {};
    try {
      const res = await fetch(`${TLDA_SERVER}/api/projects/${encodeURIComponent(doc)}/macros`, { headers: TLDA_AUTH_HEADERS });
      if (res.ok) macros = (await res.json())?.macros || {};
    } catch (e) {
      process.stderr.write(`[mcp] set_preamble macro count fetch failed for ${doc}: ${e.message}\n`);
    }
    // Point this agent's preamble at the document. From now on this agent's chat
    // math is linted with `doc`'s macros, and every message it sends carries
    // preambleRef:{doc,version} so readers render it with `doc`'s preamble.
    setAgentPreambleDoc(doc, version);
    const count = Object.keys(macros).length;
    const vnote = version ? ` (version "${version}" stored but not yet used for resolution)` : '';
    return { content: [{ type: 'text', text: `Preamble set to document "${doc}"${vnote} — ${count} macro(s) available. Your chat math now renders and lints with ${doc}'s preamble; physics-package commands are always available too.` }] };
  }

  // Dispatch to fleet tools
  const fleetResult = await handleFleetTool(name, args);
  if (fleetResult !== null) return fleetResult;

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// Run synctex lookup for a single TLDraw coordinate
function synctexLookupCoord(x, y) {
  try {
    const result = execSync(
      `node "${path.join(PROJECT_ROOT, 'synctex-lookup.mjs')}" ${x} ${y}`,
      { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Parse the JSON output at the end
    const jsonMatch = result.match(/JSON: ({.*})/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getAnnotationSummary() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return 'No snapshot file found.';
  }

  try {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const annotations = [];

    for (const [id, record] of Object.entries(snapshot.store || {})) {
      if (record.typeName === 'shape' && record.type !== 'image') {
        const ann = {
          type: record.type,
          x: Math.round(record.x),
          y: Math.round(record.y),
          color: record.props?.color,
        };

        // Look up TeX source location
        const lookup = synctexLookupCoord(record.x, record.y);
        if (lookup) {
          ann.source = {
            file: lookup.file,
            line: lookup.line,
            page: lookup.page,
          };
        }

        annotations.push(ann);
      }
    }

    if (annotations.length === 0) {
      return 'No annotations found.';
    }

    let summary = `Found ${annotations.length} annotation(s):\n`;
    annotations.forEach((a, i) => {
      const colorStr = a.color ? ` (${a.color})` : '';
      summary += `  ${i + 1}. ${a.type}${colorStr} at (${a.x}, ${a.y})`;
      if (a.source) {
        const relPath = path.relative(PROJECT_ROOT, a.source.file);
        summary += `\n     → ${relPath}:${a.source.line}`;
        summary += `\n     → texsync://file${a.source.file}:${a.source.line}`;
      }
      summary += '\n';
    });

    return summary;
  } catch (e) {
    return `Error reading snapshot: ${e.message}`;
  }
}

// Start MCP server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Unified MCP server started (tlda + fleet)');

// Initialize fleet tools (channel WS, agent registration)
initFleet(server);

// ---- Process safety (from fleet MCP) ----

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[mcp] unhandled rejection (suppressed): ${reason?.message || reason}\n`);
});

process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: uncaught exception: ${err?.message || err}\n${err?.stack || ''}\n`;
  process.stderr.write(msg);
  try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
});

process.stdin.on('end', () => {
  const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: stdin end — parent closed pipe, exiting\n`;
  process.stderr.write(msg);
  try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
  process.exit(0);
});
process.stdin.on('close', () => {
  const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: stdin close — exiting\n`;
  process.stderr.write(msg);
  try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
  process.exit(0);
});

const _parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(_parentPid, 0);
  } catch {
    const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: parent ${_parentPid} dead, exiting as orphan\n`;
    process.stderr.write(msg);
    try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
    process.exit(0);
  }
}, 30000);

for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: received ${sig}, exiting\n`;
    process.stderr.write(msg);
    try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  process.stderr.write(`[${new Date().toISOString()}] mcp PID ${process.pid}: received SIGINT, ignoring\n`);
});

process.on('exit', (code) => {
  const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: process.exit(${code}) — catch-all\n`;
  try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
});
process.on('beforeExit', (code) => {
  const msg = `[${new Date().toISOString()}] mcp PID ${process.pid}: beforeExit(${code}) — event loop drained\n`;
  process.stderr.write(msg);
  try { fs.appendFileSync('/tmp/fleet-mcp-exit.log', msg); } catch {}
});
