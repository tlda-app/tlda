#!/usr/bin/env node
// SyncTeX utilities for mapping between PDF coordinates and source locations
// Uses the synctex CLI tool that comes with TeX distributions

import { execSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * Reverse lookup: PDF position → source location
 * @param {string} pdfPath - Path to PDF file
 * @param {number} page - 1-indexed page number
 * @param {number} x - X coordinate in PDF points
 * @param {number} y - Y coordinate in PDF points
 * @returns {{ file: string, line: number, column: number } | null}
 */
export function pdfToSource(pdfPath, page, x, y) {
  const synctexPath = pdfPath.replace(/\.pdf$/, '.synctex.gz')
  if (!existsSync(synctexPath) && !existsSync(pdfPath.replace(/\.pdf$/, '.synctex'))) {
    console.error('No synctex file found. Compile with: pdflatex -synctex=1')
    return null
  }

  try {
    // synctex edit -o "page:x:y:file"
    const cmd = `synctex edit -o "${page}:${x}:${y}:${pdfPath}"`
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

    // Parse output like:
    // Input:/path/to/file.tex
    // Line:123
    // Column:0
    const lines = output.split('\n')
    let file = null, line = null, column = 0

    for (const l of lines) {
      if (l.startsWith('Input:')) file = l.slice(6)
      if (l.startsWith('Line:')) line = parseInt(l.slice(5))
      if (l.startsWith('Column:')) column = parseInt(l.slice(7))
    }

    if (file && line) {
      return { file, line, column }
    }
    return null
  } catch (e) {
    console.error('synctex edit failed:', e.message)
    return null
  }
}

/**
 * Forward lookup: source location → PDF position
 * @param {string} pdfPath - Path to PDF file
 * @param {string} sourceFile - Path to source .tex file
 * @param {number} line - Line number in source
 * @param {number} column - Column number (optional, default 0)
 * @returns {{ page: number, x: number, y: number, h: number, v: number } | null}
 */
export function sourceToPdf(pdfPath, sourceFile, line, column = 0) {
  try {
    // synctex view -i "line:column:file" -o "output.pdf"
    const cmd = `synctex view -i "${line}:${column}:${sourceFile}" -o "${pdfPath}"`
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

    // Parse output like:
    // Page:5
    // x:123.456
    // y:789.012
    // h:123.456
    // v:789.012
    const lines = output.split('\n')
    let page = null, x = null, y = null, h = null, v = null

    for (const l of lines) {
      if (l.startsWith('Page:')) page = parseInt(l.slice(5))
      if (l.startsWith('x:')) x = parseFloat(l.slice(2))
      if (l.startsWith('y:')) y = parseFloat(l.slice(2))
      if (l.startsWith('h:')) h = parseFloat(l.slice(2))
      if (l.startsWith('v:')) v = parseFloat(l.slice(2))
    }

    if (page && (x !== null || h !== null)) {
      return { page, x: x ?? h, y: y ?? v, h, v }
    }
    return null
  } catch (e) {
    console.error('synctex view failed:', e.message)
    return null
  }
}

// CLI usage
if (process.argv[1].endsWith('synctex.js')) {
  const [,, cmd, ...args] = process.argv

  if (cmd === 'edit' && args.length >= 4) {
    // Reverse lookup: synctex.js edit pdf page x y
    const [pdf, page, x, y] = args
    const result = pdfToSource(pdf, parseInt(page), parseFloat(x), parseFloat(y))
    console.log(JSON.stringify(result, null, 2))
  } else if (cmd === 'view' && args.length >= 3) {
    // Forward lookup: synctex.js view pdf source line [column]
    const [pdf, source, line, column] = args
    const result = sourceToPdf(pdf, source, parseInt(line), parseInt(column) || 0)
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('Usage:')
    console.log('  synctex.js edit <pdf> <page> <x> <y>    - PDF position → source')
    console.log('  synctex.js view <pdf> <source> <line>  - source → PDF position')
  }
}
