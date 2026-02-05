// KaTeX macros extracted from bregman-lower-bound.tex preamble
// These get passed to katex.renderToString({ macros: ... })

// Active macros - can be updated at runtime when loading a document
let activeMacros: Record<string, string> = {}

export function setActiveMacros(macros: Record<string, string>) {
  activeMacros = { ...defaultMacros, ...macros }
}

export function getActiveMacros(): Record<string, string> {
  return Object.keys(activeMacros).length > 0 ? activeMacros : defaultMacros
}

export const defaultMacros: Record<string, string> = {
  // Math operators
  "\\P": "\\operatorname{P}",
  "\\E": "\\operatorname{E}",
  "\\hQ": "\\operatorname{\\hat Q}",
  "\\Q": "\\operatorname{Q}",
  "\\Var": "\\operatorname{Var}",
  "\\pr": "\\operatorname{P}",
  "\\argmin": "\\operatorname*{argmin}",
  "\\argmax": "\\operatorname*{argmax}",
  "\\laplacian": "\\Delta",

  // Common notation
  "\\model": "\\mathcal{M}",
  "\\vmodel": "\\mathcal{V}",
  "\\F": "\\mathcal{F}",
  "\\G": "\\mathcal{G}",
  "\\R": "\\mathbb{R}",
  "\\calS": "\\mathcal{S}",

  // Text shortcuts
  "\\qwhere": "\\quad \\text{where} \\quad",
  "\\qmin": "\\underline{q}",
  "\\hQn": "\\frac{1}{n}\\sum_{i=1}^n",

  // Composition operator
  "\\comp": "\\mathbin{\\scriptstyle\\circ}",

  // Inner product (simple version - KaTeX doesn't support 2-arg commands well)
  "\\inner": "\\langle #1, #2 \\rangle",

  // Balancing weights notation
  "\\hgamma": "\\hat\\gamma",
  "\\hgammazero": "\\hat\\gamma_0",
  "\\hL": "\\hat{L}",
  "\\tL": "\\tilde{L}",
  "\\gipwstar": "\\gamma_{\\text{IPW}}",

  // Functional psi
  "\\psiZ": "\\psi_Z",
  "\\dpsiZ": "\\dot\\psi_Z",
  "\\dotpsiZ": "\\dot\\psi_Z",
  "\\griesz": "\\gamma_{\\dot\\psi}",

  // Conjugate notation with small star
  "\\conj": "{\\scriptscriptstyle *}",
  "\\chis": "\\chi^{\\scriptscriptstyle *}",
  "\\zetas": "\\zeta^{\\scriptscriptstyle *}",
  "\\dchis": "\\dot\\chi^{\\scriptscriptstyle *}",
  "\\ddchis": "\\ddot\\chi^{\\scriptscriptstyle *}",

  // Z-dependent dispersion
  "\\chiZ": "\\chi_Z",
  "\\chisZ": "\\chi^{\\scriptscriptstyle *}_Z",
  "\\dchisZ": "\\dot\\chi^{\\scriptscriptstyle *}_Z",
  "\\ddchisZ": "\\ddot\\chi^{\\scriptscriptstyle *}_Z",

  // Indicator function
  "\\ind": "\\mathbf{1}(#1)",

  // Duality proof notation
  "\\xs": "x^{\\scriptscriptstyle *}",
  "\\ys": "y^{\\scriptscriptstyle *}",
  "\\zs": "z^{\\scriptscriptstyle *}",

  // Physics package equivalents
  "\\qty": "\\left#1\\right",
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\|#1\\right\\|",

  // Common delimiter shortcuts
  "\\cb": "\\left\\{#1\\right\\}",
  "\\sqb": "\\left[#1\\right]",
  "\\p": "\\left(#1\\right)",
}

// Parse a LaTeX preamble and extract \newcommand and \DeclareMathOperator definitions
export function parsePreamble(tex: string): Record<string, string> {
  const macros: Record<string, string> = { ...defaultMacros }

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
