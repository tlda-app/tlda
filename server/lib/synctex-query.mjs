/**
 * Synctex reverse lookup: PDF position → source location with tex content.
 *
 * Parses the .synctex.gz file to find which source line corresponds to a
 * given PDF coordinate, then reads the actual tex source to return content.
 * Uses bounding boxes (h/v records) for accurate containment queries.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { createReadStream } from 'fs'
import { createGunzip } from 'zlib'
import { createInterface } from 'readline'
import { dirname, basename, join, resolve } from 'path'
import { sourceDir, getProjectsDir } from './project-store.mjs'

function realResolve(...args) {
  const p = resolve(...args)
  try { return realpathSync(p) } catch { return p }
}

/** Parsed synctex record with bounding box */
function makeSynctexRecord(inputId, lineNum, page, x, y, w, h, d) {
  return { inputId, line: lineNum, page, x, y, w, h, d }
}

/**
 * Parse synctex.gz and build a spatial index for reverse lookups.
 * Returns { records, inputMap, unit, magnification } or null on error.
 * Caches per project.
 */
const cache = new Map()

async function loadSynctex(projectName) {
  if (cache.has(projectName)) return cache.get(projectName)

  const srcDir = sourceDir(projectName)
  // Find the synctex.gz file
  const files = existsSync(srcDir) ? readdirSync(srcDir) : []
  const synctexFile = files.find(f => f.endsWith('.synctex.gz'))
  if (!synctexFile) return null

  const synctexPath = join(srcDir, synctexFile)
  if (!existsSync(synctexPath)) return null

  const inputMap = new Map()
  let unit = 1, magnification = 1000
  let currentPage = 0
  const records = [] // all h/v/x records with bounding info

  const rl = createInterface({
    input: createReadStream(synctexPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (line.startsWith('Input:')) {
      const match = line.match(/^Input:(\d+):(.+)$/)
      if (match) inputMap.set(parseInt(match[1]), realResolve(match[2]))
      continue
    }
    if (line.startsWith('Unit:')) { unit = parseInt(line.slice(5)) || 1; continue }
    if (line.startsWith('Magnification:')) { magnification = parseInt(line.slice(14)) || 1000; continue }
    if (line.startsWith('{')) { currentPage = parseInt(line.slice(1)) || 0; continue }
    if (line.startsWith('}')) continue

    const type = line[0]
    if (type !== 'x' && type !== 'h' && type !== 'v') continue
    if (currentPage === 0) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const commaIdx = line.indexOf(',')
    if (commaIdx === -1 || commaIdx > colonIdx) continue

    const inputId = parseInt(line.slice(1, commaIdx))
    const lineNum = parseInt(line.slice(commaIdx + 1, colonIdx))
    if (isNaN(inputId) || isNaN(lineNum) || lineNum <= 0) continue

    const coords = line.slice(colonIdx + 1).split(',')
    const rawX = parseInt(coords[0])
    const rawY = parseInt(coords[1])
    if (isNaN(rawX) || isNaN(rawY)) continue

    const scale = unit * magnification / 1000 / 65536
    const x = rawX * scale
    const y = rawY * scale

    // h and v records have width, height, depth
    let w = 0, h2 = 0, d = 0
    if ((type === 'h' || type === 'v') && coords.length >= 5) {
      w = parseInt(coords[2]) * scale
      h2 = parseInt(coords[3]) * scale
      d = parseInt(coords[4]) * scale
    }

    records.push({ inputId, line: lineNum, page: currentPage, x, y, w, h: h2, d })
  }

  const result = { records, inputMap, unit, magnification }
  cache.set(projectName, result)
  return result
}

/**
 * Clear cached synctex data for a project (call after rebuild).
 */
export function clearSynctexCache(projectName) {
  cache.delete(projectName)
}

/**
 * Reverse lookup: given PDF page + coordinates, find the source location.
 *
 * @param {string} projectName
 * @param {number} page - 1-indexed PDF page
 * @param {number} pdfX - X in PDF points
 * @param {number} pdfY - Y in PDF points
 * @returns {Promise<{ file: string, line: number } | null>}
 */
export async function pdfToSource(projectName, page, pdfX, pdfY) {
  const data = await loadSynctex(projectName)
  if (!data) return null

  // Find the closest record on this page
  const pageRecords = data.records.filter(r => r.page === page)
  if (pageRecords.length === 0) return null

  // For h/v records with width: check containment (y within [y-h, y+d], x within [x, x+w])
  // For point records: find nearest by y, then x
  let best = null
  let bestDist = Infinity

  for (const r of pageRecords) {
    // Skip non-source files
    if (!data.inputMap.has(r.inputId)) continue

    let dist
    if (r.w > 0) {
      // Bounding box containment check
      const top = r.y - r.h
      const bottom = r.y + r.d
      const left = r.x
      const right = r.x + r.w

      if (pdfY >= top - 2 && pdfY <= bottom + 2 && pdfX >= left - 2 && pdfX <= right + 2) {
        dist = 0 // Inside the box
      } else {
        // Distance to box
        const dx = Math.max(left - pdfX, 0, pdfX - right)
        const dy = Math.max(top - pdfY, 0, pdfY - bottom)
        dist = Math.sqrt(dx * dx + dy * dy)
      }
    } else {
      dist = Math.abs(r.y - pdfY) + Math.abs(r.x - pdfX) * 0.1 // Y-weighted
    }

    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }

  if (!best) return null

  const filePath = data.inputMap.get(best.inputId)
  return { file: filePath, line: best.line }
}

/**
 * Get source context: given a PDF bounding box, find the source line range
 * and return the actual tex content with the matched region identified.
 *
 * @param {string} projectName
 * @param {number} page - 1-indexed PDF page
 * @param {number} startX - left X in PDF points
 * @param {number} startY - top Y in PDF points
 * @param {number} endX - right X in PDF points
 * @param {number} endY - bottom Y in PDF points
 * @param {number} [contextLines=2] - extra lines of context above/below
 * @returns {Promise<{ file: string, startLine: number, endLine: number, lines: Array<{line: number, content: string, highlighted: boolean}> } | null>}
 */
export async function getSourceContext(projectName, page, startX, startY, endX, endY, contextLines = 2) {
  const start = await pdfToSource(projectName, page, startX, startY)
  const end = await pdfToSource(projectName, page, endX, endY)

  if (!start) return null

  const file = start.file
  const startLine = start.line
  const endLine = end ? Math.max(end.line, startLine) : startLine

  // Read the actual tex file
  if (!existsSync(file)) return null
  const content = readFileSync(file, 'utf8')
  const allLines = content.split('\n')

  const from = Math.max(0, startLine - 1 - contextLines)
  const to = Math.min(allLines.length, endLine + contextLines)

  const lines = []
  for (let i = from; i < to; i++) {
    lines.push({
      line: i + 1,
      content: allLines[i],
      highlighted: (i + 1) >= startLine && (i + 1) <= endLine,
    })
  }

  // Derive relative file name
  const srcDir = sourceDir(projectName)
  let relFile = file
  try {
    if (file.startsWith(realResolve(srcDir))) {
      relFile = file.slice(realResolve(srcDir).length + 1)
    }
  } catch {}

  return { file: relFile, startLine, endLine, lines }
}
