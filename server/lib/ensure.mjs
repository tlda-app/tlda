/**
 * ensure.mjs — make-like lazy build system for tlda.
 *
 * ensure(ctx, target) builds `target` if it is missing or stale relative to
 * its declared dependencies, recursively ensuring deps first. Concurrent
 * callers for the same (name, version, target) share one in-flight promise.
 *
 * ctx = {
 *   name,      // project name
 *   version,   // null = current live version | hash7 = frozen historical snapshot
 *   texBase,   // basename of this target's .tex file (e.g. 'arXiv_v2')
 *   outDir,    // directory where artifacts are read/written
 *   srcDir,    // source dir (current version only; null for historical)
 * }
 *
 * Targets are filenames inside ctx.outDir. All target filenames carry the
 * texBase prefix — there is no "main.dvi" or bare "page-N.svg":
 *
 *   <texBase>.dvi          — LaTeX compilation
 *   <texBase>.synctex.gz   — produced alongside the DVI
 *   <texBase>-page-N.svg   — dvisvgm for page N
 *   <texBase>-lookup.json  — synctex → line-label lookup table
 *   <texBase>-macros.json  — preamble macro extraction
 *
 * Staleness counterpart for the live version: output/build.stamp, written
 * by runBuild on success. Compared against source.stamp.
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
import { fileURLToPath } from 'url'

import { projectDir, outputDir, sourceDir, readProject } from './project-store.mjs'

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts')

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Absolute path to an artifact within ctx.outDir. */
export function artifactPath(ctx, target) {
  return join(ctx.outDir, target)
}

/** source.stamp path — touched by the daemon push handler when source changes. */
function stampPath(name) {
  return join(projectDir(name), 'source.stamp')
}

/** build.stamp path — touched by runBuild on each successful build. */
function buildStampPath(name) {
  return join(outputDir(name), 'build.stamp')
}

// ─── Target name decoding ───────────────────────────────────────────────────

/**
 * Decode a target filename into { texBase, kind, pageNum? }. Returns null if
 * the name doesn't match any known pattern. Recipes use this to derive deps.
 */
function decodeTarget(target) {
  let m
  if ((m = target.match(/^(.+)-page-(\d+)\.svg$/))) {
    return { texBase: m[1], kind: 'svg', pageNum: parseInt(m[2], 10) }
  }
  if ((m = target.match(/^(.+)-lookup\.json$/))) {
    return { texBase: m[1], kind: 'lookup' }
  }
  if ((m = target.match(/^(.+)-macros\.json$/))) {
    return { texBase: m[1], kind: 'macros' }
  }
  if ((m = target.match(/^(.+)\.synctex\.gz$/))) {
    return { texBase: m[1], kind: 'synctex' }
  }
  if ((m = target.match(/^(.+)\.dvi$/))) {
    return { texBase: m[1], kind: 'dvi' }
  }
  return null
}

// ─── Staleness ───────────────────────────────────────────────────────────────

/**
 * Returns true if `target` needs to be (re)built.
 *
 * Rules:
 *  1. Target file missing → stale.
 *  2. Any dep file newer than target → stale.
 *  3. Live version: if source.stamp is newer than build.stamp, the whole
 *     build is stale (any DVI artifact rebuilds).
 */
function isStale(ctx, target, deps) {
  const tp = artifactPath(ctx, target)
  if (!existsSync(tp)) return true

  const tMtime = statSync(tp).mtimeMs

  for (const dep of deps) {
    const dp = artifactPath(ctx, dep)
    if (!existsSync(dp)) return true
    if (statSync(dp).mtimeMs > tMtime) return true
  }

  const decoded = decodeTarget(target)

  // Live version: source.stamp newer than build.stamp drives DVI staleness.
  if (!ctx.version && decoded?.kind === 'dvi') {
    const sp = stampPath(ctx.name)
    const bp = buildStampPath(ctx.name)
    const buildMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0
    if (existsSync(sp) && statSync(sp).mtimeMs > buildMtime) return true
  }

  // Historical versions: synctex.gz and lookup.json are produced atomically
  // by buildHistoricalDvi (which has access to source). A deficient lookup
  // forces a full recompile. Staleness propagates through dvi → synctex →
  // lookup so any consumer triggers the full chain.
  const LOOKUP_VERSION = 2
  if (ctx.version && decoded && (decoded.kind === 'dvi' || decoded.kind === 'synctex')) {
    const synctex = `${decoded.texBase}.synctex.gz`
    const lookup = `${decoded.texBase}-lookup.json`
    if (!existsSync(artifactPath(ctx, synctex))) return true
    const lookupPath = artifactPath(ctx, lookup)
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

const _inflight = new Map()

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

  const deps = recipe.deps(target)

  await Promise.all(deps.map(dep => ensure(ctx, dep)))

  if (!isStale(ctx, target, deps)) return artifactPath(ctx, target)

  await recipe.build(ctx, target)
  return artifactPath(ctx, target)
}

// ─── Recipes ─────────────────────────────────────────────────────────────────

function findRecipe(target) {
  for (const r of RECIPES) {
    if (r.match.test(target)) return r
  }
  return null
}

const RECIPES = [
  // ── <texBase>.dvi ─────────────────────────────────────────────────────────
  // Live: handed off to runBuild which builds the entire project.
  // Historical: compiled in isolation from a checkout of the shadow source.
  {
    match: /^.+\.dvi$/,
    deps: () => [],
    build: async (ctx) => {
      if (ctx.version) {
        await buildHistoricalDvi(ctx)
      } else {
        await buildCurrentDvi(ctx)
      }
    },
  },

  // ── <texBase>.synctex.gz ──────────────────────────────────────────────────
  {
    match: /^.+\.synctex\.gz$/,
    deps: (target) => {
      const { texBase } = decodeTarget(target)
      return [`${texBase}.dvi`]
    },
    build: async (ctx, target) => {
      const synctex = artifactPath(ctx, target)
      if (!existsSync(synctex)) {
        throw new Error(`[ensure] ${target} not produced for ${ctx.name}`)
      }
    },
  },

  // ── <texBase>-page-N.svg ──────────────────────────────────────────────────
  {
    match: /^.+-page-\d+\.svg$/,
    deps: (target) => {
      const { texBase } = decodeTarget(target)
      return [`${texBase}.dvi`]
    },
    build: async (ctx, target) => {
      const { pageNum } = decodeTarget(target)
      await buildSvgPage(ctx, pageNum, target)
    },
  },

  // ── <texBase>-lookup.json ─────────────────────────────────────────────────
  {
    match: /^.+-lookup\.json$/,
    deps: (target) => {
      const { texBase } = decodeTarget(target)
      return [`${texBase}.synctex.gz`]
    },
    build: async (ctx, target) => {
      await buildLookup(ctx, target)
    },
  },

  // ── <texBase>-macros.json ─────────────────────────────────────────────────
  {
    match: /^.+-macros\.json$/,
    deps: (target) => {
      const { texBase } = decodeTarget(target)
      return [`${texBase}.dvi`]
    },
    build: async (ctx, target) => {
      await buildMacros(ctx, target)
    },
  },
]

// ─── Build steps ─────────────────────────────────────────────────────────────

/**
 * Live version: trigger a full runBuild. Dynamic import breaks the cycle
 * ensure.mjs → build-runner.mjs → shadow-repo.mjs → ensure.mjs.
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
  const { checkoutSource, compileHistoricalDvi } = await import('./shadow-repo.mjs')

  const texBase = ctx.texBase
  // The main tex may live in a subdirectory (e.g. revision/foo.tex). For
  // multi-target builds the target's basename may differ from the project's
  // primary mainFile, in which case it sits at the checkout root as
  // <texBase>.tex (mirrors buildLookup's logic).
  const project = readProject(ctx.name)
  const mainFile = project?.mainFile && basename(project.mainFile, '.tex') === texBase
    ? project.mainFile
    : `${texBase}.tex`

  console.log(`[ensure] Compiling ${ctx.name}@${ctx.version}...`)
  mkdirSync(ctx.outDir, { recursive: true })

  const tmpSrc = await checkoutSource(ctx.name, ctx.version)
  try {
    // Directory-aware, loud-on-failure compile (shared with shadow-repo).
    const { dviPath, synctexPath } = await compileHistoricalDvi({ srcDir: tmpSrc, mainFile })

    copyFileSync(dviPath, artifactPath(ctx, `${texBase}.dvi`))

    if (synctexPath) {
      copyFileSync(synctexPath, artifactPath(ctx, `${texBase}.synctex.gz`))
    }

    const srcTexFile = join(tmpSrc, mainFile)
    const lookupPath = artifactPath(ctx, `${texBase}-lookup.json`)
    if (synctexPath && existsSync(srcTexFile)) {
      try {
        await execAsync(
          `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${srcTexFile}" "${lookupPath}"`,
          { timeout: 30000 },
        )
        console.log(`[ensure] ${texBase}-lookup.json ready for ${ctx.name}@${ctx.version}`)
      } catch (e) {
        console.warn(`[ensure] lookup extraction failed for ${ctx.name}@${ctx.version}: ${e.message.split('\n')[0]}`)
      }
    }

    let pages = null
    const logPath = join(tmpSrc, dirname(mainFile), `${texBase}.log`)
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

/** Run dvisvgm for one page → ctx.outDir/<texBase>-page-N.svg. */
async function buildSvgPage(ctx, pageNum, target) {
  const { texBase } = decodeTarget(target)
  const dviFile = artifactPath(ctx, `${texBase}.dvi`)
  const svgFile = artifactPath(ctx, target)
  const tmpSvg = svgFile + '.tmp'

  await execAsync(
    `dvisvgm --page=${pageNum} --font-format=woff2 --bbox=papersize --linkmark=none ` +
    `--output="${tmpSvg}" "${dviFile}"`,
    { cwd: ctx.outDir, timeout: 30000 },
  )
  if (!existsSync(tmpSvg)) throw new Error(`dvisvgm did not produce page-${pageNum} for ${ctx.name}/${texBase}`)
  renameSync(tmpSvg, svgFile)

  if (ctx.srcDir) {
    try {
      await execAsync(
        `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${ctx.outDir}" "${ctx.srcDir}"`,
        { timeout: 60000 },
      )
    } catch (e) {
      console.warn(`[ensure] image patching failed for ${ctx.name} ${texBase} p${pageNum}: ${e.message.split('\n')[0]}`)
    }
  }
}

/** Extract lookup.json from <texBase>.synctex.gz. */
async function buildLookup(ctx, target) {
  const { texBase } = decodeTarget(target)
  const project = readProject(ctx.name)
  // For multi-target, the target's mainFile may be a sibling of the
  // primary mainFile. We assume <texBase>.tex exists at outDir-relative
  // root (mirrors the source layout for sibling targets).
  const mainFile = project?.mainFile && basename(project.mainFile, '.tex') === texBase
    ? project.mainFile
    : `${texBase}.tex`
  const synctexFile = artifactPath(ctx, `${texBase}.synctex.gz`)
  const lookupPath = artifactPath(ctx, target)

  // The extractor expects the .tex file alongside the synctex. Write a
  // stub at outDir so paths resolve.
  const texStub = join(ctx.outDir, mainFile)
  const texStubDir = dirname(texStub)
  mkdirSync(texStubDir, { recursive: true })

  const stubCreated = !existsSync(texStub)
  if (stubCreated) writeFileSync(texStub, '')

  const synctexDest = join(ctx.outDir, dirname(mainFile), `${texBase}.synctex.gz`)
  const synctexLinked = synctexDest !== synctexFile && !existsSync(synctexDest)
  if (synctexLinked) {
    try { copyFileSync(synctexFile, synctexDest) } catch {}
  }

  try {
    await execAsync(
      `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${texStub}" "${lookupPath}"`,
      { timeout: 30000 },
    )
    console.log(`[ensure] ${target} ready for ${ctx.name}${ctx.version ? '@' + ctx.version : ''}`)
  } finally {
    if (stubCreated) { try { rmSync(texStub) } catch {} }
    if (synctexLinked) { try { rmSync(synctexDest) } catch {} }
  }
}

/** Extract macros.json from the preamble (live version only). */
async function buildMacros(ctx, target) {
  if (!ctx.srcDir) return
  const macrosPath = artifactPath(ctx, target)
  try {
    await execAsync(
      `node "${join(SCRIPTS_DIR, 'extract-preamble.js')}" "${ctx.srcDir}" "${macrosPath}"`,
      { timeout: 30000 },
    )
  } catch (e) {
    console.warn(`[ensure] macros build failed for ${ctx.name}: ${e.message.split('\n')[0]}`)
  }
}

// ─── Context factories ────────────────────────────────────────────────────────

/**
 * Build context for the live version of a project's target.
 * texBase identifies which target — single-target projects pass the project's
 * primary texBase; multi-target projects pass each sibling's texBase.
 */
export function currentCtx(name, texBase) {
  if (!texBase) throw new Error('currentCtx requires texBase')
  return {
    name,
    version: null,
    texBase,
    outDir: outputDir(name),
    srcDir: sourceDir(name),
  }
}

/** Build context for a frozen historical snapshot. */
export function historicalCtx(name, hash7, texBase) {
  if (!texBase) throw new Error('historicalCtx requires texBase')
  return {
    name,
    version: hash7,
    texBase,
    outDir: join(projectDir(name), 'history', `shadow-${hash7}`),
    srcDir: null,
  }
}
