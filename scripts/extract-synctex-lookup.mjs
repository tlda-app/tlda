#!/usr/bin/env node
/**
 * Extract synctex lookup table as static JSON
 *
 * Usage: node extract-synctex-lookup.mjs /path/to/doc.tex output.json
 *
 * Output format:
 * {
 *   "meta": { "texFile": "...", "generated": "..." },
 *   "lines": {
 *     "42": { "page": 2, "x": 133.5, "y": 245.2, "content": "..." },
 *     ...
 *   }
 * }
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
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

// Read tex source
const texContent = readFileSync(texPath, 'utf8')
const texLines = texContent.split('\n')

console.log(`Extracting synctex data from ${texPath}`)
console.log(`  ${texLines.length} lines in source`)

const lookup = {
  meta: {
    texFile: basename(texPath),
    generated: new Date().toISOString(),
    totalLines: texLines.length
  },
  lines: {}
}

let successCount = 0
let failCount = 0

for (let lineNum = 1; lineNum <= texLines.length; lineNum++) {
  const content = texLines[lineNum - 1]

  // Skip empty lines and comments
  if (!content.trim() || content.trim().startsWith('%')) {
    continue
  }

  try {
    const cmd = `synctex view -i "${lineNum}:0:${texPath}" -o "${pdfPath}"`
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
      lookup.lines[lineNum] = {
        page: result.page,
        x: result.x ?? result.h,
        y: result.y ?? result.v,
        content: content.slice(0, 80)  // First 80 chars as fingerprint
      }
      successCount++
    } else {
      failCount++
    }
  } catch (e) {
    failCount++
  }

  // Progress
  if (lineNum % 100 === 0) {
    process.stdout.write(`  Processed ${lineNum}/${texLines.length} lines\r`)
  }
}

console.log(`\n  ${successCount} lines with synctex data`)
console.log(`  ${failCount} lines without (comments, preamble, etc.)`)

// Write output
writeFileSync(outputPath, JSON.stringify(lookup, null, 2))
console.log(`Written to ${outputPath}`)
