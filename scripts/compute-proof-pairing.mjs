#!/usr/bin/env node
/**
 * Compute theorem/proof pairing from a LaTeX document.
 *
 * Usage: node compute-proof-pairing.mjs <tex-file> <lookup.json> <output.json>
 *
 * Parses the TeX file to find theorem-like environments and proof environments,
 * matches them, and maps their line ranges to page/y-coordinates via the
 * synctex lookup table. Outputs proof-info.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, basename, join } from 'path'

const [texFile, lookupPath, outputPath] = process.argv.slice(2)

if (!texFile || !lookupPath || !outputPath) {
  console.error('Usage: node compute-proof-pairing.mjs <tex-file> <lookup.json> <output.json>')
  process.exit(1)
}

const texContent = readFileSync(texFile, 'utf8')
const rawLines = texContent.split('\n')
const lookup = JSON.parse(readFileSync(lookupPath, 'utf8'))

// Expand \input{} files inline and build a line→lookup-key mapping.
// This lets all parsing functions see input file content transparently,
// while mapLinesToRegions uses the right "file.tex:N" keys for lookup.
const texLines = []
const lineToKey = [] // lineToKey[i] = lookup key for texLines[i] (0-indexed)
const texDir = dirname(texFile)

for (let i = 0; i < rawLines.length; i++) {
  const line = rawLines[i]
  const m = line.match(/\\(?:input|include)\{([^}]+)\}/)
  if (m) {
    let name = m[1]
    if (!name.endsWith('.tex')) name += '.tex'
    const fullPath = join(texDir, name)
    if (existsSync(fullPath)) {
      const inputLines = readFileSync(fullPath, 'utf8').split('\n')
      const fname = basename(name)
      for (let j = 0; j < inputLines.length; j++) {
        texLines.push(inputLines[j])
        lineToKey.push(`${fname}:${j + 1}`)
      }
      continue
    }
  }
  texLines.push(line)
  lineToKey.push(`${i + 1}`) // main file: plain line number
}

// Parse .aux file for reference numbers (label → "E.2", etc.)
const auxPath = texFile.replace(/\.tex$/, '.aux')
const refNumbers = new Map()
if (existsSync(auxPath)) {
  const auxContent = readFileSync(auxPath, 'utf8')
  // \newlabel{label}{{refnum}{page}{...}{...}{...}}
  const auxRe = /\\newlabel\{([^}]+)\}\{\{([^}]*)\}/g
  let m
  while ((m = auxRe.exec(auxContent)) !== null) {
    refNumbers.set(m[1], m[2])
  }
}

/** Human-readable display name from aux file. "Lemma E.2", "(71)", etc. */
const TYPE_DISPLAY = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary',
  definition: 'Definition', assumption: 'Assumption', equation: '',
}
function displayName(label, type) {
  const num = refNumbers.get(label)
  if (!num) return label // fallback to raw label
  const prefix = TYPE_DISPLAY[type]
  if (prefix === undefined) return label
  if (type === 'equation') return `(${num})`
  return `${prefix} ${num}`
}

// --- Parse theorem-like environments ---

const THEOREM_TYPES = ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'assumption']
const BEGIN_RE = new RegExp(
  `\\\\begin\\{(${THEOREM_TYPES.join('|')})\\}(?:\\[([^\\]]+)\\])?`,
)
const END_RE = new RegExp(`\\\\end\\{(${THEOREM_TYPES.join('|')})\\}`)
const LABEL_RE = /\\label\{([^}]+)\}/
const LABEL_ALL_RE = /\\label\{([^}]+)\}/g
const BEGIN_PROOF_RE = /\\begin\{proof\}(?:\[([^\]]*)\])?/
const END_PROOF_RE = /\\end\{proof\}/
const REF_RE = /\\ref\{([^}]+)\}/g
const EQREF_RE = /\\eqref\{([^}]+)\}/g
const BODY_REF_RE = /\\(?:eq)?ref\{([^}]+)\}/g

// Equation-like environments (including starred variants)
const EQUATION_ENVS = ['equation', 'align', 'gather', 'multline', 'flalign', 'alignat']
const BEGIN_EQ_RE = new RegExp(
  `\\\\begin\\{(${EQUATION_ENVS.join('|')})\\*?\\}`,
)
const END_EQ_RE = new RegExp(
  `\\\\end\\{(${EQUATION_ENVS.join('|')})\\*?\\}`,
)

/**
 * Find all theorem-like environments with their line ranges, labels, and titles.
 */
function findStatements() {
  const statements = []
  let i = 0
  while (i < texLines.length) {
    const line = texLines[i]
    const m = line.match(BEGIN_RE)
    if (m) {
      const type = m[1]
      const title = m[2] || null
      const startLine = i + 1 // 1-indexed

      // Look for \label in the next few lines
      let label = null
      const labelLine = line.match(LABEL_RE)
      if (labelLine) {
        label = labelLine[1]
      } else {
        // Check next 3 lines for label
        for (let j = i + 1; j < Math.min(i + 4, texLines.length); j++) {
          const lm = texLines[j].match(LABEL_RE)
          if (lm) { label = lm[1]; break }
          if (texLines[j].match(END_RE)) break
        }
      }

      // Find matching \end
      let endLine = startLine
      let depth = 1
      for (let j = i + 1; j < texLines.length; j++) {
        if (texLines[j].match(new RegExp(`\\\\begin\\{${type}\\}`))) depth++
        if (texLines[j].match(new RegExp(`\\\\end\\{${type}\\}`))) {
          depth--
          if (depth === 0) {
            endLine = j + 1 // 1-indexed
            break
          }
        }
      }

      statements.push({ type, title, label, startLine, endLine })
      i = endLine // skip past \end
    } else {
      i++
    }
  }
  return statements
}

/**
 * Find all proof environments with their line ranges and any references in the title.
 */
function findProofs() {
  const proofs = []
  let i = 0
  while (i < texLines.length) {
    const line = texLines[i]
    const m = line.match(BEGIN_PROOF_RE)
    if (m) {
      const proofTitle = m[1] || null
      const startLine = i + 1 // 1-indexed

      // Extract \ref{} from proof title and first few lines
      const refs = []
      if (proofTitle) {
        let rm
        const refsInTitle = new RegExp(REF_RE.source, 'g')
        while ((rm = refsInTitle.exec(proofTitle)) !== null) {
          refs.push(rm[1])
        }
      }
      // Also check the first line for refs (sometimes \begin{proof}[Proof of Theorem~\ref{thm:foo}])
      {
        let rm
        const refsInLine = new RegExp(REF_RE.source, 'g')
        while ((rm = refsInLine.exec(line)) !== null) {
          refs.push(rm[1])
        }
      }

      // Find matching \end{proof}
      let endLine = startLine
      let depth = 1
      for (let j = i + 1; j < texLines.length; j++) {
        if (texLines[j].match(BEGIN_PROOF_RE)) depth++
        if (texLines[j].match(END_PROOF_RE)) {
          depth--
          if (depth === 0) {
            endLine = j + 1
            break
          }
        }
      }

      proofs.push({ proofTitle, startLine, endLine, refs })
      i = endLine
    } else {
      i++
    }
  }
  return proofs
}

/**
 * Build a global label map: label → { type, startLine, endLine }.
 * Covers theorem-like environments AND equation-like environments.
 */
function buildGlobalLabelMap(statements) {
  const globalLabels = new Map()

  // Add all statement labels
  for (const s of statements) {
    if (s.label) {
      globalLabels.set(s.label, {
        type: s.type,
        startLine: s.startLine,
        endLine: s.endLine,
      })
    }
  }

  // Scan for equation environments and their labels
  let i = 0
  while (i < texLines.length) {
    const line = texLines[i]
    const m = line.match(BEGIN_EQ_RE)
    if (m) {
      const envType = m[1]
      const startLine = i + 1 // 1-indexed

      // Find matching \end
      const endRe = new RegExp(`\\\\end\\{${envType}\\*?\\}`)
      let endLine = startLine
      for (let j = i; j < texLines.length; j++) {
        if (j > i && texLines[j].match(endRe)) {
          endLine = j + 1
          break
        }
      }

      // Scan all lines in the environment for labels
      for (let j = i; j < endLine && j < texLines.length; j++) {
        let lm
        const re = new RegExp(LABEL_ALL_RE.source, 'g')
        while ((lm = re.exec(texLines[j])) !== null) {
          if (!globalLabels.has(lm[1])) {
            globalLabels.set(lm[1], {
              type: 'equation',
              startLine,
              endLine,
            })
          }
        }
      }

      i = endLine
    } else {
      // Also catch standalone \label on lines outside environments (e.g. inside \[ \])
      // but only if not already captured
      const lm = line.match(LABEL_RE)
      if (lm && !globalLabels.has(lm[1])) {
        globalLabels.set(lm[1], {
          type: inferLabelType(lm[1]),
          startLine: i + 1,
          endLine: i + 1,
        })
      }
      i++
    }
  }

  return globalLabels
}

/**
 * Infer type from label prefix (e.g. "eq:foo" → "equation", "lem:bar" → "lemma").
 */
function inferLabelType(label) {
  const prefix = label.split(':')[0]
  const prefixMap = {
    eq: 'equation', thm: 'theorem', lem: 'lemma', prop: 'proposition',
    cor: 'corollary', def: 'definition', asn: 'assumption', asm: 'assumption',
    sec: 'section', subsec: 'section', fig: 'figure', tab: 'table',
  }
  return prefixMap[prefix] || 'unknown'
}

/**
 * Scan a line range for \ref{} and \eqref{} references (ordered, deduped).
 */
function scanRefsInRange(startLine, endLine) {
  const seen = new Set()
  const refs = []
  for (let line = startLine - 1; line < endLine - 1 && line < texLines.length; line++) {
    let m
    const re = new RegExp(BODY_REF_RE.source, 'g')
    while ((m = re.exec(texLines[line])) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1])
        refs.push(m[1])
      }
    }
  }
  return refs
}

/** Short type abbreviations for display */
const TYPE_ABBREV = {
  theorem: 'thm', lemma: 'lem', proposition: 'prop', corollary: 'cor',
  definition: 'def', assumption: 'asn', equation: 'eq',
}

/**
 * Resolve statement refs to dependency objects with regions and page distances.
 */
function resolveDependencies(proof, statement, proofRegions, globalLabels) {
  const bodyRefs = scanRefsInRange(statement.startLine, statement.endLine)
  const selfLabel = statement.label
  const proofPages = new Set(proofRegions.map(r => r.page))

  // Labels to exclude: self, sections, figures, tables
  const excludeTypes = new Set(['section', 'figure', 'table', 'unknown'])

  const deps = []
  for (const ref of bodyRefs) {
    if (ref === selfLabel) continue
    const info = globalLabels.get(ref)
    if (!info) continue
    if (excludeTypes.has(info.type)) continue

    const regions = mapLinesToRegions(info.startLine, info.endLine)
    if (regions.length === 0) continue

    const depPages = new Set(regions.map(r => r.page))

    // Skip same-page deps (all dep pages are proof pages)
    let allSamePage = true
    for (const dp of depPages) {
      if (!proofPages.has(dp)) { allSamePage = false; break }
    }
    if (allSamePage) continue

    // Compute minimum page distance from any proof page to any dep page
    let minDist = Infinity
    for (const pp of proofPages) {
      for (const dp of depPages) {
        minDist = Math.min(minDist, Math.abs(pp - dp))
      }
    }

    // Skip deps on the same page as any proof page (reader can already see them)
    if (minDist === 0) continue

    const shortType = TYPE_ABBREV[info.type] || info.type
    deps.push({
      label: ref,
      displayLabel: displayName(ref, info.type),
      type: info.type,
      shortType,
      region: regions[0], // primary region
      pageDist: minDist,
    })
  }

  // Sort by page distance descending (furthest first)
  deps.sort((a, b) => b.pageDist - a.pageDist)

  // Deduplicate by label (already unique from Set, but just in case)
  return deps
}

/**
 * Match proofs to statements.
 * Strategy:
 * 1. If proof has \ref{label} in its title, match to the statement with that label
 * 2. Otherwise, match to the closest preceding statement (implicit: proof follows theorem)
 */
function matchProofsToStatements(statements, proofs) {
  const labelMap = new Map()
  for (const s of statements) {
    if (s.label) labelMap.set(s.label, s)
  }

  const pairs = []
  const usedStatements = new Set()

  for (const proof of proofs) {
    let matched = null

    // Strategy 1: explicit ref in proof title
    for (const ref of proof.refs) {
      if (labelMap.has(ref)) {
        matched = labelMap.get(ref)
        break
      }
    }

    // Strategy 2: implicit — find closest preceding statement
    if (!matched) {
      let best = null
      let bestDist = Infinity
      for (const s of statements) {
        const dist = proof.startLine - s.endLine
        if (dist >= 0 && dist < bestDist) {
          bestDist = dist
          best = s
        }
      }
      // Only use implicit matching if the gap is small (< 10 lines)
      // or if the statement hasn't been matched yet
      if (best && (bestDist < 10 || !usedStatements.has(best.label))) {
        matched = best
      }
    }

    if (matched) {
      usedStatements.add(matched.label)
      pairs.push({ statement: matched, proof })
    }
  }

  return pairs
}

/**
 * Map a line range to page/y-coordinate regions using the lookup table.
 */
function mapLinesToRegions(startLine, endLine) {
  const pageRanges = new Map() // page -> { yMin, yMax }

  for (let line = startLine; line <= endLine; line++) {
    // Use lineToKey mapping for multi-file lookup support
    const key = lineToKey[line - 1] || line.toString()
    const entry = lookup.lines[key]
    if (!entry) continue

    const page = entry.page
    if (!pageRanges.has(page)) {
      pageRanges.set(page, { yMin: entry.y, yMax: entry.y })
    } else {
      const r = pageRanges.get(page)
      r.yMin = Math.min(r.yMin, entry.y)
      r.yMax = Math.max(r.yMax, entry.y)
    }
  }

  const results = []
  for (const [page, range] of pageRanges) {
    results.push({
      page,
      yTop: range.yMin - 10,
      yBottom: range.yMax + 20, // extra padding for last line of text
    })
  }

  results.sort((a, b) => a.page - b.page)
  return results
}

// --- Main ---

const statements = findStatements()
const proofs = findProofs()
const matched = matchProofsToStatements(statements, proofs)
const globalLabels = buildGlobalLabelMap(statements)

console.log(`  Found ${statements.length} theorem-like environments, ${proofs.length} proofs`)
console.log(`  Matched ${matched.length} theorem/proof pairs`)
console.log(`  Global label map: ${globalLabels.size} labels`)

const pairs = []

for (const { statement, proof } of matched) {
  const statementRegions = mapLinesToRegions(statement.startLine, statement.endLine)
  const proofRegions = mapLinesToRegions(proof.startLine, proof.endLine)

  if (statementRegions.length === 0 || proofRegions.length === 0) continue

  // Check if statement and proof are on the same page
  const statementPages = new Set(statementRegions.map(r => r.page))
  const proofPages = new Set(proofRegions.map(r => r.page))
  const samePage = statementPages.size === 1 && proofPages.size === 1 &&
    [...statementPages][0] === [...proofPages][0]

  // Display title from .aux file (e.g. "Lemma E.2") or fallback to raw label
  const displayTitle = statement.label
    ? displayName(statement.label, statement.type)
    : statement.type

  // Resolve dependencies from proof body refs
  const dependencies = resolveDependencies(proof, statement, proofRegions, globalLabels)

  pairs.push({
    id: statement.label || `${statement.type}-L${statement.startLine}`,
    type: statement.type,
    title: displayTitle,
    statementLines: [statement.startLine, statement.endLine],
    statementRegion: statementRegions[0], // primary region (first page)
    statementRegions,
    proofLines: [proof.startLine, proof.endLine],
    proofRegions,
    samePage,
    dependencies,
  })
}

// Build lineRefs: for each line with \ref/\eqref, store ordered labels
// Keys match lookup.json keys (plain number for main file, "file.tex:N" for input files)
const lineRefs = {}
const excludeRefTypes = new Set(['section', 'figure', 'table'])
for (let i = 0; i < texLines.length; i++) {
  const key = lineToKey[i] || `${i + 1}`
  let m
  const re = new RegExp(BODY_REF_RE.source, 'g')
  const refs = []
  while ((m = re.exec(texLines[i])) !== null) {
    const label = m[1]
    const info = globalLabels.get(label)
    // Skip section/figure/table refs, keep unknown (might still be useful)
    if (info && excludeRefTypes.has(info.type)) continue
    refs.push(label)
  }
  if (refs.length > 0) lineRefs[key] = refs
}

// Build labelRegions: label → region for all resolvable labels
const labelRegions = {}
for (const [label, info] of globalLabels) {
  if (excludeRefTypes.has(info.type)) continue
  const regions = mapLinesToRegions(info.startLine, info.endLine)
  if (regions.length > 0) {
    labelRegions[label] = {
      ...regions[0],
      type: info.type,
      displayLabel: displayName(label, info.type),
    }
  }
}

const output = {
  meta: {
    texFile,
    generated: new Date().toISOString(),
  },
  pairs,
  lineRefs,
  labelRegions,
}

writeFileSync(outputPath, JSON.stringify(output, null, 2))

const crossPage = pairs.filter(p => !p.samePage).length
const totalDeps = pairs.reduce((sum, p) => sum + p.dependencies.length, 0)
console.log(`  ${pairs.length} pairs total, ${crossPage} cross-page, ${totalDeps} dependencies`)
console.log(`  ${Object.keys(lineRefs).length} lines with refs, ${Object.keys(labelRegions).length} label regions`)
console.log(`  ${refNumbers.size} ref numbers from .aux file`)
console.log(`  Written to ${outputPath}`)
