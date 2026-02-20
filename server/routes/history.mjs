/**
 * History API routes.
 *
 * Mounted at /api/projects/:name/history by projects.mjs.
 * Provides a unified timeline (build snapshots + git commits),
 * on-demand git builds, and text-based diffs.
 */

import { Router } from 'express'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { requireRead, requireRw } from '../lib/auth.mjs'
import { readProject, outputDir } from '../lib/project-store.mjs'
import { listHistory, getSnapshotPath, hasGitSnapshot } from '../lib/history-store.mjs'
import { listCommits, buildAtRef, getGitBuildStatus } from '../lib/git-history.mjs'

// Lazy-load svg-text from mcp-server (it's in a sibling directory)
let _loadPageText = null
async function loadPageText(svgPath) {
  if (!_loadPageText) {
    const mod = await import('../../mcp-server/svg-text.mjs')
    _loadPageText = mod.loadPageText
  }
  return _loadPageText(svgPath)
}

const router = Router({ mergeParams: true })

/**
 * GET / — Unified timeline: build snapshots + git commits, newest first.
 */
router.get('/', requireRead, async (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const buildSnapshots = listHistory(req.params.name)

  // Get git commits (non-blocking, returns [] if no git repo)
  let commits = []
  try {
    commits = await listCommits(req.params.name, 50)
  } catch {}

  // Merge: convert git commits to history entries
  const gitEntries = commits.map(c => ({
    id: `git-${c.shortHash}`,
    type: 'git',
    timestamp: c.timestamp,
    commitHash: c.hash,
    commitMessage: c.message,
    built: hasGitSnapshot(req.params.name, c.hash),
  }))

  // Combine and sort by timestamp descending
  const all = [...buildSnapshots, ...gitEntries]
  all.sort((a, b) => b.timestamp - a.timestamp)

  // Deduplicate: if a build snapshot and git entry have the same timestamp (within 5s), keep both but mark
  res.json({ entries: all })
})

/**
 * POST /git/:hash/build — Trigger on-demand build for a git commit.
 */
router.post('/git/:hash/build', requireRw, async (req, res) => {
  const { name } = req.params
  const { hash } = req.params

  const project = readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  // Check if already cached
  if (hasGitSnapshot(name, hash)) {
    const id = `git-${hash.slice(0, 7)}`
    const snapDir = getSnapshotPath(name, id)
    const pages = readdirSync(snapDir).filter(f => /^page-\d+\.svg$/.test(f)).length
    return res.json({ status: 'cached', id, pages })
  }

  // Check if already building
  const buildStatus = getGitBuildStatus(name, hash)
  if (buildStatus.status === 'building') {
    return res.status(202).json({ status: 'building' })
  }

  // Start build (respond immediately, build runs async)
  res.status(202).json({ status: 'building' })

  try {
    await buildAtRef(name, hash)
  } catch (e) {
    console.error(`[history] Git build failed for ${name}@${hash.slice(0, 7)}: ${e.message}`)
  }
})

/**
 * GET /git/:hash/status — Check build status for a git snapshot.
 */
router.get('/git/:hash/status', requireRead, (req, res) => {
  const { name } = req.params
  const { hash } = req.params

  const project = readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const status = getGitBuildStatus(name, hash)

  if (status.status === 'cached') {
    const id = `git-${hash.slice(0, 7)}`
    const snapDir = getSnapshotPath(name, id)
    const pages = readdirSync(snapDir).filter(f => /^page-\d+\.svg$/.test(f)).length
    return res.json({ status: 'cached', id, pages })
  }

  res.json(status)
})

/**
 * GET /:id/diff — Text-based diff between a snapshot and current output.
 * Returns per-page change regions.
 */
router.get('/:id/diff', requireRead, async (req, res) => {
  const { name, id } = req.params

  const project = readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const snapDir = getSnapshotPath(name, id)
  if (!existsSync(snapDir)) {
    return res.status(404).json({ error: 'Snapshot not found' })
  }

  const outDir = outputDir(name)
  const currentSvgs = existsSync(outDir)
    ? readdirSync(outDir).filter(f => /^page-\d+\.svg$/.test(f))
    : []

  if (currentSvgs.length === 0) {
    return res.json({ pages: [] })
  }

  const pages = []

  for (const svgFile of currentSvgs) {
    const pageNum = parseInt(svgFile.match(/page-(\d+)\.svg/)[1], 10)
    const currentPath = join(outDir, svgFile)
    const oldPath = join(snapDir, svgFile)

    if (!existsSync(oldPath)) {
      // Page is new (didn't exist in snapshot)
      pages.push({ page: pageNum, status: 'added' })
      continue
    }

    try {
      const currentText = await loadPageText(currentPath)
      const oldText = await loadPageText(oldPath)

      const { changes, regions } = diffPageText(oldText, currentText, pageNum)
      if (changes.length > 0 || regions.length > 0) {
        pages.push({ page: pageNum, status: 'changed', changes, regions })
      }
    } catch (e) {
      // Skip pages that fail to parse
      continue
    }
  }

  // Check for deleted pages (in snapshot but not current)
  const snapSvgs = readdirSync(snapDir).filter(f => /^page-\d+\.svg$/.test(f))
  const currentPageNums = new Set(currentSvgs.map(f => parseInt(f.match(/page-(\d+)/)[1], 10)))
  for (const svgFile of snapSvgs) {
    const pageNum = parseInt(svgFile.match(/page-(\d+)\.svg/)[1], 10)
    if (!currentPageNums.has(pageNum)) {
      pages.push({ page: pageNum, status: 'removed' })
    }
  }

  pages.sort((a, b) => a.page - b.page)
  res.json({ pages })
})

/**
 * Line-level diff between two pages' text data.
 * Returns { changes, regions } where changes is per-hunk with old/new text,
 * and regions is the merged bounding boxes for overlay highlights.
 */
function diffPageText(oldTextData, newTextData, pageNum) {
  const oldLines = oldTextData.lines.map(l => l.text.trim())
  const newLines = newTextData.lines.map(l => l.text.trim())

  const hunks = diffHunks(oldLines, newLines)
  if (hunks.length === 0) return { changes: [], regions: [] }

  const AVG_CHAR_WIDTH = 0.48  // Computer Modern average

  const changes = []
  const allRawRegions = []

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]

    // Per-line regions in raw SVG coordinates (client handles viewBox offset)
    const newLineRegions = []
    for (let j = hunk.newStart; j < hunk.newEnd; j++) {
      const line = newTextData.lines[j]
      if (!line) continue
      const estWidth = line.text.length * line.fontSize * AVG_CHAR_WIDTH
      newLineRegions.push({
        y: line.y - line.fontSize * 0.3,
        height: line.fontSize * 1.4,
        x: line.x - line.fontSize * 0.2,
        width: estWidth + line.fontSize * 0.4,
      })
    }

    // Per-line regions for old side
    const oldLineRegions = []
    for (let j = hunk.oldStart; j < hunk.oldEnd; j++) {
      const line = oldTextData.lines[j]
      if (!line) continue
      const estWidth = line.text.length * line.fontSize * AVG_CHAR_WIDTH
      oldLineRegions.push({
        y: line.y - line.fontSize * 0.3,
        height: line.fontSize * 1.4,
        x: line.x - line.fontSize * 0.2,
        width: estWidth + line.fontSize * 0.4,
      })
    }

    // Bounding box (for arrows + fallback)
    let y, height, x, width
    if (newLineRegions.length > 0) {
      const sorted = [...newLineRegions].sort((a, b) => a.y - b.y)
      y = sorted[0].y
      x = Math.min(...sorted.map(r => r.x))
      const right = Math.max(...sorted.map(r => r.x + r.width))
      const last = sorted[sorted.length - 1]
      height = (last.y + last.height) - y
      width = right - x
    } else {
      // Pure deletion — use position of nearest new line
      const nearIdx = Math.min(hunk.newStart, newTextData.lines.length - 1)
      const near = newTextData.lines[nearIdx]
      if (!near) continue
      y = near.y - near.fontSize * 0.3
      height = near.fontSize * 1.4
      x = near.x
      width = 100
    }

    const oldText = cleanExtractedText(oldLines.slice(hunk.oldStart, hunk.oldEnd).join(' '))
    const newText = cleanExtractedText(newLines.slice(hunk.newStart, hunk.newEnd).join(' '))

    changes.push({
      id: `${pageNum}-${hi}`,
      page: pageNum,
      y, height, x, width,
      oldText: oldText || null,
      newText: newText || null,
      newLines: newLineRegions,
      oldLines: oldLineRegions,
    })

    // Collect for merged regions
    for (const r of newLineRegions) allRawRegions.push({ ...r, right: r.x + r.width })
  }

  // Build merged regions for overlay compatibility
  allRawRegions.sort((a, b) => a.y - b.y)
  const regions = []
  for (const r of allRawRegions) {
    const last = regions[regions.length - 1]
    if (last && r.y <= last.y + last.height + 2) {
      const bottom = Math.max(last.y + last.height, r.y + r.height)
      last.height = bottom - last.y
      last.x = Math.min(last.x, r.x)
      last.right = Math.max(last.right, r.right)
    } else {
      regions.push({ ...r })
    }
  }

  return {
    changes,
    regions: regions.map(r => ({ y: r.y, height: r.height, x: r.x, width: r.right - r.x })),
  }
}

/**
 * Find paired diff hunks between old and new line arrays.
 * Each hunk: { oldStart, oldEnd, newStart, newEnd } (half-open ranges).
 * Uses LCS to identify matching lines, then groups consecutive non-matches.
 */
function diffHunks(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length

  // Standard LCS via DP
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find LCS pairs: (oldIdx, newIdx)
  const lcsPairs = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcsPairs.push([i - 1, j - 1])
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  lcsPairs.reverse()

  // Walk LCS pairs to find gaps = hunks
  const hunks = []
  let oi = 0, ni = 0
  for (const [oldIdx, newIdx] of lcsPairs) {
    if (oi < oldIdx || ni < newIdx) {
      hunks.push({ oldStart: oi, oldEnd: oldIdx, newStart: ni, newEnd: newIdx })
    }
    oi = oldIdx + 1
    ni = newIdx + 1
  }
  // Trailing hunk after last LCS match
  if (oi < n || ni < m) {
    hunks.push({ oldStart: oi, oldEnd: n, newStart: ni, newEnd: m })
  }

  return hunks
}

/**
 * Clean up text extracted from SVGs.
 * dvisvgm text extraction produces artifacts: missing spaces between words,
 * stray spaces inside words, multiple spaces, etc.
 */
function cleanExtractedText(text) {
  if (!text) return text
  return text
    // Remove stray single-char spaces inside words: "argumen t" → "argument"
    .replace(/(\w) (\w)(?= |\b|$)/g, (_, a, b) => {
      // Only merge if the second part is a single char followed by space/end
      return a + b
    })
    // Insert space before uppercase after lowercase: "isstrong" → "is strong"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Insert space between lowercase and open paren/bracket
    .replace(/([a-z])([\(\[])/g, '$1 $2')
    // Collapse multiple spaces
    .replace(/  +/g, ' ')
    .trim()
}

export default router
