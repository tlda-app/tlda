/**
 * Git history: list commits and build historical versions.
 *
 * Uses the project's sourceDir (the author's git repo) to access
 * git history and extract source files at old commits.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
const _execAsync = promisify(execCb)
const texbin = '/Library/TeX/texbin'
if (!process.env.PATH?.includes(texbin)) {
  process.env.PATH = `${texbin}:${process.env.PATH || '/usr/bin:/bin'}`
}
const execAsync = (cmd, opts = {}) => _execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })

import { existsSync, mkdirSync, readdirSync, writeFileSync, copyFileSync, rmSync, renameSync } from 'fs'
import { join, basename, dirname } from 'path'
import { readProject, outputDir } from './project-store.mjs'
import { getSnapshotPath, recordGitSnapshot, hasGitSnapshot } from './history-store.mjs'

// Track in-progress git builds
const activeGitBuilds = new Map()

/**
 * List commits that touched the project's source files.
 * Returns newest-first.
 */
export async function listCommits(name, limit = 50) {
  const project = readProject(name)
  if (!project?.sourceDir) return []

  const srcDir = project.sourceDir
  if (!existsSync(srcDir)) return []

  // Check if it's a git repo
  try {
    await execAsync('git rev-parse --git-dir', { cwd: srcDir, timeout: 5000 })
  } catch {
    return []
  }

  const mainFile = project.mainFile || 'main.tex'

  try {
    // Get the repo root so we can compute the relative path
    const { stdout: repoRoot } = await execAsync('git rev-parse --show-toplevel', { cwd: srcDir, timeout: 5000 })
    const root = repoRoot.trim()

    // Compute relative path from repo root to the source dir
    const relDir = srcDir.startsWith(root) ? srcDir.slice(root.length + 1) : ''
    const relMain = relDir ? `${relDir}/${mainFile}` : mainFile

    const { stdout } = await execAsync(
      `git log --format="%H %h %at %s" -n ${limit} -- "${relMain}"`,
      { cwd: root, timeout: 10000 },
    )

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, unixTime, ...msgParts] = line.split(' ')
      return {
        hash,
        shortHash,
        timestamp: parseInt(unixTime, 10) * 1000,
        message: msgParts.join(' '),
      }
    })
  } catch (e) {
    console.error(`[git-history] listCommits failed: ${e.message}`)
    return []
  }
}

/**
 * Get the build status for a git snapshot.
 */
export function getGitBuildStatus(name, commitHash) {
  if (hasGitSnapshot(name, commitHash)) {
    return { status: 'cached' }
  }
  const key = `${name}:${commitHash}`
  const active = activeGitBuilds.get(key)
  if (active) {
    return { status: 'building', startedAt: active.startedAt }
  }
  return { status: 'none' }
}

/**
 * Build SVGs for a historical git commit.
 * Extracts source at the given ref, compiles, and caches SVGs.
 * Returns the snapshot entry, or throws on failure.
 */
export async function buildAtRef(name, commitHash) {
  // Already cached?
  if (hasGitSnapshot(name, commitHash)) {
    const id = `git-${commitHash.slice(0, 7)}`
    const snapDir = getSnapshotPath(name, id)
    const pages = readdirSync(snapDir).filter(f => /^page-\d+\.svg$/.test(f)).length
    return { id, status: 'cached', pages }
  }

  // Already building?
  const key = `${name}:${commitHash}`
  if (activeGitBuilds.has(key)) {
    return { status: 'building' }
  }

  const project = readProject(name)
  if (!project?.sourceDir) throw new Error('Project has no sourceDir')

  const srcDir = project.sourceDir
  const mainFile = project.mainFile || 'main.tex'
  const texBase = basename(mainFile, '.tex')

  // Get repo root
  const { stdout: repoRoot } = await execAsync('git rev-parse --show-toplevel', { cwd: srcDir, timeout: 5000 })
  const root = repoRoot.trim()
  const relDir = srcDir.startsWith(root) ? srcDir.slice(root.length + 1) : ''

  // Create temp build directory
  const tmpDir = join(getSnapshotPath(name, ''), '..', `_tmp-git-${commitHash.slice(0, 7)}`)
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  const buildRecord = { startedAt: Date.now() }
  activeGitBuilds.set(key, buildRecord)

  try {
    // Extract source files at the given ref
    // Use git archive to get the full directory tree at that commit
    const archiveDir = relDir ? `${relDir}/` : ''
    await execAsync(
      `git archive ${commitHash} ${archiveDir ? `"${archiveDir}"` : ''} | tar -x -C "${tmpDir}" ${archiveDir ? `--strip-components=${archiveDir.split('/').filter(Boolean).length}` : ''}`,
      { cwd: root, timeout: 30000 },
    )

    // Verify main file exists
    if (!existsSync(join(tmpDir, mainFile))) {
      throw new Error(`Main file "${mainFile}" not found at commit ${commitHash.slice(0, 7)}`)
    }

    // Build: latexmk → DVI → dvisvgm (skip synctex, proofs, macros)
    const pretex = '\\PassOptionsToPackage{draft,dvipdfmx}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}'
    writeFileSync(join(tmpDir, '.latexmkrc'), `$latex = 'pdflatex --output-format=dvi -synctex=1 %O %P';\n`)

    console.log(`[git-history] Building ${name} at ${commitHash.slice(0, 7)}...`)

    try {
      await execAsync(
        `latexmk -dvi -f -interaction=nonstopmode -pretex='${pretex}' "${texBase}.tex"`,
        { cwd: tmpDir, timeout: 180000 },
      )
    } catch {
      // Check for DVI below
    }

    const dviFile = join(tmpDir, `${texBase}.dvi`)
    if (!existsSync(dviFile)) throw new Error('DVI file not created')

    // SVG conversion into the snapshot dir
    const id = `git-${commitHash.slice(0, 7)}`
    const snapDir = getSnapshotPath(name, id)
    if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true })

    await execAsync(
      `dvisvgm --page=1- --font-format=woff2 --bbox=papersize --linkmark=none ` +
      `--output="${snapDir}/page-%p.svg" "${dviFile}"`,
      { cwd: tmpDir, timeout: 120000 },
    )

    // Normalize zero-padded names
    for (const f of readdirSync(snapDir)) {
      const m = f.match(/^page-0+(\d+\.svg)$/)
      if (m) renameSync(join(snapDir, f), join(snapDir, `page-${m[1]}`))
    }

    const pages = readdirSync(snapDir).filter(f => /^page-\d+\.svg$/.test(f)).length
    console.log(`[git-history] Built ${name}@${commitHash.slice(0, 7)}: ${pages} pages`)

    // Get commit message for the record
    let message = ''
    try {
      const { stdout } = await execAsync(`git log -1 --format="%s" ${commitHash}`, { cwd: root, timeout: 5000 })
      message = stdout.trim()
    } catch {}

    const entry = recordGitSnapshot(name, { commitHash, commitMessage: message, pages })

    return { id, status: 'cached', pages }
  } finally {
    activeGitBuilds.delete(key)
    // Clean up temp dir
    if (existsSync(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true }) } catch {}
    }
  }
}
