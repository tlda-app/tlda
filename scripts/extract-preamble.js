#!/usr/bin/env node
// Extract LaTeX preamble macros and convert to KaTeX-compatible JSON
// Usage: node extract-preamble.js input.tex output.json

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

const texFile = process.argv[2]
const outputFile = process.argv[3]

if (!texFile || !outputFile) {
  console.error('Usage: node extract-preamble.js <input.tex> <output.json>')
  process.exit(1)
}

// Resolve \input/\include directives relative to a base directory.
// Returns the fully expanded preamble text (inputs inlined, up to \begin{document}).
function loadAndExpand(filePath, visited = new Set()) {
  const abs = resolve(filePath)
  if (visited.has(abs)) return ''
  visited.add(abs)
  let src
  try { src = readFileSync(abs, 'utf8') } catch { return '' }
  const base = dirname(abs)
  // Inline \input{file} and \include{file} in preamble only
  return src.replace(/\\(?:input|include)\{([^}]+)\}/g, (match, arg) => {
    // Try with and without .tex extension
    const candidates = [join(base, arg), join(base, arg + '.tex')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return loadAndExpand(candidate, visited)
    }
    return match // leave as-is if file not found
  })
}

const tex = loadAndExpand(texFile)

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

// Match \DeclareMathOperator{\name}{body} / \DeclareMathOperator*{\name}{body}.
// The body must be matched brace-aware — a naive [^}]+ truncates bodies with
// nested braces like \mathbb{P}_n (it stops at the first }), producing a broken
// macro that KaTeX can't render.
let opIdx = 0
const OP = '\\DeclareMathOperator'
while ((opIdx = preamble.indexOf(OP, opIdx)) !== -1) {
  let p = opIdx + OP.length
  const star = preamble[p] === '*'
  if (star) p++
  const nameBrace = extractBraceContent(preamble, p)        // {\name}
  if (!nameBrace) { opIdx += OP.length; continue }
  const name = nameBrace.content.trim()                     // includes leading backslash
  const bodyBrace = extractBraceContent(preamble, nameBrace.endIdx + 1) // {body}
  if (!bodyBrace) { opIdx += OP.length; continue }
  macros[name] = star ? `\\operatorname*{${bodyBrace.content}}` : `\\operatorname{${bodyBrace.content}}`
  opIdx = bodyBrace.endIdx
}

// Match \DeclarePairedDelimiter{\name}{left}{right} → a KaTeX 1-arg macro
// "left #1 right" (KaTeX has no \DeclarePairedDelimiter, so these were missing
// entirely, e.g. \abs, \norm). Brace-aware on all three arguments.
let pdIdx = 0
const PD = '\\DeclarePairedDelimiter'
while ((pdIdx = preamble.indexOf(PD, pdIdx)) !== -1) {
  let p = pdIdx + PD.length
  if (preamble[p] === '*') p++
  const nameBrace = extractBraceContent(preamble, p)        // {\name}
  if (!nameBrace) { pdIdx += PD.length; continue }
  const left = extractBraceContent(preamble, nameBrace.endIdx + 1)   // {left}
  if (!left) { pdIdx += PD.length; continue }
  const right = extractBraceContent(preamble, left.endIdx + 1)       // {right}
  if (!right) { pdIdx += PD.length; continue }
  macros[nameBrace.content.trim()] = `${left.content} #1 ${right.content}`
  pdIdx = right.endIdx
}

let match

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
