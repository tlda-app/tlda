// KaTeX macros for rendering $math$ in chat / notes.
//
// Two layers, merged so a paper's own definitions win:
//   { ...baseMacros, ...extractedPaperMacros }
// - baseMacros: the physics.sty → KaTeX port (commands KaTeX can't know), shared
//   with the server linter. See shared/katex-base-macros.mjs.
// - extractedPaperMacros: the paper's preamble macros, fetched per-doc from
//   /api/projects/:name/macros (\chis, \hgamma, \dzetase, …). These supersede base.
import type { KatexOptions } from 'katex'
import { baseMacros } from '../shared/katex-base-macros.mjs'

// KaTeX's own type for the map, borrowed rather than restated: it declares the
// shape inline on its options interface and exports no name for it, so this is
// the one encoding of the fact and it follows a KaTeX upgrade by itself.
//
// A macro value is a string OR a function of the expander. That is not a
// generalisation for its own sake — `\DeclarePairedDelimiter` does not exist in
// KaTeX, so reading the star means peeking at the next token, which only a
// function can do. See shared/katex-base-macros.mjs. This file typed the map as
// `Record<string, string>` and had since 2026-06-08, which is why `e16aff937`
// turned `tsc -b` red everywhere.
type KatexMacroMap = NonNullable<KatexOptions['macros']>

// Active macros - can be updated at runtime when loading a document
let activeMacros: KatexMacroMap = {}

export function setActiveMacros(macros: KatexMacroMap) {
  activeMacros = { ...baseMacros, ...macros }
}

export function getActiveMacros(): KatexMacroMap {
  return Object.keys(activeMacros).length > 0 ? activeMacros : baseMacros
}

// Parse a LaTeX preamble and extract \newcommand and \DeclareMathOperator definitions
//
// Every macro this ADDS is a string — they come out of LaTeX source. The return
// type is the wider map because the result is seeded with `baseMacros`, which is
// where the function form lives.
export function parsePreamble(tex: string): KatexMacroMap {
  const macros: KatexMacroMap = { ...baseMacros }

  // Match \newcommand{\name}{definition} or \newcommand{\name}[n]{definition}
  const newcommandRegex = /\\newcommand\{\\(\w+)\}(?:\[\d+\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  let match
  while ((match = newcommandRegex.exec(tex)) !== null) {
    const [, name, def] = match
    macros[`\\${name}`] = def
  }

  // Match \DeclareMathOperator{\name}{text} or \DeclareMathOperator*{\name}{text}
  const operatorRegex = /\\DeclareMathOperator\*?\{\\(\w+)\}\{([^}]+)\}/g
  while ((match = operatorRegex.exec(tex)) !== null) {
    const [full, name, text] = match
    const isStar = full.includes('*')
    macros[`\\${name}`] = isStar ? `\\operatorname*{${text}}` : `\\operatorname{${text}}`
  }

  return macros
}
