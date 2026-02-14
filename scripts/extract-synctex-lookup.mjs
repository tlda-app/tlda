#!/usr/bin/env node
/**
 * Extract synctex lookup table as static JSON
 *
 * Usage: node extract-synctex-lookup.mjs /path/to/doc.tex output.json
 *
 * Supports multi-file LaTeX projects: discovers \input{} and \include{} files
 * and processes their lines too. Main file lines are keyed by line number;
 * input file lines are keyed as "filename.tex:lineNum".
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

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, basename, join } from 'path'

const texPath = process.argv[2]
const outputPath = process.argv[3]

if (!texPath || !outputPath) {
  console.error('Usage: node extract-synctex-lookup.mjs <tex-file> <output.json>')
  process.exit(1)
}

const dir = dirname(texPath)
const base = basename(texPath, '.tex')
const pdfPath = join(dir, base + '.pdf')

/**
 * Discover \input{} and \include{} files from a tex source.
 * Returns array of { name, path } for files that exist on disk.
 */
function discoverInputFiles(texContent, texDir) {
  const inputs = []
  // Match \input{file} and \include{file} — file may or may not have .tex extension
  const re = /\\(?:input|include)\{([^}]+)\}/g
  let m
  while ((m = re.exec(texContent)) !== null) {
    let name = m[1]
    // Add .tex if not present
    if (!name.endsWith('.tex')) name += '.tex'
    const fullPath = join(texDir, name)
    if (existsSync(fullPath)) {
      inputs.push({ name: basename(name), path: fullPath })
    }
  }
  return inputs
}

/**
 * Query synctex for a line in a given file, return { page, x, y } or null.
 */
function querySynctex(filePath, lineNum) {
  try {
    const cmd = `synctex view -i "${lineNum}:0:${filePath}" -o "${pdfPath}"`
    const output = execSync(cmd, {
      encoding: 'utf8',
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const result = {}
    for (const line of output.split('\n')) {
      if (line.startsWith('Page:')) result.page = parseInt(line.slice(5))
      if (line.startsWith('x:')) result.x = parseFloat(line.slice(2))
      if (line.startsWith('y:')) result.y = parseFloat(line.slice(2))
      if (line.startsWith('h:')) result.h = parseFloat(line.slice(2))
      if (line.startsWith('v:')) result.v = parseFloat(line.slice(2))
    }

    if (result.page) {
      return { page: result.page, x: result.x ?? result.h, y: result.y ?? result.v }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Process all lines in a file, adding entries to lookup.lines.
 * keyPrefix: "" for main file (keys are "42"), or "file.tex:" for input files.
 */
function processFile(filePath, lines, keyPrefix, lookup) {
  let success = 0, fail = 0
  const total = lines.length
  const label = keyPrefix || basename(filePath)

  for (let lineNum = 1; lineNum <= total; lineNum++) {
    const content = lines[lineNum - 1]

    if (!content.trim() || content.trim().startsWith('%')) {
      continue
    }

    const result = querySynctex(filePath, lineNum)
    if (result) {
      const key = keyPrefix ? `${keyPrefix}${lineNum}` : `${lineNum}`
      lookup.lines[key] = {
        page: result.page,
        x: result.x,
        y: result.y,
        content: content.slice(0, 80)
      }
      success++
    } else {
      fail++
    }

    if (lineNum % 100 === 0) {
      process.stdout.write(`  [${label}] Processed ${lineNum}/${total} lines\r`)
    }
  }

  return { success, fail }
}

// Read main tex source
const texContent = readFileSync(texPath, 'utf8')
const texLines = texContent.split('\n')

console.log(`Extracting synctex data from ${texPath}`)
console.log(`  ${texLines.length} lines in source`)

// Discover input files
const inputFiles = discoverInputFiles(texContent, dir)
if (inputFiles.length > 0) {
  console.log(`  Found ${inputFiles.length} input file(s): ${inputFiles.map(f => f.name).join(', ')}`)
}

const lookup = {
  meta: {
    texFile: basename(texPath),
    generated: new Date().toISOString(),
    totalLines: texLines.length,
    inputFiles: inputFiles.map(f => f.name)
  },
  lines: {}
}

// Process main file
const mainResult = processFile(texPath, texLines, '', lookup)
console.log(`\n  ${mainResult.success} lines with synctex data`)
console.log(`  ${mainResult.fail} lines without (comments, preamble, etc.)`)

// Process input files
for (const inputFile of inputFiles) {
  const inputContent = readFileSync(inputFile.path, 'utf8')
  const inputLines = inputContent.split('\n')
  console.log(`\n  Processing ${inputFile.name} (${inputLines.length} lines)...`)

  const result = processFile(inputFile.path, inputLines, `${inputFile.name}:`, lookup)
  console.log(`\n  ${result.success} lines with synctex data`)
  console.log(`  ${result.fail} lines without (comments, preamble, etc.)`)
}

// Write output
writeFileSync(outputPath, JSON.stringify(lookup, null, 2))
console.log(`Written to ${outputPath}`)
