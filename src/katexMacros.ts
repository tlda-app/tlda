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

  // Text shortcuts (physics package qq* commands)
  "\\qq": "\\quad\\text{#1}\\quad",
  "\\qwhere": "\\quad\\text{where}\\quad",
  "\\qfor": "\\quad\\text{for}\\quad",
  "\\qand": "\\quad\\text{and}\\quad",
  "\\qor": "\\quad\\text{or}\\quad",
  "\\qthen": "\\quad\\text{then}\\quad",
  "\\qif": "\\quad\\text{if}\\quad",
  "\\qelse": "\\quad\\text{else}\\quad",
  "\\qotherwise": "\\quad\\text{otherwise}\\quad",
  "\\qgiven": "\\quad\\text{given}\\quad",
  "\\qall": "\\quad\\text{for all}\\quad",
  "\\qsince": "\\quad\\text{since}\\quad",
  "\\qlet": "\\quad\\text{let}\\quad",
  "\\qimplies": "\\quad\\Rightarrow\\quad",
  "\\qas": "\\quad\\text{as}\\quad",
  "\\qc": ",",
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
  // \qty is stripped (zero-arg no-op): \qty(x) → (x), \qty[x] → [x]
  // Curly-brace case \qty{x} loses braces — no clean KaTeX solution.
  "\\qty": "",
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\|#1\\right\\|",
  "\\eval": "\\left.#1\\right|",
  "\\order": "\\mathcal{O}\\left(#1\\right)",
  "\\dv": "\\frac{d#1}{d#2}",
  "\\pdv": "\\frac{\\partial #1}{\\partial #2}",
  "\\fdv": "\\frac{\\delta #1}{\\delta #2}",
  "\\bra": "\\left\\langle #1\\right|",
  "\\ket": "\\left|#1\\right\\rangle",
  "\\braket": "\\left\\langle #1\\middle|#2\\right\\rangle",
  "\\expval": "\\left\\langle #1\\right\\rangle",
  "\\ev": "\\left\\langle #1\\right\\rangle",
  "\\comm": "\\left[#1,\\,#2\\right]",
  "\\acomm": "\\left\\{#1,\\,#2\\right\\}",
  "\\vb": "\\mathbf{#1}",
  "\\vbu": "\\hat{#1}",
  "\\grad": "\\nabla",
  "\\curl": "\\nabla\\times",
  "\\tr": "\\operatorname{Tr}",
  "\\Tr": "\\operatorname{Tr}",
  "\\rank": "\\operatorname{rank}",
  "\\diag": "\\operatorname{diag}",
  "\\sgn": "\\operatorname{sgn}",

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
