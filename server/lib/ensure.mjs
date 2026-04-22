/**
 * ensure.mjs — make-like lazy build system for tlda.
 *
 * ensure(ctx, target) builds `target` if it is missing or stale relative to
 * its declared dependencies, recursively ensuring deps first.  Concurrent
 * callers for the same (name, version, target) share one in-flight promise.
 *
 * ctx = {
 *   name,      // project name
 *   version,   // null = current live version | hash7 = frozen historical snapshot
 *   outDir,    // directory where artifacts are read/written
 *   srcDir,    // source dir (current version only; null for historical)
 * }
 *
 * Targets recognised:
 *   main.dvi           — LaTeX compilation
 *   main.synctex.gz    — produced alongside main.dvi (same build step)
 *   page-N.svg         — dvisvgm for page N
 *   lookup.json        — synctex → line-label lookup table
 *   macros.json        — preamble macro extraction
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
const _execRaw = promisify(execCb)
const execAsync = (cmd, opts = {}) => _execRaw(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })

import {
  existsSync, statSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, renameSync, rmSync,
} from 'fs'
import { join, basename, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { projectDir, outputDir, sourceDir, readProject } from './project-store.mjs'

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts')

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Absolute path to an artifact within ctx.outDir. */
export function artifactPath(ctx, target) {
  return join(ctx.outDir, target)
}

/** source.stamp path — only meaningful for the current (live) version. */
function stampPath(name) {
  return join(projectDir(name), 'source.stamp')
}

// ─── Staleness ───────────────────────────────────────────────────────────────

/**
 * Returns true if `target` needs to be (re)built.
 *
 * Rules:
 *  1. Target file missing → stale.
 *  2. Any dep file newer than target → stale.
 *  3. Current version only: if source.stamp is newer than main.dvi → stale
 *     (source changed since last build).
 */
function isStale(ctx, target, deps) {
  const tp = artifactPath(ctx, target)
  if (!existsSync(tp)) return true

  const tMtime = statSync(tp).mtimeMs

  // Check declared dep files
  for (const dep of deps) {
    const dp = artifactPath(ctx, dep)
    if (!existsSync(dp)) return true
    if (statSync(dp).mtimeMs > tMtime) return true
  }

  // For the live version, source.stamp drives DVI staleness.
  if (!ctx.version && target === 'main.dvi') {
    const sp = stampPath(ctx.name)
    if (existsSync(sp) && statSync(sp).mtimeMs > tMtime) return true
  }

  // For historical versions, synctex.gz and lookup.json are produced atomically
  // by buildHistoricalDvi (which has access to source). A deficient lookup forces a
  // full recompile. We check on both main.dvi AND main.synctex.gz so the staleness
  // propagates correctly through the dep chain (lookup → synctex → dvi → recompile).
  const LOOKUP_VERSION = 2
  if (ctx.version && (target === 'main.dvi' || target === 'main.synctex.gz')) {
    if (!existsSync(artifactPath(ctx, 'main.synctex.gz'))) return true
    const lookupPath = artifactPath(ctx, 'lookup.json')
    if (!existsSync(lookupPath)) return true
    try {
      const data = JSON.parse(readFileSync(lookupPath, 'utf8'))
      if (!data.lines || Object.keys(data.lines).length === 0) return true
      if ((data.meta?.version ?? 1) < LOOKUP_VERSION) return true
    } catch { return true }
  }

  return false
}

// ─── In-flight coalescing ────────────────────────────────────────────────────

const _inflight = new Map()  // key → Promise

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensure `target` exists and is up to date.
 * Returns the absolute path to the artifact.
 */
export async function ensure(ctx, target) {
  const key = `${ctx.name}:${ctx.version ?? 'current'}:${target}`
  if (_inflight.has(key)) return _inflight.get(key)

  const p = _ensureImpl(ctx, target).finally(() => _inflight.delete(key))
  _inflight.set(key, p)
  return p
}

async function _ensureImpl(ctx, target) {
  const recipe = findRecipe(target)
  if (!recipe) throw new Error(`[ensure] No recipe for target: ${target}`)

  const deps = recipe.deps(ctx)

  // Ensure all deps (parallel where independent)
  await Promise.all(deps.map(dep => ensure(ctx, dep)))

  if (!isStale(ctx, target, deps)) return artifactPath(ctx, target)

  await recipe.build(ctx, target)
  return artifactPath(ctx, target)
}

// ─── Recipes ─────────────────────────────────────────────────────────────────

function findRecipe(target) {
  for (const r of RECIPES) {
    if (typeof r.match === 'string' ? r.match === target : r.match.test(target)) {
      return r
    }
  }
  return null
}

const RECIPES = [
  // ── main.dvi ──────────────────────────────────────────────────────────────
  // Produced by LaTeX compilation.  For historical versions, also produces
  // main.synctex.gz (saved to outDir).  For the current version, synctex is
  // managed by the full runBuild pipeline in build-runner.mjs.
  {
    match: 'main.dvi',
    deps: () => [],   // staleness is driven by isStale() directly (source.stamp)
    build: async (ctx) => {
      if (ctx.version) {
        await buildHistoricalDvi(ctx)
      } else {
        await buildCurrentDvi(ctx)
      }
    },
  },

  // ── main.synctex.gz ───────────────────────────────────────────────────────
  // Side-effect of main.dvi — same build step.
  {
    match: 'main.synctex.gz',
    deps: () => [],
    build: async (ctx) => {
      // Building main.dvi produces main.synctex.gz as a side-effect.
      await ensure(ctx, 'main.dvi')
      // After main.dvi is built, synctex.gz should exist.
      if (!existsSync(artifactPath(ctx, 'main.synctex.gz'))) {
        throw new Error(`[ensure] main.synctex.gz not produced for ${ctx.name}`)
      }
    },
  },

  // ── page-N.svg ────────────────────────────────────────────────────────────
  {
    match: /^page-(\d+)\.svg$/,
    deps: () => ['main.dvi'],
    build: async (ctx, target) => {
      const pageNum = parseInt(target.match(/\d+/)[0], 10)
      await buildSvgPage(ctx, pageNum, target)
    },
  },

  // ── lookup.json ───────────────────────────────────────────────────────────
  {
    match: 'lookup.json',
    deps: () => ['main.synctex.gz'],
    build: async (ctx) => {
      await buildLookup(ctx)
    },
  },

  // ── macros.json ───────────────────────────────────────────────────────────
  {
    match: 'macros.json',
    deps: () => ['main.dvi'],
    build: async (ctx) => {
      await buildMacros(ctx)
    },
  },
]

// ─── Build steps ─────────────────────────────────────────────────────────────

/**
 * Current version: trigger a full runBuild (which handles LaTeX, signals,
 * post-processing).  Uses dynamic import to break the circular dep:
 *   ensure.mjs → build-runner.mjs → shadow-repo.mjs → ensure.mjs
 */
async function buildCurrentDvi(ctx) {
  const { runBuild, emitDocArrived } = await import('./build-runner.mjs')
  await runBuild(ctx.name)
  const updated = readProject(ctx.name)
  if (updated?.buildStatus === 'success') {
    emitDocArrived?.(ctx.name, updated)
  }
}

/**
 * Historical version: check out source at ctx.version, compile LaTeX,
 * save DVI + synctex.gz to ctx.outDir, extract lookup.json.
 */
async function buildHistoricalDvi(ctx) {
  const { checkoutSource } = await import('./shadow-repo.mjs')

  const project = readProject(ctx.name)
  const mainFile = project?.mainFile || 'main.tex'
  const texBase = basename(mainFile, '.tex')

  console.log(`[ensure] Compiling ${ctx.name}@${ctx.version}...`)
  mkdirSync(ctx.outDir, { recursive: true })

  const tmpSrc = await checkoutSource(ctx.name, ctx.version)
  try {
    // Compile with synctex for downstream lookup.json
    const SHADOW_PRETEX = String.raw`\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{graphics}`
    try {
      await execAsync(
        `latexmk -dvi -synctex=1 -f -interaction=nonstopmode -pretex='${SHADOW_PRETEX}' "${texBase}.tex"`,
        { cwd: tmpSrc, timeout: 180000 },
      )
    } catch { /* check for DVI below */ }

    const srcDvi = join(tmpSrc, `${texBase}.dvi`)
    if (!existsSync(srcDvi)) throw new Error(`LaTeX compile failed for ${ctx.name}@${ctx.version}`)

    copyFileSync(srcDvi, artifactPath(ctx, 'main.dvi'))

    // Save synctex.gz so lookup.json can be derived without re-running LaTeX
    const srcSynctex = join(tmpSrc, `${texBase}.synctex.gz`)
    if (existsSync(srcSynctex)) {
      copyFileSync(srcSynctex, artifactPath(ctx, 'main.synctex.gz'))
    }

    // Extract lookup.json NOW while source files are still present in tmpSrc.
    // The synctex.gz references absolute paths in tmpSrc; once deleted they can't match.
    const srcTexFile = join(tmpSrc, `${texBase}.tex`)
    const lookupPath = artifactPath(ctx, 'lookup.json')
    if (existsSync(srcSynctex) && existsSync(srcTexFile)) {
      try {
        await execAsync(
          `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${srcTexFile}" "${lookupPath}"`,
          { timeout: 30000 },
        )
        console.log(`[ensure] lookup.json ready for ${ctx.name}@${ctx.version}`)
      } catch (e) {
        console.warn(`[ensure] lookup.json extraction failed for ${ctx.name}@${ctx.version}: ${e.message.split('\n')[0]}`)
      }
    }

    // Extract page count and save meta.json
    let pages = null
    const logPath = join(tmpSrc, `${texBase}.log`)
    if (existsSync(logPath)) {
      const raw = readFileSync(logPath, 'utf8')
      const joined = raw.split('\n').reduce((acc, line) => {
        if (acc.length > 0 && acc[acc.length - 1].length === 79) {
          acc[acc.length - 1] += line
        } else {
          acc.push(line)
        }
        return acc
      }, []).join('\n')
      const m = joined.match(/Output written on .+\((\d+) pages?/)
      if (m) pages = parseInt(m[1], 10)
    }
    writeFileSync(
      join(ctx.outDir, 'meta.json'),
      JSON.stringify({ pages, version: ctx.version, compiledAt: Date.now() }),
    )
    console.log(`[ensure] DVI ready: ${ctx.name}@${ctx.version} (${pages ?? '?'} pages)`)
  } finally {
    rmSync(tmpSrc, { recursive: true, force: true })
  }
}

/** Run dvisvgm for one page, output to ctx.outDir/page-N.svg. */
async function buildSvgPage(ctx, pageNum, target) {
  const dviFile = artifactPath(ctx, 'main.dvi')
  const svgFile = artifactPath(ctx, target)
  const tmpSvg = svgFile + '.tmp'

  await execAsync(
    `dvisvgm --page=${pageNum} --font-format=woff2 --bbox=papersize --linkmark=none ` +
    `--output="${tmpSvg}" "${dviFile}"`,
    { cwd: ctx.outDir, timeout: 30000 },
  )
  if (!existsSync(tmpSvg)) throw new Error(`dvisvgm did not produce page-${pageNum} for ${ctx.name}`)
  renameSync(tmpSvg, svgFile)

  // Patch image placeholders (current version only — has srcDir)
  if (ctx.srcDir) {
    try {
      await execAsync(
        `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${ctx.outDir}" "${ctx.srcDir}"`,
        { timeout: 60000 },
      )
    } catch (e) {
      console.warn(`[ensure] image patching failed for ${ctx.name} p${pageNum}: ${e.message.split('\n')[0]}`)
    }
  }
}

/** Extract lookup.json from main.synctex.gz. */
async function buildLookup(ctx) {
  const project = readProject(ctx.name)
  const mainFile = project?.mainFile || 'main.tex'
  const synctexFile = artifactPath(ctx, 'main.synctex.gz')
  const lookupPath = artifactPath(ctx, 'lookup.json')

  // extract-synctex-lookup.mjs expects the .tex file alongside the synctex
  // Write a temporary tex stub to satisfy the path resolver
  const texStub = join(ctx.outDir, mainFile)
  const texStubDir = dirname(texStub)
  mkdirSync(texStubDir, { recursive: true })

  // The script only needs the tex path to locate synctex — write a stub if missing
  const stubCreated = !existsSync(texStub)
  if (stubCreated) writeFileSync(texStub, '')

  // If synctex.gz is not alongside the tex, symlink it there
  const synctexDest = join(ctx.outDir, dirname(mainFile), `${basename(mainFile, '.tex')}.synctex.gz`)
  const synctexLinked = synctexDest !== synctexFile && !existsSync(synctexDest)
  if (synctexLinked) {
    try { copyFileSync(synctexFile, synctexDest) } catch {}
  }

  try {
    await execAsync(
      `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${texStub}" "${lookupPath}"`,
      { timeout: 30000 },
    )
    console.log(`[ensure] lookup.json ready for ${ctx.name}${ctx.version ? '@' + ctx.version : ''}`)
  } finally {
    if (stubCreated) { try { rmSync(texStub) } catch {} }
    if (synctexLinked) { try { rmSync(synctexDest) } catch {} }
  }
}

/** Extract macros.json from the compiled DVI (runs extract-preamble.js). */
async function buildMacros(ctx) {
  // macros.json currently only makes sense for the current version
  // (requires source files alongside the build artifacts)
  if (!ctx.srcDir) return
  const macrosPath = artifactPath(ctx, 'macros.json')
  try {
    await execAsync(
      `node "${join(SCRIPTS_DIR, 'extract-preamble.js')}" "${ctx.srcDir}" "${macrosPath}"`,
      { timeout: 30000 },
    )
  } catch (e) {
    console.warn(`[ensure] macros.json build failed for ${ctx.name}: ${e.message.split('\n')[0]}`)
  }
}

// ─── Context factories ────────────────────────────────────────────────────────

/** Build context for the current (live) version of a project. */
export function currentCtx(name) {
  return {
    name,
    version: null,
    outDir: outputDir(name),
    srcDir: sourceDir(name),
  }
}

/** Build context for a frozen historical snapshot. */
export function historicalCtx(name, hash7) {
  return {
    name,
    version: hash7,
    outDir: join(projectDir(name), 'history', `shadow-${hash7}`),
    srcDir: null,
  }
}
