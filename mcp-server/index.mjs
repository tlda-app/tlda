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
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import * as Y from 'yjs';
import { findRenderedText } from './svg-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = '/tmp/tldraw-snapshot.json';
const SCREENSHOT_PATH = '/tmp/annotated-view.png';

// ---- Lookup.json support ----

const lookupCache = new Map(); // docName → { data, mtime }

function loadLookup(docName) {
  const lookupPath = path.join(PROJECT_ROOT, 'public', 'docs', docName, 'lookup.json');
  try {
    const stat = fs.statSync(lookupPath);
    const cached = lookupCache.get(docName);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.data;

    const data = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
    lookupCache.set(docName, { data, mtime: stat.mtimeMs });
    return data;
  } catch {
    return null;
  }
}

function lookupLine(docName, lineNum) {
  const lookup = loadLookup(docName);
  if (!lookup?.lines) return null;
  const entry = lookup.lines[lineNum.toString()];
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

const pageInfoCache = new Map(); // docName → { layout, mtime }
const HTML_PAGE_SPACING = PAGE_GAP;
const HTML_TAB_SPACING = 24;

function loadHtmlLayout(docName) {
  const piPath = path.join(PROJECT_ROOT, 'public', 'docs', docName, 'page-info.json');
  try {
    const stat = fs.statSync(piPath);
    const cached = pageInfoCache.get(docName);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.layout;

    const pageInfos = JSON.parse(fs.readFileSync(piPath, 'utf8'));
    const layout = computeHtmlLayout(pageInfos);
    pageInfoCache.set(docName, { layout, mtime: stat.mtimeMs });
    return layout;
  } catch {
    return null;
  }
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
  // Also check manifest
  const manifestPath = path.join(PROJECT_ROOT, 'public', 'docs', 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.documents?.[docName]?.format === 'html';
  } catch {
    return false;
  }
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

const searchIndexCache = new Map(); // docName → { data, mtime }

function loadSearchIndex(docName) {
  const siPath = path.join(PROJECT_ROOT, 'public', 'docs', docName, 'search-index.json');
  try {
    const stat = fs.statSync(siPath);
    const cached = searchIndexCache.get(docName);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.data;

    const data = JSON.parse(fs.readFileSync(siPath, 'utf8'));
    searchIndexCache.set(docName, { data, mtime: stat.mtimeMs });
    return data;
  } catch {
    return null;
  }
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

// ---- Yjs connection management ----

const SYNC_SERVER = process.env.SYNC_SERVER || 'ws://localhost:5176';
console.error(`[Yjs] SYNC_SERVER = ${SYNC_SERVER}`);
const yjsDocs = new Map(); // docName → { doc, yRecords, ws, ready }

function connectYjs(docName) {
  if (yjsDocs.has(docName)) {
    const entry = yjsDocs.get(docName);
    if (entry.ready) return Promise.resolve(entry);
    return entry.promise;
  }

  const doc = new Y.Doc();
  const yRecords = doc.getMap('tldraw');
  const roomId = `doc-${docName}`;
  const url = `${SYNC_SERVER}/${roomId}`;

  console.error(`[Yjs] Connecting to ${url}`);
  const entry = { doc, yRecords, ws: null, ready: false };

  entry.promise = new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    entry.ws = ws;

    const timeout = setTimeout(() => {
      reject(new Error(`Yjs connection timeout connecting to ${url}`));
      ws.close();
    }, 10000);

    ws.on('open', () => {
      console.error(`[Yjs] Connected to ${roomId}`);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync') {
          Y.applyUpdate(doc, new Uint8Array(msg.data));
          entry.ready = true;
          clearTimeout(timeout);
          console.error(`[Yjs] Synced ${yRecords.size} records for ${docName}`);
          resolve(entry);
        } else if (msg.type === 'update') {
          Y.applyUpdate(doc, new Uint8Array(msg.data));
        }
      } catch (e) {
        console.error('[Yjs] Message error:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Yjs] WebSocket error:`, err);
      reject(new Error(`Yjs connection error: ${err.message || err.code || JSON.stringify(err)}`));
    });

    ws.on('close', (code, reason) => {
      console.error(`[Yjs] Disconnected from ${roomId} (code=${code}, reason=${reason})`);
      yjsDocs.delete(docName);
    });
  });

  yjsDocs.set(docName, entry);
  return entry.promise;
}

function sendYjsUpdate(entry) {
  if (entry.ws?.readyState === WsClient.OPEN) {
    const update = Y.encodeStateAsUpdate(entry.doc);
    entry.ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }));
  }
}

function generateShapeId() {
  return 'shape:' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

// ---- Shared action functions (used by both HTTP and MCP) ----

async function scrollToLine(doc, line) {
  const linePos = lookupLine(doc, line);
  if (!linePos) return { ok: false, error: `Line ${line} not found in lookup.json for doc "${doc}"` };

  const canvasPos = docToCanvas(doc, linePos.page, linePos.x, linePos.y);

  // Write Yjs signal — works regardless of HTTP/WS server state
  try {
    const entry = await connectYjs(doc);
    entry.doc.transact(() => {
      entry.yRecords.set('signal:forward-scroll', {
        x: canvasPos.x, y: canvasPos.y, timestamp: Date.now(),
      });
    });
    sendYjsUpdate(entry);
  } catch (e) {
    // Fallback to WS broadcast if Yjs unavailable
    broadcast({ type: 'scroll', x: canvasPos.x, y: canvasPos.y });
  }

  return { ok: true, page: linePos.page, x: canvasPos.x, y: canvasPos.y };
}

async function highlightLine(doc, file, line) {
  // If no doc given, infer from manifest texFile paths
  if (!doc) {
    const manifestPath = path.join(PROJECT_ROOT, 'public', 'docs', 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const [name, entry] of Object.entries(manifest.documents)) {
        if (entry.texFile && file.includes(path.basename(entry.texFile, '.tex'))) {
          doc = name;
          break;
        }
      }
    } catch {}
    if (!doc) doc = path.basename(file, '.tex');
  }

  async function sendHighlightSignal(x, y, page) {
    try {
      const entry = await connectYjs(doc);
      entry.doc.transact(() => {
        entry.yRecords.set('signal:forward-highlight', {
          x, y, page, timestamp: Date.now(),
        });
      });
      sendYjsUpdate(entry);
    } catch {
      broadcastHighlight(x, y, page);
    }
  }

  const linePos = lookupLine(doc, line);
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

async function addAnnotation(doc, line, text, { color = 'violet', width = 200, height = 150, side = 'right' } = {}) {
  const linePos = lookupLine(doc, line);
  if (!linePos) return { ok: false, error: `Line ${line} not found in lookup.json for doc "${doc}"` };

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

  const entry = await connectYjs(doc);
  const shapeId = generateShapeId();
  const shape = {
    id: shapeId,
    type: 'math-note',
    typeName: 'shape',
    x, y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: width, h: height, text, color },
    meta: {
      sourceAnchor: {
        file: `./${linePos.texFile || doc + '.tex'}`,
        line,
        column: -1,
        content: linePos.content,
      },
    },
    parentId: 'page:page',
    index: 'a1',
  };

  entry.doc.transact(() => {
    entry.yRecords.set(shapeId, shape);
  });
  sendYjsUpdate(entry);

  return { ok: true, shapeId, page: linePos.page, x, y };
}

async function sendNote(doc, line, text, color = 'violet') {
  // Create persistent math-note via Yjs — syncs to all viewers automatically
  const result = await addAnnotation(doc, line, text, { color });
  if (!result.ok) return result;

  // Also scroll viewer to the note location
  await scrollToLine(doc, line);

  return { ok: true, shapeId: result.shapeId, page: result.page, x: result.x, y: result.y };
}

async function listAnnotations(doc) {
  const entry = await connectYjs(doc);
  const annotations = [];

  entry.yRecords.forEach((record, id) => {
    if (!record || record.type !== 'math-note') return;
    const anchor = record.meta?.sourceAnchor;
    annotations.push({
      id,
      x: Math.round(record.x || 0),
      y: Math.round(record.y || 0),
      color: record.props?.color,
      text: record.props?.text || '',
      anchor: anchor ? `${anchor.file}:${anchor.line}` : null,
      content: anchor?.content || null,
    });
  });

  return { ok: true, annotations };
}

async function replyAnnotation(doc, id, text) {
  const fullId = id.startsWith('shape:') ? id : `shape:${id}`;
  const entry = await connectYjs(doc);
  const record = entry.yRecords.get(fullId);
  if (!record) return { ok: false, error: `Annotation not found: ${fullId}` };

  const existing = record.props?.text || '';
  const updated = existing + '\n\n—Claude: ' + text;

  const newRecord = { ...record, props: { ...record.props, text: updated } };
  entry.doc.transact(() => {
    entry.yRecords.set(fullId, newRecord);
  });
  sendYjsUpdate(entry);

  return { ok: true, id: fullId };
}

async function deleteAnnotation(doc, id) {
  const fullId = id.startsWith('shape:') ? id : `shape:${id}`;
  const entry = await connectYjs(doc);
  if (!entry.yRecords.has(fullId)) return { ok: false, error: `Annotation not found: ${fullId}` };

  entry.doc.transact(() => {
    entry.yRecords.delete(fullId);
  });
  sendYjsUpdate(entry);

  return { ok: true, id: fullId };
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
    try {
      const manifestPath = path.join(PROJECT_ROOT, 'public', 'docs', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      docs = manifest.documents || {};
    } catch {}

    const status = {
      ok: true,
      http: { port: HTTP_PORT },
      websocket: { port: WS_PORT, clients: wsClients.size },
      yjs: { syncServer: SYNC_SERVER, connections: yjsDocs.size },
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

  // GET /shapes?doc=<name> — read all shapes + signals from Yjs
  if (req.method === 'GET' && req.url?.startsWith('/shapes')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const docName = url.searchParams.get('doc');
    if (!docName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: doc' }));
      return;
    }
    try {
      const entry = await connectYjs(docName);
      const shapes = [];
      const signals = {};
      const other = [];
      entry.yRecords.forEach((record, id) => {
        if (id.startsWith('signal:')) {
          signals[id] = record;
        } else if (id.startsWith('shape:') || id.startsWith('binding:')) {
          shapes.push({ id, ...(typeof record === 'object' ? record : { value: record }) });
        } else {
          other.push(id);
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ shapes, signals, other, total: entry.yRecords.size }));
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
  });

  console.error(`WebSocket server running on port ${WS_PORT}`);
}

// Send a WebSocket message to connected viewers, or proxy via HTTP if no local WS
function broadcast(message) {
  const msg = typeof message === 'object' ? JSON.stringify(message) : message;
  if (wsClients.size > 0) {
    for (const client of wsClients) {
      if (client.readyState === 1) client.send(msg);
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
    req.on('error', () => {});
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
      description: 'Wait for feedback from the iPad. Blocks until user hits Share, then returns screenshot path and annotation summary.',
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
      description: 'Take a screenshot of the viewer on demand. Sends a request via Yjs and waits for the viewer to capture and return the viewport image.',
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
          line: { type: 'number', description: 'Source line number to anchor the note to' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: violet)' },
          width: { type: 'number', description: 'Note width in pixels (default: 200)' },
          height: { type: 'number', description: 'Note height in pixels (default: 150)' },
          side: { type: 'string', description: 'Place note to "left" or "right" of page (default: right)' },
        },
        required: ['doc', 'line', 'text'],
      },
    },
    {
      name: 'list_annotations',
      description: 'List all annotations in a document.',
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
      description: 'Reply inside an existing annotation. Appends your reply to the note text.',
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
      name: 'scroll_to_line',
      description: 'Scroll the viewer to a source line. Looks up the line position and broadcasts a scroll command to all connected viewers.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to scroll to' },
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
          line: { type: 'number', description: 'Source line number to place the note at' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: violet)' },
        },
        required: ['doc', 'line', 'text'],
      },
    },
  ],
}));

// Track last checked time for check_feedback
let lastCheckedTime = 0;
let lastPingTimestamp = 0;

function summarizeAnnotations(entry) {
  const annotations = [];
  entry.yRecords.forEach((record, id) => {
    if (!record || record.type !== 'math-note') return;
    const anchor = record.meta?.sourceAnchor;
    const loc = anchor ? `${anchor.file}:${anchor.line}` : `(${record.x?.toFixed(0)}, ${record.y?.toFixed(0)})`;
    annotations.push(`- [${record.props?.color || '?'}] ${loc}: ${record.props?.text || '(empty)'}`);
  });
  if (annotations.length === 0) return 'No annotations.';
  return `${annotations.length} annotation(s):\n${annotations.join('\n')}`;
}

function formatPing(ping, entry) {
  const vp = ping.viewport ? `Viewport: (${ping.viewport.x?.toFixed(0)}, ${ping.viewport.y?.toFixed(0)})` : '';
  return `Ping received! ${vp}\n\n${summarizeAnnotations(entry)}`;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'wait_for_feedback') {
    const timeout = (args?.timeout || 300) * 1000;
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const entry = await connectYjs(docName);

      // Check if there's already a ping newer than what we've seen
      const existingPing = entry.yRecords.get('signal:ping');
      if (existingPing?.timestamp > lastPingTimestamp) {
        lastPingTimestamp = existingPing.timestamp;
        return { content: [{ type: 'text', text: formatPing(existingPing, entry) }] };
      }

      // Watch for pings OR annotation changes (with debounce for edits)
      const DEBOUNCE_MS = 5000;
      const waitPromise = new Promise(resolve => {
        let debounceTimer = null;
        let pendingResult = null;

        const observer = (event) => {
          event.changes.keys.forEach((change, key) => {
            // Ping signal — resolve immediately, no debounce
            if (key === 'signal:ping') {
              const ping = entry.yRecords.get('signal:ping');
              if (ping?.timestamp > lastPingTimestamp) {
                lastPingTimestamp = ping.timestamp;
                if (debounceTimer) clearTimeout(debounceTimer);
                entry.yRecords.unobserve(observer);
                resolve({ type: 'ping', ping });
              }
              return;
            }
            // Text selection — debounce briefly (user may still be adjusting)
            if (key === 'signal:text-selection') {
              const sel = entry.yRecords.get('signal:text-selection');
              if (sel?.text) {
                pendingResult = { type: 'text-selection', sel };
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  const latest = entry.yRecords.get('signal:text-selection');
                  if (latest) pendingResult.sel = latest;
                  entry.yRecords.unobserve(observer);
                  resolve(pendingResult);
                }, 2000); // shorter debounce for text selection
              }
              return;
            }
            // Annotation created or edited — debounce to wait for typing/drawing to finish
            if (key.startsWith('shape:') && (change.action === 'add' || change.action === 'update')) {
              const record = entry.yRecords.get(key);
              if (record?.type === 'math-note') {
                const text = record.props?.text || '';
                // Skip if the last line is our reply
                if (text.trimEnd().endsWith('—Claude:')) return;
                pendingResult = { type: 'annotation', key, action: change.action, record };
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  const latest = entry.yRecords.get(key);
                  if (latest) pendingResult.record = latest;
                  entry.yRecords.unobserve(observer);
                  resolve(pendingResult);
                }, DEBOUNCE_MS);
              }
              // Draw, highlight, arrow, geo, text, or line shape
              if (record?.type === 'draw' || record?.type === 'highlight' ||
                  record?.type === 'arrow' || record?.type === 'geo' ||
                  record?.type === 'text' || record?.type === 'line') {
                pendingResult = { type: 'stroke', key, action: change.action, record };
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  const latest = entry.yRecords.get(key);
                  if (latest) pendingResult.record = latest;
                  entry.yRecords.unobserve(observer);
                  resolve(pendingResult);
                }, DEBOUNCE_MS);
              }
            }
          });
        };
        entry.yRecords.observe(observer);

        // Also resolve on HTTP snapshot (backward compat)
        waitingResolvers.push(() => {
          if (debounceTimer) clearTimeout(debounceTimer);
          entry.yRecords.unobserve(observer);
          resolve({ type: 'http-snapshot' });
        });
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout waiting for feedback')), timeout);
      });

      const result = await Promise.race([waitPromise, timeoutPromise]);

      if (result?.type === 'http-snapshot') {
        return { content: [{ type: 'text', text: `New feedback received!\n\n${lastRenderOutput}` }] };
      }

      if (result?.type === 'text-selection') {
        const sel = result.sel;
        return { content: [{ type: 'text', text: `Text selected (page ${sel.page}):\n  "${sel.text}"` }] };
      }

      if (result?.type === 'ping') {
        return { content: [{ type: 'text', text: formatPing(result.ping, entry) }] };
      }

      // Shape drawn (draw/highlight/arrow/geo/text/line)
      if (result?.type === 'stroke') {
        const r = result.record;
        const color = r.props?.color || 'black';

        // Arrow
        if (r.type === 'arrow') {
          const ep = getArrowEndpoints(r);
          if (ep) {
            const pdfStart = canvasToDoc(docName, ep.start.x, ep.start.y);
            const pdfEnd = canvasToDoc(docName, ep.end.x, ep.end.y);
            const startLines = findNearbyLines(docName, { minX: ep.start.x - 10, minY: ep.start.y - 10, maxX: ep.start.x + 10, maxY: ep.start.y + 10 });
            const endLines = findNearbyLines(docName, { minX: ep.end.x - 10, minY: ep.end.y - 10, maxX: ep.end.x + 10, maxY: ep.end.y + 10 });
            const label = r.props?.text || '';
            let text = `Arrow (${color})`;
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
            return { content: [{ type: 'text', text }] };
          }
        }

        // Geo shape
        if (r.type === 'geo') {
          const bbox = getGeoBBox(r);
          const geo = r.props?.geo || 'rectangle';
          const label = r.props?.text || '';
          let text = `${geo} (${color})`;
          if (label) text += ` "${label}"`;
          if (bbox) {
            const pdfPos = canvasToDoc(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2);
            const nearbyLines = findNearbyLines(docName, bbox);
            text += `\n  page ${pdfPos.page}`;
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
          return { content: [{ type: 'text', text }] };
        }

        // Text shape
        if (r.type === 'text') {
          const textContent = r.props?.text || '';
          const bbox = getTextBBox(r);
          const pdfPos = canvasToDoc(docName, bbox.minX, bbox.minY);
          const nearbyLines = findNearbyLines(docName, bbox);
          let text = `Text (${color}): "${textContent}"`;
          text += `\n  page ${pdfPos.page}`;
          if (nearbyLines.length > 0) text += `\n  near line ${nearbyLines[0].line}: "${nearbyLines[0].content}"`;
          const rendered = getRenderedText(docName, bbox);
          if (rendered) text += `\n  rendered: "${rendered}"`;
          return { content: [{ type: 'text', text }] };
        }

        // Draw / highlight (original path)
        const bbox = getDrawShapeBBox(r);
        const tool = r.type === 'highlight' ? 'highlighter' : 'pen';
        const sentiment = tool === 'highlighter' ? 'attention' : 'correction';
        const gesture = bbox ? classifyGesture(bbox) : 'unknown';
        const nearbyLines = bbox ? findNearbyLines(docName, bbox) : [];
        const pdfPos = bbox ? canvasToDoc(docName, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2) : null;

        let text = `Stroke: ${tool} (${color}) → ${gesture} [${sentiment}]`;
        if (pdfPos) text += `\n  page ${pdfPos.page}`;
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
        return { content: [{ type: 'text', text }] };
      }

      // Annotation change (math-note)
      const r = result.record;
      const anchor = r.meta?.sourceAnchor;
      const loc = anchor ? `${anchor.file}:${anchor.line}` : `(${r.x?.toFixed(0)}, ${r.y?.toFixed(0)})`;
      return { content: [{ type: 'text', text: `Annotation ${result.action}: ${result.key}\n  [${r.props?.color}] ${loc}\n  "${r.props?.text}"\n\n${summarizeAnnotations(entry)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'check_feedback') {
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const entry = await connectYjs(docName);
      const ping = entry.yRecords.get('signal:ping');

      // Check Yjs ping first
      if (ping?.timestamp > lastPingTimestamp) {
        lastPingTimestamp = ping.timestamp;
        return { content: [{ type: 'text', text: formatPing(ping, entry) }] };
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
    // Try Yjs screenshot signal first
    if (docName) {
      try {
        const entry = await connectYjs(docName);
        const screenshot = entry.yRecords.get('signal:screenshot');
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
    // Request screenshot on demand
    if (docName) {
      try {
        const entry = await connectYjs(docName);
        entry.doc.transact(() => {
          entry.yRecords.set('signal:screenshot-request', { timestamp: Date.now() });
        });
        sendYjsUpdate(entry);
        // Wait up to 5s for the viewer to respond
        const result = await new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(null), 5000);
          const observer = (event) => {
            event.changes.keys.forEach((change, key) => {
              if (key === 'signal:screenshot') {
                const ss = entry.yRecords.get('signal:screenshot');
                if (ss?.data) {
                  clearTimeout(timeout);
                  entry.yRecords.unobserve(observer);
                  resolve(ss);
                }
              }
            });
          };
          entry.yRecords.observe(observer);
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
      content: [{ type: 'text', text: 'No screenshot available. Ask the user to tap the ping button to capture one.' }],
    };
  }

  if (name === 'screenshot') {
    const docName = args?.doc;
    if (!docName) {
      return { content: [{ type: 'text', text: 'Missing doc parameter' }], isError: true };
    }
    try {
      const entry = await connectYjs(docName);
      // Clear any old screenshot so we know the response is fresh
      entry.doc.transact(() => {
        entry.yRecords.delete('signal:screenshot');
        entry.yRecords.set('signal:screenshot-request', { timestamp: Date.now() });
      });
      sendYjsUpdate(entry);
      // Wait up to 5s for the viewer to respond
      const result = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        const observer = (event) => {
          event.changes.keys.forEach((change, key) => {
            if (key === 'signal:screenshot') {
              const ss = entry.yRecords.get('signal:screenshot');
              if (ss?.data) {
                clearTimeout(timeout);
                entry.yRecords.unobserve(observer);
                resolve(ss);
              }
            }
          });
        };
        entry.yRecords.observe(observer);
      });
      if (result?.data) {
        return {
          content: [
            { type: 'text', text: `Viewport screenshot (${Math.round(result.data.length / 1024)}KB)` },
            { type: 'image', data: result.data, mimeType: result.mimeType || 'image/png' },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'Screenshot request timed out. Is the viewer open?' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Screenshot error: ${e.message}` }], isError: true };
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
    const { doc, line, text, color, width, height, side } = args;
    if (!doc || !line || !text) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, line, text' }], isError: true };
    }
    try {
      const result = await addAnnotation(doc, line, text, { color, width, height, side });
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      return { content: [{ type: 'text', text: `Created ${result.shapeId}\n  line ${line} → page ${result.page}, canvas (${result.x.toFixed(0)}, ${result.y.toFixed(0)})\n  "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
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
        summary += `${i + 1}. ${a.id}\n`;
        summary += `   pos: (${a.x}, ${a.y}) color: ${a.color}\n`;
        if (a.anchor) summary += `   anchor: ${a.anchor}\n`;
        summary += `   text: "${a.text.slice(0, 80)}${a.text.length > 80 ? '...' : ''}"\n\n`;
      });
      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'reply_annotation') {
    const { doc, id, text } = args;
    if (!doc || !id || !text) return { content: [{ type: 'text', text: 'Missing required parameters: doc, id, text' }], isError: true };
    try {
      const result = await replyAnnotation(doc, id, text);
      if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
      return { content: [{ type: 'text', text: `Replied to ${result.id}:\n"${text}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
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
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'read_pen_annotations') {
    const { doc } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const entry = await connectYjs(doc);
      const shapes = [];

      entry.yRecords.forEach((record, id) => {
        if (!record || record.typeName !== 'shape') return;
        if (id.startsWith('signal:')) return;

        const shapeType = record.type;
        const color = record.props?.color || 'black';

        // --- Draw / Highlight strokes ---
        if (shapeType === 'draw' || shapeType === 'highlight') {
          const bbox = getDrawShapeBBox(record);
          if (!bbox) return;
          const tool = shapeType === 'highlight' ? 'highlighter' : 'pen';
          const gesture = classifyGesture(bbox);
          const nearbyLines = findNearbyLines(doc, bbox);
          const pdfPos = canvasToDoc(doc, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2);
          const rendered = getRenderedText(doc, bbox);
          shapes.push({ id, shapeType: tool, color, gesture, page: pdfPos.page, bbox, lines: nearbyLines, rendered });
          return;
        }

        // --- Arrow ---
        if (shapeType === 'arrow') {
          const ep = getArrowEndpoints(record);
          const bbox = getArrowBBox(record);
          if (!ep || !bbox) return;
          const pdfStart = canvasToDoc(doc, ep.start.x, ep.start.y);
          const pdfEnd = canvasToDoc(doc, ep.end.x, ep.end.y);
          const startLines = findNearbyLines(doc, { minX: ep.start.x - 10, minY: ep.start.y - 10, maxX: ep.start.x + 10, maxY: ep.start.y + 10 });
          const endLines = findNearbyLines(doc, { minX: ep.end.x - 10, minY: ep.end.y - 10, maxX: ep.end.x + 10, maxY: ep.end.y + 10 });
          const label = record.props?.text || '';
          const startBound = record.props?.start?.boundShapeId || null;
          const endBound = record.props?.end?.boundShapeId || null;
          const rendered = getRenderedText(doc, bbox);
          shapes.push({
            id, shapeType: 'arrow', color, label,
            page: pdfStart.page, bbox,
            startPage: pdfStart.page, endPage: pdfEnd.page,
            startLines, endLines, startBound, endBound, rendered,
          });
          return;
        }

        // --- Geo (rectangle, ellipse, diamond, etc.) ---
        if (shapeType === 'geo') {
          const bbox = getGeoBBox(record);
          if (!bbox) return;
          const geo = record.props?.geo || 'rectangle';
          const nearbyLines = findNearbyLines(doc, bbox);
          const pdfPos = canvasToDoc(doc, (bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2);
          const label = record.props?.text || '';
          const rendered = getRenderedText(doc, bbox);
          shapes.push({ id, shapeType: 'geo', geo, color, label, page: pdfPos.page, bbox, lines: nearbyLines, rendered });
          return;
        }

        // --- Text ---
        if (shapeType === 'text') {
          const bbox = getTextBBox(record);
          const text = record.props?.text || '';
          if (!text.trim()) return;
          const pdfPos = canvasToDoc(doc, bbox.minX, bbox.minY);
          const nearbyLines = findNearbyLines(doc, bbox);
          const rendered = getRenderedText(doc, bbox);
          shapes.push({ id, shapeType: 'text', color, text, page: pdfPos.page, bbox, lines: nearbyLines, rendered });
          return;
        }

        // --- Line ---
        if (shapeType === 'line') {
          // Line shapes use handles for vertices
          const handles = record.props?.handles;
          if (!handles) return;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const h of Object.values(handles)) {
            const ax = record.x + (h.x || 0);
            const ay = record.y + (h.y || 0);
            if (ax < minX) minX = ax;
            if (ay < minY) minY = ay;
            if (ax > maxX) maxX = ax;
            if (ay > maxY) maxY = ay;
          }
          if (!isFinite(minX)) return;
          const bbox = { minX, minY, maxX, maxY };
          const nearbyLines = findNearbyLines(doc, bbox);
          const pdfPos = canvasToDoc(doc, (minX + maxX) / 2, (minY + maxY) / 2);
          const rendered = getRenderedText(doc, bbox);
          shapes.push({ id, shapeType: 'line', color, page: pdfPos.page, bbox, lines: nearbyLines, rendered });
          return;
        }
      });

      // Check for text selection signal
      const textSel = entry.yRecords.get('signal:text-selection');
      const hasTextSel = textSel?.text && (Date.now() - (textSel.timestamp || 0)) < 300000; // within 5 min

      if (shapes.length === 0 && !hasTextSel) {
        return { content: [{ type: 'text', text: 'No drawn annotations found.' }] };
      }

      let summary = '';
      if (hasTextSel) {
        summary += `Text selection (page ${textSel.page}):\n  "${textSel.text}"\n\n`;
      }
      summary += `${shapes.length} annotation(s):\n\n`;
      for (const s of shapes) {
        summary += `${s.id}\n`;

        if (s.shapeType === 'pen' || s.shapeType === 'highlighter') {
          const sentiment = s.shapeType === 'highlighter' ? 'attention' : 'correction';
          summary += `  ${s.shapeType} (${s.color}) → ${s.gesture} [${sentiment}]\n`;
          summary += `  page ${s.page}\n`;
          if (s.lines.length > 0) {
            const lineRange = s.lines.length === 1
              ? `line ${s.lines[0].line}`
              : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
            summary += `  covers ${lineRange}\n`;
            summary += `  first: "${s.lines[0].content}"\n`;
            if (s.lines.length > 1) summary += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
          } else {
            summary += `  (no matching document lines)\n`;
          }
          if (s.rendered) summary += `  rendered: "${s.rendered}"\n`;
        }

        else if (s.shapeType === 'arrow') {
          summary += `  arrow (${s.color})`;
          if (s.label) summary += ` label: "${s.label}"`;
          summary += '\n';
          // Start
          if (s.startLines.length > 0) {
            summary += `  from: page ${s.startPage}, line ${s.startLines[0].line} "${s.startLines[0].content}"\n`;
          } else if (s.startBound) {
            summary += `  from: ${s.startBound}\n`;
          } else {
            summary += `  from: page ${s.startPage} (no matching line)\n`;
          }
          // End
          if (s.endLines.length > 0) {
            summary += `  to:   page ${s.endPage}, line ${s.endLines[0].line} "${s.endLines[0].content}"\n`;
          } else if (s.endBound) {
            summary += `  to:   ${s.endBound}\n`;
          } else {
            summary += `  to:   page ${s.endPage} (no matching line)\n`;
          }
          if (s.rendered) summary += `  rendered: "${s.rendered}"\n`;
        }

        else if (s.shapeType === 'geo') {
          summary += `  ${s.geo} (${s.color})`;
          if (s.label) summary += ` label: "${s.label}"`;
          summary += '\n';
          summary += `  page ${s.page}\n`;
          if (s.lines.length > 0) {
            const lineRange = s.lines.length === 1
              ? `line ${s.lines[0].line}`
              : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
            summary += `  encloses ${lineRange}\n`;
            summary += `  first: "${s.lines[0].content}"\n`;
            if (s.lines.length > 1) summary += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
          } else {
            summary += `  (no matching document lines)\n`;
          }
          if (s.rendered) summary += `  rendered: "${s.rendered}"\n`;
        }

        else if (s.shapeType === 'text') {
          summary += `  text (${s.color}): "${s.text}"\n`;
          summary += `  page ${s.page}\n`;
          if (s.lines.length > 0) {
            summary += `  near line ${s.lines[0].line}: "${s.lines[0].content}"\n`;
          }
          if (s.rendered) summary += `  rendered: "${s.rendered}"\n`;
        }

        else if (s.shapeType === 'line') {
          summary += `  line (${s.color})\n`;
          summary += `  page ${s.page}\n`;
          if (s.lines.length > 0) {
            const lineRange = s.lines.length === 1
              ? `line ${s.lines[0].line}`
              : `lines ${s.lines[0].line}–${s.lines[s.lines.length - 1].line}`;
            summary += `  covers ${lineRange}\n`;
            summary += `  first: "${s.lines[0].content}"\n`;
            if (s.lines.length > 1) summary += `  last:  "${s.lines[s.lines.length - 1].content}"\n`;
          }
          if (s.rendered) summary += `  rendered: "${s.rendered}"\n`;
        }

        summary += '\n';
      }

      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'scroll_to_line') {
    const { doc, line } = args;
    if (!doc || !line) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, line' }], isError: true };
    }
    const result = await scrollToLine(doc, line);
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    return { content: [{ type: 'text', text: `Scrolled to line ${line} → page ${result.page} (${result.x.toFixed(0)}, ${result.y.toFixed(0)})` }] };
  }

  if (name === 'send_note') {
    const { doc, line, text, color } = args;
    if (!doc || !line || !text) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, line, text' }], isError: true };
    }
    const result = await sendNote(doc, line, text, color);
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
      const entry = await connectYjs(doc);
      const timestamp = Date.now();
      const signal = pages && pages.length > 0
        ? { type: 'partial', pages, timestamp }
        : { type: 'full', timestamp };

      entry.doc.transact(() => {
        entry.yRecords.set('signal:reload', signal);
      });
      sendYjsUpdate(entry);

      const desc = signal.type === 'partial'
        ? `Partial reload signaled for pages ${pages.join(', ')}`
        : 'Full reload signaled';
      return { content: [{ type: 'text', text: `${desc} (doc: ${doc}, t=${timestamp})` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
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
