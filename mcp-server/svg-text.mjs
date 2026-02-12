/**
 * Server-side SVG text extraction for shape interpretation.
 *
 * Parses <text> and <tspan> elements from dvisvgm-generated SVGs,
 * groups fragments by baseline, detects word spaces via heuristic,
 * and provides queries like "what rendered text is in this bounding box?"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';

// ---- Font class parsing ----

/**
 * Extract font classes from SVG <style> block.
 * dvisvgm generates rules like: text.f23 {font-family:cmr17;font-size:17.215441px}
 */
function parseFontClasses(svgText) {
  const classes = {};
  const re = /text\.(\w+)\s*\{[^}]*font-family:\s*(\w+)[^}]*font-size:\s*([\d.]+)px/g;
  let m;
  while ((m = re.exec(svgText)) !== null) {
    classes[m[1]] = { fontFamily: m[2], fontSize: parseFloat(m[3]) };
  }
  return classes;
}

// ---- SVG text extraction ----

/**
 * Parse a single SVG file and return text lines grouped by baseline.
 * @param {string} svgPath - Absolute path to SVG file
 * @returns {{ lines: Array<{text: string, x: number, y: number, fontSize: number}>, viewBox: {minX: number, minY: number, width: number, height: number} }}
 */
export function loadPageText(svgPath) {
  const svgText = fs.readFileSync(svgPath, 'utf8');
  const fontClasses = parseFontClasses(svgText);

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  // Parse viewBox
  const svgEl = doc.getElementsByTagName('svg')[0];
  let viewBox = { minX: -72, minY: -72, width: 612, height: 792 };
  if (svgEl) {
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4) {
        viewBox = { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
      }
    }
  }

  // Collect all text fragments with positions
  const fragments = [];
  const textEls = doc.getElementsByTagName('text');

  for (let i = 0; i < textEls.length; i++) {
    const textEl = textEls[i];
    const classAttr = textEl.getAttribute('class') || '';
    const fontInfo = fontClasses[classAttr] || { fontFamily: 'cmr10', fontSize: 10 };

    // Get initial x, y from <text> element
    let currentX = parseFloat(textEl.getAttribute('x')) || 0;
    let currentY = parseFloat(textEl.getAttribute('y')) || 0;

    // Process direct text content of <text> element (before first tspan)
    // and all <tspan> children
    const children = textEl.childNodes;
    for (let j = 0; j < children.length; j++) {
      const node = children[j];

      if (node.nodeType === 3) {
        // Text node directly in <text>
        const txt = node.nodeValue;
        if (txt && txt.trim()) {
          fragments.push({ text: txt, x: currentX, y: currentY, fontSize: fontInfo.fontSize });
        }
      } else if (node.nodeName === 'tspan') {
        const tspanX = node.getAttribute('x');
        const tspanY = node.getAttribute('y');
        if (tspanX && tspanX.length > 0) currentX = parseFloat(tspanX);
        if (tspanY && tspanY.length > 0) currentY = parseFloat(tspanY);

        const txt = node.textContent;
        if (txt) {
          fragments.push({ text: txt, x: currentX, y: currentY, fontSize: fontInfo.fontSize });
        }
      }
    }
  }

  // Group fragments by baseline y (quantize to 0.5-unit bins, matching TextSelectionLayer)
  const yBuckets = new Map();
  for (const f of fragments) {
    const key = Math.round(f.y * 2) / 2;
    if (!yBuckets.has(key)) yBuckets.set(key, []);
    yBuckets.get(key).push(f);
  }

  // Sort each bucket by x, merge into text lines with word space detection
  const lines = [];
  const sortedKeys = [...yBuckets.keys()].sort((a, b) => a - b);

  for (const yKey of sortedKeys) {
    const bucket = yBuckets.get(yKey);
    bucket.sort((a, b) => a.x - b.x);

    // Merge fragments with word space heuristic
    let merged = '';
    let lineX = bucket[0].x;
    let lineFontSize = bucket[0].fontSize;
    let prevEndX = bucket[0].x; // estimated end of previous fragment

    for (let i = 0; i < bucket.length; i++) {
      const f = bucket[i];
      if (i > 0) {
        // Estimate width of previous fragment using per-char average for CM fonts
        const prev = bucket[i - 1];
        const prevWidth = prev.text.length * prev.fontSize * 0.48;
        prevEndX = prev.x + prevWidth;
        const gap = f.x - prevEndX;
        // Insert space if gap is significant relative to font size.
        // Threshold 0.1 is permissive — better to have extra spaces than missing ones.
        if (gap > f.fontSize * 0.1) {
          merged += ' ';
        }
      }
      merged += f.text;
    }

    lines.push({
      text: merged,
      x: lineX,
      y: yKey,
      fontSize: lineFontSize,
    });
  }

  return { lines, viewBox };
}

// ---- Cache ----

const pageTextCache = new Map(); // svgPath → { data, mtime }

function loadPageTextCached(svgPath) {
  try {
    const stat = fs.statSync(svgPath);
    const cached = pageTextCache.get(svgPath);
    if (cached && cached.mtime >= stat.mtimeMs) return cached.data;

    const data = loadPageText(svgPath);
    pageTextCache.set(svgPath, { data, mtime: stat.mtimeMs });
    return data;
  } catch {
    return null;
  }
}

// ---- Coordinate transform + query ----

const _lc2 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'layout-constants.json'), 'utf8'));
const PDF_WIDTH = _lc2.PDF_WIDTH;
const PAGE_WIDTH = _lc2.TARGET_WIDTH;
const PAGE_GAP = _lc2.PAGE_GAP;

/**
 * Find rendered text within a canvas bounding box.
 *
 * @param {string} docName - Document name (e.g. "bregman")
 * @param {object} canvasBBox - { minX, minY, maxX, maxY } in canvas coordinates
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string[]} Array of text lines overlapping the bbox
 */
export function findRenderedText(docName, canvasBBox, projectRoot) {
  // Load manifest to get page count
  const manifestPath = path.join(projectRoot, 'public', 'docs', 'manifest.json');
  let pageCount;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pageCount = manifest.documents?.[docName]?.pages;
  } catch {
    return [];
  }
  if (!pageCount) return [];

  // Determine which page(s) the bbox falls on
  // Each SVG has its own viewBox; we need to load it to get accurate dimensions
  const docDir = path.join(projectRoot, 'public', 'docs', docName);

  // Load first page to get viewBox (all pages in a doc should share the same viewBox)
  const firstPagePath = path.join(docDir, 'page-01.svg');
  const firstPageData = loadPageTextCached(firstPagePath);
  if (!firstPageData) return [];

  const vb = firstPageData.viewBox;
  const scale = PAGE_WIDTH / vb.width;
  const pageHeight = vb.height * scale;

  // Find which page the bbox center is on
  const centerY = (canvasBBox.minY + canvasBBox.maxY) / 2;
  const pageIndex = Math.floor(centerY / (pageHeight + PAGE_GAP));
  if (pageIndex < 0 || pageIndex >= pageCount) return [];

  const pageTop = pageIndex * (pageHeight + PAGE_GAP);

  // Convert canvas bbox to SVG viewBox coordinates
  const svgMinX = (canvasBBox.minX / scale) + vb.minX;
  const svgMaxX = (canvasBBox.maxX / scale) + vb.minX;
  const svgMinY = ((canvasBBox.minY - pageTop) / scale) + vb.minY;
  const svgMaxY = ((canvasBBox.maxY - pageTop) / scale) + vb.minY;

  // Load the page's text
  const pageNum = String(pageIndex + 1).padStart(2, '0');
  const svgPath = path.join(docDir, `page-${pageNum}.svg`);
  const pageData = loadPageTextCached(svgPath);
  if (!pageData) return [];

  // Find text lines whose baseline falls within the y range (with margin)
  const yMargin = 5; // SVG units — generous to catch lines near stroke
  const results = [];
  for (const line of pageData.lines) {
    if (line.y >= svgMinY - yMargin && line.y <= svgMaxY + yMargin) {
      // Optional: x-filter for wide horizontal strokes
      // For now, include all lines in the y range
      results.push(line.text);
    }
  }

  return results;
}
