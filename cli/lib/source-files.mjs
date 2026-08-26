/**
 * Shared source file definitions for tlda CLI.
 *
 * Single source of truth for which files constitute a TeX project
 * and how to encode them for upload.
 */

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import { createHash } from 'crypto'
import {
  SOURCE_EXTENSIONS,
  BUILD_JUNK_SUFFIXES,
  isBuildJunkPath,
  isIgnoredSourceDir,
  isSourceFilePath,
  isTextSourcePath,
} from '../../shared/source-manifest.mjs'
import { scanMarkdownDependencyClosure } from '../../shared/markdown-deps.mjs'
import { scanTexDependencyClosure } from '../../shared/tex-deps.mjs'

export { SOURCE_EXTENSIONS }
export const JUNK_PATTERNS = BUILD_JUNK_SUFFIXES

/** Check if a file extension is a project source file. */
export function isSourceFile(filename, context = {}) {
  return isSourceFilePath(filename, context)
}

/**
 * Turn the server's chat references into project coordinates.
 *
 * The server records each reference as an absolute path on this machine and
 * cannot relativize it — it strips `sourceDir` from every shared project, so it
 * does not know `dir`. This side does. A reference that does not land inside
 * `dir` has no project-relative coordinate and no watcher, so it is dropped
 * here rather than half-supported: nothing beneath this line can make a file
 * outside the tree live, and pretending otherwise would put the silence back.
 */
export function withReferencedRoots(dir, context = {}) {
  const referenced = Array.isArray(context.referencedSourcePaths) ? context.referencedSourcePaths : []
  const existingRoots = context.referencedRoots instanceof Set
    ? [...context.referencedRoots]
    : Array.isArray(context.referencedRoots) ? context.referencedRoots : []
  const roots = new Set(existingRoots)
  for (const abs of referenced) {
    if (typeof abs !== 'string' || !abs) continue
    const rel = relative(dir, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    roots.add(rel.split(sep).join('/'))
  }

  // Membership is closed under references: a root drags in what it refers to,
  // and what those refer to.
  //
  // **Closed over EVERY root, not just the chat-shared seeds.** The declared
  // document roots arrive here already in `referencedRoots` (put there by
  // `sourceManifestContext`), and the walk used to run only over the paths that
  // came in from chat -- so a project's own documents were members while the
  // things they include were not.
  //
  // That is how a PDF figure went missing. `isSourceFilePath` admits anything in
  // this set whatever its extension, and falls back to `SOURCE_EXTENSIONS`
  // otherwise -- which lists `.png .jpg .svg .eps` and NOT `.pdf`, presumably
  // because a `.pdf` is usually the compiled paper. So `\includegraphics{fig.pdf}`
  // was not a source file, was never pushed, and the built document lost the
  // figure while the `.tex` beside it arrived intact. Measured before this
  // change: figures/diagram.pdf NOT source, figures/plot.png IS source.
  //
  // Adding `.pdf` to that extension list would have swept the built paper back
  // in. The rule that a file a document actually INCLUDES is a member is the one
  // that separates them, and it already existed.
  //
  // The traversal is chosen by extension, exactly as the push path chooses it
  // (`daemon/git-project-sync.mjs`), rather than being a second walk.
  for (const root of [...roots]) {
    const closureFor = /\.tex$/i.test(root) ? scanTexDependencyClosure
      : /\.(?:md|markdown|qmd)$/i.test(root) ? scanMarkdownDependencyClosure
        : null
    if (!closureFor) continue
    try {
      const closure = closureFor(root, dir)
      // `files` already unions the assets on the tex side; taking both is
      // harmless there and required on the markdown side.
      for (const rel of [...closure.files, ...(closure.assets || [])]) roots.add(rel)
    } catch {
      // A root whose closure cannot be read is still a member on its own.
    }
  }
  return { ...context, referencedRoots: [...roots] }
}

/** Check if a file should be ignored by the watcher. */
export function isJunk(filename) {
  return isBuildJunkPath(filename)
}

/** Read a source file and encode it for upload (utf8 or base64). */
export function readForUpload(fullPath) {
  if (isTextSourcePath(fullPath)) {
    return { content: readFileSync(fullPath, 'utf8') }
  }
  return { content: readFileSync(fullPath).toString('base64'), encoding: 'base64' }
}

/** Recursively collect all source files in a directory, encoded for upload. */
export function collectSourceFiles(dir, context = {}) {
  const files = []
  walkCollect(dir, dir, files, withReferencedRoots(dir, context))
  return files
}

/** Recursively collect MD5 hashes of all source files (without reading full content for upload). */
export function collectSourceHashes(dir, context = {}) {
  const hashes = {}
  walkHash(dir, dir, hashes, withReferencedRoots(dir, context))
  return hashes
}

/** Collect hashes through the project's format-specific source-set adapter. */
export function collectProjectSourceHashes(dir, context = {}) {
  const resolvedContext = withReferencedRoots(dir, context)
  if (resolvedContext.format !== 'markdown' || !resolvedContext.mainFile) {
    return collectSourceHashes(dir, resolvedContext)
  }

  const hashes = {}
  const paths = new Set([
    ...scanMarkdownDependencyClosure(resolvedContext.mainFile, dir).files,
    ...(resolvedContext.referencedRoots || []),
  ])
  for (const rel of paths) {
    const full = join(dir, rel)
    if (!existsSync(full) || !isSourceFilePath(rel, resolvedContext)) continue
    hashes[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
  }
  return hashes
}

/** Read and encode only the specified files for upload. */
export function collectSpecificFiles(dir, paths) {
  const files = []
  for (const rel of paths) {
    const full = join(dir, rel)
    if (!existsSync(full)) continue
    files.push({ path: rel, ...readForUpload(full) })
  }
  return files
}

export function splitServerSourcePathsByManifest(serverHashes, finalManifest) {
  const final = new Set(finalManifest || [])
  const survivingServerPaths = []
  const staleServerPaths = []
  for (const path of Object.keys(serverHashes || {})) {
    if (final.has(path)) survivingServerPaths.push(path)
    else staleServerPaths.push(path)
  }
  return { survivingServerPaths, staleServerPaths }
}

function walkCollect(root, dir, files, context) {
  const sourceRoot = realpathSync(root)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    let resolved
    try {
      resolved = realpathSync(full)
    } catch {
      continue
    }
    if (!insideSourceRoot(sourceRoot, resolved)) continue
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      walkCollect(root, full, files, context)
    } else if (stats.isFile()) {
      const rel = full.slice(root.length + 1)
      if (!isSourceFilePath(rel, context)) continue
      files.push({ path: rel, ...readForUpload(full) })
    }
  }
}

function walkHash(root, dir, hashes, context) {
  const sourceRoot = realpathSync(root)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    let resolved
    try {
      resolved = realpathSync(full)
    } catch {
      continue
    }
    if (!insideSourceRoot(sourceRoot, resolved)) continue
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      walkHash(root, full, hashes, context)
    } else if (stats.isFile()) {
      const rel = full.slice(root.length + 1)
      if (!isSourceFilePath(rel, context)) continue
      hashes[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
    }
  }
}

function insideSourceRoot(sourceRoot, target) {
  const rel = relative(sourceRoot, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}
