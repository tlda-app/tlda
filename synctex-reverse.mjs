#!/usr/bin/env node
/**
 * Reverse synctex lookup: TeX source line → TLDraw coordinates
 *
 * Usage:
 *   node synctex-reverse.mjs <file.tex> <line>
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Config - must match synctex-lookup.mjs
const PDF_PATH = '/Users/skip/work/bregman-lower-bound/bregman-lower-bound.pdf';
const SVG_DIR = '/Users/skip/work/tlda/public/docs';
const TARGET_WIDTH = 800;
const PAGE_SPACING = 32;

// Cache for page dimensions
let pageCache = null;

async function getPageDimensions() {
  if (pageCache) return pageCache;

  const pages = [];
  let pageNum = 1;
  let top = 0;

  while (true) {
    const svgPath = path.join(SVG_DIR, `page-${String(pageNum).padStart(2, '0')}.svg`);
    if (!fs.existsSync(svgPath)) break;

    const svgContent = fs.readFileSync(svgPath, 'utf8');

    // Parse viewBox to get original dimensions and offset
    const viewBoxMatch = svgContent.match(/viewBox=['"]([^'"]+)['"]/);
    let viewBoxMinX = 0, viewBoxMinY = 0;
    let origWidth = 600, origHeight = 800;

    if (viewBoxMatch) {
      const parts = viewBoxMatch[1].split(/\s+/);
      if (parts.length === 4) {
        viewBoxMinX = parseFloat(parts[0]) || 0;
        viewBoxMinY = parseFloat(parts[1]) || 0;
        origWidth = parseFloat(parts[2]) || origWidth;
        origHeight = parseFloat(parts[3]) || origHeight;
      }
    }

    // Also try width/height attributes
    const widthMatch = svgContent.match(/width=['"]([0-9.]+)/);
    const heightMatch = svgContent.match(/height=['"]([0-9.]+)/);
    if (widthMatch) origWidth = parseFloat(widthMatch[1]);
    if (heightMatch) origHeight = parseFloat(heightMatch[1]);

    // Calculate scaled dimensions
    const scale = TARGET_WIDTH / origWidth;
    const scaledHeight = origHeight * scale;

    pages.push({
      pageNum,
      origWidth,
      origHeight,
      viewBoxMinX,
      viewBoxMinY,
      scale,
      top,
      bottom: top + scaledHeight,
    });

    top += scaledHeight + PAGE_SPACING;
    pageNum++;
  }

  pageCache = pages;
  return pages;
}

function pdfToTldrawCoords(pages, pageNum, pdfX, pdfY) {
  const page = pages[pageNum - 1];
  if (!page) {
    throw new Error(`Page ${pageNum} not found`);
  }

  // Reverse the transform from synctex-lookup.mjs:
  // pdfX = localX / scale + viewBoxMinX  →  localX = (pdfX - viewBoxMinX) * scale
  // pdfY = localY / scale + viewBoxMinY  →  localY = (pdfY - viewBoxMinY) * scale
  // tlY = page.top + localY

  const localX = (pdfX - page.viewBoxMinX) * page.scale;
  const localY = (pdfY - page.viewBoxMinY) * page.scale;

  const tldrawX = localX;
  const tldrawY = page.top + localY;

  return { tldrawX, tldrawY, page: pageNum };
}

function synctexView(texFile, line) {
  // synctex view -i line:column:file -o pdf
  const cmd = `synctex view -i "${line}:1:${texFile}" -o "${PDF_PATH}"`;

  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return parseSynctexOutput(output);
  } catch (e) {
    if (e.stdout) {
      return parseSynctexOutput(e.stdout);
    }
    throw e;
  }
}

function parseSynctexOutput(output) {
  const result = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+):(.+)$/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2];
      if (['page', 'x', 'y', 'h', 'v', 'w', 'height'].includes(key)) {
        result[key] = parseFloat(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node synctex-reverse.mjs <file.tex> <line>');
    process.exit(1);
  }

  const texFile = path.resolve(args[0]);
  const line = parseInt(args[1]);

  if (!fs.existsSync(texFile)) {
    console.error(`File not found: ${texFile}`);
    process.exit(1);
  }

  // Get PDF coordinates from synctex
  const synctexResult = synctexView(texFile, line);

  if (!synctexResult.page || synctexResult.x === undefined) {
    console.error('Synctex returned no coordinates');
    console.error('Raw output:', synctexResult);
    process.exit(1);
  }

  console.log(`TeX: ${texFile}:${line}`);
  console.log(`PDF: page ${synctexResult.page}, coords (${synctexResult.x.toFixed(1)}, ${synctexResult.y.toFixed(1)})`);

  // Convert to TLDraw coordinates
  const pages = await getPageDimensions();
  const tldraw = pdfToTldrawCoords(pages, synctexResult.page, synctexResult.x, synctexResult.y);

  console.log(`TLDraw: (${tldraw.tldrawX.toFixed(1)}, ${tldraw.tldrawY.toFixed(1)})`);
  console.log('JSON:', JSON.stringify({
    page: tldraw.page,
    tldrawX: tldraw.tldrawX,
    tldrawY: tldraw.tldrawY,
    pdfX: synctexResult.x,
    pdfY: synctexResult.y,
  }));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
