/**
 * Shared source file definitions for tlda CLI.
 *
 * Single source of truth for which files constitute a TeX project
 * and how to encode them for upload.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  SOURCE_EXTENSIONS,
  BUILD_JUNK_SUFFIXES,
  isBuildJunkPath,
  isIgnoredSourceDir,
  isSourceFilePath,
  isTextSourcePath,
} from '../../shared/source-manifest.mjs'

export { SOURCE_EXTENSIONS }
export const JUNK_PATTERNS = BUILD_JUNK_SUFFIXES

/** Check if a file extension is a project source file. */
export function isSourceFile(filename, context = {}) {
  return isSourceFilePath(filename, context)
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
  walkCollect(dir, dir, files, context)
  return files
}

/** Recursively collect MD5 hashes of all source files (without reading full content for upload). */
export function collectSourceHashes(dir, context = {}) {
  const hashes = {}
  walkHash(dir, dir, hashes, context)
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
