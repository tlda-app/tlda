// tex-deps.mjs — the SHARED LaTeX dependency detector.
//
// A LaTeX document is not a single file — it is the transitive closure of the
// local files it \input{}s, \include{}s, \includegraphics{}es and cites, rooted
// at the project's main file. This is the TeX counterpart of
// scanMarkdownDependencyClosure in markdown-deps.mjs, and it exists for the
// same reason: membership is "what does this document reference", not "what
// files sit near it with a plausible extension".
//
// Without it, LaTeX membership fell through to an extension test, so every
// .tex/.png/.svg anywhere under the project was a member — a 240KB
// .bak-before-deletion.tex and 1,528 scratch notes included. See
// isSourceFilePath in source-manifest.mjs.
//
// Pure (content + base dir in → refs out), so it runs on the agent's machine
// for the daemon as well as on the server.
import path from 'path'
import fs from 'fs'

// \input{a}  \include{a}  \subfile{a}  \includeonly is a build hint, not a ref.
const TEX_INPUT_RE = /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]+)\}/g
// \input a  — TeX's brace-less form, terminated by whitespace.
const TEX_BARE_INPUT_RE = /\\input\s+([^\s{}\\%]+)/g
// \includegraphics[opts]{a}
const TEX_GRAPHICS_RE = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
// \bibliography{a,b}  \addbibresource{a.bib}
const TEX_BIB_RE = /\\(?:bibliography|addbibresource)\s*\{([^}]+)\}/g
// \usepackage{a} and \RequirePackage{a} only matter when a.sty sits in the project.
const TEX_PACKAGE_RE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
// Local document classes and BibTeX styles are source dependencies too.
const TEX_CLASS_RE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
const TEX_BIB_STYLE_RE = /\\bibliographystyle\s*\{([^}]+)\}/g
// \inputscratch{path}{label}{caption} — tlda's own scratch inclusion.
const TEX_SCRATCH_RE = /\\inputscratch\s*\{([^}]+)\}/g

// Extensions TeX resolves implicitly, in the order it tries them.
const IMPLICIT_TEX = ['.tex']
const IMPLICIT_GRAPHICS = ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.eps']
const IMPLICIT_BIB = ['.bib']
const IMPLICIT_PACKAGE = ['.sty']
const IMPLICIT_CLASS = ['.cls']
const IMPLICIT_BIB_STYLE = ['.bst']

function isExternal(ref) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)
}

// Strip TeX comments so a commented-out \input is not a dependency. A backslash
// escapes the percent, so only an unescaped % starts a comment.
function stripComments(content) {
  return String(content || '').replace(/(^|[^\\])%.*$/gm, '$1')
}

function projectRelativeRef(raw) {
  const ref = String(raw || '').trim().replace(/^["']|["']$/g, '')
  if (!ref || isExternal(ref) || ref.startsWith('/') || ref.startsWith('~/')) return null
  return ref.replace(/\\/g, '/')
}

// Resolve a reference the way TeX does: exact match first, then each implicit
// extension. Returns the project-relative path, or null when nothing exists.
function resolveWithExtensions(baseDir, root, ref, implicit) {
  const candidates = [ref, ...implicit.map(ext => `${ref}${ext}`)]
  for (const candidate of candidates) {
    const abs = path.resolve(baseDir, candidate)
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) continue
    try {
      if (fs.statSync(abs).isFile()) return rel
    } catch {
      // Not this candidate; try the next extension.
    }
  }
  return null
}

// Every reference in one file's content, as { ref, implicit, followable }.
// `followable` marks a TeX source file whose own references must be scanned;
// graphics and bibliographies are leaves.
export function scanTexDeps(content) {
  const source = stripComments(content)
  const seen = new Set()
  const deps = []
  const collect = (re, implicit, followable, required = followable) => {
    for (const match of source.matchAll(re)) {
      // \bibliography{a,b} takes a comma-separated list; the others take one.
      for (const piece of String(match[1]).split(',')) {
        const ref = projectRelativeRef(piece)
        if (!ref) continue
        const key = `${ref}\u0000${implicit[0]}`
        if (seen.has(key)) continue
        seen.add(key)
        deps.push({ ref, implicit, followable, required })
      }
    }
  }
  collect(TEX_INPUT_RE, IMPLICIT_TEX, true)
  collect(TEX_BARE_INPUT_RE, IMPLICIT_TEX, true)
  collect(TEX_SCRATCH_RE, IMPLICIT_TEX, true)
  collect(TEX_GRAPHICS_RE, IMPLICIT_GRAPHICS, false)
  collect(TEX_BIB_RE, IMPLICIT_BIB, false)
  collect(TEX_PACKAGE_RE, IMPLICIT_PACKAGE, true, false)
  collect(TEX_CLASS_RE, IMPLICIT_CLASS, true, false)
  collect(TEX_BIB_STYLE_RE, IMPLICIT_BIB_STYLE, false)
  return deps
}

// The transitive closure of a LaTeX root. `missing` records references that
// resolve to nothing so the caller can report them rather than silently
// dropping them — a reference to a file that is not there is a real defect in
// the document, and the source validator already has a channel for it.
export function scanTexDependencyClosure(mainFile, sourceDir) {
  const root = path.resolve(sourceDir)
  const main = String(mainFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const tex = new Set()
  const assets = new Set()
  const missing = []
  const queue = [main]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || tex.has(current)) continue
    const abs = path.resolve(root, current)
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) continue
    let content
    try {
      if (!fs.statSync(abs).isFile()) throw new Error('not a file')
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      missing.push({ from: current, ref: current, path: rel })
      continue
    }
    tex.add(rel)
    const baseDir = path.dirname(abs)
    for (const dep of scanTexDeps(content)) {
      const targetRel = resolveWithExtensions(baseDir, root, dep.ref, dep.implicit)
      if (!targetRel) {
        // A \usepackage naming a real LaTeX distribution package is not a
        // missing project file, so only followable refs are reported absent.
        if (dep.required) missing.push({ from: rel, ref: dep.ref, path: dep.ref })
        continue
      }
      if (dep.followable) {
        if (!tex.has(targetRel)) queue.push(targetRel)
      } else {
        assets.add(targetRel)
      }
    }
  }

  return {
    mainFile: main,
    tex: [...tex].sort(),
    assets: [...assets].sort(),
    files: [...new Set([...tex, ...assets])].sort(),
    missing,
  }
}
