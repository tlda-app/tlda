#!/usr/bin/env node
// Extract LaTeX preamble macros and convert to KaTeX-compatible JSON
// Usage: node extract-preamble.js input.tex output.json
//
// Also exported as a library (extractMacros / extractMacrosFromFile) so the MCP
// set_preamble tool uses the SAME parser as the build — one macro-extraction
// code path, no drift between the linter's artifact and the explicit setter.

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

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

// Match \newcommand{\name}{definition} or \newcommand{\name}[n]{definition}
// Handle nested braces by counting.
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

// Find the matching ']' for a '[' at openIdx, at brace-depth 0. Used to read a
// \newcommand optional-argument default \newcommand{\x}[n][default]{...}.
function matchBracket(str, openIdx) {
  let depth = 0
  for (let i = openIdx + 1; i < str.length; i++) {
    const c = str[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === ']' && depth === 0) return i
  }
  return -1
}

// KaTeX has no concept of LaTeX's optional \newcommand argument
// (\newcommand{\x}[n][default]{body}). It treats any macro whose body contains
// #1 as taking a MANDATORY argument, so bare \E / \P / \Var error in chat/notes
// even though they're valid in LaTeX. Collapse the optional first argument by
// substituting its default for #1 and shifting #2..#n down to #1..#(n-1),
// yielding a KaTeX macro with (argCount-1) mandatory args.
function collapseOptionalArg(body, def) {
  const substituted = body.replace(/#(\d)/g, (m, d) => {
    const k = parseInt(d, 10)
    return k === 1 ? def : `#${k - 1}`
  })
  const out = substituted.replace(/\s+$/, '')
  // Wrap in braces so the macro is a single grouped unit, usable as a bare
  // sub/superscript (KaTeX rejects \operatorname directly after _ / ^). Skip
  // STARRED operators: bracing demotes \operatorname* from a limits-operator to
  // an ordinary atom, pushing its subscript from underneath to the side.
  return out.includes('\\operatorname*') ? out : `{${out}}`
}

// Extract KaTeX-compatible macros from already-expanded preamble text.
export function extractMacros(preamble) {
  const macros = {}

  // Find all \newcommand definitions.
  let idx = 0
  while ((idx = preamble.indexOf('\\newcommand', idx)) !== -1) {
    // Skip to the command name
    const nameStart = preamble.indexOf('{\\', idx)
    if (nameStart === -1 || nameStart > idx + 20) { idx++; continue }

    const nameEnd = preamble.indexOf('}', nameStart)
    if (nameEnd === -1) { idx++; continue }

    const name = preamble.slice(nameStart + 1, nameEnd) // includes backslash

    // Check for argument count [n]
    let searchIdx = nameEnd + 1
    while (preamble[searchIdx] === ' ' || preamble[searchIdx] === '\n') searchIdx++

    let argCount = 0
    let optionalDefault = null // non-null => first arg is optional with this default
    if (preamble[searchIdx] === '[') {
      const argEnd = preamble.indexOf(']', searchIdx)
      argCount = parseInt(preamble.slice(searchIdx + 1, argEnd), 10) || 0
      searchIdx = argEnd + 1
      // LaTeX optional-argument form: \newcommand{\x}[n][default]{...}
      let q = searchIdx
      while (preamble[q] === ' ' || preamble[q] === '\n') q++
      if (preamble[q] === '[') {
        const defEnd = matchBracket(preamble, q)
        if (defEnd !== -1) {
          optionalDefault = preamble.slice(q + 1, defEnd)
          searchIdx = defEnd + 1
        }
      }
    }

    // Extract definition
    const def = extractBraceContent(preamble, searchIdx)
    if (def) {
      macros[name] = optionalDefault !== null
        ? collapseOptionalArg(def.content, optionalDefault)
        : def.content
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
    // Non-starred operators are brace-wrapped so they work as a bare
    // sub/superscript; starred operators are left bare to preserve their
    // limits-underneath layout (bracing would demote them to ordinary atoms).
    macros[name] = star ? `\\operatorname*{${bodyBrace.content}}` : `{\\operatorname{${bodyBrace.content}}}`
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

  // Match \def\name{...} (simpler macro form)
  const defRegex = /\\def\\(\w+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  let match
  while ((match = defRegex.exec(preamble)) !== null) {
    const [, name, def] = match
    macros[`\\${name}`] = def
  }

  return macros
}

// Read a .tex file, inline its \input/\include, slice the preamble, and extract.
export function extractMacrosFromFile(texFile) {
  const tex = loadAndExpand(texFile)
  const preambleMatch = tex.match(/^([\s\S]*?)\\begin\{document\}/)
  const preamble = preambleMatch ? preambleMatch[1] : tex
  return extractMacros(preamble)
}

// CLI entry point (build pipeline invokes this as a subprocess).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const texFile = process.argv[2]
  const outputFile = process.argv[3]
  if (!texFile || !outputFile) {
    console.error('Usage: node extract-preamble.js <input.tex> <output.json>')
    process.exit(1)
  }
  const macros = extractMacrosFromFile(texFile)
  const output = {
    _source: texFile,
    _extracted: new Date().toISOString(),
    macros,
  }
  writeFileSync(outputFile, JSON.stringify(output, null, 2))
  console.log(`Extracted ${Object.keys(macros).length} macros to ${outputFile}`)
}
