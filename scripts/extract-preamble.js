#!/usr/bin/env node
// Extract LaTeX preamble macros and convert to KaTeX-compatible JSON
// Usage: node extract-preamble.js input.tex output.json

import { readFileSync, writeFileSync } from 'fs'

const texFile = process.argv[2]
const outputFile = process.argv[3]

if (!texFile || !outputFile) {
  console.error('Usage: node extract-preamble.js <input.tex> <output.json>')
  process.exit(1)
}

const tex = readFileSync(texFile, 'utf8')

// Extract only the preamble (before \begin{document})
const preambleMatch = tex.match(/^([\s\S]*?)\\begin\{document\}/)
const preamble = preambleMatch ? preambleMatch[1] : tex

const macros = {}

// Match \newcommand{\name}{definition} or \newcommand{\name}[n]{definition}
// Handle nested braces by counting
function extractBraceContent(str, startIdx) {
  let depth = 0
  let start = -1
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (str[i] === '}') {
      depth--
      if (depth === 0) {
        return { content: str.slice(start, i), endIdx: i }
      }
    }
  }
  return null
}

// Find all \newcommand definitions
let idx = 0
while ((idx = preamble.indexOf('\\newcommand', idx)) !== -1) {
  // Skip to the command name
  const nameStart = preamble.indexOf('{\\', idx)
  if (nameStart === -1 || nameStart > idx + 20) { idx++; continue }

  const nameEnd = preamble.indexOf('}', nameStart)
  if (nameEnd === -1) { idx++; continue }

  const name = preamble.slice(nameStart + 1, nameEnd) // includes backslash

  // Check for optional argument count [n]
  let searchIdx = nameEnd + 1
  while (preamble[searchIdx] === ' ' || preamble[searchIdx] === '\n') searchIdx++

  let argCount = 0
  if (preamble[searchIdx] === '[') {
    const argEnd = preamble.indexOf(']', searchIdx)
    argCount = parseInt(preamble.slice(searchIdx + 1, argEnd)) || 0
    searchIdx = argEnd + 1
  }

  // Extract definition
  const def = extractBraceContent(preamble, searchIdx)
  if (def) {
    macros[name] = def.content
    idx = def.endIdx
  } else {
    idx++
  }
}

// Match \DeclareMathOperator{\name}{text} or \DeclareMathOperator*{\name}{text}
const operatorRegex = /\\DeclareMathOperator(\*?)\{\\(\w+)\}\{([^}]+)\}/g
let match
while ((match = operatorRegex.exec(preamble)) !== null) {
  const [, star, name, text] = match
  const op = star ? `\\operatorname*{${text}}` : `\\operatorname{${text}}`
  macros[`\\${name}`] = op
}

// Match \def\name{...} (simpler macro form)
const defRegex = /\\def\\(\w+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
while ((match = defRegex.exec(preamble)) !== null) {
  const [, name, def] = match
  macros[`\\${name}`] = def
}

// Write output
const output = {
  _source: texFile,
  _extracted: new Date().toISOString(),
  macros
}

writeFileSync(outputFile, JSON.stringify(output, null, 2))
console.log(`Extracted ${Object.keys(macros).length} macros to ${outputFile}`)
