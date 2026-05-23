/**
 * Changelog: tracks TeX diffs across builds.
 *
 * After each successful build, computes a unified diff of all .tex files
 * against the previous snapshot, and appends an entry to changelog.jsonl.
 *
 * Storage layout:
 *   server/projects/{name}/changelog/
 *     tex-snapshot.json    — {files: {path: content, ...}, timestamp}
 *     changelog.jsonl      — one JSON object per line
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { createHash } from 'crypto'
import { projectDir, sourceDir } from './project-store.mjs'

// --- Public API ---

/**
 * Snapshot current TeX source files. Called on project creation and after builds.
 * Returns the snapshot object.
 */
export function snapshotTex(name) {
  const dir = changelogDir(name)
  mkdirSync(dir, { recursive: true })

  const files = readTexFiles(name)
  const snapshot = { files, timestamp: Date.now() }
  writeFileSync(join(dir, 'tex-snapshot.json'), JSON.stringify(snapshot))
  return snapshot
}

/**
 * Compute diff against previous snapshot, append changelog entry, update snapshot.
 * Called after a successful build in build-runner.mjs.
 *
 * @param {string} name - Project name
 * @param {number[]} changedPages - Pages that changed in this build
 * @param {string} buildHash - Hash of the build output
 */
export function appendBuildEntry(name, changedPages, buildHash) {
  const dir = changelogDir(name)
  mkdirSync(dir, { recursive: true })

  const currentFiles = readTexFiles(name)
  const previous = readSnapshot(name)

  // First build: save baseline snapshot, no diff entry
  if (!previous) {
    snapshotTex(name)
    return null
  }

  // Compute unified diff
  const texDiff = computeDiff(previous.files || {}, currentFiles)

  // Skip if nothing changed
  if (!texDiff) return null

  const entry = {
    ts: Date.now(),
    action: 'build',
    texDiff,
    changedPages: changedPages || [],
    buildHash: buildHash || hashFiles(currentFiles),
  }

  // Append to JSONL
  appendFileSync(join(dir, 'changelog.jsonl'), JSON.stringify(entry) + '\n')

  // Update snapshot
  const snapshot = { files: currentFiles, timestamp: Date.now() }
  writeFileSync(join(dir, 'tex-snapshot.json'), JSON.stringify(snapshot))

  return entry
}

/**
 * Read changelog entries (newest first).
 */
export function readChangelog(name, limit = 50) {
  const file = join(changelogDir(name), 'changelog.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  return lines
    .map((line, idx) => { try { return JSON.parse(line) } catch (e) { console.warn(`[changelog] corrupt line ${idx + 1} in ${name}: ${e.message}`); return null } })
    .filter(Boolean)
    .reverse()
    .slice(0, limit)
}

// --- Internals ---

function changelogDir(name) {
  return join(projectDir(name), 'changelog')
}

function readSnapshot(name) {
  const file = join(changelogDir(name), 'tex-snapshot.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read all .tex files from the project's source directory.
 * Returns {relativePath: content} map.
 */
function readTexFiles(name) {
  const srcDir = sourceDir(name)
  if (!existsSync(srcDir)) return {}
  const files = {}
  walkTex(srcDir, srcDir, files)
  return files
}

function walkTex(dir, root, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTex(full, root, files)
    } else if (entry.name.endsWith('.tex')) {
      const rel = relative(root, full)
      files[rel] = readFileSync(full, 'utf8')
    }
  }
}

/**
 * Compute a simple unified-style diff between two file maps.
 * Returns a string with the diff, or null if no changes.
 */
function computeDiff(oldFiles, newFiles) {
  const allPaths = new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])
  const chunks = []

  for (const path of [...allPaths].sort()) {
    const oldContent = oldFiles[path] || ''
    const newContent = newFiles[path] || ''
    if (oldContent === newContent) continue

    const oldLines = oldContent.split('\n')
    const newLines = newContent.split('\n')
    const hunks = computeHunks(oldLines, newLines)

    if (hunks.length === 0) continue

    chunks.push(`--- a/${path}`)
    chunks.push(`+++ b/${path}`)
    for (const hunk of hunks) {
      chunks.push(hunk)
    }
  }

  return chunks.length > 0 ? chunks.join('\n') : null
}

/**
 * Simple line-level diff producing unified-style hunks.
 * Uses a basic LCS approach suitable for small-to-medium TeX files.
 */
function computeHunks(oldLines, newLines) {
  // Find changed regions by comparing lines
  const maxLen = Math.max(oldLines.length, newLines.length)
  const hunks = []
  let i = 0, j = 0
  const CONTEXT = 3

  while (i < oldLines.length || j < newLines.length) {
    // Skip matching lines
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++
      continue
    }

    // Found a difference — collect the hunk
    const hunkStartOld = Math.max(0, i - CONTEXT)
    const hunkStartNew = Math.max(0, j - CONTEXT)
    const contextBefore = []

    // Context before
    for (let k = hunkStartOld; k < i; k++) {
      contextBefore.push(` ${oldLines[k]}`)
    }

    // Collect changed lines
    const removed = []
    const added = []

    // Find the extent of the change
    // Look ahead for the next matching line
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        // Check if we have enough matching lines to end the hunk
        let matchCount = 0
        while (i + matchCount < oldLines.length && j + matchCount < newLines.length &&
               oldLines[i + matchCount] === newLines[j + matchCount] && matchCount < CONTEXT * 2) {
          matchCount++
        }
        if (matchCount >= CONTEXT * 2 || (i + matchCount >= oldLines.length && j + matchCount >= newLines.length)) {
          break // Enough context, end hunk
        }
        // Not enough matching — include in hunk as context
        for (let k = 0; k < matchCount; k++) {
          removed.push(` ${oldLines[i++]}`)
          added.push(` ${newLines[j++]}`)
        }
        continue
      }
      // Consume differing lines — prefer removing old first, then adding new
      if (i < oldLines.length && (j >= newLines.length || !newLines.includes(oldLines[i]))) {
        removed.push(`-${oldLines[i++]}`)
      } else if (j < newLines.length) {
        added.push(`+${newLines[j++]}`)
      } else {
        break
      }
    }

    // Context after
    const contextAfter = []
    const afterEnd = Math.min(i + CONTEXT, oldLines.length)
    for (let k = i; k < afterEnd; k++) {
      contextAfter.push(` ${oldLines[k]}`)
    }

    if (removed.length > 0 || added.length > 0) {
      const oldCount = contextBefore.length + removed.filter(l => l[0] !== '+').length + contextAfter.length
      const newCount = contextBefore.length + added.filter(l => l[0] !== '-').length + contextAfter.length
      hunks.push(`@@ -${hunkStartOld + 1},${oldCount} +${hunkStartNew + 1},${newCount} @@`)
      hunks.push(...contextBefore)
      // Interleave: removals first, then additions (standard unified diff order)
      const pureRemoved = removed.filter(l => l[0] === '-')
      const pureAdded = added.filter(l => l[0] === '+')
      const contextInHunk = removed.filter(l => l[0] === ' ')
      hunks.push(...pureRemoved)
      hunks.push(...pureAdded)
      hunks.push(...contextInHunk)
      hunks.push(...contextAfter)
    }

    // Skip context lines we already consumed
    const skip = Math.min(CONTEXT, Math.min(oldLines.length - i, newLines.length - j))
    i += skip
    j += skip
  }

  return hunks
}

function hashFiles(files) {
  const hash = createHash('md5')
  for (const path of Object.keys(files).sort()) {
    hash.update(path)
    hash.update(files[path])
  }
  return hash.digest('hex')
}
