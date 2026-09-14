/**
 * build-qmd.mjs — render a Quarto (.qmd) project into output/.
 *
 * Quarto is the FIRST render stage tlda has ever run itself. Slides and html
 * already arrive rendered: the author runs `quarto render` on their own machine
 * and pushes the output, so the server only copies, parses, and injects. This
 * format exists because a bot cannot do that — it has no machine of its own to
 * render on, so the render has to happen where the build happens.
 *
 * The output contract is the one every other format already meets: HTML files
 * plus a page-info.json listing them. src/loaders/htmlLoader.ts does not care
 * how the HTML was produced, which is why this is a new builder rather than a
 * new rendering path inside an existing one.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, renameSync, rmSync, lstatSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { parse as parseYaml } from 'yaml'

import { readProject, sourceDir as getSourceDir, outputDir as getOutputDir, readClientSourceManifest } from './project-store.mjs'
import { scanMarkdownDependencyClosure } from '../../shared/markdown-deps.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { childFailureDetail, getBuildReporter, streamChildOutput } from './build-runner.mjs'
import { deckPageInfo } from './slides-parser.mjs'
import { extractHtmlToc } from './html-toc-extractor.mjs'
import { findTldaManifests, readTldaManifest } from './tlda-manifest.mjs'
import { injectQuartoOutputProvenance } from './quarto-output-provenance.mjs'
import { markQuartoSourceLines } from './quarto-source-lines.mjs'

const execFileAsync = promisify(execFile)

// The fifteen-minute limit remains for package restoration.
const RENV_RESTORE_TIMEOUT_MS = 15 * 60 * 1000

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 1200

/**
 * Resolve the quarto binary, or throw naming the install command.
 *
 * PATH is the only source. There is deliberately no configured path and no
 * bundled-location fallback: a second place to look is a second thing that can
 * be wrong, and "which quarto did it pick?" is a worse failure than the one a
 * fallback would prevent. A machine that renders .qmd has quarto on PATH.
 */
async function resolveQuarto() {
  const found = await execFileAsync('sh', ['-c', 'command -v quarto'])
    .then(({ stdout }) => stdout.trim())
    // `command -v` exits non-zero for "not found". That is the answer to the
    // question, not an error to report, so it becomes an empty result and the
    // single throw below is the only way this function fails.
    .catch(() => '')
  if (found) return found
  throw new Error(
    'quarto is not on PATH — a .qmd project cannot be built without it. Install it with `brew install --cask quarto`.',
  )
}

/** Resolve Rscript the same way, for the same reason. */
async function resolveRscript() {
  const found = await execFileAsync('sh', ['-c', 'command -v Rscript'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
  if (found) return found
  throw new Error(
    'Rscript is not on PATH — a .qmd project with an renv.lock cannot be built without R. Install it with `brew install r`.',
  )
}

/**
 * Restore the project's R library from its lockfile before rendering.
 *
 * An renv project pushes `renv.lock`, `.Rprofile` and `renv/activate.R`. It
 * does NOT push `renv/library` — renv gitignores it, because the library is
 * symlinks into a machine-global package cache and copying it somewhere else
 * is meaningless. So every render on a server starts from metadata alone.
 *
 * What the author's `.Rprofile` does on the way in is the part that makes this
 * mandatory rather than merely helpful: sourcing `renv/activate.R` repoints
 * the R library paths at the project library and AWAY from the system library.
 * The autoloader then bootstraps renv into that empty library and stops — it
 * installs renv and nothing else. So a machine with knitr and rmarkdown
 * installed system-wide renders with them out of reach and reports
 *
 *   The knitr package is not available in this R installation.
 *
 * which reads as a missing R installation and is not one. Installing packages
 * system-wide does not fix it; only filling the project library does.
 *
 * `renv::restore()` is what fills it, and it is the documented answer on every
 * side: quarto.org's Virtual Environments page ("To reproduce the environment
 * on another machine use the renv::restore() function"), renv's own Dockerfile
 * recipe — copy the metadata files, `R -s -e "renv::restore()"`, then copy the
 * tree — and the `make setup` target in the deck this was measured against. It
 * is transactional, and with a warm cache it links rather than reinstalls, so
 * confirming an already-matching library costs ~10s.
 *
 * Restoring in outDir rather than the source mirror is the choice
 * renderInOutput already makes, and renv's Docker recipe restores into a
 * copied tree for the same reason. One consequence is worth knowing: when a
 * project repoints `RENV_PATHS_LIBRARY_ROOT`, renv disambiguates libraries by
 * a hash of the project's absolute path, so the build gets its own library and
 * the author's interactive one is untouched. outDir is stable per project, so
 * that library is filled once and warm on every later build.
 */
/**
 * Files and bytes under a tree, for reporting what a copy actually moved.
 *
 * A duration on its own cannot separate a slow copy from a big one, and those
 * want opposite fixes -- one is the copy mechanism, the other is how much is
 * being copied at all.
 *
 * **It reports its own cost, and that is not decoration.** This walk stats every
 * entry, so it is real work added beside the thing it measures. Reporting the
 * duration makes that visible instead of quietly inflating the phase it is
 * describing -- an instrument that adds unmeasured cost to its subject is the
 * failure the copy timing exists to fix. If the walk ever becomes a meaningful
 * fraction of the copy, the log says so and it can be dropped.
 *
 * A symlink counts as one file and contributes no bytes. Note what the guard
 * does and does not do: the walk uses `lstatSync`, which never follows a link,
 * so the target's bytes were never at risk. What skipping adds is that the
 * LINK'S OWN size -- the byte length of its target path -- is not added to a
 * total meant to describe file contents. Verified by removing the guard: the
 * 3003-byte fixture reports 3008, the five characters of `a.txt`.
 */
export function measureTree(root) {
  const started = process.hrtime.bigint()
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      files += 1
      if (entry.isSymbolicLink()) continue
      try { bytes += lstatSync(full).size } catch { /* vanished mid-walk; the count is a report, not a ledger */ }
    }
  }
  return { files, bytes, walkMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) }
}

/** The log form. Separate from the measurement so the measurement stays exact:
 *  rounding to MB in the returned value would leave a 3KB tree reading 0.0MB and
 *  nothing able to check the count. */
export function describeTreeSize(root) {
  const { files, bytes, walkMs } = measureTree(root)
  return `${files} files / ${(bytes / (1024 * 1024)).toFixed(1)}MB, measured in ${walkMs}ms`
}

async function restoreRenv(outDir, addLog) {
  if (!existsSync(join(outDir, 'renv.lock'))) return

  const rscript = await resolveRscript()
  addLog('[qmd] renv::restore() from renv.lock')
  let result
  try {
    result = await execFileAsync(
      rscript,
      ['-e', 'renv::restore(prompt = FALSE)'],
      { cwd: outDir, timeout: RENV_RESTORE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    )
  } catch (e) {
    // Same reasoning as the render: renv names the package it could not get on
    // stderr, and "Command failed" names nothing anyone can act on. What it
    // printed is not always why it stopped, so say how it ended first.
    throw new Error(`renv::restore() failed in ${outDir}: ${childFailureDetail(e)}`)
  }
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of String(stream || '').split('\n')) {
      if (line.trim()) addLog(`[renv] ${line}`)
    }
  }
}

/** The .html a given .qmd renders to, as a project-relative path. */
export function qmdOutputFileForSource(sourceFile) {
  return String(sourceFile || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\.qmd$/i, '.html')
}

export function qmdRenderedOutputFileForSource(outDir, sourceFile) {
  return qmdRenderedOutputFilesForSource(outDir, sourceFile)[0] || null
}

export function qmdDeclaredOutputFilesForSource(outDir, sourceFile) {
  const normalizedSource = String(sourceFile || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  const sourcePath = join(outDir, normalizedSource)
  const candidates = []
  if (existsSync(sourcePath)) {
    const source = readFileSync(sourcePath, 'utf8')
    const frontMatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (frontMatter) {
      const options = parseYaml(frontMatter[1])
      const outputFile = options?.['output-file']
      if (typeof outputFile === 'string' && outputFile.trim()) {
        candidates.push(join(dirname(normalizedSource), outputFile).replace(/\\/g, '/'))
      }
      const format = options?.format
      if (format && typeof format === 'object' && !Array.isArray(format)) {
        for (const options of Object.values(format)) {
          if (!options || typeof options !== 'object' || Array.isArray(options)) continue
          const outputFile = options['output-file']
          if (typeof outputFile !== 'string' || !outputFile.trim()) continue
          candidates.push(join(dirname(normalizedSource), outputFile).replace(/\\/g, '/'))
        }
      }
    }
  }
  if (candidates.length === 0) candidates.push(qmdOutputFileForSource(normalizedSource))
  return [...new Set(candidates)]
}

export function qmdRenderedOutputFilesForSource(outDir, sourceFile) {
  const rendered = []
  for (const candidate of qmdDeclaredOutputFilesForSource(outDir, sourceFile)) {
    for (const path of [candidate, `_book/${candidate}`]) {
      if (existsSync(join(outDir, path))) rendered.push(path)
    }
  }
  return [...new Set(rendered)]
}

export function qmdMissingDeclaredOutputFiles(outDir, sourceFile) {
  return qmdDeclaredOutputFilesForSource(outDir, sourceFile).filter((candidate) => (
    !existsSync(join(outDir, candidate)) && !existsSync(join(outDir, `_book/${candidate}`))
  ))
}

/**
 * The page-info entry for a deck built from a .qmd root.
 *
 * One entry, not one per slide. `deck.slides` carries the address space the
 * window manager lays out; `variant`/`group` are what pair a deck with its
 * chapter as alternate renderings of one source, and both are unchanged by
 * there now being a single entry — nothing downstream keys on slide count.
 */
export function qmdDeckPageInfo(root, deck, variant) {
  return {
    ...deck,
    group: root,
    ...(variant && { variant }),
    source: { type: 'project-source', format: 'qmd', file: root },
  }
}

export function qmdDocumentRootPaths(project) {
  const declared = Array.isArray(project?.documentRoots)
    ? project.documentRoots
        .map((root) => typeof root === 'string' ? root : root?.path)
        .map((path) => String(path || '').replace(/\\/g, '/').replace(/^\.?\/+/, ''))
        .filter((path) => path.toLowerCase().endsWith('.qmd'))
    : []
  const fallback = String(project?.mainFile || 'index.qmd').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  return [...new Set(declared.length > 0 ? declared : [fallback])]
}

/**
 * Did this render produce a reveal.js deck?
 *
 * The same test slides-parser uses to find the container it walks, so a file
 * this says yes about is one it can enumerate slides from. Anything else — a
 * scrolling document, a deck in some other slide framework — is one page.
 */
function isRevealDeck(html) {
  return /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bslides\b)[^>]*>/i.test(html)
}

function titleFromRenderedHtml(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return fallback
  const title = match[1].replace(/\s+/g, ' ').trim()
  return title || fallback
}

/**
 * Give every knitr figure a URL that changes when the figure does.
 *
 * knitr names figures after the chunk, so a re-render writes new bytes to the
 * SAME path — `report_files/figure-html/unnamed-chunk-1-1.svg` every time. The
 * viewer reloads a changed document by re-pointing the iframe at a
 * cache-busted page URL, which reloads the DOCUMENT; the `<img>` inside it
 * still names an unchanged URL, so the browser reuses the copy it already has
 * and the plot on screen stays on the previous render.
 *
 * That is what "the R plot isn't updating as I change the file" was: the build
 * was correct, the server was serving new bytes, a plain fetch of that exact
 * URL returned new bytes, and the picture was old. Stamping the reference is
 * what makes the reload reach the figure.
 *
 * Only figure directories are stamped. `site_libs` and the OJS runtime are
 * byte-identical across renders, so busting them would re-download ~900KB on
 * every build to fix nothing.
 */
function stampFigureUrls(html, stamp = Date.now()) {
  return html.replace(
    /(\ssrc=")([^"]*_files\/figure-[^"?]+)(")/g,
    (_m, before, url, after) => `${before}${url}?v=${stamp}${after}`,
  )
}

/**
 * Render in the OUTPUT tree, not the source tree.
 *
 * Quarto writes its sidecar `<doc>_files/` directory next to the input and
 * maintains freeze/cache state there. Pointing it at the source mirror would
 * make a build mutate the tree the version is taken from, so the whole tree is
 * copied first and the render runs against the copy.
 */
// `project` is carried only to label the output stream. It is separate from
// `mainFile` on purpose: a project renders several roots, and a stream labelled
// by the root would report the same build under changing names.
async function renderInOutput(quarto, outDir, mainFile, addLog, { wholeProject = false, project = null, profile = null } = {}) {
  const target = wholeProject ? [] : [mainFile]
  // A Quarto profile is `_quarto-<profile>.yml` merged over `_quarto.yml`. The
  // deck pass needs one because the decks are built as a plain project (`book:
  // null`), which is a different project type from the book they belong to.
  const profileArgs = profile ? ['--profile', profile] : []
  addLog(`[qmd] quarto render${wholeProject ? '' : ` ${mainFile}`}${profile ? ` --profile ${profile}` : ''}`)
  let result
  try {
    // No `--to`. The document's own `format:` decides what it renders to, and
    // quarto's default when it declares none is already html — so passing
    // `--to html` changed nothing for a plain document and silently overrode a
    // deck. That is what made a `format: revealjs` talk render as a scrolling
    // page with no <div class="reveal"> in it at all.
    // The longest single command in this codebase, and until now the quietest:
    // a large render runs for minutes with quarto narrating to a buffer nobody
    // reads until it finishes. Streaming it is what tells the build queue this
    // is a slow build rather than a stalled one.
    //
    // No wall-clock limit. The queue checks worker liveness, and its clock is
    // refreshed by any worker message including heartbeats, so a hung renderer
    // can retain its slot while the worker keeps heartbeating.
    const running = execFileAsync(
      quarto,
      ['render', ...target, ...profileArgs],
      { cwd: outDir, maxBuffer: 32 * 1024 * 1024 },
    )
    const detachOutput = streamChildOutput(running.child, project || mainFile)
    try {
      result = await running
    } finally {
      detachOutput()
    }
  } catch (e) {
    // Quarto reports a chunk or YAML error on stderr when it gets to report
    // one at all. When it is KILLED it reports nothing, and raising its output
    // then presents the last progress line as the cause — which is how a deck
    // failed four times on 2026-09-12 naming no reason anyone could act on.
    // How it ended leads; what it printed follows, labelled as output.
    throw new Error(`quarto render failed for ${mainFile}: ${childFailureDetail(e)}`)
  }
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of String(stream || '').split('\n')) {
      if (line.trim()) addLog(`[qmd] ${line}`)
    }
  }
}

/**
 * Write the ToC the HTML panel reads, for the pages just rendered.
 *
 * Exported so the behaviour can be tested without a Quarto render: the native
 * tlda-project branch returns before the shared tail, and it returning without
 * this file is what made the panel say "No headings found".
 */
export function writeTocJson(outputDir, pageInfo) {
  const toc = extractHtmlToc(outputDir, pageInfo)
  writeFileSync(join(outputDir, 'toc.json'), JSON.stringify(toc, null, 2))
  return toc
}

export function assembleQuartoBookToc(bookToc, chapterPages, deckPages) {
  const deckByChapter = new Map()
  for (let i = 0; i < deckPages.length; i++) {
    const deck = deckPages[i]
    const entries = deckByChapter.get(deck.group) || []
    entries.push({ title: `${deck.title} — Slides`, level: 'section', page: chapterPages.length + i + 1 })
    deckByChapter.set(deck.group, entries)
  }
  const toc = []
  const attachedDecks = new Set()
  for (const entry of bookToc) {
    toc.push(entry)
    const chapter = chapterPages[entry.page - 1]?.source?.file
    const attached = deckByChapter.get(chapter) || []
    toc.push(...attached)
    for (const deck of attached) attachedDecks.add(deck.page)
  }
  for (let i = 0; i < deckPages.length; i++) {
    const page = chapterPages.length + i + 1
    if (!attachedDecks.has(page)) toc.push({ title: `${deckPages[i].title} — Slides`, level: 'chapter', page })
  }
  return toc
}

function isNativeTldaProject(dir) {
  for (const name of ['_quarto.yml', '_quarto.yaml']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const config = parseYaml(readFileSync(path, 'utf8'))
    return config?.project?.type === 'tlda'
  }
  return false
}

function quartoBookRoots(dir) {
  for (const name of ['_quarto.yml', '_quarto.yaml']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const config = parseYaml(readFileSync(path, 'utf8'))
    const roots = []
    const visit = value => {
      if (typeof value === 'string' && value.toLowerCase().endsWith('.qmd')) roots.push(value.replace(/\\/g, '/').replace(/^\.?\/+/, ''))
      else if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') {
        if (value.part) visit(value.part)
        if (value.chapters) visit(value.chapters)
      }
    }
    visit(config?.book?.chapters)
    return [...new Set(roots)]
  }
  return []
}

function normalizedBookSource(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\.handout\.qmd$/i, '.qmd')
}

/**
 * Quarto's tlda manifest derives a source name from the rendered HTML name.
 * A document with `output-file:` therefore names a .qmd that does not exist.
 * Recover the authored root by matching the rendered file to the output each
 * root declares; the root is what provenance and source editing must address.
 */
export function resolveQuartoBookPageSources(dir, pageInfo) {
  const sourceByOutput = new Map()
  for (const source of quartoBookRoots(dir)) {
    for (const output of qmdDeclaredOutputFilesForSource(dir, source)) {
      sourceByOutput.set(output.replace(/^_book\//, ''), source)
    }
  }
  return pageInfo.map(page => {
    const manifestSource = String(page.source?.file || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
    if (manifestSource && existsSync(join(dir, manifestSource))) return page
    const rendered = String(page.file || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/^_book\//, '')
    const source = sourceByOutput.get(rendered)
    return source ? { ...page, source: { ...page.source, file: source } } : page
  })
}

/**
 * Realize the book hierarchy declared in `_quarto.yml` against the pages that
 * Quarto rendered. Page titles remain document metadata; part/chapter level and
 * order come from the authored book structure, never from rendered navigation.
 */
export function quartoBookToc(dir, pageInfo) {
  let config
  for (const name of ['_quarto.yml', '_quarto.yaml']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    config = parseYaml(readFileSync(path, 'utf8'))
    break
  }
  const chapters = config?.book?.chapters
  if (!Array.isArray(chapters)) return null

  const partSources = new Set()
  const declaredSources = []
  const visit = (value, level = 'chapter') => {
    if (typeof value === 'string') {
      if (!value.toLowerCase().endsWith('.qmd')) return
      const source = normalizedBookSource(value)
      if (!declaredSources.includes(source)) declaredSources.push(source)
      if (level === 'part') partSources.add(source)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, level)
      return
    }
    if (!value || typeof value !== 'object') return
    if (value.part) visit(value.part, 'part')
    if (value.chapters) visit(value.chapters, 'chapter')
  }
  visit(chapters)

  const renderedSources = pageInfo.map(page => normalizedBookSource(page.source?.file))
  let previous = -1
  for (const source of declaredSources) {
    const position = renderedSources.indexOf(source)
    if (position === -1) throw new Error(`[toc] _quarto.yml declares ${source}, but the render did not produce it`)
    if (position <= previous) throw new Error(`[toc] rendered page order disagrees with _quarto.yml at ${source}`)
    previous = position
  }

  return pageInfo.map((page, index) => {
    const source = renderedSources[index]
    return {
      title: page.title || source || `Page ${index + 1}`,
      level: partSources.has(source) ? 'part' : 'chapter',
      page: index + 1,
    }
  })
}

export function qmdIncrementalRenderRoots(outDir, changedFiles = []) {
  if (!readTldaManifest(outDir)) return null
  const documentRoots = new Set([
    ...quartoBookRoots(outDir),
    ...qmdDeckRenderRoots(outDir),
  ])
  const changed = [...new Set((changedFiles || []).map(file => String(file).replace(/\\/g, '/').replace(/^\.?\/+/, '')))]
  if (changed.length === 0 || changed.some(file => !documentRoots.has(file))) return null
  return changed
}

export function clearQmdFreeze(outDir, root) {
  const normalized = String(root).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\.qmd$/i, '')
  rmSync(join(outDir, '_freeze', normalized), { recursive: true, force: true })
}

// A script a chunk loads is a dependency of the document, and the markdown
// closure cannot see it -- it walks includes and assets, and `source(...)` is
// neither. Measured on the course: of 37 chapters with a shared dependency, 35
// reach it by `{{< include >}}` and 2 by `source('../shared-code/estimators.R')`.
// Covering only the first leaves those two silently stale, which is the whole
// defect.
//
// Deliberately just this one form. It is what the content uses, and a scanner
// that tries to resolve computed paths would report dependencies that are not
// there -- a wrong edge costs a needless re-execution, but pretending to a
// generality it does not have is how the next person stops checking.
const CHUNK_SOURCE_CALL = /(?:^|[^\w.])source\s*\(\s*(['"])([^'"]+)\1/g

function chunkSourcedFiles(documentPath, projectDir) {
  const abs = join(projectDir, documentPath)
  if (!existsSync(abs)) return []
  const found = []
  for (const [, , ref] of readFileSync(abs, 'utf8').matchAll(CHUNK_SOURCE_CALL)) {
    const rel = relative(projectDir, join(dirname(abs), ref)).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../')) continue
    found.push(rel)
  }
  return found
}

/**
 * The documents whose results are stale because something they depend on changed.
 *
 * WHY THIS HAS TO EXIST. Quarto's freeze hash is md5 of the document's OWN bytes
 * and nothing else -- `freezeInputHash` reads one file, and that comparison is
 * the only gate before a thaw. So a changed include, a changed sourced script, a
 * changed data file invalidates NOTHING. The document thaws and the page keeps
 * the old numbers.
 *
 * Demonstrated 2026-09-13 with a control: change a sourced script, the page is
 * unchanged; change the document's own bytes, the page updates. The second is
 * what makes the first evidence rather than a broken rig.
 *
 * RENDERING THE WHOLE BOOK DOES NOT FIX IT, which is the part that misleads.
 * Each document is still checked against its own hash, so every unchanged
 * chapter thaws exactly as it would have. Falling back to a whole-project render
 * on a shared-input change therefore buys nothing at all -- it costs the whole
 * book's wall clock and propagates the change to no one.
 *
 * The document whose own bytes changed is not in this list. Quarto's hash
 * already catches that one, and it is the only case it catches.
 */
export function qmdDocumentsStaleByDependency(outDir, changedFiles = []) {
  const changed = new Set(
    (changedFiles || []).map(file => String(file).replace(/\\/g, '/').replace(/^\.?\/+/, '')),
  )
  if (changed.size === 0) return []

  const stale = []
  for (const document of new Set([...quartoBookRoots(outDir), ...qmdDeckRenderRoots(outDir)])) {
    if (changed.has(document)) continue
    // Scan every markdown file in the closure for `source(...)`, not just the
    // root. A chapter reaches a script one hop away: it `{{< include >}}`s a
    // file, and the `source(...)` is written inside THAT file. Scanning only the
    // root sees neither the include's chunk nor anything it pulls in, so the
    // script has no dependents and a change to it marks nothing stale.
    //
    // `markdown` contains the root, so this subsumes scanning it directly.
    const { files, markdown } = scanMarkdownDependencyClosure(document, outDir)
    const dependencies = new Set(files)
    for (const included of markdown) {
      for (const sourced of chunkSourcedFiles(included, outDir)) dependencies.add(sourced)
    }
    dependencies.delete(document)
    if ([...dependencies].some(dependency => changed.has(dependency))) stale.push(document)
  }
  return stale
}

/**
 * Publish a component render that Quarto wrote beside its source.
 *
 * Some book formats write a single-file render directly into the book output;
 * others write beside the source even though `quarto inspect` resolves the
 * project as a book. The latter is publishable only when it is still a prose
 * document. Refusing reveal output is the guard that prevents the incident in
 * which directory metadata turned a chapter into a deck and that deck replaced
 * the last good prose page.
 */
export function publishIncrementalQmdOutput(outDir, root) {
  const rendered = qmdOutputFileForSource(root)
  const sourceHtml = join(outDir, rendered)
  if (!existsSync(sourceHtml)) return false
  const html = readFileSync(sourceHtml, 'utf8')
  if (isRevealDeck(html)) {
    throw new Error(`[qmd] ${root}: component render produced a reveal deck instead of a book chapter`)
  }
  const manifest = readTldaManifest(outDir)
  if (!manifest) throw new Error('[qmd] component render has no prior book manifest')
  const bookHtml = join(dirname(manifest.path), rendered)
  mkdirSync(dirname(bookHtml), { recursive: true })
  cpSync(sourceHtml, bookHtml)

  const sourceFiles = join(outDir, rendered.replace(/\.html$/i, '_files'))
  if (existsSync(sourceFiles)) {
    const bookFiles = join(dirname(manifest.path), rendered.replace(/\.html$/i, '_files'))
    rmSync(bookFiles, { recursive: true, force: true })
    cpSync(sourceFiles, bookFiles, { recursive: true })
  }
  return true
}

// Named by its file: Quarto activates `_quarto-slides.yml` with
// `--profile slides`, so the profile's name and the deck set's authority are
// the same fact and cannot drift apart.
const DECK_PROFILE = 'slides'

function expandRenderEntry(dir, rel, addLog) {
  if (!rel.includes('*')) return existsSync(join(dir, rel)) ? [rel] : []
  const slash = rel.lastIndexOf('/')
  const parent = slash === -1 ? '' : rel.slice(0, slash)
  const pattern = rel.slice(slash + 1)
  if (parent.includes('*')) {
    // Said out loud rather than dropped: a deck the build silently declined to
    // find is a deck that stops appearing with nothing naming the reason.
    addLog(`[qmd] deck profile: ignoring ${rel} — a wildcard directory is not supported`)
    return []
  }
  const parentDir = parent ? join(dir, parent) : dir
  if (!existsSync(parentDir)) return []
  const matcher = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return readdirSync(parentDir)
    .filter((entry) => matcher.test(entry))
    .sort()
    .map((entry) => (parent ? `${parent}/${entry}` : entry))
}

/**
 * The deck sources `--profile slides` is allowed to build.
 *
 * `_quarto-slides.yml` is a Quarto PROFILE, not a second project: it sets
 * `project: type: default` and `book: null`, so a render under it writes
 * `<deck>.html` beside the source instead of into the book tree, and its
 * `project.render` list is the hand-maintained set of deck sources.
 *
 * That list is the authority. Nothing here infers a deck from a filename —
 * three of this project's decks are named for their chapter and three are not,
 * so a naming rule would both miss decks and claim files that are not decks.
 */
export function qmdDeckRenderRoots(dir, addLog = () => {}) {
  for (const name of [`_quarto-${DECK_PROFILE}.yml`, `_quarto-${DECK_PROFILE}.yaml`]) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const config = parseYaml(readFileSync(path, 'utf8'))
    const entries = Array.isArray(config?.project?.render) ? config.project.render : []
    const roots = []
    for (const entry of entries) {
      const rel = String(entry).replace(/\\/g, '/').replace(/^\.?\/+/, '')
      if (!rel) continue
      if (rel.startsWith('!')) {
        addLog(`[qmd] deck profile: ignoring exclusion ${rel}`)
        continue
      }
      for (const root of expandRenderEntry(dir, rel, addLog)) {
        // macOS drops an AppleDouble `._<name>` stub beside a file on a
        // non-native filesystem, and this project has committed several: they
        // match `lectures/*-slides.qmd` exactly as their originals do, are not
        // even UTF-8, and rendering one fails the whole build. The repo's own
        // handout script skips a leading dot for the same reason.
        if (root.split('/').pop().startsWith('.')) {
          addLog(`[qmd] deck profile: skipping ${root} — a dotfile is not a document`)
          continue
        }
        roots.push(root)
      }
    }
    return [...new Set(roots)]
  }
  return []
}

/**
 * Each deck with the chapter it belongs to, or null when it belongs to none.
 *
 * Pairing is stem match — `<chapter>-slides.qmd` belongs to `<chapter>.qmd` —
 * and only when that chapter is a declared book chapter. A deck that matches
 * nothing is not forced onto some chapter's map: it stands on its own, which
 * is what makes this rule safe to apply without renaming anyone's files.
 *
 * THE MATCH IS ON THE STEM, NOT ON THE PATH, and that distinction is the whole
 * of this function. Substituting `-slides.qmd` for `.qmd` in the deck's path
 * assumes a deck sits in the same directory as its chapter -- true while both
 * live in one folder, and false the moment decks and chapters are separated,
 * which is a layout decision rather than a fact about the pairing. The chapter
 * list already says which documents are chapters, so it is the thing to search.
 *
 * The consequence of getting it wrong is not an error. An unpaired deck groups
 * under itself, so it detaches from its chapter's map and stands alone -- a
 * build that succeeds and quietly puts every deck in the wrong place.
 *
 * AMBIGUITY IS REFUSED RATHER THAN GUESSED. Two chapters in different
 * directories can share a stem, and there is no correct way to choose between
 * them. Such a deck is left unpaired and says so, which is recoverable; putting
 * it on the wrong chapter's map is not.
 */
export function qmdDeckChapterPairs(outDir, addLog = () => {}) {
  const byStem = new Map()
  for (const chapter of quartoBookRoots(outDir)) {
    const stem = basename(chapter).replace(/\.qmd$/i, '')
    byStem.set(stem, byStem.has(stem) ? null : chapter)
  }
  return qmdDeckRenderRoots(outDir, addLog).map((deck) => {
    const stem = basename(deck).replace(/-slides\.qmd$/i, '')
    if (`${stem}.qmd` === basename(deck)) return { deck, chapter: null }
    if (!byStem.has(stem)) return { deck, chapter: null }
    const chapter = byStem.get(stem)
    if (chapter === null) {
      addLog(`[qmd] ${deck}: more than one chapter is named ${stem}.qmd, so it is not paired with any of them`)
      return { deck, chapter: null }
    }
    return { deck, chapter }
  })
}

/**
 * Move a deck's render into the book tree, where publication can reach it.
 *
 * This is a copy from beside the source, which is exactly what the component
 * chapter render must NOT do — and the difference is the whole point. A chapter
 * renders as part of the book project and lands in the book tree already; a
 * deck renders under `book: null`, so beside the source is genuinely where its
 * HTML is. The book tree is also all that survives `retainNativeTldaRender`,
 * so a deck left outside it is a deck that never reaches a reader.
 */
export function publishDeckIntoBook(outDir, bookDir, deck) {
  const rendered = deck.replace(/\.qmd$/i, '.html')
  const source = join(outDir, rendered)
  if (!existsSync(source)) return false
  const target = join(bookDir, rendered)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  const sourceFiles = join(outDir, rendered.replace(/\.html$/i, '_files'))
  if (existsSync(sourceFiles)) {
    const targetFiles = join(bookDir, rendered.replace(/\.html$/i, '_files'))
    rmSync(targetFiles, { recursive: true, force: true })
    cpSync(sourceFiles, targetFiles, { recursive: true })
  }
  return true
}

/**
 * Render each deck, and let a deck that fails fail alone.
 *
 * Builds are doc-by-doc, so a doc's failure is that doc's failure. A chapter
 * render still takes the build down with it — the chapter IS the document being
 * published — but a broken deck must not stop its chapter's edit from reaching
 * the reader: under project-per-chapter there was no deck in a chapter's build
 * to block it, and the bar this replaces it against is that the one-project book
 * be no less usable for developing a chapter.
 *
 * The failure is recorded with the `[build] ` marker, which is what puts it on
 * `/api/projects/<name>/build/errors` rather than only in the log nobody reads.
 * A stale deck that says so is the point; a stale deck that is silent is the
 * failure this exists to avoid.
 *
 * Returns the decks that failed. They are not published, so what stays on the
 * shelf is the last good render — never the half-written output of the render
 * that just failed.
 */
export async function renderDeckSet(quarto, outDir, decks, addLog, { project = null } = {}) {
  // MEASURED, against the guess that replaced it: rendering the deck file that
  // IS the profile's whole render list counts as rendering everything, so
  // Quarto sets QUARTO_PROJECT_RENDER_ALL and the tlda extension's post-render
  // writes a manifest — at the profile's output dir, which under
  // `type: default` is the project root. The next `readTldaManifest` then finds
  // two and fails the build with "Multiple tlda-manifest.json files found".
  //
  // The deck pass made it, so the deck pass clears it. Only manifests that were
  // not there beforehand: a project whose own output dir is the root would
  // otherwise have its real manifest deleted here.
  const before = new Set(findTldaManifests(outDir))
  const failed = new Set()
  for (const deck of decks) {
    clearQmdFreeze(outDir, deck)
    try {
      await renderInOutput(quarto, outDir, deck, addLog, { project, profile: DECK_PROFILE })
    } catch (e) {
      failed.add(deck)
      addLog(`[build] deck ${deck} failed to render; its last good render is still being served: ${e?.message || e}`)
    }
  }
  for (const path of findTldaManifests(outDir)) {
    if (before.has(path)) continue
    addLog(`[qmd] deck profile: discarding the manifest its render wrote at ${relative(outDir, path)}`)
    rmSync(path, { force: true })
  }
  return failed
}

async function writeSourceScope(name, srcDir, outDir) {
  const files = (await readClientSourceManifest(name))
    .filter((rel) => existsSync(join(srcDir, rel)))
    .sort()
  writeFileSync(
    join(outDir, 'relevant-files.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 2),
  )
}

/**
 * A Quarto build's manifest.
 *
 * Quarto is the one renderer whose view is not a property of its adapter. The
 * registry declares a `view` for `latex`, `latex-slides` and the identity
 * adapters, and deliberately none for `quarto` — because quarto renders a .qmd
 * to a scrolling document or to a reveal deck depending on the `format:` its
 * author wrote, and only the build knows which it produced. That is the same
 * fact `renderedFormat` exists to carry and `viewFormat()` exists to read.
 *
 * So this derives the view from what was rendered rather than from a constant
 * or from the adapter. Getting it from the adapter would mean guessing before
 * quarto ran.
 *
 * Pages come from `pageInfo` unchanged — the same entries written to
 * `page-info.json`, so the manifest and the viewer cannot describe different
 * documents.
 */
function qmdManifest(project, pageInfo, renderedFormat) {
  const isDeck = renderedFormat === 'slides'
  return createDocumentManifest(project, pageInfo, {
    sourceMapping: 'none',
    view: {
      kind: isDeck ? 'slides' : 'html-pages',
      capabilities: { presentation: isDeck, sourceMapping: false, searchableText: true },
    },
  })
}

// Quarto's `_freeze` is the executed output of every code chunk, keyed by the
// md5 of its source document. It is the difference between a build that
// re-runs R for two hours and one that replays stored results.
//
// It cannot simply live in `output/`, because `output/` is doing three jobs at
// once: it is the Quarto project root, it is the published tree served over
// `/docs/`, and it is the promotion payload walked file-by-file. That
// conflation is why `retainNativeTldaRender` exists at all — the render root
// pulls in the whole copied source tree, which the other two must not carry.
//
// So `_freeze` lives BESIDE `output/` between builds and is staged in and out
// around the render. It is never a member of the published tree, so it is
// never promoted and never served, and `retainNativeTldaRender` keeps doing
// exactly what it was written to do rather than growing an exemption.
//
// This is the SECOND thing to need that treatment — `.quarto/xref`, `idx` and
// `cites` are the first, seeded and published by the same lists. A third would
// be the signal that the sweep is the wrong shape rather than that each of
// these is a special case.
//
// DELETE THIS PAIR when the build workspace is wired. `advanceBuildWorkspace`
// (`build-workspace.mjs`, added in 121c73dcf, not yet called from the build)
// replaces the per-edit instance with a long-lived per-project worktree, and
// its `clean -fdx -e .quarto -e _freeze -e build-cache -e .biber-par-cache`
// keeps the freeze by construction. At that point `stageFreezeIntoRender` and
// `retainFreezeOutsideRender` are dead code and should go, rather than being
// maintained beside the thing that made them unnecessary.
export const PERSISTENT_FREEZE_DIR = '_freeze'

const persistentFreezePath = outDir => join(dirname(outDir), PERSISTENT_FREEZE_DIR)

/**
 * Overlay the persisted freeze onto the render directory, after the source
 * copy so it WINS over whatever the revision carried.
 *
 * Precedence matters and this is the direction that pays: the records the
 * server computed last build are current for the chapters he just edited,
 * while the committed copy of those same records is stale by definition — he
 * edited the source. Letting the revision win would discard exactly the
 * records this exists to keep. A stale persisted record costs one wasted
 * execution and then corrects itself, because the render writes a fresh one.
 */
export function stageFreezeIntoRender(outDir, addLog = () => {}) {
  const persisted = persistentFreezePath(outDir)
  if (!existsSync(persisted)) return false
  const start = process.hrtime.bigint()
  cpSync(persisted, join(outDir, PERSISTENT_FREEZE_DIR), { recursive: true, force: true })
  rmSync(persisted, { recursive: true, force: true })
  const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6)
  addLog(`[qmd] staged the persisted freeze into the render in ${ms}ms`)
  return true
}

/**
 * Move the freeze back out of the render directory, BEFORE the publication
 * sweep deletes everything beside the book.
 *
 * A rename, not a copy: both paths are inside the build instance, so this is a
 * metadata operation on the same filesystem and costs nothing regardless of
 * how large the tree is.
 */
export function retainFreezeOutsideRender(outDir, addLog = () => {}) {
  const rendered = join(outDir, PERSISTENT_FREEZE_DIR)
  if (!existsSync(rendered)) return false
  const persisted = persistentFreezePath(outDir)
  rmSync(persisted, { recursive: true, force: true })
  mkdirSync(dirname(persisted), { recursive: true })
  try {
    renameSync(rendered, persisted)
  } catch (error) {
    // EXDEV only: a rename across devices is refused, and the fallback is the
    // copy this exists to avoid. Reported rather than silent, because it turns
    // a free operation into the size of the tree.
    if (error?.code !== 'EXDEV') throw error
    addLog(`[qmd] freeze retain fell back to a copy: ${error.code}`)
    cpSync(rendered, persisted, { recursive: true })
    rmSync(rendered, { recursive: true, force: true })
  }
  addLog('[qmd] kept the freeze beside the output, out of the published tree')
  return true
}

export function retainNativeTldaRender(outDir, manifestPath) {
  const relativeManifest = relative(outDir, manifestPath).replace(/\\/g, '/')
  const renderedRoot = relativeManifest.split('/')[0]
  if (!renderedRoot || renderedRoot === '..' || !relativeManifest.includes('/') || relativeManifest.startsWith('../')) {
    throw new Error('tlda manifest is outside the build output')
  }
  for (const entry of readdirSync(outDir)) {
    if (entry === renderedRoot) continue
    rmSync(join(outDir, entry), { recursive: true, force: true })
  }
}

export async function buildQmdDocument(name, addLog = console.log, { changedFiles = [] } = {}) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  const project = await readProject(name)
  const mainFiles = qmdDocumentRootPaths(project)
  const mainFile = mainFiles[0]

  // Throw, don't return. A normal return is how a builder says it BUILT, and
  // the worker reads it that way: it publishes the instance. What that
  // publishes depends on the format, and neither case is acceptable.
  //
  // Where the instance's `output/` is created empty, a build that rendered
  // nothing swaps an empty directory over the last good render and takes the
  // whole document down. The existence guard in publishBuildInstance cannot
  // catch it — the directory IS there, it is just empty, which is the state
  // nobody thought to distinguish.
  //
  // qmd is NOT that case, and this comment used to say it was. The worker
  // passes `seedOutput` for qmd (bin/build-worker.mjs), so this instance's
  // `output/` already holds the previous render. A silent return here
  // republishes that render as though this revision had produced it: the
  // document stays up and quietly stops matching its source, which is harder
  // to notice than a blank page and no less wrong.
  //
  // The worker's catch is the path that already does the right thing for both:
  // diagnostics out, nothing published, `build_failed` recorded.
  for (const root of mainFiles) {
    if (!existsSync(join(srcDir, root))) {
      throw new Error(`[qmd] document root not found: ${root}`)
    }
  }

  const quarto = await resolveQuarto()

  mkdirSync(outDir, { recursive: true })
  // The whole tree, for the reason `buildSlidesDocument` copies it: a .qmd depends on
  // sibling data files, figures, _quarto.yml, and any _extensions/ it uses, and
  // a render that cannot see them fails in a way that reads as bad source.
  //
  // Timed and logged because this copy is INSIDE the phase that reports nothing.
  // Measured 2026-09-12: ~48s elapsed between a revision being accepted and
  // quarto starting, with no line written. `materializeBuildInstance` reports
  // its own phases now, and without this one the breakdown would show three
  // small numbers and leave the bulk of that gap unaccounted for -- which reads
  // as "the copy is cheap" rather than "the copy was measured somewhere else".
  //
  // It copies the WHOLE SOURCE TREE, so it scales with the size of the project
  // and not with the size of the edit. That is the property under question, so
  // the log reports what was moved as well as how long it took.
  const copyStart = process.hrtime.bigint()
  cpSync(srcDir, outDir, { recursive: true })
  const copyMs = Math.round(Number(process.hrtime.bigint() - copyStart) / 1e6)
  addLog(`[qmd] copied source tree to the output directory in ${copyMs}ms (${describeTreeSize(srcDir)})`)

  // After the source copy, so the persisted records win over the revision's.
  stageFreezeIntoRender(outDir, addLog)

  await restoreRenv(outDir, addLog)
  const nativeTldaProject = isNativeTldaProject(outDir)

  // Before any render decision, and for every build rather than only the
  // incremental ones. Quarto's freeze hash reads the document's own bytes and
  // nothing else, so a changed include or sourced script leaves every dependent
  // document thawing its old results -- on a whole-book render exactly as much
  // as on a one-chapter one. Dropping their records is what makes the change
  // reach the page, and it is the only thing that does.
  if (nativeTldaProject) {
    const staleByDependency = qmdDocumentsStaleByDependency(outDir, changedFiles)
    for (const document of staleByDependency) clearQmdFreeze(outDir, document)
    if (staleByDependency.length > 0) {
      addLog(`[qmd] re-executing ${staleByDependency.length} document(s) whose dependencies changed: ${staleByDependency.join(', ')}`)
    }
  }

  const incrementalRoots = nativeTldaProject ? qmdIncrementalRenderRoots(outDir, changedFiles) : null
  const deckPairs = nativeTldaProject ? qmdDeckChapterPairs(outDir, addLog) : []
  const deckRoots = new Set(deckPairs.map(({ deck }) => deck))
  const chapterRoots = incrementalRoots?.filter((root) => !deckRoots.has(root)) || null
  const incrementalDecks = incrementalRoots?.filter((root) => deckRoots.has(root)) || null
  // A direct edit to a declared book component re-renders that component over
  // a private copy of the last complete output. Publication still swaps a
  // complete output tree. Shared inputs and uncertain changes render the whole
  // project because their dependency fan-out is not confined to one chapter.
  if (nativeTldaProject && incrementalRoots) {
    for (const root of chapterRoots) {
      // freeze:auto stores the rendered markdown as well as executed chunks.
      // Reusing it after a direct source edit can complete successfully while
      // publishing the old prose. This is the private build instance, so
      // invalidate only the changed component's freeze before rendering it.
      clearQmdFreeze(outDir, root)
      // Quarto renders a book component AS PART OF ITS PROJECT: this writes
      // `_book/<component>.html` over the seeded output and leaves nothing
      // beside the .qmd. Nothing is copied afterwards -- a copy from beside the
      // source is a copy of a file that a project render never writes, and the
      // check guarding it failed every component build on a render that had
      // already published the page.
      await renderInOutput(quarto, outDir, root, addLog, { project: name })
      publishIncrementalQmdOutput(outDir, root)
    }
  } else if (nativeTldaProject) {
    await renderInOutput(quarto, outDir, mainFile, addLog, { wholeProject: true, project: name })
  } else {
    for (const root of mainFiles) await renderInOutput(quarto, outDir, root, addLog, { project: name })
  }

  // The decks, under their own profile, one file at a time.
  //
  // One at a time on purpose: a whole-project render under the profile would
  // set QUARTO_PROJECT_RENDER_ALL, which is what tells the tlda extension's
  // post-render to write a manifest — and a second tlda-manifest.json outside
  // the book tree fails the build with "Multiple tlda-manifest.json files
  // found". Per file, the post-render exits and the book's manifest stands.
  //
  // A component build renders only the document whose source changed. A deck
  // is a separate document from its chapter; pairing controls placement, not
  // rebuild scope. A whole-project build renders every declared deck because
  // publication swaps the tree wholesale.
  const decksToRender = incrementalRoots
    ? deckPairs.filter(({ deck }) => incrementalDecks.includes(deck))
    : deckPairs
  const failedDecks = await renderDeckSet(quarto, outDir, decksToRender.map(({ deck }) => deck), addLog, { project: name })

  if (nativeTldaProject) {
    const renderedProject = readTldaManifest(outDir)
    if (!renderedProject) {
      throw new Error('tlda Quarto project rendered without producing tlda-manifest.json')
    }
    const renderedPageInfo = resolveQuartoBookPageSources(outDir, renderedProject.pageInfo)
    for (const page of renderedPageInfo) {
      const path = join(outDir, page.file)
      const sourceFile = page.source.file
      const source = readFileSync(join(outDir, sourceFile), 'utf8')
      const withProvenance = injectQuartoOutputProvenance(readFileSync(path, 'utf8'), source, sourceFile)
      writeFileSync(path, stampFigureUrls(markQuartoSourceLines(withProvenance, source)))
    }
    // Every deck the profile declares that HAS a render — the ones built just
    // now, and the ones the seeded output already carried. Deriving the set
    // from the profile rather than from what this build rendered is what keeps
    // a component build's output tree complete.
    const bookDir = dirname(renderedProject.path)
    const prefix = relative(outDir, bookDir).replace(/\\/g, '/')
    // Only what THIS pass rendered is moved in. The source tree is copied into
    // the output before rendering, so a `<deck>.html` committed beside its .qmd
    // would otherwise be copied over a good render — the same beside-the-source
    // publication that took a prose chapter, arriving by the other door.
    for (const { deck } of decksToRender) {
      if (failedDecks.has(deck)) continue
      publishDeckIntoBook(outDir, bookDir, deck)
    }
    const deckPages = []
    for (const { deck, chapter } of deckPairs) {
      const rendered = deck.replace(/\.qmd$/i, '.html')
      const path = join(bookDir, rendered)
      if (!existsSync(path)) continue
      const html = stampFigureUrls(injectQuartoOutputProvenance(
        readFileSync(path, 'utf8'),
        readFileSync(join(outDir, deck), 'utf8'),
        deck,
      ))
      writeFileSync(path, html)
      const info = deckPageInfo(html, prefix ? `${prefix}/${rendered}` : rendered)
      if (info.slides.length === 0) {
        addLog(`[qmd] ${deck}: rendered without reveal slides, not published as a deck`)
        continue
      }
      // `group` is the CHAPTER's root, which is what puts a deck on its
      // chapter's map; `source.file` stays the deck's own root, because that is
      // the file an edit to this document lands in. An unpaired deck groups
      // under itself and stands alone.
      deckPages.push({ ...qmdDeckPageInfo(deck, info, 'slides'), group: chapter || deck })
    }
    // `group` on the chapter too, not only on decks. It is the map layer's sole
    // key, by agreement with that half: an entry with no `group` keeps its
    // positional page, so keying on `source.file` instead would have re-keyed
    // every markdown project, whose column builder emits `source.file` as well.
    // A chapter groups under itself, which is the spec's model — one map per
    // chapter — and is what a paired deck joins by naming the same root.
    //
    // Chapters stay contiguous and in manifest order, decks after all of them:
    // `toc.json` numbers entries by position and the panel turns that number
    // straight back into `pages[n - 1]`, so a reorder here sends the ToC to the
    // wrong document without looking broken.
    const bookToc = quartoBookToc(outDir, renderedPageInfo)
    if (!bookToc) throw new Error('[toc] tlda book rendered without book.chapters in _quarto.yml')
    // Before the sweep, which deletes everything beside the book.
    retainFreezeOutsideRender(outDir, addLog)
    retainNativeTldaRender(outDir, renderedProject.path)
    const bookTitleByPage = new Map(bookToc.map(entry => [entry.page, entry.title]))
    const nativePageInfo = [
      ...renderedPageInfo.map((page, i) => ({
        ...page,
        title: bookTitleByPage.get(i + 1) || page.title,
        group: page.source.file,
      })),
      ...deckPages.map(page => ({ ...page, title: `${page.title} — Slides` })),
    ]
    writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(nativePageInfo, null, 2))
    const toc = assembleQuartoBookToc(bookToc, renderedPageInfo, deckPages)
    writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))
    await writeSourceScope(name, srcDir, outDir)
    await reporter.updateProject(name, {
      buildStatus: 'success',
      pages: nativePageInfo.length,
      renderedFormat: 'html',
      lastBuild: new Date().toISOString(),
    })
    addLog(`[qmd] ${name}: rendered tlda project with ${renderedPageInfo.length} chapter(s) and ${deckPages.length} deck(s)`)
    // A tlda Quarto project is always the scrolling document, which is why the
    // patch above hardcodes renderedFormat 'html'. Both return paths describe
    // themselves or the cutover would work for one kind of qmd and not the
    // other — and this one returns early, so it is the one easy to miss.
    return { manifest: qmdManifest(await readProject(name), nativePageInfo, 'html'), regenerateBookTocs: true }
  }

  const pageInfo = []
  let anyDeck = false
  for (const root of mainFiles) {
    const sourceOutputFile = qmdOutputFileForSource(root)
    const declaredOutputFiles = qmdDeclaredOutputFilesForSource(outDir, root)
    const outputFiles = qmdRenderedOutputFilesForSource(outDir, root)
    // Throws for the reason the root check above throws: a render that produced
    // no document is a failed build, and returning normally publishes the empty
    // instance over the last good render.
    if (outputFiles.length === 0) {
      throw new Error(`[qmd] render produced neither ${sourceOutputFile} nor _book/${sourceOutputFile}`)
    }
    const missingOutputFiles = qmdMissingDeclaredOutputFiles(outDir, root)
    if (missingOutputFiles.length > 0) {
      throw new Error(`[qmd] render did not produce declared output(s): ${missingOutputFiles.join(', ')}`)
    }
    const hasAlternates = declaredOutputFiles.length > 1
    for (const outputFile of outputFiles) {
      const renderedPath = join(outDir, outputFile)
      const rootSource = readFileSync(join(outDir, root), 'utf8')
      const rendered = stampFigureUrls(markQuartoSourceLines(
        injectQuartoOutputProvenance(readFileSync(renderedPath, 'utf8'), rootSource, root),
        rootSource,
      ))
      writeFileSync(renderedPath, rendered)

      const isDeck = isRevealDeck(rendered)
      anyDeck ||= isDeck
      const variant = hasAlternates ? (isDeck ? 'slides' : 'chapter') : undefined
      if (isDeck) {
        const deck = deckPageInfo(rendered, outputFile)
        pageInfo.push(qmdDeckPageInfo(root, deck, variant))
        addLog(`[qmd] ${root}: one deck document, ${deck.slides.length} slides`)
      } else {
        pageInfo.push({
          file: outputFile,
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          title: titleFromRenderedHtml(rendered, root.replace(/\.qmd$/i, '')),
          format: 'qmd',
          ...(variant && { variant }),
          source: { type: 'project-source', format: 'qmd', file: root },
        })
      }
    }
  }
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  const chapterPages = pageInfo.filter((entry) => entry.variant !== 'slides')
  const toc = extractHtmlToc(outDir, chapterPages)
  if (pageInfo.some((entry) => entry.variant === 'slides') && chapterPages.length > 0) {
    toc.push({ title: 'Slides', level: 'section', page: 1, variant: 'slides' })
  }
  writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))

  await writeSourceScope(name, srcDir, outDir)
  // Computed once and used twice, deliberately. This condition decides both
  // what the project records and what the manifest's view says, and two copies
  // of it would be two answers to "is this a deck" that can drift apart —
  // exactly the split `renderedFormat` was added to stop.
  const renderedFormat = mainFiles.length === 1 && anyDeck && pageInfo.every((entry) => entry.variant !== 'chapter') ? 'slides' : 'html'
  await reporter.updateProject(name, {
    buildStatus: 'success',
    pages: pageInfo.length,
    renderedFormat,
    lastBuild: new Date().toISOString(),
  })
  addLog(`[qmd] ${name}: rendered ${mainFiles.length} document root(s)`)

  return { manifest: qmdManifest(await readProject(name), pageInfo, renderedFormat), regenerateBookTocs: true }
}
