#!/usr/bin/env node
/**
 * Extract synctex lookup table as static JSON
 *
 * Parses the .synctex.gz file directly in a single pass instead of
 * spawning `synctex view` per line (~200s → ~1s for a 70-page doc).
 *
 * Usage: node extract-synctex-lookup.mjs /path/to/doc.tex output.json
 *
 * Output format:
 * {
 *   "meta": { "texFile": "...", "generated": "...", "inputFiles": [...] },
 *   "lines": {
 *     "42": { "page": 2, "x": 133.5, "y": 245.2, "content": "..." },
 *     "appendix.tex:10": { "page": 24, "x": 99.0, "y": 367.8, "content": "..." },
 *     ...
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createReadStream } from 'fs'
import { createGunzip } from 'zlib'
import { createInterface } from 'readline'
import { dirname, basename, join, resolve } from 'path'

const texPath = process.argv[2]
const outputPath = process.argv[3]

if (!texPath || !outputPath) {
  console.error('Usage: node extract-synctex-lookup.mjs <tex-file> <output.json>')
  process.exit(1)
}

const dir = dirname(texPath)
const base = basename(texPath, '.tex')
const synctexGz = join(dir, base + '.synctex.gz')

if (!existsSync(synctexGz)) {
  console.error(`synctex.gz not found: ${synctexGz}`)
  process.exit(1)
}

// Read source files for content snippets
const texContent = readFileSync(texPath, 'utf8')
const texLines = texContent.split('\n')

// Discover input files from source
function discoverInputFiles(content, texDir) {
  const inputs = []
  const re = /\\(?:input|include)\{([^}]+)\}/g
  let m
  while ((m = re.exec(content)) !== null) {
    let name = m[1]
    if (!name.endsWith('.tex')) name += '.tex'
    const fullPath = join(texDir, name)
    if (existsSync(fullPath)) {
      inputs.push({ name: basename(name), path: fullPath })
    }
  }
  return inputs
}

const inputFiles = discoverInputFiles(texContent, dir)

// Build a map of file content for snippets: path → lines[]
const sourceLines = new Map()
sourceLines.set(resolve(texPath), texLines)
for (const f of inputFiles) {
  sourceLines.set(resolve(f.path), readFileSync(f.path, 'utf8').split('\n'))
}

console.log(`Extracting synctex data from ${synctexGz}`)
console.log(`  Main file: ${texLines.length} lines`)
if (inputFiles.length > 0) {
  console.log(`  Input files: ${inputFiles.map(f => f.name).join(', ')}`)
}

// Parse synctex.gz in a single pass
const inputMap = new Map()  // synctex input ID → resolved file path
let currentPage = 0
const lineData = new Map()  // "key" → { page, x, y }  (first occurrence wins)

// Synctex units: coordinates are in sp (scaled points). 1 sp = 1/65536 pt, 1 pt = 1/72.27 in
// The magnification and unit are in the preamble. Default: unit = 1, magnification = 1000
// Effective scale: coord_in_pt = value * unit * magnification / 1000 / 65536
let unit = 1
let magnification = 1000

const rl = createInterface({
  input: createReadStream(synctexGz).pipe(createGunzip()),
  crlfDelay: Infinity,
})

for await (const line of rl) {
  // Preamble: Input declarations
  if (line.startsWith('Input:')) {
    const match = line.match(/^Input:(\d+):(.+)$/)
    if (match) {
      inputMap.set(parseInt(match[1]), resolve(match[2]))
    }
    continue
  }

  // Preamble values
  if (line.startsWith('Unit:')) {
    unit = parseInt(line.slice(5)) || 1
    continue
  }
  if (line.startsWith('Magnification:')) {
    magnification = parseInt(line.slice(14)) || 1000
    continue
  }

  // Page boundaries
  if (line.startsWith('{')) {
    currentPage = parseInt(line.slice(1)) || 0
    continue
  }
  if (line.startsWith('}')) {
    continue
  }

  // Content records: x, h, v, g, k all have format TYPE<input>,<line>:<x>,<y>...
  // We care about x (character), h (horizontal box), v (vertical box)
  // These give us the position of source line content on the page.
  const type = line[0]
  if (type !== 'x' && type !== 'h' && type !== 'v') continue
  if (currentPage === 0) continue

  // Parse: TYPE<inputId>,<lineNum>:<x>,<y>[,...]
  const colonIdx = line.indexOf(':')
  if (colonIdx === -1) continue
  const commaIdx = line.indexOf(',')
  if (commaIdx === -1 || commaIdx > colonIdx) continue

  const inputId = parseInt(line.slice(1, commaIdx))
  const lineNum = parseInt(line.slice(commaIdx + 1, colonIdx))
  if (isNaN(inputId) || isNaN(lineNum) || lineNum <= 0) continue

  const filePath = inputMap.get(inputId)
  if (!filePath) continue

  // Only process our source files (skip system .sty/.cls files)
  if (!sourceLines.has(filePath)) continue

  // Parse coordinates
  const coords = line.slice(colonIdx + 1).split(',')
  const rawX = parseInt(coords[0])
  const rawY = parseInt(coords[1])
  if (isNaN(rawX) || isNaN(rawY)) continue

  // Convert to points
  const scale = unit * magnification / 1000 / 65536
  const x = parseFloat((rawX * scale).toFixed(1))
  const y = parseFloat((rawY * scale).toFixed(1))

  // Build lookup key
  const isMainFile = filePath === resolve(texPath)
  const key = isMainFile ? `${lineNum}` : `${basename(filePath)}:${lineNum}`

  // First occurrence wins (gives the start position of the line)
  if (!lineData.has(key)) {
    lineData.set(key, { page: currentPage, x, y })
  }
}

// Build output with content snippets
const lookup = {
  meta: {
    texFile: basename(texPath),
    generated: new Date().toISOString(),
    totalLines: texLines.length,
    inputFiles: inputFiles.map(f => f.name),
  },
  lines: {},
}

let mainCount = 0, inputCount = 0
for (const [key, data] of lineData) {
  // Get content snippet
  let content = ''
  if (key.includes(':')) {
    const [fileName, lineStr] = key.split(':')
    const lineIdx = parseInt(lineStr) - 1
    const file = inputFiles.find(f => f.name === fileName)
    if (file) {
      const lines = sourceLines.get(resolve(file.path))
      if (lines && lineIdx >= 0 && lineIdx < lines.length) {
        content = lines[lineIdx].slice(0, 80)
      }
    }
    inputCount++
  } else {
    const lineIdx = parseInt(key) - 1
    if (lineIdx >= 0 && lineIdx < texLines.length) {
      content = texLines[lineIdx].slice(0, 80)
    }
    mainCount++
  }

  // Skip blank/comment lines
  if (!content.trim() || content.trim().startsWith('%')) continue

  lookup.lines[key] = { ...data, content }
}

writeFileSync(outputPath, JSON.stringify(lookup, null, 2))
console.log(`  ${mainCount} main file lines, ${inputCount} input file lines`)
console.log(`  ${Object.keys(lookup.lines).length} total entries (excluding blanks/comments)`)
console.log(`Written to ${outputPath}`)
