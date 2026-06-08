// Universal KaTeX base macros — given to everybody, superseded by a paper's own
// extracted definitions.
//
// KaTeX has NO `\usepackage` mechanism and ships only a fixed built-in macro set
// (plus the mhchem contrib). So commands provided by the LaTeX `physics` package
// — \qty, \norm, \abs, \grad, the \q… text helpers, etc. — are unknown to KaTeX
// unless we define them. This file is that physics.sty → KaTeX port.
//
// It contains ONLY commands that live in a package (nothing a paper writes in its
// own preamble). Paper-specific macros (\chis, \hgamma, \dzetase, …) come from the
// build's `*-macros.json` extraction and override anything here via merge order:
//   { ...baseMacros, ...extractedPaperMacros }
//
// Single source of truth: imported by the browser renderer (src/katexMacros.ts)
// and the server-side chat linter (mcp-server/fleet-tools.mjs).

export const baseMacros = {
  // physics: text spacers (\q… family)
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

  // physics: delimiters & operators
  // \qty is stripped (zero-arg no-op): \qty(x) → (x), \qty[x] → [x].
  // The curly-brace case \qty{x} loses its braces — no clean KaTeX equivalent.
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

  // common paired-delimiter shortcuts (mathtools \DeclarePairedDelimiter idiom,
  // shared across these papers; KaTeX has no \DeclarePairedDelimiter)
  "\\cb": "\\left\\{#1\\right\\}",
  "\\sqb": "\\left[#1\\right]",
  "\\p": "\\left(#1\\right)",
}
