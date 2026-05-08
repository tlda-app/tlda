#!/usr/bin/env node
/**
 * LaTeX typesetting linter — board model violations.
 *
 * Flags:
 * 1. Inline math before a display block (statement split across inline + block)
 * 2. Display blocks with very little content (should be inline)
 * 3. Long/complex inline math at end of sentence (should be a block)
 *
 * Usage: node bin/lint-tex.mjs <file.tex>
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync } from 'fs'
import { basename } from 'path'

const file = process.argv[2]
if (!file) { console.error('Usage: lint-tex.mjs <file.tex>'); process.exit(2) }

const content = readFileSync(file, 'utf8')
const lines = content.split('\n')
const fileName = basename(file)

const warnings = []

function warn(lineNum, msg) {
  warnings.push({ line: lineNum, msg })
}

// --- Rule 1: Inline math immediately before a display block ---
// Pattern: line has $...$ and next non-blank line starts \[ or \begin{equation/align/...}
const displayStarts = /^\s*\\[\[\(]|^\s*\\begin\{(equation|align|gather|multline|split|aligned)/

for (let i = 0; i < lines.length - 1; i++) {
  const line = lines[i]
  if (!line.includes('$')) continue

  // Check if line has inline math containing relations (=, \le, \ge, \in, \subset)
  // — suggests a mathematical statement, not just variable naming
  const uncommented = line.replace(/%.*$/, '')
  const inlineMathParts = uncommented.match(/\$([^$]+)\$/g) || []
  const hasStatement = inlineMathParts.some(m =>
    /[=<>]|\\le\b|\\ge\b|\\in\b|\\subset|\\supseteq|\\subseteq|\\exists|\\forall/.test(m) && m.length > 20
  )
  if (!hasStatement) continue

  // Look ahead for display block start
  for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
    if (lines[j].trim() === '') continue
    if (displayStarts.test(lines[j])) {
      const mathPreview = inlineMathParts.find(m => /[=<>]|\\le|\\ge|\\in/.test(m))?.slice(1, -1).slice(0, 40) || ''
      warn(i + 1, `Inline statement before display — absorb into block: ${mathPreview}...`)
      break
    }
    break
  }
}

// --- Rule 2: Display blocks with very little math content ---
// Pattern: \[ ... \] on one line with < 15 chars of math
const oneLineDisplay = /^\s*\\\[\s*(.*?)\s*\\\]\s*$/

for (let i = 0; i < lines.length; i++) {
  const match = lines[i].match(oneLineDisplay)
  if (match) {
    const mathContent = match[1].replace(/\\q(where|for|and|text)\b/g, '').replace(/\\(left|right|big|Big)\b/g, '').trim()
    if (mathContent.length > 0 && mathContent.length < 15) {
      warn(i + 1, `Tiny display block (${mathContent.length} chars) — consider making inline: ${mathContent}`)
    }
  }
}

// --- Rule 3: Long inline math at end of sentence ---
// Pattern: $...$ with 50+ chars right before period/comma at end of line
const trailingInline = /\$([^$]{50,})\$\s*[.,;]?\s*$/

for (let i = 0; i < lines.length; i++) {
  const uncommented = lines[i].replace(/%.*$/, '')
  const match = uncommented.match(trailingInline)
  if (match) {
    // Skip if this line is inside a display environment
    let inDisplay = false
    for (let j = i; j >= Math.max(0, i - 10); j--) {
      if (/\\begin\{(equation|align|gather|multline)/.test(lines[j])) { inDisplay = true; break }
      if (/\\end\{(equation|align|gather|multline)/.test(lines[j])) break
      if (/^\s*\\\[/.test(lines[j])) { inDisplay = true; break }
      if (/\\\]/.test(lines[j])) break
    }
    if (!inDisplay) {
      warn(i + 1, `Long inline math (${match[1].length} chars) at end of sentence — consider display block`)
    }
  }
}

// --- Output ---
if (warnings.length === 0) {
  console.log(`${fileName}: clean`)
  process.exit(0)
} else {
  console.log(`${fileName}: ${warnings.length} warning(s)\n`)
  for (const w of warnings) {
    console.log(`  L${w.line}: ${w.msg}`)
  }
  process.exit(1)
}
