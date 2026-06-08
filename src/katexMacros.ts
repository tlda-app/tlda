// KaTeX macros for rendering $math$ in chat / notes.
//
// Two layers, merged so a paper's own definitions win:
//   { ...baseMacros, ...extractedPaperMacros }
// - baseMacros: the physics.sty → KaTeX port (commands KaTeX can't know), shared
//   with the server linter. See shared/katex-base-macros.mjs.
// - extractedPaperMacros: the paper's preamble macros, fetched per-doc from
//   /api/projects/:name/macros (\chis, \hgamma, \dzetase, …). These supersede base.
import { baseMacros } from '../shared/katex-base-macros.mjs'

// Active macros - can be updated at runtime when loading a document
let activeMacros: Record<string, string> = {}

export function setActiveMacros(macros: Record<string, string>) {
  activeMacros = { ...baseMacros, ...macros }
}

export function getActiveMacros(): Record<string, string> {
  return Object.keys(activeMacros).length > 0 ? activeMacros : baseMacros
}

// Parse a LaTeX preamble and extract \newcommand and \DeclareMathOperator definitions
export function parsePreamble(tex: string): Record<string, string> {
  const macros: Record<string, string> = { ...baseMacros }

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
