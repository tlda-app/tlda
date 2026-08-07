/**
 * Shared source file definitions for tlda CLI.
 *
 * Single source of truth for which files constitute a TeX project
 * and how to encode them for upload.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
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
    const projectRelative = rel.split(sep).join('/')
    roots.add(projectRelative)
    // Membership is closed under references, so a root drags in what it refers
    // to, and what those refer to. This is the same walk that already backs
    // markdown pushes and chat file-share rather than a second traversal — the
    // seed differs, the edge-following does not.
    if (!/\.(?:md|markdown)$/i.test(projectRelative)) continue
    try {
      const closure = scanMarkdownDependencyClosure(projectRelative, dir)
      for (const rel of [...closure.files, ...closure.assets]) roots.add(rel)
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

function walkCollect(root, dir, files, context) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      walkCollect(root, full, files, context)
    } else {
      const rel = full.slice(root.length + 1)
      if (!isSourceFilePath(rel, context)) continue
      files.push({ path: rel, ...readForUpload(full) })
    }
  }
}

function walkHash(root, dir, hashes, context) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      walkHash(root, full, hashes, context)
    } else {
      const rel = full.slice(root.length + 1)
      if (!isSourceFilePath(rel, context)) continue
      hashes[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
    }
  }
}
