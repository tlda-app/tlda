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

// Bare is fixed, starred stretches. KaTeX has no \DeclarePairedDelimiter and no
// \@ifstar, so the star is read here by peeking at the next token.
function pairedDelimiter(open, close) {
  return (ctx) => {
    const next = ctx.future()
    if (next && next.text === "*") {
      ctx.popToken()
      return `\\left${open}#1\\right${close}`
    }
    return `${open}#1${close}`
  }
}

export const baseMacros = {
  // physics: text spacers (\q… family)
  "\\qq": "\\quad\\text{#1}\\quad",
  // physics spells this one both ways and the long form is the one the course
  // actually writes -- 358 uses against \qq's handful. It was absent here, so a
  // course moving to KaTeX would have lost all 358 SILENTLY: an undefined macro
  // renders as literal text with a clean console. Same expansion as \qq; they
  // are the same command in physics.
  "\\qqtext": "\\quad\\text{#1}\\quad",
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

  // The course's \DeclareMathOperator declarations, as plain entries. KaTeX has
  // no \DeclareMathOperator and fails silently on it -- literal text, no console
  // error -- so the operators have to live here instead.
  //
  // Skip, 2026-09-12: "um just define \E to be \operatorname{E} no? ... like
  // it's not that hard?" It is not. The alarming 2,577-call-site number came
  // from costing a TeX-level rewrite, where \newcommand vs \renewcommand is
  // fragile -- one line changed there killed eight working operators while the
  // error count went from 1 to 0. Here each declaration is one string and no
  // call site changes at all.
  //
  // \argmin is defined by stock KaTeX; a later key wins, which is what makes
  // redefining it safe here and was NOT safe in the TeX route.
  "\\E": "\\operatorname{E}",
  "\\P": "\\operatorname{P}",
  "\\V": "\\operatorname{V}",
  "\\Var": "\\operatorname{V}",
  "\\Cov": "\\operatorname{Cov}",
  "\\CATE": "\\operatorname{CATE}",
  "\\RMSE": "\\operatorname{RMSE}",
  "\\sd": "\\operatorname{sd}",
  "\\bias": "\\operatorname{bias}",
  "\\argmin": "\\operatorname{argmin}",
  "\\invlogit": "\\operatorname{logit}^{-1}",
  "\\hVar": "\\widehat{\\operatorname{V}}",

  // Paired delimiters. Skip, 2026-09-12: "i said \p \cb \sb".
  //
  // Bare is fixed, starred stretches -- he uses * for tacit \left\right
  // consistently. KaTeX has no \DeclarePairedDelimiter and no \@ifstar, so the
  // star is read by a function macro peeking at the next token. Verified
  // against KaTeX 0.16.47, including the counterfactual that a BARE macro on
  // tall content stays fixed, so the check is not merely detecting \frac.
  "\\p": pairedDelimiter("(", ")"),
  "\\sb": pairedDelimiter("[", "]"),
  "\\cb": pairedDelimiter("\\{", "\\}"),
}
