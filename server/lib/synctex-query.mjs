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
import { sourceDir, outputDir, getProjectsDir, readProject, readSourceFile } from './project-store.mjs'

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

/**
 * Load synctex for a project's target. texBase identifies which sibling
 * .tex file to read records for — single-target projects pass the project's
 * primary texBase. The cache is keyed by (project, texBase) so multiple
 * targets coexist.
 */
export async function loadSynctex(projectName, texBase, opts = {}) {
  const variant = opts.variant || ''
  const key = `${projectName}:${texBase || ''}:${variant}`
  if (cache.has(key)) return cache.get(key)

  const srcDir = sourceDir(projectName)
  const proj = await readProject(projectName)
  const mainFileDir = proj?.mainFile ? dirname(proj.mainFile) : '.'
  const synctexDir = (mainFileDir && mainFileDir !== '.') ? join(srcDir, mainFileDir) : srcDir

  let synctexFile
  let synctexPath
  if (variant === 'word') {
    if (!texBase) return null
    synctexPath = join(outputDir(projectName), `${texBase}-word.synctex.gz`)
  } else if (texBase) {
    synctexFile = `${texBase}.synctex.gz`
  } else {
    const files = existsSync(synctexDir) ? readdirSync(synctexDir) : []
    synctexFile = files.find(f => f.endsWith('.synctex.gz'))
  }
  if (!synctexPath && !synctexFile) return null

  synctexPath ||= join(synctexDir, synctexFile)
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

  // --- Construct bounding boxes from adjacent records ---
  // Most synctex records have w=0, h=0. Build boxes from the sequence:
  // - Horizontal: each record extends from its x to the next record's x on the same baseline
  // - Vertical: each baseline extends halfway to the adjacent baselines above and below

  // Group records by page
  const byPage = new Map()
  for (const r of records) {
    if (!byPage.has(r.page)) byPage.set(r.page, [])
    byPage.get(r.page).push(r)
  }

  for (const [, pageRecs] of byPage) {
    // Cluster baselines: records within 1pt vertically are on the same rendered line
    const baselineY = new Map() // rounded y → [records]
    for (const r of pageRecs) {
      const key = Math.round(r.y * 2) / 2 // 0.5pt granularity
      if (!baselineY.has(key)) baselineY.set(key, [])
      baselineY.get(key).push(r)
    }

    // Sort baseline keys to compute vertical extents
    const sortedBaselines = [...baselineY.keys()].sort((a, b) => a - b)
    const baselineHalfGaps = new Map() // baseline y → { top, bottom } half-gaps
    for (let i = 0; i < sortedBaselines.length; i++) {
      const y = sortedBaselines[i]
      const gapAbove = i > 0 ? (y - sortedBaselines[i - 1]) / 2 : 6
      const gapBelow = i < sortedBaselines.length - 1 ? (sortedBaselines[i + 1] - y) / 2 : 6
      baselineHalfGaps.set(y, { top: Math.min(gapAbove, 8), bottom: Math.min(gapBelow, 8) })
    }

    // For each baseline cluster, sort by x and assign horizontal extents
    for (const [y, recs] of baselineY) {
      recs.sort((a, b) => a.x - b.x)
      const gaps = baselineHalfGaps.get(y) || { top: 6, bottom: 6 }

      for (let i = 0; i < recs.length; i++) {
        const r = recs[i]
        // Only construct boxes for records that lack real dimensions
        if (r.w > 0 && r.h > 0) continue

        // Horizontal: extends to next record's x, or add a small default for last record
        r.w = i < recs.length - 1 ? recs[i + 1].x - r.x : 5
        if (r.w <= 0) r.w = 2 // safety: overlapping records

        // Vertical: use half-gaps to adjacent baselines
        r.h = gaps.top    // height above baseline
        r.d = gaps.bottom // depth below baseline
      }
    }
  }

  const result = { records, inputMap, unit, magnification }
  cache.set(key, result)
  return result
}

/**
 * Clear cached synctex data for a project (call after rebuild).
 * Clears every (project, texBase) entry for the given project.
 */
export function clearSynctexCache(projectName) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${projectName}:`)) cache.delete(key)
  }
}

function readWordMap(projectName, texBase) {
  if (!texBase) return null
  const p = join(outputDir(projectName), `${texBase}-word-map.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function wordInputRelFile(filePath) {
  const marker = `${join('word-synctex-source')}/`
  const normalized = filePath.replaceAll('\\', '/')
  const idx = normalized.lastIndexOf(marker)
  if (idx >= 0) return normalized.slice(idx + marker.length)
  return basename(filePath)
}

function densifyPathPoints(points, maxStep = 2) {
  if (!Array.isArray(points) || points.length < 2) return points || []
  const out = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    out.push(a)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / maxStep))
    for (let j = 1; j < steps; j++) {
      const t = j / steps
      out.push({ x: a.x + dx * t, y: a.y + dy * t })
    }
  }
  out.push(points[points.length - 1])
  return out
}

function collectPointHits(pageRecords, points) {
  const hitRecords = new Set()
  for (const pt of densifyPathPoints(points)) {
    let pointHit = false
    for (const r of pageRecords) {
      const top = r.y - (r.h || 0)
      const bottom = r.y + (r.d || 0)
      const left = r.x
      const right = r.x + (r.w || 0)
      if (pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom) {
        hitRecords.add(r)
        pointHit = true
      }
    }
    if (!pointHit) {
      let bestDist = Infinity
      let best = null
      for (const r of pageRecords) {
        const yDist = Math.abs(r.y - pt.y)
        if (yDist > 6) continue
        const dist = yDist + Math.abs(r.x - pt.x) * 0.1
        if (dist < bestDist) { bestDist = dist; best = r }
      }
      if (best) hitRecords.add(best)
    }
  }
  return hitRecords
}

async function getSourceFromWordPath(projectName, page, points, target = '') {
  const project = await readProject(projectName)
  const texBase = target || (project?.mainFile || 'main.tex').replace(/\.tex$/i, '').split('/').pop()
  const wordMap = readWordMap(projectName, texBase)
  if (!wordMap?.lineMap?.length) return null

  const data = await loadSynctex(projectName, texBase, { variant: 'word' })
  if (!data || points.length === 0) return null

  const mapByGenerated = new Map()
  for (const row of wordMap.lineMap) {
    mapByGenerated.set(`${row.file}:${row.generatedLine}`, row)
  }

  const sourceFileIds = new Set()
  const relByInputId = new Map()
  for (const [id, filePath] of data.inputMap) {
    if (!filePath.endsWith('.tex')) continue
    const rel = wordInputRelFile(filePath)
    sourceFileIds.add(id)
    relByInputId.set(id, rel)
  }

  const pageRecords = data.records.filter(r => r.page === page && sourceFileIds.has(r.inputId))
  if (pageRecords.length === 0) return null

  const hitRows = []
  for (const r of collectPointHits(pageRecords, points)) {
    const rel = relByInputId.get(r.inputId)
    const mapped = rel ? mapByGenerated.get(`${rel}:${r.line}`) : null
    if (mapped && !mapped.structural && !mapped.unsafe) hitRows.push(mapped)
  }
  if (hitRows.length === 0) return null

  const byFile = new Map()
  for (const row of hitRows) {
    if (!byFile.has(row.file)) byFile.set(row.file, [])
    byFile.get(row.file).push(row)
  }
  const [file, rows] = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  rows.sort((a, b) => a.line - b.line || a.startCol - b.startCol)

  const sourceContent = readSourceFile(projectName, file)
  if (!sourceContent) return null
  const allLines = sourceContent.split('\n')
  const hitByLine = new Map()

  for (const row of rows) {
    const cur = hitByLine.get(row.line) || { start: Infinity, end: -Infinity }
    cur.start = Math.min(cur.start, row.startCol)
    cur.end = Math.max(cur.end, row.endCol)
    hitByLine.set(row.line, cur)
  }

  const hitLineNums = [...hitByLine.keys()].sort((a, b) => a - b)
  const from = Math.max(1, hitLineNums[0] - 5)
  const to = Math.min(allLines.length, hitLineNums[hitLineNums.length - 1] + 5)
  const lines = []
  for (let line = from; line <= to; line++) {
    const hit = hitByLine.get(line)
    const entry = { line, content: allLines[line - 1], file }
    if (hit) {
      entry.highlighted = true
      entry.hlStart = hit.start
      entry.hlEnd = hit.end
      entry.exact = true
      entry.resolver = 'word-synctex'
    }
    lines.push(entry)
  }

  return {
    file,
    startLine: hitLineNums[0],
    endLine: hitLineNums[hitLineNums.length - 1],
    lines,
    resolver: 'word-synctex',
  }
}

export function findTextNearSourceLine(projectName, file, startLine, text, radius = 10) {
  const sourceContent = readSourceFile(projectName, file)
  if (!sourceContent) return null
  const sourceLines = sourceContent.split('\n')
  const searchStart = Math.max(0, startLine - radius - 1)
  const searchEnd = Math.min(sourceLines.length, startLine + radius)
  const searchRegion = sourceLines.slice(searchStart, searchEnd).join('\n')
  const matchIdx = searchRegion.indexOf(text)
  if (matchIdx === -1) return null

  const beforeMatch = searchRegion.slice(0, matchIdx)
  const matchStartLine = searchStart + beforeMatch.split('\n').length
  const matchStartCol = beforeMatch.split('\n').pop().length
  const beforeEnd = searchRegion.slice(0, matchIdx + text.length)
  const matchEndLine = searchStart + beforeEnd.split('\n').length
  const matchEndCol = beforeEnd.split('\n').pop().length

  return {
    sourceLines,
    startLine: matchStartLine,
    startCol: matchStartCol,
    endLine: matchEndLine,
    endCol: matchEndCol,
  }
}

function sourceFileIdsForSynctex(data) {
  const sourceFileIds = new Set()
  for (const [id, filePath] of data.inputMap) {
    if (filePath.endsWith('.tex')) sourceFileIds.add(id)
  }
  return sourceFileIds
}

function targetFileIdForSynctex(data, file) {
  const targetBasename = basename(file)
  for (const [id, filePath] of data.inputMap) {
    if (basename(filePath) === targetBasename) return id
  }
  return null
}

/**
 * Shared rendered-span resolver used by text highlights and source-cursor laser
 * placement. It maps source columns through the same Synctex record ordering.
 */
export async function sourceTextSpanToPdfSpans(projectName, file, sourceLines, span) {
  const data = await loadSynctex(projectName)
  if (!data) return null

  const sourceFileIds = sourceFileIdsForSynctex(data)
  const targetFileId = targetFileIdForSynctex(data, file)
  const recordsByLine = new Map()
  for (const r of data.records) {
    if (r.line < span.startLine || r.line > span.endLine) continue
    if (targetFileId != null && r.inputId !== targetFileId) continue
    if (!sourceFileIds.has(r.inputId)) continue
    if (!recordsByLine.has(r.line)) recordsByLine.set(r.line, [])
    recordsByLine.get(r.line).push(r)
  }

  if (recordsByLine.size === 0) return null

  const firstLineRecs = recordsByLine.values().next().value
  const page = firstLineRecs[0].page
  const pdfSpans = []
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity

  for (let line = span.startLine; line <= span.endLine; line++) {
    const lineRecs = recordsByLine.get(line)
    if (!lineRecs || lineRecs.length === 0) continue
    const allInOrder = [...lineRecs].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
    const n = allInOrder.length
    if (n === 0) continue

    const srcLine = sourceLines[line - 1] || ''
    const strippedLen = stripTex(srcLine).length || 1
    let colStart = 0
    let colEnd = srcLine.length
    if (line === span.startLine) colStart = span.startCol
    if (line === span.endLine) colEnd = span.endCol

    const strippedPre = stripTex(srcLine.slice(0, colStart)).length
    const strippedMatch = stripTex(srcLine.slice(colStart, colEnd)).length
    if (strippedMatch === 0) continue

    const startRecIdx = Math.max(0, Math.round((strippedPre / strippedLen) * (n - 1)))
    const endRecIdx = Math.min(n - 1, Math.round(((strippedPre + strippedMatch) / strippedLen) * (n - 1)))
    const selected = allInOrder.slice(startRecIdx, endRecIdx + 1)
    const yValues = new Set(selected.map(r => Math.round(r.y)))
    for (const yKey of yValues) {
      const recsOnLine = selected.filter(r => Math.round(r.y) === yKey)
      if (recsOnLine.length === 0) continue
      const xStart = Math.min(...recsOnLine.map(r => r.x))
      const xEnd = Math.max(...recsOnLine.map(r => r.x))
      const y = recsOnLine[0].y
      pdfSpans.push({ page, line, xStart, xEnd, y })
      left = Math.min(left, xStart)
      right = Math.max(right, xEnd)
      top = Math.min(top, y - 3)
      bottom = Math.max(bottom, y + 3)
    }
  }

  if (pdfSpans.length === 0) return null
  return { page, pdfSpans, bounds: { left, right, top, bottom } }
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
export async function getSourceFromPath(projectName, page, points, highlightText = '', fragments = [], target = '') {
  const wordResult = await getSourceFromWordPath(projectName, page, points, target)
  if (wordResult) return wordResult

  const data = await loadSynctex(projectName, target || undefined)
  if (!data || points.length === 0) return null

  // Filter to source .tex files that actually exist on disk.
  // The synctex wrapper file (e.g. <texBase>-wrapped.tex written to a now-deleted
  // temp build dir) ends in .tex but no longer exists — exclude it so we don't
  // return null when a hit record maps to the ephemeral wrapper.
  const sourceFileIds = new Set()
  for (const [id, filePath] of data.inputMap) {
    if (filePath.endsWith('.tex') && existsSync(filePath)) sourceFileIds.add(id)
  }

  // Get all synctex records on this page from source files
  const pageRecords = data.records.filter(r => r.page === page && sourceFileIds.has(r.inputId))
  if (pageRecords.length === 0) return null

  // For each path point, collect synctex records whose bounding box contains it.
  // Synctex coords: x = left edge, y = baseline, w = width, h = height above baseline, d = depth below.
  // Bounding box: x to x+w horizontally, y-h to y+d vertically.
  const hitRecords = new Set()
  for (const pt of points) {
    const pointHits = []
    for (const r of pageRecords) {
      const top = r.y - (r.h || 0)
      const bottom = r.y + (r.d || 0)
      const left = r.x
      const right = r.x + (r.w || 0)
      if (pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom) {
        pointHits.push(r)
      }
    }
    for (const r of pointHits) hitRecords.add(r)
    // Fallback: if no box contains this point, use nearest within ~6pt vertically
    if (pointHits.length === 0) {
      let bestDist = Infinity
      let best = null
      for (const r of pageRecords) {
        const yDist = Math.abs(r.y - pt.y)
        if (yDist > 6) continue
        const dist = yDist + Math.abs(r.x - pt.x) * 0.1
        if (dist < bestDist) { bestDist = dist; best = r }
      }
      if (best) hitRecords.add(best)
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

  // Context: find rendered baselines above and below the highlight, and include
  // the source text for those baselines. This gives context that matches what
  // the user sees on the page, not arbitrary source file entries.
  const CONTEXT_RENDERED_LINES = 5 // rendered lines above/below the highlight
  const hitYs = [...hitRecords].map(r => r.y)
  const hitYMin = Math.min(...hitYs)
  const hitYMax = Math.max(...hitYs)

  // Collect all unique baselines on this page, sorted by y
  const allBaselines = [...new Set(pageRecords.map(r => Math.round(r.y * 2) / 2))].sort((a, b) => a - b)
  const hitBaselineIdx = allBaselines.findIndex(y => y >= hitYMin - 1)
  const hitBaselineEndIdx = allBaselines.findIndex(y => y > hitYMax + 1)
  const contextStartIdx = Math.max(0, (hitBaselineIdx >= 0 ? hitBaselineIdx : 0) - CONTEXT_RENDERED_LINES)
  const contextEndIdx = Math.min(allBaselines.length, (hitBaselineEndIdx >= 0 ? hitBaselineEndIdx : allBaselines.length) + CONTEXT_RENDERED_LINES)

  // Find which source lines correspond to the context baselines
  const contextSourceLines = new Set()
  for (let i = contextStartIdx; i < contextEndIdx; i++) {
    const y = allBaselines[i]
    for (const r of pageRecords) {
      if (Math.abs(r.y - y) < 1) contextSourceLines.add(r.line)
    }
  }
  // Also include the hit lines themselves
  for (const ln of hitLines.keys()) contextSourceLines.add(ln)

  const sortedContext = [...contextSourceLines].sort((a, b) => a - b)
  const from = sortedContext.length > 0 ? sortedContext[0] : startLine
  const to = sortedContext.length > 0 ? sortedContext[sortedContext.length - 1] : endLine

  const lines = []
  for (let lineNum = from; lineNum <= to; lineNum++) {
    const i = lineNum - 1
    const isHit = hitLines.has(lineNum)
    const entry = { line: lineNum, content: allLines[i], highlighted: isHit }

    if (isHit) {
      // Synctex gives a trustworthy line, not a trustworthy column span.
      // Leave the span absent until the tspan ranker proves it.
      entry.ambiguous = true
      entry.exact = false
      entry.approximate = true
      entry.resolver = 'ranker'
    }

    lines.push(entry)
  }

  // --- Tspan-anchored column estimation ---
  // Each fragment is a rendered text span with (x, y, text) in PDF coords.
  // Match fragment positions to synctex records to assign fragments to source lines.
  // Then search for fragment text in the source line to find exact column positions.
  if (fragments.length > 0) {
    // Assign each fragment to the nearest synctex record's source line
    const fragsByLine = new Map() // lineNum → [fragment texts in order]
    for (const frag of fragments) {
      let bestDist = Infinity
      let bestLine = null
      for (const r of pageRecords) {
        const dy = Math.abs(r.y - frag.y)
        if (dy > 15) continue // must be on same rendered line
        const dx = Math.abs(r.x - frag.x)
        const dist = dy * 10 + dx // weight y heavily
        if (dist < bestDist) { bestDist = dist; bestLine = r.line }
      }
      if (bestLine != null && hitLines.has(bestLine)) {
        if (!fragsByLine.has(bestLine)) fragsByLine.set(bestLine, [])
        fragsByLine.get(bestLine).push(frag.text)
      }
    }

    // For each highlighted line, find column range by searching for anchor words
    for (const entry of lines) {
      if (!entry.highlighted) continue
      const frags = fragsByLine.get(entry.line)
      if (!frags || frags.length === 0) continue

      const src = entry.content
      const ranked = rankSourceSpanCandidates({
        sourceLine: src,
        fragmentTexts: frags,
        highlightText,
        lineRecords: allRecordsByLine.get(entry.line) || [],
        hitRange: hitLines.get(entry.line),
      })
      if (ranked.candidates.length > 0) {
        entry.candidates = ranked.candidates.map(c => ({ ...c, line: entry.line }))
        entry.confidence = ranked.confidence
        entry.ambiguous = ranked.ambiguous
        if (!ranked.ambiguous && ranked.confidence >= 0.45) {
          entry.hlStart = ranked.candidates[0].start
          entry.hlEnd = ranked.candidates[0].end
        }
      }
    }
  }

  // Derive relative file name
  const srcDir = sourceDir(projectName)
  let relFile = hitFile
  try {
    if (hitFile.startsWith(realResolve(srcDir))) {
      relFile = hitFile.slice(realResolve(srcDir).length + 1)
    }
  } catch {}

  return { file: relFile, startLine, endLine, lines, resolver: 'ranker', exact: false, approximate: true }
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
export function rankSourceSpanCandidates({ sourceLine, fragmentTexts, highlightText, lineRecords, hitRange }) {
  const fullHighlightQuery = normalizeRenderedText(highlightText || '')
  const queries = [...new Set([
    normalizeRenderedText(fragmentTexts.join(' ')),
    fullHighlightQuery,
  ].filter(Boolean))]
  const query = queries[0] || ''
  if (!query) return { candidates: [], confidence: 0, ambiguous: true }

  const stripped = stripTex(sourceLine)
  const rawCandidates = []

  for (const q of queries) {
    const fuzzy = fuzzySubstringMatch(stripped, q)
    if (fuzzy) {
      const sourceSpan = mapStrippedToSource(sourceLine, fuzzy.start, fuzzy.end)
      if (sourceSpan) rawCandidates.push(sourceSpan)
    }
  }

  for (const q of queries) {
    for (const span of tokenWindowCandidates(sourceLine, q)) rawCandidates.push(span)
  }

  const seen = new Set()
  const candidates = []
  for (const span of rawCandidates) {
    const start = Math.max(0, Math.min(sourceLine.length, span.start))
    const end = Math.max(start, Math.min(sourceLine.length, span.end))
    if (end <= start) continue
    const key = `${start}:${end}`
    if (seen.has(key)) continue
    seen.add(key)

    const candidateText = sourceLine.slice(start, end)
    const renderedCandidate = normalizeRenderedText(stripTex(candidateText))
    const textScore = Math.max(...queries.map(q => similarityScore(renderedCandidate, q)))
    const containmentScore = fullHighlightQuery
      ? highlightContainmentScore(renderedCandidate, fullHighlightQuery)
      : 0
    const edgeScore = Math.max(...queries.map(q => edgeWordScore(renderedCandidate, q)))
    const geomScore = geometryScore(sourceLine.length, start, end, lineRecords, hitRange)
    const continuityScore = lineRecords?.length ? 1 : 0.5
    const fullHighlightBonus = fullHighlightQuery && renderedCandidate === fullHighlightQuery ? 0.08 : 0
    const semanticScore = Math.max(textScore, containmentScore)
    const score = clamp01(semanticScore * 0.55 + edgeScore * 0.2 + geomScore * 0.2 + continuityScore * 0.05 + fullHighlightBonus)

    candidates.push({
      line: 0,
      start,
      end,
      score,
      confidence: score,
      text: candidateText,
    })
  }

  candidates.sort((a, b) => b.score - a.score || (a.end - a.start) - (b.end - b.start))
  const top = candidates.slice(0, 5)
  const best = top[0]
  const second = best ? top.find(c => spanOverlapRatio(best, c) < 0.8) : undefined
  const gap = best && second ? best.score - second.score : best ? best.score : 0
  const confidence = best ? clamp01(best.score * 0.75 + Math.min(0.25, gap)) : 0
  const ambiguous = !best || confidence < 0.55 || (!!second && gap < 0.08)

  for (const c of top) c.confidence = confidence
  return { candidates: top, confidence, ambiguous }
}

function spanOverlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  const smaller = Math.max(1, Math.min(a.end - a.start, b.end - b.start))
  return overlap / smaller
}

function tokenWindowCandidates(sourceLine, query) {
  const stripped = stripTex(sourceLine)
  const tokens = []
  const re = /[A-Za-z0-9]+/g
  let match
  while ((match = re.exec(stripped))) {
    tokens.push({ text: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length })
  }
  if (tokens.length === 0) return []

  const queryTokens = normalizeRenderedText(query).split(/\s+/).filter(Boolean)
  const targetLen = Math.max(1, queryTokens.length)
  const spans = []
  for (let i = 0; i < tokens.length; i++) {
    for (const width of [targetLen - 1, targetLen, targetLen + 1, targetLen + 2]) {
      if (width <= 0) continue
      const j = i + width - 1
      if (j >= tokens.length) continue
      const strippedStart = tokens[i].start
      const strippedEnd = tokens[j].end
      const mapped = mapStrippedToSource(sourceLine, strippedStart, strippedEnd)
      if (mapped) spans.push(mapped)
    }
  }
  return spans
}

function normalizeRenderedText(text) {
  return (text || '')
    .replace(/[ﬁﬂ]/g, m => m === 'ﬁ' ? 'fi' : 'fl')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function similarityScore(a, b) {
  const aTokens = a.split(/\s+/).filter(Boolean)
  const bTokens = b.split(/\s+/).filter(Boolean)
  if (aTokens.length === 0 || bTokens.length === 0) return 0
  const counts = new Map()
  for (const t of aTokens) counts.set(t, (counts.get(t) || 0) + 1)
  let overlap = 0
  for (const t of bTokens) {
    const n = counts.get(t) || 0
    if (n > 0) {
      overlap++
      counts.set(t, n - 1)
    }
  }
  const dice = (2 * overlap) / (aTokens.length + bTokens.length)
  const seq = orderedTokenScore(aTokens, bTokens)
  return clamp01(dice * 0.7 + seq * 0.3)
}

function highlightContainmentScore(candidate, highlight) {
  const candidateTokens = candidate.split(/\s+/).filter(Boolean)
  const highlightTokens = highlight.split(/\s+/).filter(Boolean)
  if (candidateTokens.length === 0 || highlightTokens.length === 0) return 0

  const candidateInHighlight = orderedCoverage(candidateTokens, highlightTokens)
  const highlightInCandidate = orderedCoverage(highlightTokens, candidateTokens)
  const coverage = Math.max(candidateInHighlight, highlightInCandidate)
  if (coverage < 0.65) return 0

  const lengthBalance = Math.min(candidateTokens.length, highlightTokens.length) / Math.max(candidateTokens.length, highlightTokens.length)
  return clamp01(coverage * 0.85 + lengthBalance * 0.15)
}

function orderedCoverage(needleTokens, haystackTokens) {
  let i = 0
  let matched = 0
  for (const t of needleTokens) {
    while (i < haystackTokens.length && haystackTokens[i] !== t) i++
    if (i < haystackTokens.length) {
      matched++
      i++
    }
  }
  return matched / Math.max(needleTokens.length, 1)
}

function orderedTokenScore(aTokens, bTokens) {
  let i = 0
  let matched = 0
  for (const t of bTokens) {
    while (i < aTokens.length && aTokens[i] !== t) i++
    if (i < aTokens.length) {
      matched++
      i++
    }
  }
  return matched / Math.max(aTokens.length, bTokens.length, 1)
}

function edgeWordScore(candidate, query) {
  const c = candidate.split(/\s+/).filter(Boolean)
  const q = query.split(/\s+/).filter(Boolean)
  if (c.length === 0 || q.length === 0) return 0
  let score = 0
  if (c[0] === q[0]) score += 0.5
  else if (c[0]?.startsWith(q[0]) || q[0]?.startsWith(c[0])) score += 0.25
  const cLast = c[c.length - 1]
  const qLast = q[q.length - 1]
  if (cLast === qLast) score += 0.5
  else if (cLast?.startsWith(qLast) || qLast?.startsWith(cLast)) score += 0.25
  return score
}

function geometryScore(sourceLen, start, end, lineRecords, hitRange) {
  if (!lineRecords?.length || !hitRange || sourceLen <= 0) return 0.5
  const sorted = [...lineRecords].sort((a, b) => a.x - b.x)
  const lineMin = sorted[0].x
  const lineMax = sorted[sorted.length - 1].x
  const lineWidth = lineMax - lineMin
  if (lineWidth <= 0) return 0.5

  const expectedStart = lineMin + (start / sourceLen) * lineWidth
  const expectedEnd = lineMin + (end / sourceLen) * lineWidth
  const actualStart = Math.max(lineMin, hitRange.minX)
  const actualEnd = Math.min(lineMax, hitRange.maxX)
  const startErr = Math.abs(expectedStart - actualStart) / lineWidth
  const endErr = Math.abs(expectedEnd - actualEnd) / lineWidth
  return clamp01(1 - (startErr + endErr))
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

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
  const { text, map } = stripTexWithSourceMap(source)
  const start = Math.max(0, Math.min(strippedStart, text.length - 1))
  const end = Math.max(start + 1, Math.min(strippedEnd, text.length))
  if (map.length === 0 || start >= map.length) return null

  const sourceStart = map[start]
  const sourceEnd = map[Math.min(end - 1, map.length - 1)] + 1
  if (sourceEnd <= sourceStart) return null
  return { start: sourceStart, end: sourceEnd }
}

function stripTexWithSourceMap(source) {
  let text = ''
  const map = []

  const push = (ch, idx) => {
    if (/\s/.test(ch)) {
      if (text.length === 0 || text.endsWith(' ')) return
      text += ' '
      map.push(idx)
      return
    }
    text += ch
    map.push(idx)
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      while (i < source.length && /[a-zA-Z]/.test(source[i])) i++
      i--
      continue
    }
    if (/[{}$^_~]/.test(ch)) continue
    push(ch, i)
  }

  while (text.startsWith(' ')) {
    text = text.slice(1)
    map.shift()
  }
  while (text.endsWith(' ')) {
    text = text.slice(0, -1)
    map.pop()
  }

  return { text, map }
}
