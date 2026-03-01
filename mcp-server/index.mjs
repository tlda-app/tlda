#!/usr/bin/env node
/**
 * MCP Server for TLDraw Feedback
 *
 * Provides:
 * - HTTP endpoint to receive snapshots from Share button
 * - MCP tools to wait for / check feedback
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { getIndexAbove } from '@tldraw/utils';
import { findRenderedText } from './svg-text.mjs';
import { initDataSource, readJsonSync, readManifestSync, readManifest, localDocDir, isRemote } from './data-source.mjs';
import { resolveToken } from './resolve-token.mjs';

const CTD_TOKEN = resolveToken();
const CTD_AUTH_HEADERS = CTD_TOKEN ? { 'Authorization': `Bearer ${CTD_TOKEN}` } : {};
const CTD_SERVER = process.env.CTD_SERVER || 'http://localhost:5176';
// Separate sync server for shapes/signals (e.g. Fly.io) — falls back to CTD_SERVER
const CTD_SYNC_SERVER = process.env.CTD_SYNC_SERVER || CTD_SERVER;

// ---- REST API helpers (shape CRUD via @tldraw/sync rooms) ----

async function serverFetch(urlPath, options = {}) {
  const url = `${CTD_SYNC_SERVER}${urlPath}`;
  const headers = { ...CTD_AUTH_HEADERS, ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${urlPath} → ${res.status}: ${body}`);
  }
  return res.json();
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
  } catch {}
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

/**
 * Connect to signal SSE stream. Returns { close() }.
 * Calls onSignal(signal) for each signal broadcast ({key, ...data, timestamp}).
 */
function connectSignalStream(docName, onSignal) {
  const url = `${CTD_SYNC_SERVER}/api/projects/${docName}/signal/stream`;
  const headers = { ...CTD_AUTH_HEADERS, 'Accept': 'text/event-stream' };

  const urlObj = new URL(url);
  const req = http.request({
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname,
    method: 'GET',
    headers,
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[SSE] Signal stream ${docName}: HTTP ${res.statusCode}`);
      return;
    }
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const block of lines) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6));
          if (event.type !== 'connected') {
            onSignal(event);
          }
        } catch {}
      }
    });
  });
  req.on('error', (e) => {
    console.error(`[SSE] Signal stream ${docName} error: ${e.message}`);
  });
  req.end();

  return {
    close() {
      try { req.destroy(); } catch {}
    },
  };
}

/**
 * Connect to shape change SSE stream. Returns { eventSource, close() }.
 * Calls onChange() whenever shapes change in the sync room.
 */
function connectShapeStream(docName, onChange) {
  const url = `${CTD_SYNC_SERVER}/api/projects/${docName}/shapes/stream`;
  const headers = { ...CTD_AUTH_HEADERS, 'Accept': 'text/event-stream' };

  // Node doesn't have native EventSource, so use raw HTTP
  const urlObj = new URL(url);
  const req = http.request({
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname,
    method: 'GET',
    headers,
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[SSE] Shape stream ${docName}: HTTP ${res.statusCode}`);
      return;
    }
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      // Parse SSE: lines starting with "data: " followed by \n\n
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep incomplete last chunk
      for (const block of lines) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6));
          if (event.type !== 'connected') {
            onChange(event);
          }
        } catch {}
      }
    });
  });
  req.on('error', (e) => {
    console.error(`[SSE] Shape stream ${docName} error: ${e.message}`);
  });
  req.end();

  return {
    close() {
      try { req.destroy(); } catch {}
    },
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = '/tmp/tldraw-snapshot.json';
const SCREENSHOT_PATH = '/tmp/annotated-view.png';

// ---- Headless screenshot fallback ----

let _browser = null;
let _browserIdleTimer = null;
const BROWSER_IDLE_MS = 120_000; // close after 2min idle

async function getHeadlessBrowser() {
  if (_browser && _browser.connected) {
    clearTimeout(_browserIdleTimer);
    return _browser;
  }
  const puppeteer = await import('puppeteer');
  _browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  return _browser;
}

function scheduleBrowserClose() {
  clearTimeout(_browserIdleTimer);
  _browserIdleTimer = setTimeout(async () => {
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  }, BROWSER_IDLE_MS);
}

/** Check if a document has built pages. Returns { ok, pages, buildStatus } or { ok: false, reason }. */
async function checkDocBuildStatus(docName) {
  const sUrl = process.env.CTD_SERVER || 'http://localhost:5176';
  try {
    const res = await fetch(`${sUrl}/api/projects/${docName}`, { headers: CTD_AUTH_HEADERS });
    if (res.ok) {
      const info = await res.json();
      if (!info.pages || info.pages === 0) {
        const status = info.buildStatus || 'unknown';
        if (status === 'building') return { ok: false, reason: `Document "${docName}" is currently building — no pages available yet` };
        return { ok: false, reason: `Document "${docName}" has no built pages (build status: ${status})` };
      }
      return { ok: true, pages: info.pages, buildStatus: info.buildStatus };
    }
    // API returned error — fall back to disk check
    return checkDocBuildStatusDisk(docName);
  } catch (e) {
    // No local server — fall back to disk (project.json or manifest)
    const diskResult = checkDocBuildStatusDisk(docName);
    if (diskResult.ok) return diskResult;
    if (e?.cause?.code === 'ECONNREFUSED' || e?.code === 'ECONNREFUSED') {
      // Disk also failed — if we have a separate sync server, that's fine (doc assets are on disk)
      if (process.env.CTD_SYNC_SERVER) return diskResult;
      return { ok: false, reason: 'Server is not running (connection refused on port 5176). Start it with "ctd server start"' };
    }
    return diskResult;
  }
}

/** Disk-based fallback: check project.json directly. */
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
    return { ok: false, reason: `Project "${docName}" not found on server. Run "ctd errors ${docName}" or "ctd build ${docName}" to investigate.` };
  }
}

async function headlessScreenshot(docName, targetPage) {
  const serverUrl = process.env.CTD_SERVER || 'http://localhost:5176';
  const url = `${serverUrl}/?doc=${docName}`;
  const browser = await getHeadlessBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 960 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Wait for TLDraw to render shapes
    await page.waitForSelector('.tl-shapes', { timeout: 15000 });
    // Let annotations sync from Yjs
    await new Promise(r => setTimeout(r, 3000));

    if (targetPage) {
      await page.evaluate((pg) => {
        const pageHeight = 792 * (800 / 612); // PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
        const pageGap = 32;
        const y = (pg - 1) * (pageHeight + pageGap) + pageHeight / 2;
        const editor = window.__tldraw_editor__;
        if (editor) {
          editor.centerOnPoint({ x: 400, y });
        }
      }, targetPage);
      await new Promise(r => setTimeout(r, 500));
    }

    const buf = await page.screenshot({ type: 'png' });
    const base64 = buf.toString('base64');
    return base64;
  } finally {
    await page.close();
    scheduleBrowserClose();
  }
}

// Initialize data source: HTTP fetch when CTD_SERVER is set, disk read otherwise
initDataSource(PROJECT_ROOT, process.env.CTD_SERVER || null);

// ---- Lookup.json support ----

function loadLookup(docName) {
  return readJsonSync(docName, 'lookup.json');
}

function lookupLine(docName, lineNum, file) {
  const lookup = loadLookup(docName);
  if (!lookup?.lines) return null;
  // If file is given, try "filename.tex:lineNum" key first (multi-file project)
  let entry = null;
  if (file) {
    const fname = path.basename(file);
    entry = lookup.lines[`${fname}:${lineNum}`];
  }
  // Fall back to plain line number (main file)
  if (!entry) entry = lookup.lines[lineNum.toString()];
  if (!entry) return null;
  return { page: entry.page, x: entry.x, y: entry.y, content: entry.content, texFile: lookup.meta?.texFile };
}

// PDF → canvas coordinate conversion (constants from shared/layout-constants.json)
const _lc = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'shared', 'layout-constants.json'), 'utf8'));
const PDF_WIDTH = _lc.PDF_WIDTH;
const PDF_HEIGHT = _lc.PDF_HEIGHT;
const PAGE_WIDTH = _lc.TARGET_WIDTH;
const PAGE_HEIGHT = PDF_HEIGHT * (PAGE_WIDTH / PDF_WIDTH);
const PAGE_GAP = _lc.PAGE_GAP;

function pdfToCanvas(page, pdfX, pdfY) {
  const pageY = (page - 1) * (PAGE_HEIGHT + PAGE_GAP);
  const scaleX = PAGE_WIDTH / PDF_WIDTH;
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT;
  return {
    x: pdfX * scaleX,
    y: pageY + pdfY * scaleY,
  };
}

function canvasToPdf(canvasX, canvasY) {
  const page = Math.floor(canvasY / (PAGE_HEIGHT + PAGE_GAP)) + 1;
  const localY = canvasY - (page - 1) * (PAGE_HEIGHT + PAGE_GAP);
  const scaleX = PAGE_WIDTH / PDF_WIDTH;
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT;
  return {
    page,
    pdfX: canvasX / scaleX,
    pdfY: localY / scaleY,
  };
}

// ---- HTML document layout support ----

const pageInfoCache = new Map(); // docName → computed layout
const HTML_PAGE_SPACING = PAGE_GAP;
const HTML_TAB_SPACING = 24;

function loadHtmlLayout(docName) {
  if (pageInfoCache.has(docName)) return pageInfoCache.get(docName);
  const pageInfos = readJsonSync(docName, 'page-info.json');
  if (!pageInfos) return null;
  const layout = computeHtmlLayout(pageInfos);
  pageInfoCache.set(docName, layout);
  return layout;
}

function computeHtmlLayout(pageInfos) {
  // Replicates svgDocumentLoader.ts layout algorithm
  const pages = []; // { x, y, width, height } per page (0-indexed)
  let top = 0;
  let widest = 0;
  let i = 0;

  while (i < pageInfos.length) {
    const info = pageInfos[i];
    if (!info.group) {
      pages.push({ x: 0, y: top, width: info.width, height: info.height });
      top += info.height + HTML_PAGE_SPACING;
      widest = Math.max(widest, info.width);
      i++;
    } else {
      const groupId = info.group;
      let left = 0;
      let tallest = 0;
      while (i < pageInfos.length && pageInfos[i].group === groupId) {
        const gp = pageInfos[i];
        pages.push({ x: left, y: top, width: gp.width, height: gp.height });
        left += gp.width + HTML_TAB_SPACING;
        tallest = Math.max(tallest, gp.height);
        i++;
      }
      const groupWidth = left - HTML_TAB_SPACING;
      widest = Math.max(widest, groupWidth);
      top += tallest + HTML_PAGE_SPACING;
    }
  }

  // Center: single pages individually, tab groups as units
  for (let j = 0; j < pages.length; j++) {
    if (!pageInfos[j].group) {
      pages[j].x = (widest - pages[j].width) / 2;
    }
  }
  const groupOffsets = new Map();
  for (let j = 0; j < pageInfos.length; j++) {
    const g = pageInfos[j].group;
    if (!g || groupOffsets.has(g)) continue;
    let gw = 0, k = j;
    while (k < pageInfos.length && pageInfos[k].group === g) {
      gw += pageInfos[k].width + HTML_TAB_SPACING;
      k++;
    }
    gw -= HTML_TAB_SPACING;
    groupOffsets.set(g, { startIdx: j, totalWidth: gw });
  }
  for (const [, { startIdx, totalWidth }] of groupOffsets) {
    const offset = (widest - totalWidth) / 2;
    let k = startIdx;
    while (k < pageInfos.length && pageInfos[k].group === pageInfos[startIdx].group) {
      pages[k].x += offset;
      k++;
    }
  }

  return { pages, widest };
}

function isHtmlDoc(docName) {
  const lookup = loadLookup(docName);
  if (lookup?.meta?.format === 'html') return true;
  const manifest = readManifestSync();
  return manifest?.documents?.[docName]?.format === 'html';
}

function htmlToCanvas(docName, page, localX, localY) {
  const layout = loadHtmlLayout(docName);
  if (!layout || page < 1 || page > layout.pages.length) return null;
  const p = layout.pages[page - 1];
  return { x: p.x + localX, y: p.y + localY };
}

function canvasToHtml(docName, canvasX, canvasY) {
  const layout = loadHtmlLayout(docName);
  if (!layout) return null;
  // Find which page contains this point (check both X and Y for tab groups)
  let bestMatch = null;
  let bestDist = Infinity;
  for (let i = 0; i < layout.pages.length; i++) {
    const p = layout.pages[i];
    if (canvasY >= p.y && canvasY < p.y + p.height + HTML_PAGE_SPACING) {
      if (canvasX >= p.x && canvasX < p.x + p.width) {
        // Exact hit
        return { page: i + 1, localX: canvasX - p.x, localY: canvasY - p.y };
      }
      // Track closest page in this Y band
      const dx = canvasX < p.x ? p.x - canvasX : canvasX - (p.x + p.width);
      if (dx < bestDist) {
        bestDist = dx;
        bestMatch = i;
      }
    }
  }
  if (bestMatch !== null) {
    const p = layout.pages[bestMatch];
    return { page: bestMatch + 1, localX: canvasX - p.x, localY: canvasY - p.y };
  }
  // Past the last page — assign to last
  const last = layout.pages.length;
  const lp = layout.pages[last - 1];
  return { page: last, localX: canvasX - lp.x, localY: canvasY - lp.y };
}

// Format-aware coordinate conversion
function docToCanvas(docName, page, x, y) {
  if (isHtmlDoc(docName)) {
    const result = htmlToCanvas(docName, page, x, y);
    if (result) return result;
    // Fallback: treat as simple vertical stack
    return { x, y: (page - 1) * 432 + y };
  }
  return pdfToCanvas(page, x, y);
}

function canvasToDoc(docName, canvasX, canvasY) {
  if (isHtmlDoc(docName)) {
    const result = canvasToHtml(docName, canvasX, canvasY);
    if (!result) return { page: 1, pdfX: canvasX, pdfY: canvasY };
    return { page: result.page, pdfX: result.localX, pdfY: result.localY };
  }
  return canvasToPdf(canvasX, canvasY);
}

function getPageWidth(docName) {
  if (isHtmlDoc(docName)) {
    const layout = loadHtmlLayout(docName);
    return layout?.pages?.[0]?.width || 800;
  }
  return PAGE_WIDTH;
}

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
      const sourceLine = record.meta?.sourceLine || null;
      shapes.push({ id, shapeType: tool, color, gesture, page: pos.page, position: pos.description,
        bbox, lines: nearbyLines, rendered, createdAt, highlightText, highlightLines, sourceLine });
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
  const linePos = lookupLine(doc, line, file);
  if (!linePos) return { ok: false, error: `Line ${line}${file ? ' in ' + path.basename(file) : ''} not found in lookup.json for doc "${doc}"` };

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
  } catch {}

  return { ok: false, error: `Line ${line} not found in lookup or synctex` };
}

async function addAnnotation(doc, line, text, { color = 'orange', width = 200, height = 150, side = 'right', file, choices, page: pageNum } = {}) {
  let linePos;
  if (line) {
    linePos = lookupLine(doc, line, file);
    if (!linePos) return { ok: false, error: `Line ${line}${file ? ' in ' + path.basename(file) : ''} not found in lookup.json for doc "${doc}"` };
  } else if (pageNum) {
    // Position near top of the given page when no source line is available
    linePos = { page: pageNum, x: 0, y: 150, texFile: null, content: '' };
  } else {
    return { ok: false, error: 'Either line or page is required' };
  }

  const canvasPos = docToCanvas(doc, linePos.page, linePos.x, linePos.y);
  // Position note at left or right margin of the page
  let x;
  if (isHtmlDoc(doc)) {
    const layout = loadHtmlLayout(doc);
    const p = layout?.pages?.[linePos.page - 1];
    const pageRight = p ? p.x + p.width : canvasPos.x + 800;
    const pageLeft = p ? p.x : 0;
    x = side === 'left' ? pageLeft - width - 20 : pageRight + 10;
  } else {
    x = side === 'left' ? -width - 20 : 690;
  }
  const y = canvasPos.y - height / 2;

  const shapeId = generateShapeId();

  // Find the highest index among existing shapes so the note renders on top
  let maxIndex = 'a1';
  try {
    const allShapes = await fetchShapes(doc);
    for (const s of allShapes) {
      if (s.typeName === 'shape' && s.index && s.index > maxIndex) {
        maxIndex = s.index;
      }
    }
  } catch {}
  const noteIndex = getIndexAbove(maxIndex);

  const shape = {
    id: shapeId,
    type: 'math-note',
    typeName: 'shape',
    x, y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: width, h: height, text, color, autoSize: true, ...(choices?.length ? { choices, selectedChoice: -1 } : {}) },
    meta: {
      sourceAnchor: {
        file: `./${linePos.texFile || doc + '.tex'}`,
        line,
        column: -1,
        content: linePos.content,
      },
    },
    parentId: 'page:page',
    index: noteIndex,
  };

  await createShapeRest(doc, shape);

  return { ok: true, shapeId, page: linePos.page, x, y };
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
    const ann = {
      id: record.id,
      x: Math.round(record.x || 0),
      y: Math.round(record.y || 0),
      color: record.props?.color,
      text: record.props?.text || '',
      anchor: anchor ? `${anchor.file}:${anchor.line}` : null,
      content: anchor?.content || null,
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
      sync: { server: CTD_SYNC_SERVER, docAssets: CTD_SERVER },
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

  // GET /annotations?doc=<name>
  if (req.method === 'GET' && req.url?.startsWith('/annotations')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const doc = url.searchParams.get('doc');
    if (!doc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: doc' }));
      return;
    }
    try {
      const result = await listAnnotations(doc);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /shapes?doc=<name> — read all shapes from sync room + signals from Yjs
  if (req.method === 'GET' && req.url?.startsWith('/shapes')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const docName = url.searchParams.get('doc');
    if (!docName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: doc' }));
      return;
    }
    try {
      // Shapes from @tldraw/sync room via REST
      const records = await fetchShapes(docName);
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

// WebSocket server for forward sync (Claude → iPad)
const WS_PORT = 5175;
let wss = null;
const wsClients = new Set();

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
} catch {
  console.error(`Port ${WS_PORT} in use — skipping WebSocket server`);
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
const server = new Server(
  { name: 'tldraw-feedback', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'wait_for_feedback',
      description: 'Wait for feedback from the iPad. Blocks until user hits the ping button, draws a shape, selects text, or edits a note. Returns a screenshot and summary of math-note sticky notes. To read pen/highlighter strokes, call read_pen_annotations separately.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            description: 'Document name (e.g. "bregman")',
          },
          timeout: {
            type: 'number',
            description: 'Max seconds to wait (default: 300)',
          },
        },
        required: ['doc'],
      },
    },
    {
      name: 'wait_for_any_feedback',
      description: 'Wait for feedback from ANY active document. Connects to all project Yjs rooms simultaneously and returns the first feedback from any of them. Yields to terminal agents: skips docs where another agent has a recent heartbeat. Returns the same format as wait_for_feedback, plus a "doc" field identifying which document.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: {
            type: 'number',
            description: 'Max seconds to wait (default: 300)',
          },
        },
      },
    },
    {
      name: 'check_feedback',
      description: 'Check if there is new feedback since last check. Non-blocking.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            description: 'Document name (e.g. "bregman")',
          },
        },
        required: ['doc'],
      },
    },
    {
      name: 'get_latest_feedback',
      description: 'Get the latest feedback screenshot, regardless of whether it is new.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            description: 'Document name (e.g. "bregman")',
          },
        },
      },
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of the viewer on demand. Sends a request via Yjs and waits for the viewer to capture and return the viewport image. If page is specified, scrolls there first.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            description: 'Document name (e.g. "bregman")',
          },
          page: {
            type: 'number',
            description: 'Page number to scroll to before capturing (optional — captures current viewport if omitted)',
          },
        },
        required: ['doc'],
      },
    },
    {
      name: 'highlight_location',
      description: 'Highlight a location in the TLDraw canvas on the iPad. Use this for forward sync from TeX source to iPad.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            description: 'Document name (e.g. "bregman"). If omitted, inferred from file path.',
          },
          file: {
            type: 'string',
            description: 'Path to the TeX file',
          },
          line: {
            type: 'number',
            description: 'Line number in the TeX file',
          },
        },
        required: ['file', 'line'],
      },
    },
    {
      name: 'add_annotation',
      description: 'Add a math note annotation to the document at a specific source line. The note appears in the TLDraw canvas and syncs to all viewers.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to anchor the note to. Required unless page is given.' },
          page: { type: 'number', description: 'Page number to place the note on (use when no source line is available).' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: orange). Convention: orange=claude, green=todd, violet=user.' },
          width: { type: 'number', description: 'Note width in pixels (default: 200)' },
          height: { type: 'number', description: 'Note height in pixels (default: 150)' },
          side: { type: 'string', description: 'Place note to "left" or "right" of page (default: right)' },
          file: { type: 'string', description: 'Source file path or name (for multi-file projects, e.g. "appendix.tex"). Omit for main file.' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Multiple-choice options rendered as tappable buttons. User selection readable via list_annotations or wait_for_feedback.' },
        },
        required: ['doc', 'text'],
      },
    },
    {
      name: 'list_annotations',
      description: 'List all math-note annotations (sticky notes) in a document. Does NOT include pen strokes, highlights, or drawn shapes — use read_pen_annotations for those.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'reply_annotation',
      description: 'Reply to an annotation by creating a new note in its thread. The reply appears as a new tab on the note. The target can be any note in a thread (root or reply) — the reply always joins the same thread.',
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
      name: 'mark_done',
      description: 'Mark an annotation as done. Collapses and dims the note. By default, also moves it to the page margin (like the viewer\'s done button). Set margin=false to keep it in place.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          id: { type: 'string', description: 'Shape ID (e.g. "shape:abc123")' },
          margin: { type: 'boolean', description: 'Move note to the page margin (default: true)', default: true },
        },
        required: ['doc', 'id'],
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
      name: 'read_pen_annotations',
      description: 'Read drawn annotations from the TLDraw canvas: pen strokes, highlighter strokes, arrows, rectangles/ellipses, text labels, and lines. Returns each shape with its type, color, position, and the document lines it covers. Arrows include start/end source lines and direction. Geo shapes (rectangles, ellipses) report the region they enclose. Use this to interpret the user\'s visual annotations without needing a screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'signal_reload',
      description: 'Signal the viewer to reload SVG pages. Use after rebuilding SVGs from DVI. Partial reload refreshes specific pages (~0.5s), full reload refreshes everything and remaps annotations.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          pages: {
            type: 'array',
            items: { type: 'number' },
            description: 'Page numbers to reload (1-indexed). Omit for full reload.',
          },
        },
        required: ['doc'],
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
          endLine: { type: 'number', description: 'Last source line to highlight (same as startLine for single line)' },
          color: { type: 'string', description: 'Highlight color: yellow, light-blue, light-green, light-violet, light-red, orange (default: orange)' },
          file: { type: 'string', description: 'Source file path or name (for multi-file projects). Omit for main file.' },
        },
        required: ['doc', 'startLine', 'endLine'],
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
      name: 'scroll_to_line',
      description: 'Scroll the viewer to a source line. Looks up the line position and broadcasts a scroll command to all connected viewers.',
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
      name: 'send_note',
      description: 'Drop a quick note at a source line. Creates a persistent math-note in Yjs and broadcasts via WebSocket for immediate visibility on all viewers.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to place the note at. Required unless page is given.' },
          page: { type: 'number', description: 'Page number to place the note on (use when no source line is available).' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: orange). Convention: orange=claude, green=todd, violet=user.' },
          file: { type: 'string', description: 'Source file path or name (for multi-file projects, e.g. "appendix.tex"). Omit for main file.' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Multiple-choice options rendered as tappable buttons. User selection readable via list_annotations or wait_for_feedback.' },
        },
        required: ['doc', 'text'],
      },
    },
  ],
}));

// Track last checked time for check_feedback
let lastCheckedTime = 0;
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
  'wait_for_feedback', 'screenshot', 'get_latest_feedback',
  'highlight_location', 'add_annotation', 'send_note',
  'scroll_to_line', 'read_pen_annotations',
  'draw_highlight', 'draw_arrow',
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
        return { content: [{ type: 'text', text: `${buildCheck.reason}. Run "ctd errors ${docName}" or "ctd build ${docName}" to investigate.` }], isError: true };
      }
    }
  }

  if (name === 'wait_for_feedback') {
    const timeout = (args?.timeout || 300) * 1000;
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    let heartbeatInterval;
    let shapeStream;
    let signalStream;
    try {
      // Signal that an agent is listening
      writeAgentHeartbeat(docName, 'listening', 'claude');
      heartbeatInterval = setInterval(() => writeAgentHeartbeat(docName, 'listening', 'claude'), 15000);

      // Initialize ping timestamp from signal cache so stale pings are ignored
      const existingPing = await readSignalRest(docName, 'signal:ping');
      if (existingPing?.timestamp > lastPingTimestamp) {
        if (lastPingTimestamp > 0) {
          lastPingTimestamp = existingPing.timestamp;
          clearInterval(heartbeatInterval);
          writeAgentHeartbeat(docName, 'thinking', 'claude');
          return { content: [{ type: 'text', text: await formatPing(existingPing, docName) }] };
        }
        lastPingTimestamp = existingPing.timestamp;
      }

      // Snapshot current shapes (from @tldraw/sync via REST) for diffing
      const knownShapes = new Map(); // id → shape
      try {
        const allShapes = await fetchShapes(docName);
        for (const s of allShapes) {
          if (s.typeName === 'shape') knownShapes.set(s.id, s);
        }
      } catch (e) {
        console.error(`[wait] Failed to snapshot shapes for ${docName}: ${e.message}`);
      }

      const DEBOUNCE_MS = 5000;
      const waitPromise = new Promise(resolve => {
        let debounceTimer = null;
        let pendingResult = null;
        let resolved = false;

        function cleanup() {
          if (debounceTimer) clearTimeout(debounceTimer);
          if (signalStream) { signalStream.close(); signalStream = null; }
          if (shapeStream) { shapeStream.close(); shapeStream = null; }
        }

        function doResolve(result) {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(result);
        }

        // --- Signal SSE stream: ping, text-selection ---
        signalStream = connectSignalStream(docName, (signal) => {
          if (resolved) return;
          if (signal.key === 'signal:ping') {
            if (signal.timestamp > lastPingTimestamp) {
              lastPingTimestamp = signal.timestamp;
              doResolve({ type: 'ping', ping: signal });
            }
            return;
          }
          if (signal.key === 'signal:text-selection') {
            if (signal.text) {
              pendingResult = { type: 'text-selection', sel: signal };
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                doResolve(pendingResult);
              }, 2000);
            }
            return;
          }
        });

        // --- SSE stream: shape changes (from @tldraw/sync rooms) ---
        shapeStream = connectShapeStream(docName, async () => {
          if (resolved) return;
          // Debounce shape changes
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            if (resolved) return;
            try {
              // Fetch current shapes and diff against snapshot
              const currentShapes = await fetchShapes(docName);
              for (const record of currentShapes) {
                if (record.typeName !== 'shape') continue;
                const known = knownShapes.get(record.id);

                if (!known) {
                  // New shape
                  knownShapes.set(record.id, record);
                  if (record.type === 'math-note') {
                    const choices = record.props?.choices;
                    const sel = record.props?.selectedChoice;
                    if (choices?.length && sel != null && sel >= 0) {
                      doResolve({ type: 'choice', key: record.id, record, choiceIndex: sel, choiceText: choices[sel] });
                      return;
                    }
                    const text = record.props?.text || '';
                    if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue;
                    doResolve({ type: 'annotation', key: record.id, action: 'add', record });
                    return;
                  }
                  if (['draw', 'highlight', 'arrow', 'geo', 'text', 'line'].includes(record.type)) {
                    doResolve({ type: 'stroke', key: record.id, action: 'add', record });
                    return;
                  }
                } else {
                  // Updated shape — check for meaningful changes
                  const oldJson = JSON.stringify(known.props);
                  const newJson = JSON.stringify(record.props);
                  if (oldJson !== newJson) {
                    knownShapes.set(record.id, record);
                    if (record.type === 'math-note') {
                      const choices = record.props?.choices;
                      const sel = record.props?.selectedChoice;
                      if (choices?.length && sel != null && sel >= 0 && sel !== known.props?.selectedChoice) {
                        doResolve({ type: 'choice', key: record.id, record, choiceIndex: sel, choiceText: choices[sel] });
                        return;
                      }
                      const text = record.props?.text || '';
                      if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue;
                      doResolve({ type: 'annotation', key: record.id, action: 'update', record });
                      return;
                    }
                  }
                }
              }
            } catch (e) {
              console.error(`[wait] Shape diff error: ${e.message}`);
            }
          }, DEBOUNCE_MS);
        });

        // Also resolve on HTTP snapshot (backward compat)
        waitingResolvers.push(() => {
          doResolve({ type: 'http-snapshot' });
        });
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout waiting for feedback')), timeout);
      });

      const result = await Promise.race([waitPromise, timeoutPromise]);
      clearInterval(heartbeatInterval);
      if (shapeStream) { shapeStream.close(); shapeStream = null; }
      if (signalStream) { signalStream.close(); signalStream = null; }
      writeAgentHeartbeat(docName, 'thinking', 'claude');

      if (result?.type === 'http-snapshot') {
        return { content: [{ type: 'text', text: `New feedback received!\n\n${lastRenderOutput}` }] };
      }

      if (result?.type === 'text-selection') {
        const sel = result.sel;
        return { content: [{ type: 'text', text: `Text selected (page ${sel.page}):\n  "${sel.text}"` }] };
      }

      if (result?.type === 'ping') {
        return { content: [{ type: 'text', text: await formatPing(result.ping, docName) }] };
      }

      if (result?.type === 'choice') {
        const r = result.record;
        const anchor = r.meta?.sourceAnchor;
        let text = `Choice selected on ${result.key}:\n`;
        text += `  question: "${r.props?.text || ''}"\n`;
        text += `  selected: ${result.choiceIndex} — "${result.choiceText}"\n`;
        text += `  all choices: ${r.props.choices.map((c, i) => i === result.choiceIndex ? `[${c}]` : c).join(' | ')}\n`;
        if (anchor) text += `  anchor: ${anchor.file}:${anchor.line}`;
        return { content: [{ type: 'text', text }] };
      }

      // Shape drawn (draw/highlight/arrow/geo/text/line)
      if (result?.type === 'stroke') {
        const formatted = formatStrokeResult(result.record, docName, '', null, 'claude');
        // Append nearby-shapes context
        let text = formatted.content[0].text;
        if (formatted.page != null) {
          try {
            const allShapes = await collectDrawnShapes(docName);
            const ctx = buildNearbyContext(allShapes, result.key, formatted.page);
            if (ctx) text += '\n' + ctx;
          } catch {}
        }
        return { content: [{ type: 'text', text }] };
      }

      // Annotation change (math-note)
      const r = result.record;
      const anchor = r.meta?.sourceAnchor;
      const loc = anchor ? `${anchor.file}:${anchor.line}` : `(${r.x?.toFixed(0)}, ${r.y?.toFixed(0)})`;
      if (r.x != null && r.y != null) writeAgentAttention(docName, r.x, r.y, 'claude');
      // Include nearby context for annotation changes too
      let noteText = `Annotation ${result.action}: ${result.key}\n  [${r.props?.color}] ${loc}\n  "${r.props?.text}"`;
      try {
        const allShapes = await collectDrawnShapes(docName);
        const noteBBox = { minX: r.x, minY: r.y, maxX: r.x + 10, maxY: r.y + 10 };
        const notePos = describePagePosition(docName, noteBBox);
        const ctx = buildNearbyContext(allShapes, result.key, notePos.page);
        if (ctx) noteText += '\n' + ctx;
      } catch {}
      const summary = await summarizeAnnotations(docName);
      return { content: [{ type: 'text', text: noteText + '\n\n' + summary }] };
    } catch (e) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (shapeStream) { shapeStream.close(); shapeStream = null; }
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'wait_for_any_feedback') {
    const timeout = (args?.timeout || 300) * 1000;

    // Discover active docs from manifest
    const manifest = await readManifest();
    const docNames = manifest?.documents ? Object.keys(manifest.documents) : [];
    if (docNames.length === 0) {
      return { content: [{ type: 'text', text: 'No documents found. Is the server running with projects?' }], isError: true };
    }

    // Filter docs by agent heartbeat — skip docs where a terminal agent is active
    const HEARTBEAT_STALE_MS = 60000;
    const activeDocs = [];
    for (const docName of docNames) {
      const hb = await readSignalRest(docName, 'signal:agent-heartbeat');
      if (hb?.state === 'thinking' && hb.timestamp && (Date.now() - hb.timestamp) < HEARTBEAT_STALE_MS) {
        console.error(`[wait_for_any] Skipping ${docName} — terminal agent active`);
        continue;
      }
      activeDocs.push(docName);
    }

    if (activeDocs.length === 0) {
      return { content: [{ type: 'text', text: 'All documents have active terminal agents. No docs to monitor.' }], isError: true };
    }

    const heartbeatIntervals = [];
    for (const docName of activeDocs) {
      writeAgentHeartbeat(docName, 'listening', 'todd');
      heartbeatIntervals.push(setInterval(async () => {
        const hb = await readSignalRest(docName, 'signal:agent-heartbeat');
        if (hb?.state === 'thinking' && hb.timestamp && (Date.now() - hb.timestamp) < HEARTBEAT_STALE_MS) return;
        writeAgentHeartbeat(docName, 'listening', 'todd');
      }, 15000));
    }

    if (!global._anyFeedbackPingBaselines) global._anyFeedbackPingBaselines = new Map();
    const pingBaselines = global._anyFeedbackPingBaselines;
    for (const docName of activeDocs) {
      if (!pingBaselines.has(docName)) {
        const existingPing = await readSignalRest(docName, 'signal:ping');
        pingBaselines.set(docName, existingPing?.timestamp || 0);
      }
    }

    // Snapshot shapes per doc via REST
    const knownShapes = new Map(); // docName → Map(id → shape)
    for (const docName of activeDocs) {
      try {
        const shapes = await fetchShapes(docName);
        const m = new Map();
        for (const s of shapes) { if (s.typeName === 'shape') m.set(s.id, s); }
        knownShapes.set(docName, m);
      } catch {
        knownShapes.set(docName, new Map());
      }
    }

    const DEBOUNCE_MS = 5000;
    const shapeStreams = [];
    const signalStreams = [];

    try {
      const waitPromise = new Promise(resolve => {
        let debounceTimer = null;
        let resolved = false;

        function doResolve(result) {
          if (resolved) return;
          resolved = true;
          if (debounceTimer) clearTimeout(debounceTimer);
          for (const s of signalStreams) s.close();
          for (const s of shapeStreams) s.close();
          signalStreams.length = 0;
          shapeStreams.length = 0;
          resolve(result);
        }

        // --- Signal SSE streams: ping, text-selection ---
        for (const docName of activeDocs) {
          const stream = connectSignalStream(docName, (signal) => {
            if (resolved) return;

            if (signal.key === 'signal:ping') {
              const baseline = pingBaselines.get(docName) || 0;
              if (signal.timestamp > baseline) {
                pingBaselines.set(docName, signal.timestamp);
                doResolve({ type: 'ping', ping: signal, docName });
              }
              return;
            }
            if (signal.key === 'signal:text-selection') {
              if (signal.text) {
                if (debounceTimer) clearTimeout(debounceTimer);
                const pending = { type: 'text-selection', sel: signal, docName };
                debounceTimer = setTimeout(() => doResolve(pending), 2000);
              }
              return;
            }
          });
          signalStreams.push(stream);
        }

        // --- SSE streams: shape changes ---
        for (const docName of activeDocs) {
          const stream = connectShapeStream(docName, async () => {
            if (resolved) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              if (resolved) return;
              try {
                const currentShapes = await fetchShapes(docName);
                const known = knownShapes.get(docName) || new Map();
                for (const record of currentShapes) {
                  if (record.typeName !== 'shape') continue;
                  const prev = known.get(record.id);
                  if (!prev) {
                    known.set(record.id, record);
                    if (record.type === 'math-note') {
                      const choices = record.props?.choices;
                      const sel = record.props?.selectedChoice;
                      if (choices?.length && sel != null && sel >= 0) {
                        doResolve({ type: 'choice', key: record.id, record, choiceIndex: sel, choiceText: choices[sel], docName });
                        return;
                      }
                      const text = record.props?.text || '';
                      if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue;
                      doResolve({ type: 'annotation', key: record.id, action: 'add', record, docName });
                      return;
                    }
                    if (['draw', 'highlight', 'arrow', 'geo', 'text', 'line'].includes(record.type)) {
                      doResolve({ type: 'stroke', key: record.id, action: 'add', record, docName });
                      return;
                    }
                  } else if (JSON.stringify(prev.props) !== JSON.stringify(record.props)) {
                    known.set(record.id, record);
                    if (record.type === 'math-note') {
                      const choices = record.props?.choices;
                      const sel = record.props?.selectedChoice;
                      if (choices?.length && sel != null && sel >= 0 && sel !== prev.props?.selectedChoice) {
                        doResolve({ type: 'choice', key: record.id, record, choiceIndex: sel, choiceText: choices[sel], docName });
                        return;
                      }
                      const text = record.props?.text || '';
                      if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue;
                      doResolve({ type: 'annotation', key: record.id, action: 'update', record, docName });
                      return;
                    }
                  }
                }
              } catch (e) {
                console.error(`[wait_for_any] Shape diff error for ${docName}: ${e.message}`);
              }
            }, DEBOUNCE_MS);
          });
          shapeStreams.push(stream);
        }
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout waiting for feedback')), timeout);
      });

      const result = await Promise.race([waitPromise, timeoutPromise]);
      heartbeatIntervals.forEach(i => clearInterval(i));
      for (const s of shapeStreams) s.close();
      for (const s of signalStreams) s.close();

      const docName = result.docName;
      writeAgentHeartbeat(docName, 'thinking', 'todd');

      const prefix = `[${docName}] `;

      if (result.type === 'text-selection') {
        return { content: [{ type: 'text', text: `${prefix}Text selected (page ${result.sel.page}):\n  "${result.sel.text}"` }] };
      }

      if (result.type === 'ping') {
        return { content: [{ type: 'text', text: `${prefix}${await formatPing(result.ping, docName)}` }] };
      }

      if (result.type === 'choice') {
        const r = result.record;
        const anchor = r.meta?.sourceAnchor;
        let text = `${prefix}Choice selected on ${result.key}:\n`;
        text += `  question: "${r.props?.text || ''}"\n`;
        text += `  selected: ${result.choiceIndex} — "${result.choiceText}"\n`;
        text += `  all choices: ${r.props.choices.map((c, i) => i === result.choiceIndex ? `[${c}]` : c).join(' | ')}\n`;
        if (anchor) text += `  anchor: ${anchor.file}:${anchor.line}`;
        return { content: [{ type: 'text', text }] };
      }

      if (result.type === 'stroke') {
        const formatted = formatStrokeResult(result.record, docName, prefix, null, 'todd');
        let text = formatted.content[0].text;
        if (formatted.page != null) {
          try {
            const allShapes = await collectDrawnShapes(docName);
            const ctx = buildNearbyContext(allShapes, result.key, formatted.page);
            if (ctx) text += '\n' + ctx;
          } catch {}
        }
        return { content: [{ type: 'text', text }] };
      }

      // Annotation
      const r = result.record;
      const anchor = r.meta?.sourceAnchor;
      const loc = anchor ? `${anchor.file}:${anchor.line}` : `(${r.x?.toFixed(0)}, ${r.y?.toFixed(0)})`;
      if (r.x != null && r.y != null) writeAgentAttention(docName, r.x, r.y, 'todd');
      let noteText = `${prefix}Annotation ${result.action}: ${result.key}\n  [${r.props?.color}] ${loc}\n  "${r.props?.text}"`;
      try {
        const allShapes = await collectDrawnShapes(docName);
        const noteBBox = { minX: r.x, minY: r.y, maxX: r.x + 10, maxY: r.y + 10 };
        const notePos = describePagePosition(docName, noteBBox);
        const ctx = buildNearbyContext(allShapes, result.key, notePos.page);
        if (ctx) noteText += '\n' + ctx;
      } catch {}
      const summary = await summarizeAnnotations(docName);
      return { content: [{ type: 'text', text: noteText + '\n\n' + summary }] };

    } catch (e) {
      heartbeatIntervals.forEach(i => clearInterval(i));
      for (const s of shapeStreams) s.close();
      for (const s of signalStreams) s.close();
      if (e.message === 'Timeout waiting for feedback') {
        return { content: [{ type: 'text', text: `No feedback on any document for ${timeout / 1000}s.` }] };
      }
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'check_feedback') {
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const ping = await readSignalRest(docName, 'signal:ping');

      if (ping?.timestamp > lastPingTimestamp) {
        lastPingTimestamp = ping.timestamp;
        return { content: [{ type: 'text', text: await formatPing(ping, docName) }] };
      }

      // Fall back to HTTP snapshot check
      if (lastSnapshotTime > lastCheckedTime) {
        lastCheckedTime = Date.now();
        return { content: [{ type: 'text', text: `New feedback available!\n\n${lastRenderOutput}` }] };
      }

      return { content: [{ type: 'text', text: 'No new feedback since last check.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'get_latest_feedback') {
    const docName = args?.doc;
    // Try cached screenshot signal first
    if (docName) {
      try {
        const screenshot = await readSignalRest(docName, 'signal:screenshot');
        if (screenshot?.data) {
          return {
            content: [
              { type: 'text', text: `Viewport screenshot (${Math.round(screenshot.data.length / 1024)}KB)` },
              { type: 'image', data: screenshot.data, mimeType: screenshot.mimeType || 'image/png' },
            ],
          };
        }
      } catch {}
    }
    // Fallback to file
    if (fs.existsSync(SCREENSHOT_PATH)) {
      return {
        content: [
          { type: 'text', text: `Viewport screenshot: ${SCREENSHOT_PATH}` },
          { type: 'image', data: fs.readFileSync(SCREENSHOT_PATH).toString('base64'), mimeType: 'image/png' },
        ],
      };
    }
    // Request screenshot on demand via signal broadcast + listen for response
    if (docName) {
      try {
        await broadcastSignalRest(docName, 'signal:screenshot-request', { timestamp: Date.now() });
        const result = await new Promise((resolve) => {
          const stream = connectSignalStream(docName, (signal) => {
            if (signal.key === 'signal:screenshot' && signal.data) {
              clearTimeout(timer);
              stream.close();
              resolve(signal);
            }
          });
          const timer = setTimeout(() => {
            stream.close();
            resolve(null);
          }, 8000);
        });
        if (result?.data) {
          return {
            content: [
              { type: 'text', text: `Viewport screenshot (${Math.round(result.data.length / 1024)}KB)` },
              { type: 'image', data: result.data, mimeType: result.mimeType || 'image/png' },
            ],
          };
        }
      } catch {}
    }
    return {
      content: [{ type: 'text', text: 'No screenshot available. No viewer is connected — open the document in a browser or tap the ping button on the iPad.' }],
    };
  }

  if (name === 'screenshot') {
    const docName = args?.doc;
    const targetPage = args?.page;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing doc parameter' }], isError: true };
    }
    try {
      const base64 = await headlessScreenshot(docName, targetPage);
      return {
        content: [
          { type: 'text', text: `Screenshot (${Math.round(base64.length / 1024)}KB)` },
          { type: 'image', data: base64, mimeType: 'image/png' },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Screenshot failed: ${e.message}` }], isError: true };
    }
  }

  if (name === 'highlight_location') {
    const { doc, file, line } = args;
    if (!file || !line) {
      return { content: [{ type: 'text', text: 'Missing file or line parameter' }], isError: true };
    }
    const result = await highlightLine(doc, file, line);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    return { content: [{ type: 'text', text: `Highlighted page ${result.page} at (${result.x.toFixed(0)}, ${result.y.toFixed(0)})` }] };
  }

  if (name === 'add_annotation') {
    const { doc, line, page: pageNum, text, color, width, height, side, file, choices } = args;
    if (!doc || (!line && !pageNum) || !text) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, (line or page), text' }], isError: true };
    }
    try {
      const result = await addAnnotation(doc, line, text, { color, width, height, side, file, choices, page: pageNum });
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      return { content: [{ type: 'text', text: `Created ${result.shapeId}\n  ${line ? `line ${line}` : `page ${pageNum}`} → page ${result.page}, canvas (${result.x.toFixed(0)}, ${result.y.toFixed(0)})\n  "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'list_annotations') {
    const { doc } = args;
    if (!doc) return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    try {
      const result = await listAnnotations(doc);
      const { annotations } = result;
      if (annotations.length === 0) return { content: [{ type: 'text', text: 'No annotations found.' }] };
      let summary = `${annotations.length} annotation(s):\n\n`;
      annotations.forEach((a, i) => {
        summary += `${i + 1}. ${a.id}`;
        if (a.tabCount > 1) summary += ` (${a.tabCount} tabs, showing tab ${(a.activeTab || 0) + 1})`;
        summary += '\n';
        summary += `   pos: (${a.x}, ${a.y}) color: ${a.color}\n`;
        if (a.anchor) summary += `   anchor: ${a.anchor}\n`;
        summary += `   text: "${a.text}"\n`;
        if (a.choices) {
          summary += `   choices: ${a.choices.map((c, j) => (j === a.selectedChoice ? `[${c}]` : c)).join(' | ')}\n`;
          summary += `   selected: ${a.selectedChoice >= 0 ? `${a.selectedChoice} ("${a.choices[a.selectedChoice]}")` : 'none'}\n`;
        }
        summary += '\n';
      });
      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'reply_annotation') {
    const { doc, id, text } = args;
    if (!doc || !id || !text) return { content: [{ type: 'text', text: 'Missing required parameters: doc, id, text' }], isError: true };
    try {
      const result = await replyAnnotation(doc, id, text);
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      return { content: [{ type: 'text', text: `Added tab ${result.tabIndex + 1}/${result.tabCount} to ${result.id}:\n"${text}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'mark_done') {
    const { doc, id, margin } = args;
    if (!doc || !id) return { content: [{ type: 'text', text: 'Missing required parameters: doc, id' }], isError: true };
    const moveToMargin = margin !== false; // default true
    try {
      // Fetch the note shape to get its position
      const shape = await fetchShape(doc, id);
      if (!shape || shape.type !== 'math-note') {
        return { content: [{ type: 'text', text: `Shape ${id} not found or not a math-note` }], isError: true };
      }

      const updates = { props: { done: true } };

      if (moveToMargin) {
        // Find the nearest svg-page to compute margin position
        const pages = await fetchShapes(doc, 'svg-page');
        let bestPage = null;
        let bestDist = Infinity;
        const noteH = shape.props?.h || 150;
        const noteCy = shape.y + noteH / 2;
        for (const p of pages) {
          if (p.typeName !== 'shape') continue;
          const ph = p.props?.h || 0;
          const pMinY = p.y;
          const pMaxY = p.y + ph;
          const dist = noteCy < pMinY ? pMinY - noteCy : noteCy > pMaxY ? noteCy - pMaxY : 0;
          if (dist < bestDist) { bestDist = dist; bestPage = p; }
        }
        if (bestPage) {
          const pageRight = bestPage.x + (bestPage.props?.w || 0);
          updates.x = pageRight + 20;
        }
      }

      await updateShapeRest(doc, id, updates);
      return { content: [{ type: 'text', text: `Marked done: ${id}${moveToMargin ? ' (moved to margin)' : ''}` }] };
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

  if (name === 'read_pen_annotations') {
    const { doc } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const allShapes = await collectDrawnShapes(doc);
      // Filter to drawn shapes only (not notes) for this tool's output
      const shapes = allShapes.filter(s => s.shapeType !== 'note');

      // Check for text selection signal
      let textSel = null;
      try {
        textSel = await readSignalRest(doc, 'signal:text-selection');
      } catch {}
      const hasTextSel = textSel?.text && (Date.now() - (textSel.timestamp || 0)) < 300000; // within 5 min

      if (shapes.length === 0 && !hasTextSel) {
        return { content: [{ type: 'text', text: 'No drawn annotations found.' }] };
      }

      let summary = '';

      // Page summary header
      const pageSummary = buildPageSummary(allShapes);
      if (pageSummary) summary += pageSummary + '\n\n';

      if (hasTextSel) {
        summary += `Text selection (page ${textSel.page}):\n  "${textSel.text}"\n\n`;
      }
      // Cluster shapes temporally + spatially and output grouped
      const clusters = clusterShapes(shapes);
      summary += `${shapes.length} drawn annotation(s) in ${clusters.length} group(s):\n\n`;
      for (const cluster of clusters) {
        const age = describeClusterAge(cluster);
        const pages = [...cluster.pages].filter(Boolean).sort((a, b) => a - b);
        const pageStr = pages.length === 0 ? '' : pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`;
        summary += `--- ${age}${pageStr ? ', ' + pageStr : ''} (${cluster.shapes.length} mark${cluster.shapes.length === 1 ? '' : 's'}) ---\n`;
        for (const s of cluster.shapes) {
          summary += formatShapeDetail(s);
          summary += '\n';
        }
      }

      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
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
    return { content: [{ type: 'text', text: `Scrolled to line ${line} → page ${result.page} (${result.x.toFixed(0)}, ${result.y.toFixed(0)})` }] };
  }

  if (name === 'send_note') {
    const { doc, line, page: pageNum, text, color, file, choices } = args;
    if (!doc || (!line && !pageNum) || !text) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, (line or page), text' }], isError: true };
    }
    const result = line
      ? await sendNote(doc, line, text, color, file, choices)
      : await addAnnotation(doc, null, text, { color, file, choices, page: pageNum });
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    let msg = `Note sent at line ${line} → page ${result.page} (${result.shapeId || 'broadcast only'})\n  "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`;
    if (result.warning) msg += `\n  Warning: ${result.warning}`;
    return { content: [{ type: 'text', text: msg }] };
  }

  if (name === 'signal_reload') {
    const { doc, pages } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const timestamp = Date.now();
      const signal = pages && pages.length > 0
        ? { type: 'partial', pages, timestamp }
        : { type: 'full', timestamp };

      await broadcastSignalRest(doc, 'signal:reload', signal);

      const desc = signal.type === 'partial'
        ? `Partial reload signaled for pages ${pages.join(', ')}`
        : 'Full reload signaled';
      return { content: [{ type: 'text', text: `${desc} (doc: ${doc}, t=${timestamp})` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Signal error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'draw_highlight') {
    const { doc, startLine, endLine, color = 'orange', file } = args;
    if (!doc || startLine == null || endLine == null) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, startLine, endLine' }], isError: true };
    }

    try {
      // Look up canvas positions for start and end lines
      const startPos = lookupLine(doc, startLine, file);
      const endPos = lookupLine(doc, endLine, file);
      if (!startPos) return { content: [{ type: 'text', text: `Line ${startLine} not found in lookup` }], isError: true };
      if (!endPos) return { content: [{ type: 'text', text: `Line ${endLine} not found in lookup` }], isError: true };

      const startCanvas = pdfToCanvas(startPos.page, startPos.x, startPos.y);
      const endCanvas = pdfToCanvas(endPos.page, endPos.x, endPos.y);

      const pageW = getPageWidth(doc);
      // Highlight spans from text start to near-right edge
      const hlLeft = Math.min(startCanvas.x, endCanvas.x);
      const hlRight = pageW * 0.9; // stop before right margin
      const hlTop = Math.min(startCanvas.y, endCanvas.y) - 3;
      const hlBottom = Math.max(startCanvas.y, endCanvas.y) + 3;

      // Create one horizontal segment per text line
      const width = hlRight - hlLeft;
      const height = hlBottom - hlTop;
      const numLines = endLine - startLine + 1;
      const lineH = numLines > 1 ? height / numLines : 0;

      const segments = [];
      if (numLines <= 1) {
        // Single line: one horizontal sweep
        segments.push({ type: 'free', path: encodeB64Path([
          { x: 0, y: 0, z: 0.5 },
          { x: width, y: 0, z: 0.5 },
        ])});
      } else {
        // One horizontal sweep per line
        for (let i = 0; i < numLines; i++) {
          const y = i * lineH;
          segments.push({ type: 'free', path: encodeB64Path([
            { x: 0, y, z: 0.5 },
            { x: width, y, z: 0.5 },
          ])});
        }
      }

      const shapeId = generateShapeId();
      const shapeIndex = await getNextShapeIndex(doc);
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
          sourceAnchor: { file: file || './' + (startPos.texFile || 'main.tex'), line: startLine },
        },
        parentId: 'page:page',
        typeName: 'shape',
      };

      await createShapeRest(doc, shape);
      return { content: [{ type: 'text', text: `Highlight drawn: lines ${startLine}–${endLine}, page ${startPos.page}, ${color} (${shapeId})` }] };
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
server.connect(transport);
console.error('TLDraw Feedback MCP server started');
