/**
 * Shadow repo: a per-project git repository that tracks source file snapshots.
 *
 * After every successful build, the current source files are committed here.
 * The commit hash IS the version ref. Time-based lookups use `git log --before`.
 *
 * Storage: server/projects/{name}/shadow-repo/
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(execCb)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, symlinkSync, lstatSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { projectDir, sourceDir, outputDir } from './project-store.mjs'

const GITIGNORE_CONTENT = `# Build artifacts
*.aux
*.log
*.out
*.synctex.gz
*.fls
*.fdb_latexmk
*.toc
*.lof
*.lot
*.bbl
*.blg
*.bcf
*.run.xml
*.nav
*.snm
*.vrb
*.dvi
*.pdf
`

function shadowRepoDir(name) {
  return join(projectDir(name), 'shadow-repo')
}

/**
 * Initialize shadow repo for a project (git init if needed).
 */
export async function initShadowRepo(name) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(repoDir)) {
    mkdirSync(repoDir, { recursive: true })
  }

  // Already initialized?
  if (existsSync(join(repoDir, '.git'))) return repoDir

  await execAsync('git init', { cwd: repoDir, timeout: 10000 })
  await execAsync('git config user.email "tlda@local"', { cwd: repoDir, timeout: 5000 })
  await execAsync('git config user.name "tlda"', { cwd: repoDir, timeout: 5000 })

  writeFileSync(join(repoDir, '.gitignore'), GITIGNORE_CONTENT)
  await execAsync('git add .gitignore && git commit -m "init"', { cwd: repoDir, timeout: 10000 })

  return repoDir
}

/**
 * Commit current source files to shadow repo. Returns { hash, timestamp }.
 * Copies source files from server/projects/{name}/source/ into the shadow repo,
 * git add -A, git commit. Returns null if nothing changed.
 */
export async function commitSnapshot(name) {
  const repoDir = await initShadowRepo(name)
  const srcDir = sourceDir(name)

  if (!existsSync(srcDir)) {
    throw new Error(`Source directory not found: ${srcDir}`)
  }

  // Clear existing files in shadow repo (except .git and .gitignore)
  for (const entry of readdirSync(repoDir)) {
    if (entry === '.git' || entry === '.gitignore') continue
    const fullPath = join(repoDir, entry)
    rmSync(fullPath, { recursive: true, force: true })
  }

  // Copy source files in
  for (const entry of readdirSync(srcDir)) {
    cpSync(join(srcDir, entry), join(repoDir, entry), { recursive: true })
  }

  // Stage everything
  await execAsync('git add -A', { cwd: repoDir, timeout: 10000 })

  // Check if there are changes to commit
  try {
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoDir, timeout: 5000 })
    if (!status.trim()) {
      // Nothing changed
      return null
    }
  } catch {
    // If status fails, try to commit anyway
  }

  const timestamp = new Date().toISOString()
  const message = `Build at ${timestamp}`

  await execAsync(`git commit -m "${message}"`, { cwd: repoDir, timeout: 15000 })

  // Get the commit hash
  const { stdout: hash } = await execAsync('git rev-parse HEAD', { cwd: repoDir, timeout: 5000 })

  return { hash: hash.trim(), timestamp }
}

/**
 * Find the active version at a given time (latest commit before that time).
 * time can be ISO string, unix ms, or relative like "20 minutes ago".
 */
export async function versionAt(name, time) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return null

  // Normalize time
  let beforeArg
  if (typeof time === 'number') {
    beforeArg = new Date(time).toISOString()
  } else if (typeof time === 'string') {
    // Could be ISO string or relative like "20 minutes ago"
    beforeArg = time
  } else {
    throw new Error('time must be a number (unix ms) or string')
  }

  try {
    const { stdout } = await execAsync(
      `git log --format="%H %at %s" --before="${beforeArg}" -n 1`,
      { cwd: repoDir, timeout: 10000 },
    )
    if (!stdout.trim()) return null

    const [hash, unixTime, ...msgParts] = stdout.trim().split(' ')
    return {
      hash,
      timestamp: parseInt(unixTime, 10) * 1000,
      message: msgParts.join(' '),
    }
  } catch {
    return null
  }
}

/**
 * List recent commits. Returns [{hash, timestamp, message}].
 */
export async function listVersions(name, { limit = 20 } = {}) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return []

  try {
    const { stdout } = await execAsync(
      `git log --format="%H %at %s" -n ${limit}`,
      { cwd: repoDir, timeout: 10000 },
    )
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, unixTime, ...msgParts] = line.split(' ')
      return {
        hash,
        timestamp: parseInt(unixTime, 10) * 1000,
        message: msgParts.join(' '),
      }
    }).filter(v => v.message !== 'init')  // Skip the init commit
  } catch {
    return []
  }
}

/**
 * Get the source files at a given ref. Extracts via git archive into a temp dir.
 * Returns the temp dir path. Caller is responsible for cleanup.
 */
export async function checkoutSource(name, ref) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) {
    throw new Error(`Shadow repo not found for ${name}`)
  }

  const tmpDir = join(tmpdir(), `tlda-shadow-${name}-${ref.slice(0, 7)}-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })

  await execAsync(
    `git -C "${repoDir}" archive "${ref}" | tar x -C "${tmpDir}"`,
    { timeout: 30000 },
  )

  return tmpDir
}

const MAX_CACHE_BYTES = 100 * 1024 * 1024  // ~100 MB

function historyDir(name) {
  return join(projectDir(name), 'history')
}

function fileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * Cache the SVGs for this version.
 * 1. Copy SVGs from output/ into history/{hash7}/
 * 2. Compare each SVG against the previous cached version using file hash
 * 3. If identical, replace the OLDER version's file with a forward-pointing symlink to the newer one
 * 4. Prune old cached versions to stay under ~20 MB
 */
export async function cacheSvgSnapshot(name, commitHash) {
  const outDir = outputDir(name)
  if (!existsSync(outDir)) return

  const svgs = readdirSync(outDir).filter(f => /^page-\d+\.svg$/.test(f))
  if (svgs.length === 0) return

  const hash7 = commitHash.slice(0, 7)
  const histDir = historyDir(name)
  const cacheDir = join(histDir, `shadow-${hash7}`)
  mkdirSync(cacheDir, { recursive: true })

  // Copy current SVGs into cache dir
  for (const svg of svgs) {
    copyFileSync(join(outDir, svg), join(cacheDir, svg))
  }

  // Find the most recent previously-cached shadow version (not this one)
  const allCached = readdirSync(histDir)
    .filter(d => d.startsWith('shadow-') && d !== `shadow-${hash7}`)
    .sort()  // lexicographic sort of hash prefixes; we just need any previous one

  if (allCached.length > 0) {
    const prevDir = join(histDir, allCached[allCached.length - 1])

    // For each SVG, compare against the previous version
    for (const svg of svgs) {
      const prevFile = join(prevDir, svg)
      const newFile = join(cacheDir, svg)

      // Skip if prev doesn't exist or is already a symlink
      if (!existsSync(prevFile)) continue
      try {
        const prevStat = lstatSync(prevFile)
        if (prevStat.isSymbolicLink()) continue
      } catch { continue }

      // Compare content hashes
      const prevHash = fileHash(prevFile)
      const newHash = fileHash(newFile)

      if (prevHash === newHash) {
        // Replace the OLDER version's file with a forward-pointing symlink to the newer one
        const relPath = relative(prevDir, newFile)
        rmSync(prevFile)
        symlinkSync(relPath, prevFile)
      }
    }
  }

  // Prune old cached versions to stay under ~20 MB
  pruneShadowCache(name)
}

/**
 * Calculate total size of shadow cache (follows symlinks = false, counts real files only).
 */
function shadowCacheSize(name) {
  const histDir = historyDir(name)
  if (!existsSync(histDir)) return 0

  let total = 0
  const dirs = readdirSync(histDir).filter(d => d.startsWith('shadow-'))
  for (const dir of dirs) {
    const dirPath = join(histDir, dir)
    try {
      for (const file of readdirSync(dirPath)) {
        const filePath = join(dirPath, file)
        const st = lstatSync(filePath)
        if (st.isFile() && !st.isSymbolicLink()) {
          total += st.size
        }
      }
    } catch { /* skip broken dirs */ }
  }
  return total
}

/**
 * Prune oldest shadow cache dirs until under MAX_CACHE_BYTES.
 * Evicting old dirs is safe because symlinks point forward (old → new).
 */
function pruneShadowCache(name) {
  const histDir = historyDir(name)
  if (!existsSync(histDir)) return

  let dirs = readdirSync(histDir)
    .filter(d => d.startsWith('shadow-'))
    .sort()  // oldest first (by hash prefix — not perfect, but combined with creation order it works)

  // Use directory mtime for ordering instead
  dirs = dirs.map(d => ({
    name: d,
    path: join(histDir, d),
    mtime: lstatSync(join(histDir, d)).mtimeMs,
  })).sort((a, b) => a.mtime - b.mtime)

  while (shadowCacheSize(name) > MAX_CACHE_BYTES && dirs.length > 1) {
    const oldest = dirs.shift()
    rmSync(oldest.path, { recursive: true, force: true })
  }
}

/**
 * Get the shadow repo directory path (for direct git commands like diff).
 */
export function getShadowRepoDir(name) {
  return shadowRepoDir(name)
}
