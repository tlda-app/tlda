// latex-deps.mjs — the SHARED LaTeX dependency detector.
//
// **Membership is the transitive closure of the document roots.** Skip,
// 2026-08-17: *"it's the transitive closure of the document roots. that's it."*
//
// Markdown has had this since it shipped (`shared/markdown-deps.mjs`). LaTeX has
// not: membership was a directory walk plus a file-extension test, so `\input{}`
// was never followed and a file's presence in the project was decided by where it
// sat on disk rather than by whether the paper reaches it.
//
// This is the LaTeX half, deliberately built to the same shape as the markdown
// half so there is ONE rule with two scanners rather than two rules. In
// particular it inherits the markdown scanner's two decisions, which are the ones
// that matter:
//
//   - **A reference that escapes the project root is simply NOT A MEMBER.** Not
//     normalised into range, not reported as missing, not an error. The paper
//     reaches outside the project; the project does not grow to meet it.
//   - **A reference that does not resolve is not a member either, and it is
//     RECORDED.** A member with no bytes is the phantom class that refused every
//     push Skip made for four days. An unresolvable `\input` must never become a
//     manifest entry, and it must not vanish silently either.
//
// **The directive set is measured from his actual papers, not assumed.** Counted
// across `eiv-paper` and `bregman-lower-bound` on 2026-08-19:
//
//   \usepackage 109 · \documentclass 11 · \bibliography 7 · \addbibresource 7
//   \includegraphics 7 · \RequirePackage 5 · \input 3
//
// and **no `\include`, `\import`, `\subfile`, `\lstinputlisting` or
// `\includeonly` at all.** They are handled anyway where the cost is one entry in
// a table, and named here so the next person knows which are load-bearing and
// which are speculative.
//
// Pure (content in → refs out), so it runs on the server, in the daemon, and over
// a git tree rather than a working copy. The closure driver below takes its file
// access as arguments for exactly that reason — see `latexDependencyClosure`.
import path from 'path'

// **Extension inference is not a convenience, it is the common case.** Measured
// in his papers: 3 of 3 `\input`, 3 of 3 `\bibliography` and 1 of 5
// `\includegraphics` are written WITHOUT one. A closure that required the
// extension would miss `\input{body}` — which is the entire paper.
//
// The candidate lists are in TeX's own resolution order, and the first hit wins.
const EXTENSIONS_FOR = {
  tex: ['.tex'],
  bib: ['.bib'],
  graphics: ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.svg'],
  package: ['.sty'],
  class: ['.cls'],
}

// Each directive, what kind of file its argument names, and whether the argument
// is a comma-separated list. `\bibliography{a,b}` is two files; `\input{a,b}` is
// one file with a comma in its name.
const DIRECTIVES = [
  { name: 'input', kind: 'tex', list: false },
  { name: 'include', kind: 'tex', list: false },
  { name: 'includeonly', kind: 'tex', list: true },
  { name: 'subfile', kind: 'tex', list: false },
  { name: 'InputIfFileExists', kind: 'tex', list: false },
  { name: 'lstinputlisting', kind: 'any', list: false },
  { name: 'verbatiminput', kind: 'any', list: false },
  { name: 'bibliography', kind: 'bib', list: true },
  { name: 'addbibresource', kind: 'bib', list: false },
  { name: 'includegraphics', kind: 'graphics', list: false },
  { name: 'usepackage', kind: 'package', list: true },
  { name: 'RequirePackage', kind: 'package', list: true },
  { name: 'documentclass', kind: 'class', list: false },
]

const DIRECTIVE_RE = new RegExp(
  // \name, an optional [options] group, an optional <presentation> group, then
  // the braced argument. The optional groups are skipped rather than captured:
  // `\includegraphics[width=\textwidth]{fig}` is by far the common form and the
  // width is not a file.
  String.raw`\\(${DIRECTIVES.map(d => d.name).join('|')})\s*(?:\[[^\]]*\])?\s*(?:<[^>]*>)?\s*\{([^}]*)\}`,
  'g',
)

const BY_NAME = new Map(DIRECTIVES.map(d => [d.name, d]))

/**
 * Strip TeX comments so a commented-out directive is not a dependency.
 *
 * **This is a phantom guard, not tidiness.** `% \input{old-draft}` names a file
 * that the paper does not include, and turning it into a member produces exactly
 * the failure this module exists to prevent — an entry in the manifest that the
 * document does not reach.
 *
 * Neither of his papers has one today. Commenting out an `\input` while drafting
 * is ordinary enough that the zero is a fact about this afternoon, not a property
 * of the input.
 *
 * `\%` is an escaped percent and does not start a comment; `\\%` is a line break
 * followed by one. Counting the backslashes immediately before the `%` settles
 * both: an odd number means the `%` is escaped.
 */
export function stripTexComments(content) {
  return String(content || '')
    .split('\n')
    .map(line => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== '%') continue
        let backslashes = 0
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1
        if (backslashes % 2 === 0) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/**
 * Every local file reference in one LaTeX source, as written.
 *
 * Returns `[{ ref, kind, directive }]` — `ref` exactly as the author typed it,
 * without an extension if that is how they typed it. Resolution is the closure's
 * job, because only the closure knows the base directory and what exists.
 *
 * **A reference the scanner cannot read as a filename is dropped here rather
 * than passed on as a guess.** `\input{\datadir/body}` contains a macro this
 * module cannot expand, and the honest answer is that we do not know what file
 * that is. See `unresolved` on the closure result: it is dropped from members
 * and kept visible.
 */
export function scanLatexDeps(content) {
  const deps = []
  const seen = new Set()
  for (const match of stripTexComments(content).matchAll(DIRECTIVE_RE)) {
    const directive = BY_NAME.get(match[1])
    if (!directive) continue
    const parts = directive.list ? match[2].split(',') : [match[2]]
    for (const part of parts) {
      const ref = part.trim()
      if (!ref) continue
      const key = `${directive.kind}:${ref}`
      if (seen.has(key)) continue
      seen.add(key)
      deps.push({ ref, kind: directive.kind, directive: directive.name })
    }
  }
  return deps
}

// A reference containing a macro, a group, or a comment character is one we
// cannot resolve to a path. Reported rather than guessed at.
function isUnresolvable(ref) {
  return /[\\{}$%#]/.test(ref)
}

function isTexPath(file) {
  return /\.tex$/i.test(file)
}

/**
 * The transitive closure of a LaTeX document's roots.
 *
 * **File access is injected**, which is the whole reason this is separable from
 * the markdown version's shape: the design computes membership from the COMMIT'S
 * TREE rather than from a working copy being written underneath it, and the same
 * closure has to run over both. Pass `exists` and `read` that answer from
 * whichever of the two you mean.
 *
 *   roots   — the declared document roots, project-relative
 *   exists  — (relPath) => boolean
 *   read    — (relPath) => string
 *
 * Returns `{ roots, tex, assets, files, missing, unresolved }`.
 *
 * **`files` is the member set and nothing else is.** `missing` and `unresolved`
 * are deliberately NOT in it: a member with no bytes is the wedge that refused
 * his pushes, and both of those are references we could not turn into bytes.
 * They are returned so that a person can be told, never so that a manifest can
 * include them.
 */
export function latexDependencyClosure({ roots = [], exists, read }) {
  const tex = new Set()
  const assets = new Set()
  const missing = []
  const unresolved = []
  const queue = roots.map(root => normalizeRel(root)).filter(Boolean)

  // Resolve one written reference against the directory of the file that wrote
  // it, trying each candidate extension in TeX's own order. Returns the
  // project-relative path, or null.
  const resolve = (ref, fromDir, kind) => {
    const candidates = kind === 'any' ? [''] : [...(EXTENSIONS_FOR[kind] || []), '']
    // An explicitly-written extension wins outright: `\includegraphics{a.png}`
    // must not silently resolve to `a.png.pdf` because `.pdf` is tried first.
    const written = normalizeRel(path.posix.join(fromDir, ref))
    if (written && path.posix.extname(written) && exists(written)) return written
    for (const extension of candidates) {
      const candidate = normalizeRel(path.posix.join(fromDir, ref + extension))
      if (candidate && exists(candidate)) return candidate
    }
    return null
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || tex.has(current)) continue
    if (!exists(current)) {
      missing.push({ from: null, ref: current, path: current })
      continue
    }
    tex.add(current)
    const fromDir = path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current)

    for (const dep of scanLatexDeps(read(current))) {
      if (isUnresolvable(dep.ref)) {
        unresolved.push({ from: current, ref: dep.ref, directive: dep.directive, reason: 'macro-in-path' })
        continue
      }
      // **An escaping reference is not a member and is not an error.** The paper
      // reaches outside the project; the project does not grow to meet it, and
      // nothing is reported — this is the markdown scanner's behaviour and the
      // reason it is safe to run over an arbitrary tree.
      if (escapesRoot(path.posix.join(fromDir, dep.ref))) continue

      const resolved = resolve(dep.ref, fromDir, dep.kind)
      if (!resolved) {
        // A `\usepackage` or `\documentclass` that resolves to nothing local is
        // the ORDINARY case -- it names a TeX distribution package, which is not
        // a project file and never was. Reporting those as missing would bury
        // the real ones: 109 `\usepackage` lines against a handful of local files.
        if (dep.kind === 'package' || dep.kind === 'class') continue
        missing.push({ from: current, ref: dep.ref, directive: dep.directive, path: null })
        continue
      }
      if (isTexPath(resolved)) {
        if (!tex.has(resolved)) queue.push(resolved)
      } else {
        assets.add(resolved)
      }
    }
  }

  return {
    roots: [...roots],
    tex: [...tex].sort(),
    assets: [...assets].sort(),
    files: [...tex, ...assets].sort(),
    missing,
    unresolved,
  }
}

function normalizeRel(candidate) {
  const rel = String(candidate || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel || escapesRoot(rel)) return null
  return path.posix.normalize(rel)
}

function escapesRoot(candidate) {
  const normalized = path.posix.normalize(String(candidate || '').replace(/\\/g, '/'))
  return normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
}
