/**
 * History API routes.
 *
 * Mounted at /api/projects/:name/history by projects.mjs.
 * Provides shadow-repo version history, shadow rendering endpoints, source
 * diffs, checkout/revert, and staleness checks.
 */

import { Router } from 'express'
import { join } from 'path'
import { access, cp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { exec as execCb, execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(execCb)
const execFileAsync = promisify(execFileCb)
import { requireRead, requireRw } from '../lib/auth.mjs'
import { readProject, outputDir, projectDir, sourceDir as getSourceDir, validateSourceFilePath } from '../lib/project-store.mjs'
import { dispatchBuild } from '../lib/build-dispatch.mjs'
import { listVersions, versionAt, checkoutSource, getShadowRepoDir, getTimeBounds, adjacentVersion, ensureShadowDvi } from '../lib/shadow-repo.mjs'
import { ensure, historicalCtx } from '../lib/ensure.mjs'
import { broadcastSignal, putShape } from '../lib/sync-rooms.mjs'
import { loadProofInfo, dryRunInvalidation } from '../lib/invalidation-graph.mjs'

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonOr(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

// ---- Diff highlight helpers (mirrored from mcp-server draw_highlight logic) ----
const _PDF_WIDTH = 612, _TARGET_WIDTH = 800, _PDF_HEIGHT = 792, _PAGE_GAP = 32
const _SCALE = _TARGET_WIDTH / _PDF_WIDTH
const _PAGE_H = _PDF_HEIGHT * _SCALE
const _VBOX = 72  // dvisvgm viewBox offset in PDF points

function _pdfToCanvas(page, pdfX, pdfY) {
  return {
    x: (pdfX + _VBOX) * _SCALE,
    y: (page - 1) * (_PAGE_H + _PAGE_GAP) + (pdfY + _VBOX) * _SCALE,
  }
}

function _toF16(v) {
  if (v === 0) return 0
  if (!isFinite(v)) return v > 0 ? 0x7c00 : 0xfc00
  const s = v < 0 ? 1 : 0; v = Math.abs(v)
  if (v > 65504) return s ? 0xfc00 : 0x7c00
  if (v < 5.96e-8) return s << 15
  const l = Math.log2(v); let e = Math.floor(l), f = v / 2**e - 1
  if (e < -14) { f = v / 2**-14; return (s<<15)|Math.round(f*1024) }
  e += 15; if (e >= 31) return s ? 0xfc00 : 0x7c00
  return (s<<15)|(e<<10)|Math.round(f*1024)
}
function _f16(u) {
  const s = (u>>15) ? -1 : 1, e = (u>>10)&0x1f, f = u&0x3ff
  if (!e) return s * 2**-14 * (f/1024)
  if (e===31) return f ? NaN : s*Infinity
  return s * 2**(e-15) * (1+f/1024)
}
function _encodeB64Path(pts) {
  if (!pts.length) return ''
  const buf = Buffer.alloc(12 + (pts.length-1)*6)
  buf.writeFloatLE(pts[0].x, 0); buf.writeFloatLE(pts[0].y, 4); buf.writeFloatLE(pts[0].z??0.5, 8)
  let px=pts[0].x, py=pts[0].y, pz=pts[0].z??0.5
  for (let i=1; i<pts.length; i++) {
    const dx=pts[i].x-px, dy=pts[i].y-py, dz=(pts[i].z??0.5)-pz, o=12+(i-1)*6
    const dxu=_toF16(dx), dyu=_toF16(dy), dzu=_toF16(dz)
    buf.writeUInt16LE(dxu,o); buf.writeUInt16LE(dyu,o+2); buf.writeUInt16LE(dzu,o+4)
    px+=_f16(dxu); py+=_f16(dyu); pz+=_f16(dzu)
  }
  return buf.toString('base64')
}

/** Extract content of a {…} block starting just after the opening brace. */
function _readBraced(str, start) {
  let depth = 1, i = start
  while (i < str.length && depth > 0) {
    if (str[i] === '{') depth++
    else if (str[i] === '}') { depth--; if (depth === 0) break }
    i++
  }
  return { content: str.slice(start, i), nextI: i + 1 }
}

/**
 * Parse latexdiff output → arrays of changed text strings.
 * Extracts \DIFadd{...} content (added in new) and \DIFdel{...} content (deleted from old).
 */
function _parseDiffOutput(diffText) {
  const addTexts = [], delTexts = []
  let i = 0
  while (i < diffText.length) {
    if (diffText.startsWith('\\DIFadd{', i)) {
      const { content, nextI } = _readBraced(diffText, i + 8)
      if (content.trim()) addTexts.push(content.trim())
      i = nextI
    } else if (diffText.startsWith('\\DIFdel{', i)) {
      const { content, nextI } = _readBraced(diffText, i + 8)
      if (content.trim()) delTexts.push(content.trim())
      i = nextI
    } else {
      i++
    }
  }
  return { addTexts, delTexts }
}

export async function runLatexdiffFiles(oldPath, newPath, opts = {}) {
  try {
    const { stdout } = await execFileAsync(
      'latexdiff',
      ['--math-markup=0', oldPath, newPath],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts },
    )
    return stdout
  } catch (e) {
    if (e?.code === 'ENOENT') {
      const err = new Error('latexdiff is not installed on this server')
      err.status = 503
      err.dependency = 'latexdiff'
      throw err
    }
    throw e
  }
}

/**
 * Search excerptLines for a changed text span. Returns the first matching line's
 * { lineNum, colStart, colEnd, lineLen }, or null if not found.
 */
function _findInExcerpt(excerptLines, firstLineNum, searchText) {
  // Normalize whitespace for matching
  const needle = searchText.replace(/\s+/g, ' ').trim()
  if (needle.length < 2) return null
  for (let k = 0; k < excerptLines.length; k++) {
    const hay = excerptLines[k].replace(/\s+/g, ' ')
    const idx = hay.indexOf(needle)
    if (idx >= 0) {
      return { lineNum: firstLineNum + k, colStart: idx, colEnd: idx + needle.length, lineLen: excerptLines[k].length }
    }
  }
  // Fallback: try first significant word of the needle (handles multi-line or split content)
  const firstWord = needle.split(/\s+/).find(w => w.replace(/[\\{}$]/g, '').length > 3)
  if (firstWord) {
    for (let k = 0; k < excerptLines.length; k++) {
      const idx = excerptLines[k].indexOf(firstWord)
      if (idx >= 0) {
        return { lineNum: firstLineNum + k, colStart: idx, colEnd: idx + firstWord.length, lineLen: excerptLines[k].length }
      }
    }
  }
  return null
}

/** Create a single horizontal highlight shape and write it to the Yjs room. */
async function _createHighlightShape(docName, entry, colStart, colEnd, lineLen, color, xColumnOffset, yColumnOffset, triggerId) {
  const canvas = _pdfToCanvas(entry.page, entry.x, entry.y)
  const fullLeft = canvas.x
  const fullWidth = _TARGET_WIDTH * 0.9 - fullLeft
  if (fullWidth <= 0) return null
  const norm = Math.max(lineLen, 1)
  const xs = fullLeft + xColumnOffset + (colStart / norm) * fullWidth
  const xe = fullLeft + xColumnOffset + (colEnd   / norm) * fullWidth
  const w  = Math.max(xe - xs, 4)
  const shapeId = `shape:diff-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
  await putShape(`doc-${docName}`, {
    id: shapeId, type: 'highlight', typeName: 'shape',
    x: xs, y: canvas.y + yColumnOffset - 3,
    rotation: 0, isLocked: false, opacity: 0.5,
    parentId: 'page:page', index: 'a1',
    props: {
      segments: [{ type: 'free', path: _encodeB64Path([{x:0,y:0,z:0.5},{x:w,y:0,z:0.5}]) }],
      color, size: 's', isComplete: true, isPen: false, scale: 1, scaleX: 1, scaleY: 1,
    },
    meta: { diffTrigger: triggerId, diffType: color.includes('green') ? 'addition' : 'deletion' },
  })
  return shapeId
}

const router = Router({ mergeParams: true })

/**
 * GET /shadow/diff?ref1=<hash>&ref2=<hash> — Diff between two shadow repo refs.
 * ref2 defaults to HEAD if omitted.
 * NOTE: must be defined before /:id/diff or Express routes it as id="shadow".
 */
router.get('/shadow/diff', requireRead, async (req, res) => {
  const { name } = req.params
  const { ref1, ref2 = 'HEAD' } = req.query

  if (!ref1) return res.status(400).json({ error: 'ref1 is required' })

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const repoDir = getShadowRepoDir(name)
  if (!await pathExists(join(repoDir, '.git'))) {
    return res.status(400).json({ error: 'Shadow repo not initialized for this project' })
  }

  try {
    const { stdout } = await execAsync(
      `git diff "${ref1}" "${ref2}"`,
      { cwd: repoDir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
    )
    res.json({ diff: stdout, ref1, ref2 })
  } catch (e) {
    res.status(500).json({ error: `shadow diff failed: ${e.message}` })
  }
})

/**
 * GET /shadow/source?version=<hash>&file=<project-relative-path>
 * Read one source file from the per-project Git history.
 */
router.get('/shadow/source', requireRead, async (req, res) => {
  const { name } = req.params
  const version = String(req.query.version || '')
  const file = String(req.query.file || '')

  if (!/^[0-9a-f]{7,40}$/i.test(version)) {
    return res.status(400).json({ error: 'version must be a Git commit hash' })
  }
  if (!file) return res.status(400).json({ error: 'file is required' })

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    validateSourceFilePath(name, file)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  try {
    const repoDir = getShadowRepoDir(name)
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${version}:${file}`],
      { cwd: repoDir, encoding: 'utf8', timeout: 10000, maxBuffer: 20 * 1024 * 1024 },
    )
    res.json({ project: name, version, file, content: stdout })
  } catch (e) {
    res.status(404).json({ error: `Could not read ${file} at ${version}: ${e.message}` })
  }
})

/**
 * GET /shadow/:hash7/lookup — SyncTeX lookup table for a shadow version.
 * Returns the lookup.json if compiled with synctex, 404 if not available.
 */
router.get('/shadow/:hash7/lookup', requireRead, async (req, res) => {
  const { name, hash7 } = req.params

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  // Use the ensure system: chains lookup → synctex → DVI → source.
  const texBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
  const ctx = historicalCtx(name, hash7, texBase)
  ensure(ctx, `${texBase}-lookup.json`)
    .then(async lookupPath => {
      const data = await readFile(lookupPath, 'utf8')
      res.setHeader('Content-Type', 'application/json')
      res.send(data)
    })
    .catch(e => {
      console.warn(`[history] lookup build failed (${name}@${hash7}):`, e.message)
      res.status(404).json({ error: 'Lookup not available', detail: e.message })
    })
})

/**
 * GET /shadow/:hash7/meta — Page count and compile status for a shadow version.
 * Returns { pages, hash7, compiledAt } if compiled, or { pages: null } if not yet.
 */
router.get('/shadow/:hash7/meta', requireRead, async (req, res) => {
  const { name, hash7 } = req.params

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const metaPath = join(projectDir(name), 'history', `shadow-${hash7}`, 'meta.json')
  if (await pathExists(metaPath)) {
    const meta = await readJsonOr(metaPath, null)
    if (meta) return res.json(meta)
  }

  // Not yet compiled — check if cached SVGs exist (older entries from cacheSvgSnapshot)
  const svgDir = join(projectDir(name), 'history', `shadow-${hash7}`)
  if (await pathExists(svgDir)) {
    const svgs = (await readdir(svgDir)).filter(f => /page-\d+\.svg$/.test(f))
    if (svgs.length > 0) {
      return res.json({ pages: svgs.length, hash7, compiledAt: null })
    }
  }

  res.json({ pages: null, hash7 })
})

/**
 * GET /shadow — List recent shadow repo versions.
 * ?timestamp=<unix_ms> — find the version active at that time.
 * ?limit=<n> — max entries (default 20).
 */
router.get('/shadow', requireRead, async (req, res) => {
  const { name } = req.params
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const ts = req.query.timestamp ? parseInt(req.query.timestamp, 10) : null
  const limit = parseInt(req.query.limit, 10) || 20

  try {
    if (ts) {
      const version = await versionAt(name, ts)
      res.json({ version })
    } else {
      const versions = await listVersions(name, { limit })
      res.json({ versions })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /shadow/at?time=<string> — Find version at a time string.
 * time can be ISO, unix ms, or relative like "20 minutes ago".
 */
router.get('/shadow/at', requireRead, async (req, res) => {
  const { name } = req.params
  const { time } = req.query
  if (!time) return res.status(400).json({ error: 'time is required' })

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    // If time is a pure number string, treat as unix milliseconds so git
    // doesn't interpret it as a literal year-58000 date string.
    const parsedTime = /^\d+$/.test(time) ? parseInt(time, 10) : time
    const version = await versionAt(name, parsedTime)
    res.json({ version })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /shadow/:ref/checkout — Restore source at a shadow repo ref.
 * Extracts source from shadow repo, copies to project source dir, triggers a build.
 */
router.post('/shadow/:ref/checkout', requireRw, async (req, res) => {
  const { name, ref } = req.params
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    const tmpDir = await checkoutSource(name, ref)
    const srcDir = getSourceDir(name)

    // Clear existing source and copy from extracted ref
    for (const entry of await readdir(srcDir)) {
      await rm(join(srcDir, entry), { recursive: true, force: true })
    }
    for (const entry of await readdir(tmpDir)) {
      if (entry === '.gitignore') continue
      await cp(join(tmpDir, entry), join(srcDir, entry), { recursive: true })
    }

    // Clean up temp dir
    await rm(tmpDir, { recursive: true, force: true })

    // Trigger build
    dispatchBuild(name).catch(e => console.error(`[history] build trigger failed for ${name}: ${e.message}`))

    // Tell the viewer it's showing a pinned old version (cleared when daemon pushes fresh files)
    broadcastSignal(`doc-${name}`, 'signal:view-pin', { ref: ref.slice(0, 7), timestamp: Date.now() })

    res.json({ ok: true, ref, message: `Source restored to ${ref.slice(0, 7)}, build triggered` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /shadow/:ref/revert — Permanent revert.
 * Like /checkout but ALSO writes to the author's working copy (project.sourceDir)
 * so the watcher picks up the restored files and doesn't overwrite them on next edit.
 * Destructive: overwrites any uncommitted changes in project.sourceDir.
 */
router.post('/shadow/:ref/revert', requireRw, async (req, res) => {
  const { name, ref } = req.params
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    const tmpDir = await checkoutSource(name, ref)
    const srcDir = getSourceDir(name)
    const authorDir = project.sourceDir

    // Write to server source (same as /checkout)
    for (const entry of await readdir(srcDir)) {
      await rm(join(srcDir, entry), { recursive: true, force: true })
    }
    for (const entry of await readdir(tmpDir)) {
      if (entry === '.gitignore') continue
      await cp(join(tmpDir, entry), join(srcDir, entry), { recursive: true })
    }

    // Also write to author's working copy — this is what makes revert permanent
    const authorDirExists = !!(authorDir && await pathExists(authorDir))
    if (authorDirExists) {
      for (const entry of await readdir(tmpDir)) {
        if (entry === '.gitignore') continue
        const dest = join(authorDir, entry)
        await cp(join(tmpDir, entry), dest, { recursive: true })
      }
    }

    await rm(tmpDir, { recursive: true, force: true })
    dispatchBuild(name).catch(e => console.error(`[history] build trigger failed for ${name}: ${e.message}`))

    res.json({
      ok: true,
      ref,
      author_dir_updated: authorDirExists,
      message: `Reverted to ${ref.slice(0, 7)} — server source + author working copy updated, build triggered`,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /diff-region — Word-level diff between current and historical version in a page region.
 *
 * Body: { hash7, page, pdfYMin, pdfYMax, columnX, triggerId }
 * Response: { shapeIds: string[] }
 *
 * Uses synctex reverse lookup → latexdiff → forward lookup → creates highlight shapes.
 */
router.post('/diff-region', requireRead, async (req, res) => {
  const { name } = req.params
  const { hash7, page, pdfYMin, pdfYMax, columnX = 848, shadowYOffset = 0, triggerId = '' } = req.body ?? {}

  if (!hash7 || page == null || pdfYMin == null || pdfYMax == null) {
    return res.status(400).json({ error: 'Required: hash7, page, pdfYMin, pdfYMax' })
  }

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  // 1. Reverse synctex: find source line range covering this y-region
  const { loadSynctex } = await import('../lib/synctex-query.mjs')
  const synctex = await loadSynctex(name)
  if (!synctex) return res.status(404).json({ error: 'No synctex data for current version' })

  const margin = 8
  const { records, inputMap } = synctex
  const texFileIds = new Set()
  for (const [id, p] of inputMap) { if (p.endsWith('.tex')) texFileIds.add(id) }

  const pageRecords = records.filter(r =>
    r.page === page &&
    r.y >= pdfYMin - margin &&
    r.y <= pdfYMax + margin &&
    texFileIds.has(r.inputId),
  )
  if (pageRecords.length === 0) {
    return res.status(404).json({ error: 'No synctex records found in specified region' })
  }

  const startLine = Math.min(...pageRecords.map(r => r.line))
  const endLine   = Math.max(...pageRecords.map(r => r.line))
  const hitFileAbsolute = inputMap.get(pageRecords[0].inputId)

  const srcDir = getSourceDir(name)
  const relHitFile = hitFileAbsolute.startsWith(srcDir)
    ? hitFileAbsolute.slice(srcDir.length + 1)
    : (project.mainFile || 'main.tex')

  // 2. Read FULL current source file
  let currentLines
  try {
    currentLines = (await readFile(hitFileAbsolute, 'utf8')).split('\n')
  } catch (e) {
    return res.status(500).json({ error: `Cannot read current source: ${e.message}` })
  }
  const currentFull = currentLines.join('\n')

  // 3. Read FULL historical source via git show in shadow-repo
  const repoDir = getShadowRepoDir(name)
  let historicalLines = []
  try {
    const { stdout } = await execAsync(
      `git show "${hash7}:${relHitFile}"`,
      { cwd: repoDir, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
    )
    historicalLines = stdout.split('\n')
  } catch (e) {
    return res.status(404).json({ error: `Historical source not found at ${hash7}:${relHitFile}: ${e.message}` })
  }
  const historicalFull = historicalLines.join('\n')

  // 4. Run latexdiff on FULL files — avoids line-alignment issues from excerpts
  const { tmpdir } = await import('os')
  const ts = Date.now()
  const tmpOld = join(tmpdir(), `tlda-ldiff-old-${ts}.tex`)
  const tmpNew = join(tmpdir(), `tlda-ldiff-new-${ts}.tex`)
  let addTexts = [], delTexts = []
  try {
    await writeFile(tmpOld, historicalFull)
    await writeFile(tmpNew, currentFull)
    const ldOut = await runLatexdiffFiles(tmpOld, tmpNew)
    ;({ addTexts, delTexts } = _parseDiffOutput(ldOut))
  } catch (e) {
    const status = e?.status || 500
    const detail = e?.stderr ? String(e.stderr).trim() : String(e?.message || e)
    return res.status(status).json({
      error: status === 503 ? 'history diff dependency unavailable' : 'latexdiff failed',
      dependency: e?.dependency || 'latexdiff',
      detail,
    })
  } finally {
    await rm(tmpOld, { force: true })
    await rm(tmpNew, { force: true })
  }

  // 5. Load lookup tables (source line → PDF position) for the primary target.
  const primaryTexBase = (project?.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()

  const currentLookup = (await readJsonOr(join(outputDir(name), `${primaryTexBase}-lookup.json`), {})).lines ?? {}

  const shadowLookupPath = join(projectDir(name), 'history', `shadow-${hash7}`, `${primaryTexBase}-lookup.json`)
  const shadowLookup = (await readJsonOr(shadowLookupPath, {})).lines ?? {}

  // 6. Create highlight shapes for changes in the highlighted Y-region
  // Filter: only include changes whose PDF position falls in the requested page/Y range
  const shapeIds = []
  const seenNewLines = new Set(), seenOldLines = new Set()
  const yMargin = 20  // allow some slack around the highlighted region

  for (const text of addTexts) {
    const info = _findInExcerpt(currentLines, 1, text)
    if (!info) continue
    if (seenNewLines.has(info.lineNum)) continue
    const entry = currentLookup[info.lineNum]
    if (!entry) continue
    // Filter to highlighted region
    if (entry.page !== page || entry.y < pdfYMin - yMargin || entry.y > pdfYMax + yMargin) continue
    seenNewLines.add(info.lineNum)
    const id = await _createHighlightShape(name, entry, info.colStart, info.colEnd, info.lineLen, 'light-green', 0, 0, triggerId)
    if (id) shapeIds.push(id)
  }

  for (const text of delTexts) {
    const info = _findInExcerpt(historicalLines, 1, text)
    if (!info) continue
    if (seenOldLines.has(info.lineNum)) continue
    const entry = shadowLookup[info.lineNum]
    if (!entry) continue
    // Filter to highlighted region (shadow column page number matches)
    if (entry.page !== page || entry.y < pdfYMin - yMargin || entry.y > pdfYMax + yMargin) continue
    seenOldLines.add(info.lineNum)
    const id = await _createHighlightShape(name, entry, info.colStart, info.colEnd, info.lineLen, 'light-red', columnX, shadowYOffset, triggerId)
    if (id) shapeIds.push(id)
  }

  res.json({ shapeIds })
})

/**
 * GET /shadow/bounds — Time range of the shadow repo history.
 * Returns { oldest: {hash, timestamp}, newest: {hash, timestamp} }.
 * Used by the time-axis scrubber to set its range without fetching the full list.
 */
router.get('/shadow/bounds', requireRead, async (req, res) => {
  const { name } = req.params
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    const bounds = await getTimeBounds(name)
    if (!bounds) return res.json({ oldest: null, newest: null })
    res.json(bounds)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /shadow/adjacent?hash=<hash>&dir=older|newer
 * Returns the build immediately before or after the given hash.
 * Returns { version: {hash, timestamp} } or { version: null } if at boundary.
 */
router.get('/shadow/adjacent', requireRead, async (req, res) => {
  const { name } = req.params
  const { hash, dir } = req.query

  if (!hash) return res.status(400).json({ error: 'hash is required' })
  if (dir !== 'older' && dir !== 'newer') return res.status(400).json({ error: 'dir must be older or newer' })

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  try {
    const version = await adjacentVersion(name, hash, dir)
    res.json({ version })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/** Parse `git diff -U0` output into OLD-side hunk ranges. */
export function parseOldSideHunks(diffOut) {
  const hunks = []
  for (const line of diffOut.split('\n')) {
    if (!line.startsWith('@@')) continue
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+/)
    if (!m) continue
    const start = parseInt(m[1], 10)
    const count = m[2] != null ? parseInt(m[2], 10) : 1
    hunks.push({ start, count })
  }
  return hunks
}

/** Does an old-side hunk touch the inclusive line range [lo, hi]? */
export function hunkIntersectsRange(hunk, lo, hi) {
  if (hunk.count === 0) {
    // Pure insertion after old line `start`: the text lands between start and
    // start+1. Count it only when that point is strictly interior to the span,
    // so an insertion abutting either boundary doesn't false-alarm.
    return hunk.start >= lo && hunk.start <= hi - 1
  }
  const hStart = hunk.start
  const hEnd = hunk.start + hunk.count - 1
  return hStart <= hi && hEnd >= lo
}

const _COMMIT_RE = /^[0-9a-fA-F]{4,40}$|^HEAD$/

/**
 * POST /ribbon-stale — Given approved ribbon segments, report which have gone
 * stale because their source lines changed since the commit they were approved at.
 *
 * Body: { segments: [{ file, startLine, endLine, approvedAtCommit }], currentCommit? }
 * Response: { results: [{ stale, reason? }] } in the same order as the input.
 *
 * Each segment's line numbers are relative to its approvedAtCommit (the build that
 * was on screen when it was approved), so we diff approvedAtCommit..currentCommit
 * and intersect the OLD-side hunk ranges with the segment's [startLine, endLine].
 */
router.post('/ribbon-stale', requireRead, async (req, res) => {
  const { name } = req.params
  const { segments = [], currentCommit = 'HEAD' } = req.body ?? {}

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  if (!Array.isArray(segments)) return res.status(400).json({ error: 'segments must be an array' })
  if (typeof currentCommit !== 'string' || !_COMMIT_RE.test(currentCommit)) {
    return res.status(400).json({ error: 'currentCommit must be a git hash or HEAD' })
  }

  const repoDir = getShadowRepoDir(name)
  if (!await pathExists(join(repoDir, '.git'))) {
    return res.json({ results: segments.map(() => ({ stale: false, reason: 'no-shadow-repo' })) })
  }

  const mainFile = project.mainFile || 'main.tex'
  const relFileFor = (f) => (f && f !== '') ? f : mainFile

  // One git diff per distinct (commit, file) pair; test every segment in the pair.
  const results = segments.map(() => ({ stale: false }))
  const groups = new Map()
  segments.forEach((seg, i) => {
    if (!seg || typeof seg.approvedAtCommit !== 'string' || !_COMMIT_RE.test(seg.approvedAtCommit)) {
      results[i] = { stale: false, reason: 'no-anchor' }
      return
    }
    const file = relFileFor(seg.file)
    if (file.includes('\0') || file.includes('\n')) { results[i] = { stale: false, reason: 'bad-file' }; return }
    const key = `${seg.approvedAtCommit}\0${file}`
    if (!groups.has(key)) groups.set(key, { commit: seg.approvedAtCommit, file, idxs: [] })
    groups.get(key).idxs.push(i)
  })

  for (const { commit, file, idxs } of groups.values()) {
    if (commit === currentCommit) {
      for (const i of idxs) results[i] = { stale: false, reason: 'current' }
      continue
    }
    let hunks
    try {
      // execFile (no shell) — file/commit are client-supplied; never interpolate into a shell.
      const { stdout } = await execFileAsync(
        'git', ['diff', '-U0', commit, currentCommit, '--', file],
        { cwd: repoDir, timeout: 15000, maxBuffer: 20 * 1024 * 1024 },
      )
      hunks = parseOldSideHunks(stdout)
    } catch (e) {
      // Unknown commit / git failure: can't determine — report it, don't false-alarm.
      for (const i of idxs) results[i] = { stale: false, reason: `diff-failed: ${String(e.message).split('\n')[0]}` }
      continue
    }
    for (const i of idxs) {
      const seg = segments[i]
      const lo = Math.min(seg.startLine, seg.endLine)
      const hi = Math.max(seg.startLine, seg.endLine)
      results[i] = { stale: hunks.some(h => hunkIntersectsRange(h, lo, hi)) }
    }
  }

  res.json({ results })
})

/**
 * POST /invalidation/dry-run — structural (dependency-graph) invalidation of a
 * PROPOSED edit, without committing it.
 *
 * Body: { fromLine, toLine, file? }  — the source line range the edit would touch.
 * Response: { directlyStale: [...], cascadeStale: [...] }
 *   directlyStale: proof nodes whose own statement the edit changes
 *   cascadeStale:  nodes that transitively depend on a changed node (with depth + via)
 *
 * Pure graph + interval logic over proof-info.json — no git needed, because the
 * proposed range IS the change. (file is accepted but v1 treats statementLines as
 * main-file-relative; multi-file anchoring is a follow-up.)
 */
router.post('/invalidation/dry-run', requireRead, async (req, res) => {
  const { name } = req.params
  const { fromLine, toLine } = req.body ?? {}

  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const lo = Number(fromLine)
  const hi = Number(toLine)
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < 1) {
    return res.status(400).json({ error: 'fromLine and toLine must be positive integers' })
  }

  const proofInfo = loadProofInfo(outputDir(name))
  if (!proofInfo) return res.json({ directlyStale: [], cascadeStale: [], reason: 'no-proof-info' })

  res.json(dryRunInvalidation(proofInfo, lo, hi))
})

export default router
