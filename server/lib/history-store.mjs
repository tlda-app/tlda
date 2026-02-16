/**
 * History store: saves build snapshots so the viewer can compare
 * the current version against any previous build or git commit.
 *
 * Storage layout:
 *   server/projects/{name}/history/
 *     index.json                  — [{id, type, timestamp, pages, commitHash?, commitMessage?}]
 *     build-{timestamp}/          — in-session snapshots (SVG copies)
 *     git-{hash7}/                — cached git builds
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'fs'
import { join } from 'path'
import { projectDir, outputDir } from './project-store.mjs'

const MAX_BUILD_SNAPSHOTS = 30

/**
 * Snapshot the current output SVGs before a new build overwrites them.
 * No-op if there are no existing SVGs (first build).
 */
export function snapshotBeforeBuild(name) {
  const outDir = outputDir(name)
  const svgs = existsSync(outDir)
    ? readdirSync(outDir).filter(f => /^page-\d+\.svg$/.test(f))
    : []

  if (svgs.length === 0) return null

  const histDir = historyDir(name)
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true })

  const id = `build-${Date.now()}`
  const snapDir = join(histDir, id)
  mkdirSync(snapDir)

  for (const svg of svgs) {
    copyFileSync(join(outDir, svg), join(snapDir, svg))
  }

  const entry = {
    id,
    type: 'build',
    timestamp: Date.now(),
    pages: svgs.length,
  }

  const index = readIndex(name)
  index.push(entry)
  pruneBuilds(name, index)
  writeIndex(name, index)

  return entry
}

/**
 * Record a completed git snapshot build in the index.
 */
export function recordGitSnapshot(name, { commitHash, commitMessage, pages }) {
  const id = `git-${commitHash.slice(0, 7)}`
  const entry = {
    id,
    type: 'git',
    timestamp: Date.now(),
    commitHash,
    commitMessage,
    pages,
  }

  const index = readIndex(name)
  // Replace existing entry for same commit if present
  const existing = index.findIndex(e => e.commitHash === commitHash)
  if (existing >= 0) index[existing] = entry
  else index.push(entry)
  writeIndex(name, index)

  return entry
}

/**
 * List all history entries (newest first).
 */
export function listHistory(name) {
  return readIndex(name).slice().reverse()
}

/**
 * Get the directory path for a snapshot.
 */
export function getSnapshotPath(name, snapshotId) {
  return join(historyDir(name), snapshotId)
}

/**
 * Check if a git snapshot exists (is built and cached).
 */
export function hasGitSnapshot(name, commitHash) {
  const id = `git-${commitHash.slice(0, 7)}`
  const dir = join(historyDir(name), id)
  return existsSync(dir) && readdirSync(dir).some(f => /^page-\d+\.svg$/.test(f))
}

// --- internals ---

function historyDir(name) {
  return join(projectDir(name), 'history')
}

function readIndex(name) {
  const path = join(historyDir(name), 'index.json')
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

function writeIndex(name, index) {
  const dir = historyDir(name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2))
}

function pruneBuilds(name, index) {
  const buildEntries = index.filter(e => e.type === 'build')
  while (buildEntries.length > MAX_BUILD_SNAPSHOTS) {
    const oldest = buildEntries.shift()
    const dir = join(historyDir(name), oldest.id)
    if (existsSync(dir)) rmSync(dir, { recursive: true })
    const idx = index.indexOf(oldest)
    if (idx >= 0) index.splice(idx, 1)
  }
}
