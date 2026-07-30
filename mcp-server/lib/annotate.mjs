/**
 * Annotation staging — the shared core behind add_note / draw_highlight.
 *
 * Extracted from index.mjs so callers OTHER than the MCP stdio server (e.g. the
 * drill teacher bot) can stage real annotations through the same code path —
 * one source of truth, no drift. These functions are STATELESS: coordinate
 * lookup + a shape POST. They carry none of the MCP's per-agent state
 * (identity, monitors, stdio), so a bot caller just imports and calls them.
 *
 * Both callers must `initDataSource(root, server)` first (data-source.mjs) so
 * lookup/manifest reads resolve, and pass a `server` URL for the shape POST.
 */
import path from 'path';
import { getIndexAbove } from '@tldraw/utils';
import { tldaFetch } from '../../shared/http-client.mjs';
import { docToCanvas, isHtmlDoc, pdfToCanvas, getPageWidth } from './formatCoords.mjs';
import { loadHtmlLayout } from './htmlCoords.mjs';
import { readJson, readJsonSync, ensureProject } from '../data-source.mjs';

const DEFAULT_SERVER = process.env.TLDA_SYNC_SERVER || null;

export function generateShapeId() {
  return 'shape:' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

// Resolve a source line to its lookup entry. Sync: reads the cached/disk
// lookup.json (callers pre-fetch via ensureProject so remote mode is warm).
function lookupLineInData(lookup, lineNum, file) {
  let entry = null;
  if (file) entry = lookup.lines[`${path.basename(file)}:${lineNum}`];
  if (!entry) entry = lookup.lines[lineNum.toString()];
  if (!entry) return null;
  return { page: entry.page, x: entry.x, y: entry.y, content: entry.content, texFile: lookup.meta?.texFile };
}
export function lookupLine(projectName, lineNum, file) {
  const lookup = readJsonSync(projectName, 'lookup.json');
  if (!lookup?.lines) return null;
  return lookupLineInData(lookup, lineNum, file);
}

const SIZE_PRESETS = {
  sm: { width: 250, height: 100 },
  md: { width: 450, height: 200 },
  lg: { width: 650, height: 400 },
  a5: { width: 559, height: 794 },
};
export function resolveSize({ size, width, height }) {
  const preset = (size && SIZE_PRESETS[size]) || SIZE_PRESETS.md;
  return {
    width: typeof width === 'number' ? width : preset.width,
    height: typeof height === 'number' ? height : preset.height,
  };
}

async function postShape(projectName, shape, server) {
  return tldaFetch(`/api/projects/${projectName}/shapes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shape),
    server: server || DEFAULT_SERVER,
  });
}
async function getShapes(projectName, server, typeFilter) {
  const qs = typeFilter ? `?type=${typeFilter}` : '';
  return tldaFetch(`/api/projects/${projectName}/shapes${qs}`, { server: server || DEFAULT_SERVER });
}

/**
 * Stage a math-note annotation anchored to a source line. Behaviour mirrors the
 * former index.mjs addAnnotation exactly. `server` overrides the shape POST
 * target; `fleetId`/`fleetName` stamp authorship (default from env).
 */
export async function stageNote(doc, line, text, {
  color = 'orange', size, width, height, side = 'right', file, choices, page: pageNum,
  server, fleetId = process.env.FLEET_ID, fleetName = process.env.FLEET_NAME, markdownSelectorSource,
} = {}) {
  const dims = resolveSize({ size, width, height });
  width = dims.width;
  height = dims.height;
  await ensureProject(doc); // warm lookup + manifest so the sync coord calls resolve in remote mode

  let linePos;
  if (line) {
    linePos = lookupLine(doc, line, file);
    if (!linePos) return { ok: false, error: `Line ${line}${file ? ' in ' + path.basename(file) : ''} not found in lookup.json for doc "${doc}"` };
  } else if (pageNum) {
    linePos = { page: pageNum, x: 0, y: 150, texFile: null, content: '' };
  } else {
    return { ok: false, error: 'Either line or page is required' };
  }

  const canvasPos = docToCanvas(doc, linePos.page, linePos.x, linePos.y);
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
  let maxIndex = 'a1';
  try {
    const allShapes = await getShapes(doc, server);
    for (const s of allShapes) {
      if (s.typeName === 'shape' && s.index && s.index > maxIndex) maxIndex = s.index;
    }
  } catch (e) { process.stderr.write(`[annotate] shape index scan failed: ${e.message}\n`); }
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
      sourceAnchor: { file: `./${linePos.texFile || doc + '.tex'}`, line, column: -1, content: linePos.content },
      ...(fleetId ? { fleet_id: fleetId } : {}),
      ...(fleetName ? { friendly_name: fleetName } : {}),
      ...(markdownSelectorSource ? { markdownSelectorSource } : {}),
    },
    parentId: 'page:page',
    index: noteIndex,
  };

  await postShape(doc, shape, server);
  return { ok: true, shapeId, page: linePos.page, x, y };
}

// ---- highlight staging (full-line line-range; the drill cue primitive) ----

export async function lookupLineAsync(projectName, lineNum, file) {
  const lookup = await readJson(projectName, 'lookup.json');
  if (!lookup?.lines) return null;
  return lookupLineInData(lookup, lineNum, file);
}

async function getNextShapeIndex(projectName, server) {
  let maxIndex = 'a1';
  try {
    const all = await getShapes(projectName, server);
    for (const s of all) if (s.typeName === 'shape' && s.index && s.index > maxIndex) maxIndex = s.index;
  } catch (e) { process.stderr.write(`[annotate] shape index scan failed: ${e.message}\n`); }
  return getIndexAbove(maxIndex);
}

// Encode {x,y,z} points into TLDraw v4 base64 delta path: first point 3×Float32 LE,
// each subsequent point 3×Float16 LE deltas. Verbatim from index.mjs.
function encodeB64Path(points) {
  if (points.length === 0) return '';
  const buf = Buffer.alloc(12 + (points.length - 1) * 6);
  buf.writeFloatLE(points[0].x, 0);
  buf.writeFloatLE(points[0].y, 4);
  buf.writeFloatLE(points[0].z ?? 0.5, 8);
  let prevX = points[0].x, prevY = points[0].y, prevZ = points[0].z ?? 0.5;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prevX, dy = points[i].y - prevY, dz = (points[i].z ?? 0.5) - prevZ;
    const off = 12 + (i - 1) * 6;
    buf.writeUInt16LE(toFloat16(dx), off);
    buf.writeUInt16LE(toFloat16(dy), off + 2);
    buf.writeUInt16LE(toFloat16(dz), off + 4);
    prevX += float16(toFloat16(dx)); prevY += float16(toFloat16(dy)); prevZ += float16(toFloat16(dz));
  }
  return buf.toString('base64');
}
function toFloat16(value) {
  if (value === 0) return 0;
  if (!isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00;
  const sign = value < 0 ? 1 : 0;
  value = Math.abs(value);
  if (value > 65504) return sign ? 0xfc00 : 0x7c00;
  if (value < 5.96e-8) return sign << 15;
  const exp0 = Math.floor(Math.log2(value));
  let exp = exp0, frac = value / Math.pow(2, exp) - 1;
  if (exp < -14) { frac = value / Math.pow(2, -14); return (sign << 15) | Math.round(frac * 1024); }
  exp += 15;
  if (exp >= 31) return sign ? 0xfc00 : 0x7c00;
  return (sign << 15) | (exp << 10) | Math.round(frac * 1024);
}
function float16(bits) {
  const sign = bits >> 15, exp = (bits >> 10) & 0x1f, frac = bits & 0x3ff;
  if (exp === 0) { const val = frac * (Math.pow(2, -14) / 1024); return sign ? -val : val; }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  const val = Math.pow(2, exp - 15) * (1 + frac / 1024);
  return sign ? -val : val;
}

/**
 * Stage a full-line (line-range) highlight. Mirrors index.mjs's full-line
 * draw_highlight path exactly. The column-precise text-based variant stays in
 * the MCP handler — the drill cue is line-range, so it lives here.
 */
export async function stageHighlight(doc, startLine, endLine, {
  color = 'orange', file, server, fleetId = process.env.FLEET_ID, fleetName = process.env.FLEET_NAME,
} = {}) {
  endLine = endLine ?? startLine;
  await ensureProject(doc);
  const startPos = await lookupLineAsync(doc, startLine, file);
  const endPos = await lookupLineAsync(doc, endLine, file);
  if (!startPos) return { ok: false, error: `Line ${startLine} not found in lookup` };
  if (!endPos) return { ok: false, error: `Line ${endLine} not found in lookup` };

  const startCanvas = pdfToCanvas(startPos.page, startPos.x, startPos.y);
  const endCanvas = pdfToCanvas(endPos.page, endPos.x, endPos.y);
  const pageW = getPageWidth(doc);
  const hlLeft = Math.min(startCanvas.x, endCanvas.x);
  const hlRight = pageW * 0.9;
  const hlTop = Math.min(startCanvas.y, endCanvas.y) - 3;
  const hlBottom = Math.max(startCanvas.y, endCanvas.y) + 3;
  const width = hlRight - hlLeft;
  const height = hlBottom - hlTop;
  const numLines = endLine - startLine + 1;
  const lineH = numLines > 1 ? height / numLines : 0;

  const segments = [];
  if (numLines <= 1) {
    segments.push({ type: 'free', path: encodeB64Path([{ x: 0, y: 0, z: 0.5 }, { x: width, y: 0, z: 0.5 }]) });
  } else {
    for (let i = 0; i < numLines; i++) {
      const y = i * lineH;
      segments.push({ type: 'free', path: encodeB64Path([{ x: 0, y, z: 0.5 }, { x: width, y, z: 0.5 }]) });
    }
  }

  const shapeId = generateShapeId();
  const shapeIndex = await getNextShapeIndex(doc, server);
  const shape = {
    id: shapeId,
    type: 'highlight',
    x: hlLeft, y: hlTop,
    index: shapeIndex,
    rotation: 0, isLocked: false, opacity: 0.7,
    props: { segments, color, size: 's', isComplete: true, isPen: false, scale: 1, scaleX: 1, scaleY: 1 },
    meta: {
      createdAt: Date.now(), createdBy: 'claude',
      sourceAnchor: { file: file || './' + (startPos.texFile || 'main.tex'), line: startLine },
      ...(fleetId ? { fleet_id: fleetId } : {}),
      ...(fleetName ? { friendly_name: fleetName } : {}),
    },
    parentId: 'page:page', typeName: 'shape',
  };
  await postShape(doc, shape, server);
  return { ok: true, shapeId, page: startPos.page };
}
