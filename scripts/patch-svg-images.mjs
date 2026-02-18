#!/usr/bin/env node
/**
 * Patch SVG pages to replace draft-mode image placeholders with actual images.
 *
 * LaTeX's graphicx draft mode renders \includegraphics as a thin-ruled box
 * with the filename inside. dvisvgm converts this to:
 *   - 4 <rect> elements forming the box border
 *   - 1 <text> element (monospace class) with the filename
 *
 * This script finds those placeholders, extracts the filename and bounding box,
 * and replaces them with the actual image:
 *   - SVG figures: inlined directly (vector quality preserved)
 *   - Raster (PNG/JPG/etc): embedded as <image> with base64 data URI
 *
 * Usage:
 *   node scripts/patch-svg-images.mjs <svg-dir> <source-dir>
 *
 * Processes all page-*.svg files in svg-dir, looking for image files in source-dir.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'

const SVG_DIR = process.argv[2]
const SRC_DIR = process.argv[3]

if (!SVG_DIR || !SRC_DIR) {
  console.error('Usage: node patch-svg-images.mjs <svg-dir> <source-dir>')
  process.exit(1)
}

// Image extensions and their MIME types (null = needs conversion, not direct embed)
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': null,
  '.eps': null,
}

/**
 * Find draft-mode image placeholders in SVG content.
 *
 * Pattern: a monospace <text> element containing a filename with an image extension,
 * surrounded by 4 thin <rect> elements forming a box.
 *
 * Returns array of { filename, x, y, width, height, elements } where elements
 * are the SVG source ranges to replace.
 */
function findPlaceholders(svgText) {
  const placeholders = []

  // Find monospace text elements that look like filenames
  // dvisvgm uses class like 'f0' for monospace (cmtt*) — we detect by checking
  // if the text content looks like a filename with an image extension
  const textRe = /<text\s+class='(\w+)'\s+x='([^']+)'\s+y='([^']+)'>([^<]+)<\/text>/g
  let match

  while ((match = textRe.exec(svgText)) !== null) {
    const [fullMatch, cls, tx, ty, content] = match
    const trimmed = content.trim()

    // Check if this looks like an image filename
    const ext = extname(trimmed).toLowerCase()
    if (!MIME.hasOwnProperty(ext)) continue

    // Look for surrounding rect elements that form the draft box
    // The box consists of 4 thin rects (width or height ≈ 0.4)
    // They should be near this text element in the SVG source
    const searchStart = Math.max(0, match.index - 2000)
    const searchEnd = Math.min(svgText.length, match.index + fullMatch.length + 2000)
    const region = svgText.slice(searchStart, searchEnd)

    const rectRe = /<rect\s+x='([^']+)'\s+y='([^']+)'\s+height='([^']+)'\s+width='([^']+)'\s*\/>/g
    const rects = []
    let rm
    while ((rm = rectRe.exec(region)) !== null) {
      rects.push({
        full: rm[0],
        globalIndex: searchStart + rm.index,
        x: parseFloat(rm[1]),
        y: parseFloat(rm[2]),
        h: parseFloat(rm[3]),
        w: parseFloat(rm[4]),
      })
    }

    // Find the 4 rects that form a consistent box containing the text.
    // Draft mode draws: left vert, top horiz, bottom horiz, right vert.
    // Their corners must align: two verts share y-range with two horiz.
    // In grid layouts, multiple figures' rects appear nearby — match by corners.
    const thin = 1.0
    const verts = rects.filter(r => r.w < thin && r.h > thin)
    const horis = rects.filter(r => r.h < thin && r.w > thin)

    if (verts.length < 2 || horis.length < 2) continue

    const textX = parseFloat(tx)
    const textY = parseFloat(ty)
    const eps = 2.0

    // Try all pairs of verts and horiz to find a box containing the text
    let bestBox = null
    for (let vi = 0; vi < verts.length; vi++) {
      for (let vj = vi + 1; vj < verts.length; vj++) {
        const v1 = verts[vi], v2 = verts[vj]
        // Verts must share the same y-range
        if (Math.abs(v1.y - v2.y) > eps || Math.abs(v1.h - v2.h) > eps) continue
        const left = Math.min(v1.x, v2.x)
        const right = Math.max(v1.x, v2.x)
        // Text x must be inside
        if (textX < left - eps || textX > right + eps) continue

        for (let hi = 0; hi < horis.length; hi++) {
          for (let hj = hi + 1; hj < horis.length; hj++) {
            const h1 = horis[hi], h2 = horis[hj]
            // Horiz must share the same x-range
            if (Math.abs(h1.x - h2.x) > eps || Math.abs(h1.w - h2.w) > eps) continue
            const top = Math.min(h1.y, h2.y)
            const bottom = Math.max(h1.y, h2.y)
            // Text y must be inside
            if (textY < top - eps || textY > bottom + eps) continue
            // Corners must align: horiz x-range ≈ vert x-range
            if (Math.abs(h1.x - left) > eps || Math.abs(h1.x + h1.w - right) > eps) continue

            const w = right - left
            const h = bottom - top
            if (w < 5 || h < 5) continue
            // Pick the tightest box containing the text
            if (!bestBox || w * h < bestBox.area) {
              bestBox = { left, right, top, bottom, w, h, area: w * h,
                rects: [v1, v2, h1, h2] }
            }
          }
        }
      }
    }

    if (!bestBox) continue

    const { left, top, w: width, h: height } = bestBox
    const boxRects = bestBox.rects

    placeholders.push({
      filename: trimmed,
      x: left,
      y: top,
      width,
      height,
      textMatch: fullMatch,
      textIndex: match.index,
      rectMatches: boxRects.map(r => r.full),
    })
  }

  return placeholders
}

/** Counter for generating unique font prefixes across inlined figures */
let figureCounter = 0

/**
 * Inline SVG content into a <g> element scaled to fit the placeholder box.
 *
 * Font namespacing: PDF→SVG figures define @font-face rules for the same font
 * families as the page SVG (cmr10, cmmi10, etc.) but with different subset
 * glyph encodings. Without namespacing, the browser merges them and text
 * renders with wrong glyphs. We prefix all font-family names in the figure
 * with a unique ID to isolate them.
 */
function inlineSvg(svgContent, x, y, width, height) {
  const vbMatch = svgContent.match(/viewBox\s*=\s*["']([^"']+)["']/)
  let innerW, innerH
  if (vbMatch) {
    const parts = vbMatch[1].split(/\s+/).map(Number)
    innerW = parts[2]
    innerH = parts[3]
  } else {
    const wm = svgContent.match(/width\s*=\s*["']([^"']+)["']/)
    const hm = svgContent.match(/height\s*=\s*["']([^"']+)["']/)
    innerW = wm ? parseFloat(wm[1]) : width
    innerH = hm ? parseFloat(hm[1]) : height
  }

  const scaleX = width / innerW
  const scaleY = height / innerH
  const scale = Math.min(scaleX, scaleY)

  let inner = svgContent
    .replace(/<\?xml[^?]*\?>\s*/g, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')

  // Namespace font families to avoid conflicts with the page's fonts
  const prefix = `fig${figureCounter++}`
  const fontNames = new Set()
  // Collect font-family names from @font-face rules
  inner.replace(/@font-face\s*\{[^}]*font-family:\s*([^;\s}]+)/g, (_, name) => {
    fontNames.add(name)
    return _
  })
  // Prefix each font name in both @font-face declarations and font-family usages
  for (const name of fontNames) {
    inner = inner.replaceAll(name, `${prefix}-${name}`)
  }

  const scaledW = innerW * scale
  const scaledH = innerH * scale
  const offsetX = x + (width - scaledW) / 2
  const offsetY = y + (height - scaledH) / 2

  // Clip to the viewBox bounds — <g transform> doesn't clip like <svg> does.
  // Content extending beyond the viewBox (e.g. svglite background rects) would overflow.
  const clipId = `figclip${figureCounter}`
  const clip = `<defs><clipPath id='${clipId}'><rect x='0' y='0' width='${innerW}' height='${innerH}'/></clipPath></defs>`

  return `<g transform='translate(${offsetX},${offsetY}) scale(${scale})'>${clip}<g clip-path='url(#${clipId})'>${inner}</g></g>`
}

/**
 * Build a replacement SVG element for an image.
 */
function buildReplacement(placeholder, srcDir) {
  const { filename, x, y, width, height } = placeholder
  let ext = extname(filename).toLowerCase()

  // Search for the file in source dir (might be in subdirectories)
  let imagePath = findFile(srcDir, filename)

  // For unsupported formats (PDF, EPS), try SVG fallback with same basename
  if ((!imagePath || !MIME[ext]) && (ext === '.pdf' || ext === '.eps')) {
    const svgName = filename.replace(/\.[^.]+$/, '.svg')
    const svgPath = findFile(srcDir, svgName)
    if (svgPath) {
      console.log(`  [patch] Using SVG fallback: ${svgName} for ${filename}`)
      imagePath = svgPath
      ext = '.svg'
    }
  }

  if (!imagePath) {
    console.log(`  [patch] Image not found: ${filename}`)
    return null
  }

  if (ext === '.svg') {
    const svgContent = readFileSync(imagePath, 'utf8')
    return inlineSvg(svgContent, x, y, width, height)
  }

  // Raster image: embed as <image> with base64 data URI
  const mime = MIME[ext]
  if (!mime) {
    console.log(`  [patch] Unsupported format: ${filename}`)
    return null
  }

  const data = readFileSync(imagePath)
  const b64 = data.toString('base64')
  return `<image x='${x}' y='${y}' width='${width}' height='${height}' href='data:${mime};base64,${b64}' preserveAspectRatio='xMidYMid meet'/>`
}

/**
 * Search for a file by name in a directory tree.
 */
function findFile(dir, filename) {
  // Try exact path first
  const exact = join(dir, filename)
  if (existsSync(exact)) return exact

  // Search recursively
  const base = basename(filename)
  return searchDir(dir, base)
}

function searchDir(dir, target) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const found = searchDir(join(dir, entry.name), target)
        if (found) return found
      } else if (entry.name === target) {
        return join(dir, entry.name)
      }
    }
  } catch {}
  return null
}

/**
 * Patch a single SVG file.
 */
function patchSvg(svgPath, srcDir) {
  let svgText = readFileSync(svgPath, 'utf8')
  const placeholders = findPlaceholders(svgText)

  if (placeholders.length === 0) return 0

  let patched = 0
  for (const ph of placeholders) {
    const replacement = buildReplacement(ph, srcDir)
    if (!replacement) continue

    // Remove the filename text
    svgText = svgText.replace(ph.textMatch, '')

    // Remove the 4 box rects
    for (const rect of ph.rectMatches) {
      svgText = svgText.replace(rect, '')
    }

    // Insert the replacement before the closing </g> of the page group
    const closeG = svgText.lastIndexOf('</g>')
    if (closeG >= 0) {
      svgText = svgText.slice(0, closeG) + replacement + '\n' + svgText.slice(closeG)
    }

    patched++
  }

  // Clean up any remaining thin rects near placeholder positions.
  // Stacked figures can share border rects that don't match as a clean box
  // of 4, leaving orphan draft-mode borders.
  if (patched > 0) {
    const thinRe = /<rect\s+x='([^']+)'\s+y='([^']+)'\s+height='([^']+)'\s+width='([^']+)'\s*\/>/g
    const margin = 5
    svgText = svgText.replace(thinRe, (match, rx, ry, rh, rw) => {
      const w = parseFloat(rw), h = parseFloat(rh)
      const x = parseFloat(rx), y = parseFloat(ry)
      if (w >= 1.5 && h >= 1.5) return match  // not a draft border
      // Check if near any matched placeholder
      for (const ph of placeholders) {
        if (x >= ph.x - margin && x <= ph.x + ph.width + margin &&
            y >= ph.y - margin && y <= ph.y + ph.height + margin) {
          return ''  // remove orphan border rect
        }
      }
      return match
    })
    writeFileSync(svgPath, svgText)
  }
  return patched
}

// --- Main ---

const svgFiles = readdirSync(SVG_DIR)
  .filter(f => /^page-\d+\.svg$/.test(f))
  .sort()

let totalPatched = 0
for (const f of svgFiles) {
  const count = patchSvg(join(SVG_DIR, f), SRC_DIR)
  if (count > 0) {
    console.log(`  [patch] ${f}: replaced ${count} image(s)`)
    totalPatched += count
  }
}

if (totalPatched > 0) {
  console.log(`  [patch] Total: ${totalPatched} image(s) patched across ${svgFiles.length} pages`)
} else {
  console.log(`  [patch] No image placeholders found`)
}
