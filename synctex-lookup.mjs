#!/usr/bin/env node
/**
 * Look up TeX source line from TLDraw annotation position
 *
 * The TLDraw canvas has SVG pages stacked vertically, scaled to ~800px wide.
 * We need to:
 * 1. Figure out which page the annotation is on
 * 2. Map TLDraw coords back to original SVG/PDF coordinates
 * 3. Query synctex
 *
 * Usage:
 *   node synctex-lookup.mjs <x> <y>                    # Auto-detect page from Y
 *   node synctex-lookup.mjs --page <N> <x> <y>         # Explicit page
 *   node synctex-lookup.mjs --from-snapshot            # Read from latest snapshot
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Config
const PDF_PATH = '/Users/skip/work/bregman-lower-bound/bregman-lower-bound.pdf';
const SVG_DIR = '/Users/skip/work/tlda/public/docs';
const SNAPSHOT_PATH = '/tmp/tldraw-snapshot.json';

// TLDraw layout constants (from SvgDocument.tsx)
const TARGET_WIDTH = 800;  // SVGs scaled to this width
const PAGE_SPACING = 32;   // Gap between pages

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

    // Calculate scaled dimensions (matching SvgDocument.tsx)
    const scale = TARGET_WIDTH / origWidth;
    const scaledWidth = origWidth * scale;
    const scaledHeight = origHeight * scale;

    pages.push({
      pageNum,
      origWidth,
      origHeight,
      viewBoxMinX,
      viewBoxMinY,
      scaledWidth,
      scaledHeight,
      scale,
      top,  // Y position in TLDraw
      bottom: top + scaledHeight,
    });

    top += scaledHeight + PAGE_SPACING;
    pageNum++;
  }

  pageCache = pages;
  return pages;
}

function findPageForY(pages, y) {
  for (const page of pages) {
    if (y >= page.top && y < page.bottom) {
      return page;
    }
  }
  // Default to last page if beyond
  return pages[pages.length - 1];
}

function tldrawToPdfCoords(pages, tlX, tlY) {
  const page = findPageForY(pages, tlY);

  // Get local coordinates within this page
  const localX = tlX;
  const localY = tlY - page.top;

  // Unscale to original SVG/PDF coordinates
  // Add viewBox offset since SVG may not start at (0,0)
  const pdfX = localX / page.scale + page.viewBoxMinX;
  const pdfY = localY / page.scale + page.viewBoxMinY;

  return {
    page: page.pageNum,
    pdfX,
    pdfY,
    localX,
    localY,
    origWidth: page.origWidth,
    origHeight: page.origHeight,
  };
}

function synctexLookup(pageNum, pdfX, pdfY) {
  // synctex edit -o page:x:y:file
  // Coordinates are in big points (72 dpi) from top-left
  const cmd = `synctex edit -o "${pageNum}:${pdfX}:${pdfY}:${PDF_PATH}"`;

  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return parseSynctexOutput(output);
  } catch (e) {
    if (e.stdout) {
      return parseSynctexOutput(e.stdout);
    }
    return { error: e.message };
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
      if (key === 'line' || key === 'column') {
        result[key] = parseInt(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function readAnnotationsFromSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error('No snapshot found at', SNAPSHOT_PATH);
    return [];
  }

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const annotations = [];

  for (const [id, record] of Object.entries(snapshot.store || {})) {
    if (record.typeName === 'shape' && record.type !== 'image') {
      annotations.push({
        id: record.id,
        type: record.type,
        x: record.x,
        y: record.y,
        color: record.props?.color,
      });
    }
  }

  return annotations;
}

async function main() {
  const args = process.argv.slice(2);

  // Check prerequisites
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`PDF not found: ${PDF_PATH}`);
    console.error('Run: pdflatex -synctex=1 bregman-lower-bound.tex');
    process.exit(1);
  }

  const synctexPath = PDF_PATH.replace(/\.pdf$/, '.synctex.gz');
  if (!fs.existsSync(synctexPath)) {
    console.error(`Synctex not found: ${synctexPath}`);
    console.error('Run: pdflatex -synctex=1 bregman-lower-bound.tex');
    process.exit(1);
  }

  const pages = await getPageDimensions();
  console.log(`Loaded ${pages.length} page dimensions`);

  if (args[0] === '--from-snapshot') {
    // Process all annotations from snapshot
    const annotations = readAnnotationsFromSnapshot();
    console.log(`Found ${annotations.length} annotations\n`);

    for (const ann of annotations) {
      const coords = tldrawToPdfCoords(pages, ann.x, ann.y);
      const result = synctexLookup(coords.page, coords.pdfX, coords.pdfY);

      console.log(`${ann.type} (${ann.color || 'default'}) at TLDraw (${ann.x.toFixed(0)}, ${ann.y.toFixed(0)})`);
      console.log(`  → Page ${coords.page}, PDF coords (${coords.pdfX.toFixed(1)}, ${coords.pdfY.toFixed(1)})`);

      if (result.input && result.line) {
        const relPath = path.relative(process.cwd(), result.input);
        const absPath = path.resolve(result.input);
        console.log(`  → ${relPath}:${result.line}`);
        console.log(`  → texsync://file${absPath}:${result.line}`);
      } else {
        console.log(`  → No source found`);
      }
      console.log();
    }
  } else {
    // Single coordinate lookup
    let x, y;

    if (args[0] === '--page') {
      const pageNum = parseInt(args[1]);
      x = parseFloat(args[2]);
      y = parseFloat(args[3]);
      // Convert page-local coords to global
      const page = pages[pageNum - 1];
      y = page.top + y;
    } else {
      x = parseFloat(args[0]);
      y = parseFloat(args[1]);
    }

    if (isNaN(x) || isNaN(y)) {
      console.error('Usage: node synctex-lookup.mjs <x> <y>');
      console.error('       node synctex-lookup.mjs --from-snapshot');
      process.exit(1);
    }

    const coords = tldrawToPdfCoords(pages, x, y);
    console.log(`TLDraw coords: (${x.toFixed(1)}, ${y.toFixed(1)})`);
    console.log(`Page ${coords.page}, PDF coords: (${coords.pdfX.toFixed(1)}, ${coords.pdfY.toFixed(1)})`);

    const result = synctexLookup(coords.page, coords.pdfX, coords.pdfY);

    if (result.input && result.line) {
      const absPath = path.resolve(result.input);
      console.log(`\nSource: ${result.input}:${result.line}`);
      console.log(`texsync://file${absPath}:${result.line}`);

      console.log('\nJSON:', JSON.stringify({
        file: absPath,
        line: result.line,
        page: coords.page,
        tldraw: { x, y },
        pdf: { x: coords.pdfX, y: coords.pdfY },
      }));
    } else {
      console.log('\nNo source location found');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
