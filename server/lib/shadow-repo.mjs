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
const _execAsyncRaw = promisify(execCb)
const execAsync = (cmd, opts = {}) => _execAsyncRaw(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, cpSync, rmSync, symlinkSync, lstatSync, statSync } from 'fs'
import { readdir as readdirAsync, rm as rmAsync, cp as cpAsync } from 'fs/promises'
import { join, relative, basename, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts')

// Ensure TeX binaries are on PATH (launchd doesn't inherit shell PATH).
for (const texbin of ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/x86_64-linux', '/usr/local/texlive/2025/bin/x86_64-linux']) {
  try {
    if (!process.env.PATH?.includes(texbin) && statSync(texbin).isDirectory()) {
      process.env.PATH = `${texbin}:${process.env.PATH || '/usr/bin:/bin'}`
    }
  } catch {}
}

// Protected compare refs — exempt from pruning while a compare is active.
// Set by the MCP doc_compare handler, cleared when compare is dismissed.
const _compareRefs = new Map()
export function setCompareRef(projectName, hash7) {
  if (hash7) _compareRefs.set(projectName, hash7)
  else _compareRefs.delete(projectName)
}
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { projectDir, sourceDir, outputDir, readProject } from './project-store.mjs'

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

export async function createShadowBundleBase64(name, hash) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) {
    throw new Error(`Shadow repo not found for ${name}`)
  }
  const safeHash = String(hash || '').trim()
  if (!/^[0-9a-f]{40}$/i.test(safeHash)) {
    throw new Error(`Invalid shadow hash for ${name}: ${hash}`)
  }
  await execAsync(`git cat-file -e "${safeHash}^{commit}"`, { cwd: repoDir, timeout: 5000 })
  const bundlePath = join(tmpdir(), `tlda-shadow-${name}-${safeHash.slice(0, 7)}-${Date.now()}.bundle`)
  try {
    await execAsync(`git bundle create "${bundlePath}" --all`, { cwd: repoDir, timeout: 30000 })
    return readFileSync(bundlePath).toString('base64')
  } finally {
    rmSync(bundlePath, { force: true })
  }
}

/**
 * Initialize a shadow repo by filtering an existing project repo down to
 * paper-scope paths only. The filter operation is the canonical way to bring
 * an extant project repo into tlda's world: take its full git history,
 * keep only paths that pdflatex actually opened (plus bibtex + svg
 * augmentation per writeRelevantFiles), drop everything else.
 *
 * Existing dirty shadows are reset by the same operation: caller renames
 * the dirty shadow out of the way (e.g. shadow-repo-dirty), then calls this
 * to produce a clean shadow from the project's working-copy git.
 *
 * Requires `git-filter-repo` on PATH. paperScope is the list of paths
 * (relative to the project repo's root) to keep.
 *
 * Throws on failure. Returns the path of the new shadow repo.
 */
export async function initShadowFromProjectRepo(name, projectRepoPath, paperScope) {
  if (!existsSync(join(projectRepoPath, '.git'))) {
    throw new Error(`Project repo has no .git: ${projectRepoPath}`)
  }
  if (!Array.isArray(paperScope) || paperScope.length === 0) {
    throw new Error('paperScope must be a non-empty list of paths')
  }
  const repoDir = shadowRepoDir(name)
  if (existsSync(repoDir)) {
    throw new Error(`Shadow repo already exists at ${repoDir} — rename or delete first`)
  }

  // Clone the project repo to the shadow location (file:// transport copies
  // history; --no-local would skip hardlinks but we don't need that).
  await execAsync(
    `git clone --no-local "${projectRepoPath}" "${repoDir}"`,
    { timeout: 120000 }
  )

  // Filter the clone to keep only paper-scope paths. git-filter-repo refuses
  // to run on a non-fresh clone by default — pass --force.
  const pathArgs = paperScope.map(p => `--path "${p.replace(/"/g, '\\"')}"`).join(' ')
  await execAsync(
    `git-filter-repo ${pathArgs} --force`,
    { cwd: repoDir, timeout: 600000 }
  )

  // Set local identity so subsequent commitSnapshot calls work.
  await execAsync('git config user.email "tlda@local"', { cwd: repoDir, timeout: 5000 })
  await execAsync('git config user.name "tlda"', { cwd: repoDir, timeout: 5000 })

  // Drop the origin remote that filter-repo leaves behind — the shadow
  // shouldn't track upstream.
  try { await execAsync('git remote remove origin', { cwd: repoDir, timeout: 5000 }) } catch {}

  return repoDir
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

  const claudeMd = `# DO NOT WRITE HERE\n\nThis directory is a server-managed mirror of the paper's source files.\n\n**Do not commit changes here.** Write in your project directory instead\n(e.g. \`~/work/${name}/\`). Use the MCP \`push\` or \`input_scratch\`\ntools to send changes to the server.\n\nChanges committed directly here **do not trigger builds** and will be\n**overwritten by the next successful build**.\n\nOnly touch this repo if the build pipeline itself has broken badly and you\nare debugging the server infrastructure directly.\n`
  writeFileSync(join(repoDir, 'CLAUDE.md'), claudeMd)

  const commitMsgHook = `#!/bin/sh\n# Block agent commits to shadow repo — only the server's commitSnapshot should write here.\nmsg=$(cat "$1")\nif ! echo "$msg" | grep -qE "^Build at "; then\n  echo "ERROR: Direct commits to this shadow repo are blocked." >&2\n  echo "Write your changes in your project source directory instead." >&2\n  echo "See CLAUDE.md in this repo for details." >&2\n  exit 1\nfi\n`
  await execAsync('git add .gitignore CLAUDE.md && git commit -m "init"', { cwd: repoDir, timeout: 10000 })

  const hookPath = join(repoDir, '.git', 'hooks', 'commit-msg')
  writeFileSync(hookPath, commitMsgHook, { mode: 0o755 })

  return repoDir
}

/**
 * Read the paper-scope set from output/relevant-files.json.
 * Returns paths relative to srcDir, or null if relevant-files.json doesn't
 * exist or yields no files inside srcDir (callers should treat as bootstrap).
 *
 * The set is whatever pdflatex actually opened during the build (via the
 * .fls recorder), augmented in writeRelevantFiles() with bibtex inputs
 * (.bib/.bst) and svg siblings of pdf figures. Build artifacts are
 * filtered here.
 */
const BUILD_ARTIFACT_RE = /\.(aux|log|toc|bbl|blg|fls|fdb_latexmk|out|synctex\.gz|nav|snm|vrb|dvi|lof|lot|bcf|run\.xml)$/

export function readPaperScope(name) {
  const relPath = join(outputDir(name), 'relevant-files.json')
  if (!existsSync(relPath)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(relPath, 'utf8'))
  } catch (e) {
    throw new Error(`paper scope is corrupt (${relPath}): ${e.message}`)
  }
  const files = Array.isArray(parsed?.files) ? parsed.files : []
  const srcDir = sourceDir(name)
  const out = new Set()
  for (const p of files) {
    if (typeof p !== 'string') continue
    if (!p.startsWith(srcDir + '/')) continue
    const rel = p.slice(srcDir.length + 1)
    if (BUILD_ARTIFACT_RE.test(rel)) continue
    if (existsSync(join(srcDir, rel))) out.add(rel)
  }
  return out.size === 0 ? null : [...out].sort()
}

export async function readShadowSourceScope(name) {
  const out = new Set(readPaperScope(name) || [])
  const repoDir = shadowRepoDir(name)
  if (existsSync(join(repoDir, '.git'))) {
    const { stdout: commitsRaw } = await execAsync('git log --format=%H', { cwd: repoDir, timeout: 10000 })
    const commits = commitsRaw.split('\n').map(line => line.trim()).filter(Boolean)
    for (const commit of commits) {
      const { stdout: filesRaw } = await execAsync(`git ls-tree -rz --name-only "${commit}"`, { cwd: repoDir, timeout: 10000 })
      for (const rel of filesRaw.split('\0')) {
        if (!rel || rel === '.gitignore' || rel === 'CLAUDE.md') continue
        if (BUILD_ARTIFACT_RE.test(rel)) continue
        out.add(rel)
      }
    }
  }
  return out.size === 0 ? null : [...out].sort()
}

/**
 * Commit paper-scope source files to shadow repo. Returns { hash, timestamp }.
 *
 * What "paper-scope" means: the files pdflatex actually opened during the
 * build (from the .fls recorder), augmented with bibtex inputs and svg
 * figure sources. Build artifacts (.aux/.log/etc.) are filtered out.
 *
 * Source of truth: output/relevant-files.json (written by writeRelevantFiles
 * in build-runner.mjs at the end of every successful build). If that file
 * is missing — first build hasn't completed, or relevant-files generation
 * failed — we skip the snapshot rather than fall back to copy-everything.
 *
 * Returns null if nothing changed or paper-scope is unavailable.
 */
export async function commitSnapshot(name) {
  const repoDir = await initShadowRepo(name)
  const srcDir = sourceDir(name)

  if (!existsSync(srcDir)) {
    throw new Error(`Source directory not found: ${srcDir}`)
  }

  const scope = readPaperScope(name)
  if (!scope) {
    // No paper-scope yet — first build hasn't produced relevant-files.json,
    // or augmentation failed. Skip rather than fall back to copy-everything
    // (which would re-introduce the bug class this whole change is fixing).
    return null
  }

  // Clear existing non-.git, non-.gitignore content from the shadow repo.
  // We rebuild from scope to handle removals, renames, etc. uniformly.
  // Async fs avoids blocking the event loop on large source trees.
  const repoEntries = await readdirAsync(repoDir)
  await Promise.all(
    repoEntries
      .filter((entry) => entry !== '.git' && entry !== '.gitignore')
      .map((entry) => rmAsync(join(repoDir, entry), { recursive: true, force: true })),
  )

  // Copy each paper-scope file from src into the shadow repo, preserving
  // directory structure. mkdir each dirname first since cp is per-file.
  await Promise.all(
    scope.map(async (rel) => {
      const from = join(srcDir, rel)
      const to = join(repoDir, rel)
      mkdirSync(dirname(to), { recursive: true })
      await cpAsync(from, to)
    }),
  )

  // Step 3: stage all changes (additions, modifications, deletions).
  await execAsync('git add -A', { cwd: repoDir, timeout: 10000 })

  // Nothing changed? Don't make an empty commit.
  try {
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoDir, timeout: 5000 })
    if (!status.trim()) return null
  } catch {}

  const timestamp = new Date().toISOString()
  const message = `Build at ${timestamp}`
  await execAsync(`git commit -m "${message}"`, { cwd: repoDir, timeout: 15000 })

  const { stdout: hash } = await execAsync('git rev-parse HEAD', { cwd: repoDir, timeout: 5000 })
  return { hash: hash.trim(), timestamp }
}

/**
 * Return the current shadow HEAD version, or null if the shadow repo has no
 * committed version yet.
 */
export async function currentVersion(name) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return null

  try {
    const { stdout } = await execAsync(
      'git log --format="%H %at %s" -n 1',
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
 * Get the oldest and newest build timestamps. Used to set the time-axis
 * range for the history scrubber without transferring the full version list.
 */
export async function getTimeBounds(name) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return null

  try {
    // Newest: most recent commit (default git log order)
    // Oldest: root commit — use rev-list with --max-parents=0 to find the
    // initial commit, since `git log --reverse -n 1` selects before reversing
    // and still returns the newest commit.
    const newestResult = await execAsync(
      `git log --format="%H %at" -n 1`,
      { cwd: repoDir, timeout: 10000 },
    )
    const rootHashResult = await execAsync(
      `git rev-list --max-parents=0 HEAD`,
      { cwd: repoDir, timeout: 10000 },
    )
    const rootHash = rootHashResult.stdout.trim().split('\n')[0]
    const oldestResult = rootHash
      ? await execAsync(`git log --format="%H %at" -n 1 "${rootHash}"`, { cwd: repoDir, timeout: 10000 })
      : newestResult

    const parseEntry = (stdout) => {
      const line = stdout.trim()
      if (!line) return null
      const [hash, unixTime] = line.split(' ')
      return { hash, timestamp: parseInt(unixTime, 10) * 1000 }
    }
    const newest = parseEntry(newestResult.stdout)
    const oldest = parseEntry(oldestResult.stdout)
    if (!newest || !oldest) return null
    return { newest, oldest }
  } catch {
    return null
  }
}

/**
 * Get the build immediately adjacent to a known hash.
 * dir='older' → the build just before this one in time.
 * dir='newer' → the build just after this one in time.
 * Returns null if already at the boundary.
 */
export async function adjacentVersion(name, hash, dir) {
  const repoDir = shadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return null

  try {
    const { stdout: tsOut } = await execAsync(
      `git log --format="%at" -n 1 "${hash}"`,
      { cwd: repoDir, timeout: 10000 },
    )
    const ts = parseInt(tsOut.trim(), 10)
    if (isNaN(ts)) return null

    let result
    if (dir === 'older') {
      const before = new Date((ts - 1) * 1000).toISOString()
      result = await execAsync(
        `git log --format="%H %at" --before="${before}" -n 1`,
        { cwd: repoDir, timeout: 10000 },
      )
    } else {
      const after = new Date((ts + 1) * 1000).toISOString()
      result = await execAsync(
        `git log --format="%H %at" --after="${after}" --reverse -n 1`,
        { cwd: repoDir, timeout: 10000 },
      )
    }

    const line = result.stdout.trim()
    if (!line) return null
    const [adjHash, adjTs] = line.split(' ')
    return { hash: adjHash, timestamp: parseInt(adjTs, 10) * 1000 }
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

  const svgs = readdirSync(outDir).filter(f => /page-\d+\.svg$/.test(f))
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

  // Exempt the actively-compared version from pruning.
  // The compare ref is set by setCompareRef() (called from the MCP tool handler).
  const protectedHash = _compareRefs.get(name) || null

  let dirs = readdirSync(histDir)
    .filter(d => d.startsWith('shadow-'))

  // Use directory mtime for ordering instead of hash prefix
  dirs = dirs.map(d => ({
    name: d,
    path: join(histDir, d),
    mtime: lstatSync(join(histDir, d)).mtimeMs,
  })).sort((a, b) => a.mtime - b.mtime)

  while (shadowCacheSize(name) > MAX_CACHE_BYTES && dirs.length > 1) {
    const oldest = dirs[0]
    // Don't prune the actively-compared version
    if (protectedHash && oldest.name === `shadow-${protectedHash}`) {
      dirs.shift()
      continue
    }
    dirs.shift()
    rmSync(oldest.path, { recursive: true, force: true })
  }
}

/**
 * Get the shadow repo directory path (for direct git commands like diff).
 */
export function getShadowRepoDir(name) {
  return shadowRepoDir(name)
}

// ── On-demand shadow page generation ─────────────────────────────────────────

// Active DVI compiles: "name:hash7" → Promise<void>
// First request for a hash7 starts the compile; all subsequent requests wait on the same promise.
const _activeDviBuilds = new Map()

// Single source of truth for the historical-build pretex. Used by every
// shadow compile path so they can't drift apart (they used to each carry
// their own copy — one even omitted the hyperref hook).
export const SHADOW_PRETEX = '\\PassOptionsToPackage{draft}{graphics}\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}'

/**
 * Compile a checked-out historical source tree to a DVI — the ONE place that
 * runs latexmk for a shadow/historical version. Directory-aware: latexmk runs
 * in the directory that actually contains the main tex, because `mainFile` may
 * live in a subdirectory (e.g. `revision/supplementary_appendix.tex`). The
 * live build (`build-runner.compileLaTeX`) already does this via its texDir;
 * the shadow paths used to hardcode the checkout root, which silently produced
 * no DVI for any subdir-main doc.
 *
 * Fails LOUD: if no DVI is produced it throws with the tail of the latexmk log
 * (or the exec error). Callers must NOT swallow this — a blank shadow column
 * is exactly the failure mode we're eliminating.
 *
 * @param {{ srcDir: string, mainFile: string }} args
 *   srcDir  — root of the checked-out source tree
 *   mainFile — repo-relative path to the main tex (may include a subdir)
 * @returns {{ texBase, compileDir, dviPath, synctexPath, logPath }}
 */
export async function compileHistoricalDvi({ srcDir, mainFile }) {
  const texBase = basename(mainFile, '.tex')
  const compileDir = join(srcDir, dirname(mainFile))

  // The doc's preamble does \input{.tlda/scratch/scratch-template}. In a live
  // build, build-runner injects its own scratch-template into buildDir (first
  // on TEXINPUTS), so that path is a build artifact and is deliberately kept
  // OUT of the paper scope / shadow repo. That means a historical checkout may
  // not contain scratch-template at all (older commits) — and the versions
  // that do contain it carry the author's marker version, whose \inputscratch
  // pulls in scratch CONTENT files that were never versioned either. Both cases
  // break the historical compile. Mirror the live build's injection, but as a
  // no-op: define \inputscratch to expand to nothing so the paper itself
  // compiles and renders its real text; scratch sections are simply omitted
  // from historical views (their content isn't versioned anyway).
  try {
    const scratchDir = join(compileDir, '.tlda', 'scratch')
    mkdirSync(scratchDir, { recursive: true })
    writeFileSync(
      join(scratchDir, 'scratch-template.tex'),
      '% historical no-op scratch-template (shadow build override)\n' +
      '\\newcommand{\\inputscratch}[3]{}\n',
    )
  } catch (e) {
    // Non-fatal: if we can't write the override, the compile below will fail
    // loud on the missing \input. Surface why so it's diagnosable.
    console.warn(`[shadow] could not write scratch-template override in ${compileDir}: ${e.message}`)
  }

  let execErr = null
  try {
    await execAsync(
      `latexmk -dvi -synctex=1 -f -interaction=nonstopmode -pretex='${SHADOW_PRETEX}' "${texBase}.tex"`,
      { cwd: compileDir, timeout: 180000 },
    )
  } catch (e) { execErr = e }

  const dviPath = join(compileDir, `${texBase}.dvi`)
  const logPath = join(compileDir, `${texBase}.log`)
  if (!existsSync(dviPath)) {
    let detail
    if (existsSync(logPath)) {
      detail = readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n')
    } else {
      detail = execErr?.message || 'latexmk produced no log and no DVI'
    }
    throw new Error(
      `Historical LaTeX compile produced no DVI (cwd=${compileDir}, main=${mainFile}):\n${detail}`,
    )
  }

  const synctexPath = join(compileDir, `${texBase}.synctex.gz`)
  return {
    texBase,
    compileDir,
    dviPath,
    synctexPath: existsSync(synctexPath) ? synctexPath : null,
    logPath: existsSync(logPath) ? logPath : null,
  }
}

/**
 * Compile shadow source at hash7 to a DVI file cached at
 * history/shadow-{hash7}/<texBase>.dvi. No-op if DVI already exists.
 * Serializes concurrent callers for the same hash7.
 */
export async function ensureShadowDvi(name, hash7) {
  const project = readProject(name)
  const mainFile = project?.mainFile || 'main.tex'
  const texBase = basename(mainFile, '.tex')

  const cacheDir = join(historyDir(name), `shadow-${hash7}`)
  const dviFile = join(cacheDir, `${texBase}.dvi`)
  if (existsSync(dviFile)) return

  const key = `${name}:${hash7}`
  if (!_activeDviBuilds.has(key)) {
    const promise = (async () => {
      if (existsSync(dviFile)) return

      console.log(`[shadow] Compiling ${name}@${hash7}...`)
      const tmpSrc = await checkoutSource(name, hash7)
      try {
        mkdirSync(cacheDir, { recursive: true })
        // Directory-aware, loud-on-failure compile (shared with ensure.mjs).
        const { dviPath, synctexPath, logPath } = await compileHistoricalDvi({ srcDir: tmpSrc, mainFile })
        copyFileSync(dviPath, dviFile)

        let pages = null
        if (logPath && existsSync(logPath)) {
          const m = readFileSync(logPath, 'utf8').match(/Output written on .+?\((\d+) pages?\)/)
          if (m) pages = parseInt(m[1], 10)
        }
        writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify({ pages, hash7, compiledAt: Date.now() }))
        console.log(`[shadow] DVI ready: ${name}@${hash7} (${pages ?? '?'} pages)`)

        const lookupPath = join(cacheDir, `${texBase}-lookup.json`)
        if (synctexPath && !existsSync(lookupPath)) {
          try {
            const texFilePath = join(tmpSrc, mainFile)
            await execAsync(
              `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${texFilePath}" "${lookupPath}"`,
              { timeout: 30000 },
            )
            // Save synctex.gz alongside lookup so ensure recipes find it.
            copyFileSync(synctexPath, join(cacheDir, `${texBase}.synctex.gz`))
            console.log(`[shadow] ${texBase}-lookup.json ready for ${name}@${hash7}`)
          } catch (e) {
            console.warn(`[shadow] lookup generation failed for ${name}@${hash7}:`, e.message)
          }
        }
      } finally {
        rmSync(tmpSrc, { recursive: true, force: true })
      }
    })()
    _activeDviBuilds.set(key, promise)
    promise.finally(() => {
      if (_activeDviBuilds.get(key) === promise) _activeDviBuilds.delete(key)
    })
  }

  await _activeDviBuilds.get(key)
}

/**
 * Build and return the path to a shadow history page SVG.
 * Cascade: cached SVG → generate from cached DVI → compile DVI then generate.
 * Throws if the page cannot be produced.
 */
export async function buildShadowPage(name, hash7, pageNum) {
  const { ensure, historicalCtx } = await import('./ensure.mjs')
  const project = readProject(name)
  const texBase = basename(project?.mainFile || 'main.tex', '.tex')
  const ctx = historicalCtx(name, hash7, texBase)
  return ensure(ctx, `${texBase}-page-${pageNum}.svg`)
}

export async function buildCurrentPage(name, pageNum, texBase) {
  const { ensure, currentCtx } = await import('./ensure.mjs')
  if (!texBase) {
    const project = readProject(name)
    texBase = basename(project?.mainFile || 'main.tex', '.tex')
  }
  const ctx = currentCtx(name, texBase)
  return ensure(ctx, `${texBase}-page-${pageNum}.svg`)
}
