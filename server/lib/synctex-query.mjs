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
 * Path-based source lookup: given a sequence of PDF points (the highlight's
 * center path), find the nearest synctex record for each point. Returns the
 * source text passage with the matched region highlighted.
 *
 * @param {string} projectName
 * @param {number} page - 1-indexed PDF page
 * @param {Array<{x: number, y: number}>} points - PDF coordinates along the path
 * @param {string} [highlightText] - SVG-extracted text for fuzzy validation
 */
export async function getSourceFromPath(projectName, page, points, highlightText = '') {
  const data = await loadSynctex(projectName)
  if (!data || points.length === 0) return null

  // Filter to source .tex files
  const sourceFileIds = new Set()
  for (const [id, path] of data.inputMap) {
    if (path.endsWith('.tex')) sourceFileIds.add(id)
  }

  // Get all synctex records on this page from source files
  const pageRecords = data.records.filter(r => r.page === page && sourceFileIds.has(r.inputId))
  if (pageRecords.length === 0) return null

  // For each path point, find the nearest synctex record
  // Only consider records within ~6pt vertically (half a line height)
  const hitRecords = new Set()
  for (const pt of points) {
    let bestDist = Infinity
    let best = null
    for (const r of pageRecords) {
      const yDist = Math.abs(r.y - pt.y)
      if (yDist > 10) continue // must be on the same rendered line (~12pt spacing)
      const dist = yDist + Math.abs(r.x - pt.x) * 0.1
      if (dist < bestDist) {
        bestDist = dist
        best = r
      }
    }
    if (best) {
      hitRecords.add(best)
    }
  }

  if (hitRecords.size === 0) return null

  // Get the unique source lines hit, in order
  const hitLines = new Map() // line → { minX, maxX } of hit records
  let hitFile = null
  for (const r of hitRecords) {
    if (!hitFile) hitFile = data.inputMap.get(r.inputId)
    if (!hitLines.has(r.line)) hitLines.set(r.line, { minX: r.x, maxX: r.x })
    const entry = hitLines.get(r.line)
    entry.minX = Math.min(entry.minX, r.x)
    entry.maxX = Math.max(entry.maxX, r.x)
  }

  if (!hitFile) return null

  // Read the tex source
  if (!existsSync(hitFile)) return null
  const content = readFileSync(hitFile, 'utf8')
  const allLines = content.split('\n')

  const sortedLineNums = [...hitLines.keys()].sort((a, b) => a - b)
  const startLine = sortedLineNums[0]
  const endLine = sortedLineNums[sortedLineNums.length - 1]

  // Get all records for hit lines (for column estimation)
  const allRecordsByLine = new Map()
  for (const r of pageRecords) {
    if (hitLines.has(r.line)) {
      if (!allRecordsByLine.has(r.line)) allRecordsByLine.set(r.line, [])
      allRecordsByLine.get(r.line).push(r)
    }
  }

  // Build output: full contiguous range with context, but only mark
  // path-hit lines as highlighted (non-hit lines between are shown but not highlighted)
  const contextPad = 1
  const from = Math.max(1, startLine - contextPad)
  const to = Math.min(allLines.length, endLine + contextPad)

  const lines = []
  for (let lineNum = from; lineNum <= to; lineNum++) {
    const i = lineNum - 1
    const isHit = hitLines.has(lineNum)
    const entry = { line: lineNum, content: allLines[i], highlighted: isHit }

    // Column estimation for hit lines
    if (isHit) {
      const hitRange = hitLines.get(lineNum)
      const lineRecs = allRecordsByLine.get(lineNum) || []
      if (lineRecs.length >= 2) {
        const sorted = [...lineRecs].sort((a, b) => a.x - b.x)
        const lineXMin = sorted[0].x
        const lineXMax = sorted[sorted.length - 1].x
        const lineXRange = lineXMax - lineXMin
        if (lineXRange > 0) {
          const fracStart = Math.max(0, (hitRange.minX - lineXMin) / lineXRange)
          const fracEnd = Math.min(1, (hitRange.maxX - lineXMin) / lineXRange)
          const srcLen = allLines[i].length
          entry.hlStart = Math.max(0, Math.round(fracStart * srcLen))
          entry.hlEnd = Math.min(srcLen, Math.round(fracEnd * srcLen))
        }
      }
    }

    lines.push(entry)
  }

  // Derive relative file name
  const srcDir = sourceDir(projectName)
  let relFile = hitFile
  try {
    if (hitFile.startsWith(realResolve(srcDir))) {
      relFile = hitFile.slice(realResolve(srcDir).length + 1)
    }
  } catch {}

  return { file: relFile, startLine, endLine, lines }
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

  // Filter to source files only (skip .sty/.cls)
  const sourceFileIds = new Set()
  for (const [id, path] of data.inputMap) {
    if (path.endsWith('.tex')) sourceFileIds.add(id)
  }

  for (const r of pageRecords) {
    if (!sourceFileIds.has(r.inputId)) continue

    // Y-weighted distance (y matters much more than x for line identification)
    const dist = Math.abs(r.y - pdfY) * 1.0 + Math.abs(r.x - pdfX) * 0.05

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
 * @param {string} [highlightText] - SVG-extracted text to fuzzy-match for substring highlighting
 * @returns {Promise<{ file: string, startLine: number, endLine: number, lines: Array<{line: number, content: string, highlighted: boolean, hlStart?: number, hlEnd?: number}> } | null>}
 */
export async function getSourceContext(projectName, page, startX, startY, endX, endY, contextLines = 2, highlightText = '') {
  const data = await loadSynctex(projectName)
  if (!data) return null

  // Find ALL synctex records in the y-range on this page (from source .tex files)
  const sourceFileIds = new Set()
  for (const [id, path] of data.inputMap) {
    if (path.endsWith('.tex')) sourceFileIds.add(id)
  }

  const xMin = Math.min(startX, endX)
  const xMax = Math.max(startX, endX)
  // Tight y-range: ±4pt catches the rendered line without bleeding into adjacent
  const yMin = Math.min(startY, endY) - 4
  const yMax = Math.max(startY, endY) + 4

  // Collect all synctex records in the highlight bbox, grouped by source line
  // Also collect ALL records for matched lines (for column estimation)
  const insideRecords = [] // records inside the highlight bbox
  const allRecordsByLine = new Map() // line → all records for that line on this page
  let matchedFile = null

  for (const r of data.records) {
    if (r.page !== page) continue
    if (!sourceFileIds.has(r.inputId)) continue

    const inYRange = r.y >= yMin && r.y <= yMax
    const inXRange = r.x >= xMin - 10 && r.x <= xMax + 10
    const inBbox = inYRange && inXRange

    if (inYRange) {
      if (!matchedFile) matchedFile = data.inputMap.get(r.inputId)
      // Collect ALL records for this line (for column estimation)
      if (!allRecordsByLine.has(r.line)) allRecordsByLine.set(r.line, [])
      allRecordsByLine.get(r.line).push(r)
    }
    if (inBbox) {
      insideRecords.push(r)
    }
  }

  // Also do point lookups for start/end as fallback
  const start = await pdfToSource(projectName, page, startX, startY)
  const end = await pdfToSource(projectName, page, endX, endY)
  if (start && !matchedFile) matchedFile = start.file

  // Determine matched line range
  const matchedLines = new Set(insideRecords.map(r => r.line))
  if (start) matchedLines.add(start.line)
  if (end) matchedLines.add(end.line)

  if (matchedLines.size === 0 || !matchedFile) return null

  const sortedLines = [...matchedLines].sort((a, b) => a - b)
  const file = matchedFile
  const startLine = sortedLines[0]
  const endLine = sortedLines[sortedLines.length - 1]

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

  // --- Method 1: synctex x-record column estimation ---
  // For each highlighted line, use the x-positions of synctex records to estimate
  // which portion of the source line falls within the highlight's x-range.
  for (const l of lines) {
    if (!l.highlighted) continue
    const lineRecords = allRecordsByLine.get(l.line)
    if (!lineRecords || lineRecords.length < 2) continue

    // Sort all records for this line by x-position
    const sorted = [...lineRecords].sort((a, b) => a.x - b.x)
    const lineXMin = sorted[0].x
    const lineXMax = sorted[sorted.length - 1].x
    const lineXRange = lineXMax - lineXMin

    if (lineXRange <= 0) continue

    // Find which fraction of the line's x-range the highlight covers
    const hlXStart = Math.max(xMin, lineXMin)
    const hlXEnd = Math.min(xMax, lineXMax)
    if (hlXEnd <= hlXStart) continue

    const fracStart = (hlXStart - lineXMin) / lineXRange
    const fracEnd = (hlXEnd - lineXMin) / lineXRange

    // Map fractions to column positions in the source text
    const srcLen = l.content.length
    l.hlStart = Math.max(0, Math.round(fracStart * srcLen))
    l.hlEnd = Math.min(srcLen, Math.round(fracEnd * srcLen))
  }

  // --- Method 2: fuzzy text matching (validates/refines method 1) ---
  if (highlightText) {
    const hlLines = lines.filter(l => l.highlighted)
    const fullSource = hlLines.map(l => l.content).join(' ')
    // Strip tex commands to get plain text for matching
    const stripped = stripTex(fullSource)
    // Normalize the SVG text (collapse spaces, remove ligature artifacts)
    const normalizedHl = highlightText.replace(/\s+/g, ' ').trim()

    // Find the best substring match of normalizedHl within stripped
    const match = fuzzySubstringMatch(stripped, normalizedHl)
    if (match) {
      // Map the match position back to the original source (with tex commands)
      const sourceMatch = mapStrippedToSource(fullSource, match.start, match.end)
      if (sourceMatch) {
        // Find which lines and columns the match spans
        let charOffset = 0
        for (const l of hlLines) {
          const lineLen = l.content.length
          const matchStart = sourceMatch.start - charOffset
          const matchEnd = sourceMatch.end - charOffset

          if (matchEnd > 0 && matchStart < lineLen) {
            l.hlStart = Math.max(0, matchStart)
            l.hlEnd = Math.min(lineLen, matchEnd)
          }
          charOffset += lineLen + 1 // +1 for the space we joined with
        }
      }
    }
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

/** Strip tex commands to get approximate plain text. */
function stripTex(tex) {
  return tex
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')  // \cmd{content} → content
    .replace(/\\[a-zA-Z]+/g, '')                 // \cmd → ''
    .replace(/[{}$^_~]/g, '')                    // remove braces, math, etc.
    .replace(/\s+/g, ' ')
    .trim()
}

/** Find best fuzzy substring match of query within text. Returns {start, end} in text coords or null. */
function fuzzySubstringMatch(text, query) {
  if (!query || query.length < 3) return null
  const tLower = text.toLowerCase()
  const qLower = query.toLowerCase()

  // Try exact substring first
  const exact = tLower.indexOf(qLower)
  if (exact >= 0) return { start: exact, end: exact + query.length }

  // Try with first/last few words (SVG text often has garbled edges)
  const words = qLower.split(/\s+/).filter(w => w.length > 2)
  if (words.length < 2) return null

  // Find the first word that matches
  const firstWord = words[0]
  const lastWord = words[words.length - 1]
  const firstIdx = tLower.indexOf(firstWord)
  const lastIdx = tLower.lastIndexOf(lastWord)

  if (firstIdx >= 0 && lastIdx >= 0 && lastIdx >= firstIdx) {
    return { start: firstIdx, end: lastIdx + lastWord.length }
  }

  // Try middle words if edges are garbled
  for (let i = 1; i < words.length - 1; i++) {
    const idx = tLower.indexOf(words[i])
    if (idx >= 0) {
      // Expand outward to find word boundaries
      const start = Math.max(0, idx - 20)
      const end = Math.min(text.length, idx + words[i].length + 20)
      return { start, end }
    }
  }

  return null
}

/** Map a position in stripped text back to position in original source. */
function mapStrippedToSource(source, strippedStart, strippedEnd) {
  const stripped = stripTex(source)
  // Build character map: stripped index → source index
  // This is approximate — we re-strip and align
  let si = 0 // source index
  let di = 0 // stripped index
  const strippedChars = stripTex(source)

  // Simple approach: find the stripped substring, then search for it in source
  const matchedText = stripped.slice(strippedStart, strippedEnd)
  // Find this text in the source (allowing tex commands interspersed)
  const pattern = matchedText.split('').map(c =>
    c === ' ' ? '\\s+(?:\\\\[a-zA-Z]+(?:\\{[^}]*\\})?\\s*)*' : escapeRegex(c)
  ).join('(?:\\\\[a-zA-Z]+(?:\\{[^}]*\\})?)*\\s*')

  try {
    const re = new RegExp(pattern, 'i')
    const m = source.match(re)
    if (m) {
      return { start: m.index, end: m.index + m[0].length }
    }
  } catch {
    // Regex too complex — fall back to proportional mapping
  }

  // Proportional fallback
  const ratio = source.length / Math.max(1, stripped.length)
  return { start: Math.round(strippedStart * ratio), end: Math.round(strippedEnd * ratio) }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
