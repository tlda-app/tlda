/**
 * incremental-qmd-build.mjs — host-independent incremental Quarto build/link engine.
 *
 * The SAME engine the app build-service adapter and the standalone CLI adapter
 * call. It takes explicit inputs (a materialized source tree, an output
 * destination, a changed-file set, build options and a log callback) and
 * produces a deterministic output tree: rendered HTML plus page-info.json,
 * toc.json and the document manifest.
 *
 * Host independence is structural, not promised: this module imports no
 * project store, no build instance, no publication path and no credentials —
 * only the filesystem, child processes, and pure document helpers. The
 * tlda project-store/build-instance/publication coupling lives in the thin
 * build-service adapter (`buildQmdDocument` in build-qmd.mjs), which calls
 * `buildIncrementalQmd` with materialized paths.
 *
 * An empty destination (or one with no prior manifest) is the FIRST
 * incremental run, not a separate full-render implementation: it flows through
 * this same engine down the whole-project branch. There is no app-only
 * full-render path to retain.
 *
 * Extracted verbatim from build-qmd.mjs: the render behaviour below is
 * unchanged, only the inputs are explicit.
 */

import { copyFileSync, existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, cpSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { parse as parseYaml } from 'yaml'

import { scanMarkdownDependencyClosure, scanMarkdownDeps } from '../../shared/markdown-deps.mjs'
import { createDocumentManifest, readDocumentManifest } from './document-manifest.mjs'
import { deckPageInfo } from './slides-parser.mjs'
import { extractHtmlToc } from './html-toc-extractor.mjs'
import { withoutAbsentSupportFilters } from './qmd-support-filters.mjs'
import { findTldaManifests, manifestTitleFromHtml, readTldaManifest } from './tlda-manifest.mjs'
import { injectQuartoOutputProvenance } from './quarto-output-provenance.mjs'
import { markQuartoSourceLines } from './quarto-source-lines.mjs'

const execFileAsync = promisify(execFile)

/**
 * Where a running build's output goes, line by line, WHILE it runs.
 *
 * A module-global sink rather than a parameter, so a direct in-process build
 * stays silent when nothing sets it — and so the worker's one
 * `setBuildOutputSink` call covers every render in the build without threading
 * a callback through each one. Moved verbatim with `streamChildOutput` from
 * build-runner.mjs: the engine owns the only callers, and the runner keeps
 * re-exports for its existing importers.
 */
let _outputSink = null
export function setBuildOutputSink(fn) { _outputSink = typeof fn === 'function' ? fn : null }
export function getBuildOutputSink() { return _outputSink }

/**
 * Feed a command's output to the sink at most once a second.
 *
 * Throttled because a large render emits a great deal of text and the fix for
 * builds locking up must not become an IPC flood. The most recent line is the
 * informative one, so the throttle keeps that and counts what it dropped rather
 * than queueing.
 *
 * Returns a detach function; callers attach it to a child process's stdio.
 */
export function streamChildOutput(child, name, { intervalMs = 1000, now = Date.now } = {}) {
  if (!child || !_outputSink) return () => {}
  let lastLine = ''
  let dropped = 0
  let lastSent = 0
  const flush = force => {
    if (!lastLine) return
    const at = now()
    if (!force && at - lastSent < intervalMs) return
    lastSent = at
    const line = lastLine
    const skipped = dropped
    lastLine = ''
    dropped = 0
    try { _outputSink(name, line, skipped) } catch { /* output must never fail a build */ }
  }
  const onData = chunk => {
    // Keep the last NON-EMPTY line: TeX pads its output with blank lines and a
    // blank final line would report the build as silent while it is working.
    const lines = String(chunk).split('\n').map(l => l.trimEnd()).filter(Boolean)
    if (!lines.length) return
    if (lastLine) dropped += 1
    dropped += lines.length - 1
    lastLine = lines[lines.length - 1]
    flush(false)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  return () => {
    flush(true)
    child.stdout?.off?.('data', onData)
    child.stderr?.off?.('data', onData)
  }
}

/**
 * How a child process ended, in a sentence, when it ended badly.
 *
 * A build that dies has to say why. Every failure site here used to report
 * `e.stderr || e.stdout || e.message`, and that ordering is the bug: when a
 * process is KILLED it writes no error, so `stderr` is empty, and the fallback
 * reports `stdout` — which is the program's ordinary progress output. The
 * failure then reads as though the last thing printed caused it, and the one
 * field that actually says what happened, `signal`, is thrown away.
 *
 * Measured on 2026-09-12 against the real shapes:
 *
 *   SIGKILL         signal SIGKILL, stderr '', stdout 'working\n'  -> reported "working"
 *   maxBuffer       code ERR_CHILD_PROCESS_STDIO_MAXBUFFER, stdout truncated
 *                                                                 -> reported the first 1KB of progress
 *   plain exit 1    code 1, stderr '', stdout 'WARN: ...'          -> reported the WARN
 *
 * In all three the reported cause was normal output. A course build died four
 * times that day naming no cause, and two people spent hours on a theory the
 * evidence could neither support nor refute, because nothing on any surface
 * distinguished "killed" from "exited with an error it printed".
 *
 * This never returns an empty string: not knowing why is itself worth saying.
 */
export function describeChildFailure(error) {
  if (!error) return 'failed for an unrecorded reason'
  if (error.signal) {
    // A signal the process did not ask for means something outside it decided
    // to stop it. Naming the usual suspect is the difference between a reader
    // knowing where to look and guessing, which is what this whole helper is for.
    const hint = error.signal === 'SIGKILL' ? ' — the OS stopped it, commonly for memory' : ''
    return `killed by ${error.signal}${hint}`
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'produced more output than the build was willing to buffer, so it was stopped mid-run'
  }
  // `killed` without a signal is how the promisified timeout surfaces.
  if (error.killed) return 'was stopped for running past its time limit'
  if (typeof error.code === 'number') return `exited with status ${error.code}`
  if (typeof error.code === 'string') return `failed with ${error.code}`
  return String(error.message || 'failed for an unrecorded reason').trim()
}

/**
 * The failure message for a child process: how it ended, then what it printed.
 *
 * Order matters. How it ended goes FIRST and is never omitted, because it is
 * the part that is missing today; the output follows as context and is labelled
 * as output so nobody reads a progress line as a diagnosis again.
 */
export function childFailureDetail(error, { maxOutputChars = 4000 } = {}) {
  const how = describeChildFailure(error)
  // BOTH STREAMS, NEITHER DISCARDED. This read `error.stderr || error.stdout`,
  // so any content on stderr threw stdout away entirely. Measured 2026-09-20
  // against this function: given both, only the stderr text survived.
  //
  // That discards exactly what a pre-render gate produces. The course's
  // `check-macros-defined.mjs` prints its finding -- which macro is undefined,
  // in how many files -- with `console.log`, and uses `console.error` only for
  // refusals. So a gate that caught a real problem reported quarto's generic
  // line and dropped the reason, on the one failure the gate exists to make
  // visible.
  //
  // Splitting the window rather than concatenating and trimming: a long stderr
  // must not be able to crowd out a short stdout, which is the same
  // one-stream-wins defect in a slower form. The total stays what it was.
  const streams = [['stderr', error?.stderr], ['stdout', error?.stdout]]
    .map(([label, value]) => [label, String(value || '').trim()])
    .filter(([, value]) => value)
  if (streams.length === 0) return `${how}, and printed nothing`

  const budget = Math.floor(maxOutputChars / streams.length)
  const printed = streams
    // The end is where a renderer says what went wrong; the beginning is where
    // it says hello. That is true of a render error and BACKWARDS for a
    // pre-render gate, whose message comes first -- which is why carrying both
    // streams matters more than choosing an end: a gate's output is short and
    // survives whole.
    .map(([label, value]) => `${label}:\n${value.length > budget ? `…\n${value.slice(-budget)}` : value}`)
    .join('\n')
  return `${how}. Its last output was:\n${printed}`
}

// The fifteen-minute limit remains for package restoration.
const RENV_RESTORE_TIMEOUT_MS = 15 * 60 * 1000

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 1200

const QUARTO_INSTALL_CANDIDATES = ['/Applications/quarto/bin/quarto', '/usr/local/bin/quarto', '/opt/homebrew/bin/quarto']

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
  throw new Error(`quarto is not on PATH — a .qmd project cannot be built without it. ${quartoAbsenceDetail()}`)
}

/**
 * Say which absence this is. Resolution stays PATH-only, as above; this only
 * reports what the process already knows, because the two cases have different
 * remedies and "install it" is wrong advice on a machine that already has it.
 *
 * Seen 2026-09-18: quarto 1.9.38 installed at /Applications/quarto/bin/quarto,
 * absent from the launchd PATH, so every .qmd build failed and the message sent
 * the reader to reinstall software that was already there.
 */
export function quartoAbsenceDetail(candidates = QUARTO_INSTALL_CANDIDATES, path = process.env.PATH) {
  const installed = candidates.find(candidate => existsSync(candidate))
  if (installed) {
    return `It is installed at ${installed} but not on this process's PATH (${path || '(empty)'}), `
      + 'so whatever launched this server gave it no login environment. Put that directory on PATH at launch.'
  }
  return 'Install it with `brew install --cask quarto`.'
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
 * window manager lays out. Pairing with a chapter belongs to the book builder,
 * which adds `map`; a deck entry on its own is not a comparison group.
 */
export function qmdDeckPageInfo(root, deck, variant) {
  return {
    ...deck,
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

export function assembleQuartoBookToc(bookToc, chapterPages, deckPages, missingDecks = []) {
  const deckByChapter = new Map()
  for (let i = 0; i < deckPages.length; i++) {
    const deck = deckPages[i]
    const entries = deckByChapter.get(deck.map) || []
    // `deckOf` names the chapter root this deck belongs to, so the panel can
    // put the deck affordance beside its chapter without parsing titles. The
    // section row itself stays: it is the deck's own row, carrying its own
    // bullet mark and fold position.
    entries.push({ title: `${deck.title} — Slides`, level: 'section', page: chapterPages.length + i + 1, deckOf: deck.map })
    deckByChapter.set(deck.map, entries)
  }
  // A declared deck with no render still gets a row, beside its chapter, with
  // NO PAGE. `page` numbers a row into `pages[n - 1]`, so there is no number
  // that could be right here and a wrong one sends the reader to somebody
  // else's document; `source` is what identifies it instead, and a reader that
  // cannot navigate it is correct — there is nothing to navigate to. Without
  // this the deck simply vanishes from the contents when it breaks, which is
  // the failure hardest to notice and the one worth noticing most.
  for (const { deck, chapter } of missingDecks) {
    const title = basename(deck).replace(/-slides\.qmd$/i, '').replace(/^chapter-/, '').replace(/-/g, ' ')
    const entries = deckByChapter.get(chapter || deck) || []
    entries.push({ title: `${title} — Slides`, level: 'section', page: null, source: deck, unbuilt: true, deckOf: chapter || deck })
    deckByChapter.set(chapter || deck, entries)
  }
  const toc = []
  const attachedDecks = new Set()
  for (const entry of bookToc) {
    const chapter = chapterPages[entry.page - 1]?.source?.file
    // `chapterRoot` is the declared chapter root this row is, so the panel can
    // match a deck row's `deckOf` against it exactly. Titles reflow through
    // renders; roots are the pairing the build already used.
    toc.push({ ...entry, chapterRoot: chapter })
    const attached = deckByChapter.get(chapter) || []
    toc.push(...attached)
    for (const deck of attached) attachedDecks.add(deck.page)
  }
  for (let i = 0; i < deckPages.length; i++) {
    const page = chapterPages.length + i + 1
    if (!attachedDecks.has(page)) toc.push({ title: `${deckPages[i].title} — Slides`, level: 'chapter', page, deckOf: deckPages[i].map })
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

export function quartoBookRoots(dir) {
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
 * Join the chapters a component render wrote without a manifest row.
 *
 * A component render never rewrites `tlda-manifest.json`, so a newly added
 * chapter lands in `_book/` with no manifest row pointing at it. Splice each
 * such rendered-but-unmanifested chapter into the seeded page list at the
 * position `_quarto.yml` declares, before the provenance loop and the ToC
 * build that both read that list.
 */
export function joinRenderedButUnmanifestedChapters(outDir, seededPageInfo, bookDir, addLog = () => {}) {
  const prefix = relative(outDir, bookDir).replace(/\\/g, '/')
  const declaredBookSources = quartoBookRoots(outDir)
  const renderedPageInfo = [...seededPageInfo]
  for (const source of declaredBookSources) {
    const normalizedSource = String(source).replace(/\\/g, '/').replace(/^\.?\/+/, '')
    if (renderedPageInfo.some(page => normalizedBookSource(page.source?.file) === normalizedBookSource(normalizedSource))) continue
    const renderedOutput = qmdRenderedOutputFilesForSource(outDir, normalizedSource)
      .map(output => String(output).replace(/\\/g, '/').replace(/^\.?\/+/, ''))
      .find(output => existsSync(join(outDir, output)))
    if (!renderedOutput) continue
    const file = prefix
      ? `${prefix}/${renderedOutput.replace(/^_book\//, '')}`
      : renderedOutput
    const title = manifestTitleFromHtml(readFileSync(join(outDir, renderedOutput), 'utf8'), renderedOutput)
    const position = declaredBookSources.indexOf(normalizedSource)
    let insertAt = renderedPageInfo.length
    if (position !== -1) {
      for (let i = 0; i < renderedPageInfo.length; i++) {
        const otherPosition = declaredBookSources.indexOf(String(renderedPageInfo[i].source?.file || '').replace(/\\/g, '/').replace(/^\.?\/+/, ''))
        if (otherPosition === -1 || otherPosition > position) { insertAt = i; break }
      }
    }
    renderedPageInfo.splice(insertAt, 0, {
      file,
      width: 800,
      height: 1200,
      title,
      format: 'qmd',
      source: { type: 'project-source', format: 'qmd', file: normalizedSource },
    })
    addLog(`[qmd] ${normalizedSource}: rendered without a manifest row — joined the book at position ${insertAt + 1}`)
  }
  return renderedPageInfo
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

export function orderQuartoBookPages(dir, pageInfo) {
  const declaredOrder = quartoBookRoots(dir).map(normalizedBookSource)
  return pageInfo.sort((a, b) => (
    declaredOrder.indexOf(normalizedBookSource(a.source?.file))
    - declaredOrder.indexOf(normalizedBookSource(b.source?.file))
  ))
}

function normalizeChangedPath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.?\/+/, '')
}

function qmdDocumentRootSet(outDir) {
  return new Set([
    ...quartoBookRoots(outDir),
    ...qmdDeckRenderRoots(outDir),
  ])
}

/**
 * Quarto project configuration, as a changed-file path.
 *
 * `_quarto.yml`, its profiles and the extensions they load decide titles,
 * formats, filters and pre-render hooks for EVERY page, so a change to any of
 * them has book-wide fan-out no dependency closure can bound. That is what
 * makes them scope-widening rather than merely unrenderable.
 */
export function isQuartoConfigFile(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (/(^|\/)_quarto(-[^/]*)?\.(yml|yaml)$/.test(normalized)) return true
  if (normalized === '_extensions' || normalized.startsWith('_extensions/')) return true
  return false
}

/**
 * Every document root with the files its render reads, by the narrowed
 * build-dependency closure plus `source(...)` edges. Computed once per scope
 * decision; staleness and orphan detection both read it.
 *
 * Navigation links excluded: `[text](other.qmd)` never inlines content (see
 * scanMarkdownDeps). `source(...)` is scanned in every markdown file of the
 * closure, not just the root: a chapter reaches a script one hop away through
 * an `{{< include >}}`, and scanning only the root leaves the script with no
 * dependents. `markdown` contains the root, so this subsumes scanning it.
 */
function qmdDocumentDependencyMap(outDir) {
  const map = new Map()
  for (const document of qmdDocumentRootSet(outDir)) {
    const { files, markdown } = scanMarkdownDependencyClosure(document, outDir, { includeNavigationLinks: false })
    const dependencies = new Set(files)
    for (const included of markdown) {
      for (const sourced of chunkSourcedFiles(included, outDir)) dependencies.add(sourced)
    }
    dependencies.delete(document)
    map.set(document, dependencies)
  }
  return map
}

/**
 * Changed files no document reads: not a root, not config, and in no
 * dependency closure. A regenerated handout zip is the recurring one — pages
 * link it, none inlines it, so it needs artifact sync rather than a render.
 * Returned so the caller can sync and name them; silently dropping them would
 * be the same green-missing-an-edit failure as dropping a chapter.
 */
export function qmdUnplacedChangedFiles(outDir, changedFiles = []) {
  const documentRoots = qmdDocumentRootSet(outDir)
  const changed = [...new Set((changedFiles || []).map(normalizeChangedPath))]
  const candidates = changed.filter(file => !documentRoots.has(file) && !isQuartoConfigFile(file))
  if (candidates.length === 0) return []
  const dependencyMap = qmdDocumentDependencyMap(outDir)
  return candidates.filter(file => {
    for (const dependencies of dependencyMap.values()) {
      if (dependencies.has(file)) return false
    }
    return true
  })
}

/**
 * Every file any document root references — links, images and includes alike,
 * followed through include chains. This is the WIDE closure: the question is
 * "could a reader reach this file from some page", not "does some page inline
 * it". A handout zip passes here (pages link it) and fails the narrowed
 * dependency map (none inlines it), which is exactly the split between an
 * artifact to sync and a render to run. Computed lazily — only change sets
 * with unplaced files need it, and those are rare.
 */
export function qmdFilesReferencedByDocuments(outDir) {
  const referenced = new Set()
  const seen = new Set()
  const queue = [...qmdDocumentRootSet(outDir)]
  while (queue.length > 0) {
    const rel = normalizeChangedPath(queue.shift())
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const abs = join(outDir, rel)
    if (!existsSync(abs)) continue
    let content
    try { content = readFileSync(abs, 'utf8') } catch { continue }
    for (const dep of scanMarkdownDeps(content, dirname(abs))) {
      const ref = String(dep.ref || '').split(/[#?]/)[0].trim().replace(/^<|>$/g, '')
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
      const targetRel = relative(outDir, resolve(dirname(abs), ref)).replace(/\\/g, '/')
      if (!targetRel || targetRel.startsWith('../')) continue
      referenced.add(targetRel)
    }
    // Recurse through includes only: a link names a page, an include inlines a
    // file whose own references arrive with it.
    for (const [, included] of content.matchAll(/\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g)) {
      const targetRel = relative(outDir, resolve(dirname(abs), included)).replace(/\\/g, '/')
      if (targetRel && !targetRel.startsWith('../')) queue.push(targetRel)
    }
  }
  return referenced
}

/**
 * Publish changed files no document renders.
 *
 * A regenerated handout zip is the recurring one: pages link it, none inlines
 * it, so no render is owed — but its published bytes must still move, or the
 * seed's copy stays and the build reports success on stale artifacts. Copied
 * at the resource path quarto itself publishes at; a deletion removes the
 * published copy the same way. A file nothing references and nothing
 * published (a README) is inert rather than an error — named, not copied,
 * since copying would publish a file no render path publishes.
 *
 * Returns the count synced, so the caller can tell "artifacts moved" from
 * "nothing needed doing" from "nothing could be done".
 */
export function syncUnplacedChangedFiles(outDir, bookDir, orphans, referenced, addLog = () => {}) {
  let synced = 0
  for (const rel of orphans) {
    const from = join(outDir, rel)
    const to = join(bookDir, rel)
    if (!existsSync(from)) {
      if (existsSync(to)) {
        rmSync(to, { force: true })
        synced += 1
        addLog(`[qmd] ${rel}: removed from the published tree (deleted from source)`)
      } else {
        addLog(`[qmd] ${rel}: deleted from source and never published — nothing to sync`)
      }
      continue
    }
    if (!referenced.has(rel) && !existsSync(to)) {
      addLog(`[qmd] ${rel}: no page reads it and it is not published — nothing to render or sync`)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
    synced += 1
    addLog(`[qmd] ${rel}: synced the published artifact without a render`)
  }
  return synced
}

/**
 * The documents a change set renders: every changed root plus every document
 * whose dependencies changed. Null means the whole project; [] means the set
 * resolved to nothing renderable (artifacts only — the caller syncs those and
 * renders nothing).
 *
 * The rule is total: every changed file maps somewhere, and a set that omits
 * a changed root is never returned. The old rule returned null on ANY non-root
 * and let a stale-fallback substitute the wrong set — measured on the course,
 * chapter + `_quarto.yml` rendered only index.qmd while the chapter edit sat
 * silently missing from its page and the build reported success. Config still
 * widens to the whole project (its fan-out is every page), but the widening is
 * announced with the files that caused it rather than failing over silently.
 */
export function qmdIncrementalRenderRoots(outDir, changedFiles = []) {
  const documentRoots = qmdDocumentRootSet(outDir)
  const changed = [...new Set((changedFiles || []).map(normalizeChangedPath))]
  if (changed.length === 0) return null
  const direct = changed.filter(file => documentRoots.has(file))
  const nonRoots = changed.filter(file => !documentRoots.has(file))
  if (nonRoots.some(isQuartoConfigFile)) return null
  const stale = qmdDocumentsStaleByDependency(outDir, nonRoots)
  return [...new Set([...direct, ...stale])]
}

/**
 * The page sources the post-render loop may rewrite, as a set: this build's
 * components, plus whatever the book join admitted that the seed did not
 * already carry. A whole-project render (null scope) admits everything; an
 * incremental render admits its components and its newly-joined chapters, and
 * every seeded page passes through byte-identical.
 */
export function qmdFreshPageSources(renderedPageInfo, componentPages, seededSources, incrementalRoots) {
  const fresh = new Set((componentPages || []).map(page => normalizedBookSource(page.source?.file)))
  if (incrementalRoots === null) {
    for (const page of renderedPageInfo || []) fresh.add(normalizedBookSource(page.source?.file))
  } else {
    for (const page of renderedPageInfo || []) {
      if (!seededSources.has(normalizedBookSource(page.source?.file))) fresh.add(normalizedBookSource(page.source?.file))
    }
  }
  return fresh
}

/**
 * An incremental scope is sound only on top of a seeded prior render: without
 * carried outputs, every unrendered document would publish as a stub and every
 * unrendered deck would drop. A render that asked for incremental files but
 * received no seed renders everything instead. seeded is true (carried),
 * false (asked, absent), or null (this render has no seed concept).
 */
export function changedFilesWithSeedFallback(changedFiles, seeded) {
  if (seeded === false && (changedFiles || []).length > 0) return null
  return changedFiles
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
    (changedFiles || []).map(normalizeChangedPath),
  )
  if (changed.size === 0) return []

  // WITHOUT navigation links (see qmdDocumentDependencyMap): a link
  // `[text](other.qmd)` is not a build dependency — the linking page renders
  // byte-identically whatever the linked page contains. Measured on the course:
  // index.qmd links every chapter, so link-following marked index stale on
  // every chapter edit and dropped its frozen R results, then rendered nothing
  // for it. Includes, images and `source(...)` edges stay: those genuinely
  // change the depending page.
  const stale = []
  for (const [document, dependencies] of qmdDocumentDependencyMap(outDir)) {
    if (changed.has(document)) continue
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
  const bookHtml = join(manifest ? dirname(manifest.path) : join(outDir, '_book'), rendered)
  mkdirSync(dirname(bookHtml), { recursive: true })
  cpSync(sourceHtml, bookHtml)

  const sourceFiles = join(outDir, rendered.replace(/\.html$/i, '_files'))
  if (existsSync(sourceFiles)) {
    const bookFiles = join(manifest ? dirname(manifest.path) : join(outDir, '_book'), rendered.replace(/\.html$/i, '_files'))
    rmSync(bookFiles, { recursive: true, force: true })
    cpSync(sourceFiles, bookFiles, { recursive: true })
  }
  return true
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sourceTitle(outDir, root) {
  try {
    const source = readFileSync(join(outDir, root), 'utf8')
    return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\{[^}]*\}\s*$/, '').trim() || basename(root, '.qmd')
  } catch {
    return basename(root, '.qmd')
  }
}

function failedChapterPage(outDir, root, error) {
  const rendered = `_book/${qmdDeclaredOutputFilesForSource(outDir, root)[0]}`
  const title = sourceTitle(outDir, root)
  mkdirSync(dirname(join(outDir, rendered)), { recursive: true })
  writeFileSync(join(outDir, rendered), `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><section class="tlda-build-failure"><h2>This chapter did not build</h2><pre>${escapeHtml(error)}</pre></section></main></body></html>\n`)
  return {
    file: rendered, width: 800, height: 1200, title, format: 'qmd', working: false, error,
    source: { type: 'project-source', format: 'qmd', file: root },
  }
}

function successfulChapterPage(outDir, root) {
  const rendered = qmdRenderedOutputFilesForSource(outDir, root).find(file => file.startsWith('_book/'))
  if (!rendered) throw new Error(`[qmd] ${root}: component render produced no book page`)
  return {
    file: rendered, width: 800, height: 1200,
    title: manifestTitleFromHtml(readFileSync(join(outDir, rendered), 'utf8'), rendered),
    format: 'qmd', working: true,
    source: { type: 'project-source', format: 'qmd', file: root },
  }
}

// Named by its file: Quarto activates `_quarto-slides.yml` with
// `--profile slides`, so the profile's name and the deck set's authority are
// the same fact and cannot drift apart.
const DECK_PROFILE = 'slides'

/**
 * One `project.render` entry of the deck profile, as deck sources.
 *
 * A literal entry names its file. A `*` entry names a NAMING RULE, and it is
 * expanded against the book's DECLARED CHAPTERS rather than against the
 * directory: `decks/*-slides.qmd` means "the deck of each declared chapter",
 * the chapter's stem substituted for the `*`. The directory decides only
 * whether a named deck exists, never which names to look for.
 *
 * That direction of travel is the whole of this function. Read the other way it
 * is a glob over `decks/`, and what is in `decks/` is not the deck list: an
 * abandoned lecture, an iPad backup, three competing variants of one deck with
 * no chosen source. Each of those is a file that exists and none of them is the
 * deck of a chapter anybody declared, so each arrives in the book, and in a
 * status display each would wear a colour as though it were material. Walking
 * from the declaration excludes them by construction rather than by a filter
 * somebody has to keep current.
 */
function expandRenderEntry(dir, rel, chapterStems, addLog) {
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
  const parts = pattern.split('*')
  if (parts.length !== 2) {
    addLog(`[qmd] deck profile: ignoring ${rel} — a name rule substitutes one chapter stem, and this names ${parts.length - 1} places to put it`)
    return []
  }
  const roots = []
  for (const stem of chapterStems) {
    const root = (parent ? `${parent}/` : '') + parts[0] + stem + parts[1]
    if (existsSync(join(dir, root))) roots.push(root)
  }
  return roots
}

/**
 * The deck sources `--profile slides` is allowed to build.
 *
 * `_quarto-slides.yml` is a Quarto PROFILE, not a second project: it sets
 * `project: type: default` and `book: null`, so a render under it writes
 * `<deck>.html` beside the source instead of into the book tree, and its
 * `project.render` list is the hand-maintained set of deck sources.
 *
 * That list is the authority, and a `*` in it is a naming rule read against the
 * book's declared chapters — never a listing of a directory. See
 * `expandRenderEntry`: a deck is in the book because a chapter names it, so
 * whatever else is sitting in `decks/` cannot arrive by being there.
 */
export function qmdDeckRenderRoots(dir, addLog = () => {}) {
  for (const name of [`_quarto-${DECK_PROFILE}.yml`, `_quarto-${DECK_PROFILE}.yaml`]) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const config = parseYaml(readFileSync(path, 'utf8'))
    const entries = Array.isArray(config?.project?.render) ? config.project.render : []
    // In declaration order, which is the order the chapters are read in, so a
    // deck sits where its chapter does rather than where the alphabet puts it.
    const chapterStems = quartoBookRoots(dir).map((chapter) => basename(chapter).replace(/\.qmd$/i, ''))
    const roots = []
    for (const entry of entries) {
      const rel = String(entry).replace(/\\/g, '/').replace(/^\.?\/+/, '')
      if (!rel) continue
      if (rel.startsWith('!')) {
        addLog(`[qmd] deck profile: ignoring exclusion ${rel}`)
        continue
      }
      for (const root of expandRenderEntry(dir, rel, chapterStems, addLog)) {
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
      const renderStart = process.hrtime.bigint()
      await renderInOutput(quarto, outDir, deck, addLog, { project, profile: DECK_PROFILE })
      const renderMs = Math.round(Number(process.hrtime.bigint() - renderStart) / 1e6)
      // Measured per deck, same contract as the chapter line: a fact about
      // this render, safe for any surface to show.
      addLog(`[qmd] ${deck}: rendered in ${renderMs}ms`)
      getBuildOutputSink()?.(project || 'qmd', `${deck}: rendered in ${renderMs}ms`, 0)
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

/**
 * Record the source scope a build read, for the relevance filter that decides
 * whether the next revision needs a render. The file list is an explicit
 * input — the service adapter derives it from the project manifest — so this
 * writes but never reads the store. Null skips it (the standalone adapter).
 */
export function writeSourceScopeFile(outDir, files) {
  if (!files) return false
  writeFileSync(
    join(outDir, 'relevant-files.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), files: [...files].sort() }, null, 2),
  )
  return true
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
export function qmdManifest(project, pageInfo, renderedFormat) {
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

/**
 * Build (or incrementally rebuild) a Quarto project from explicit inputs.
 *
 * `sourceDir` is a materialized source tree the engine reads and never writes
 * (the render runs on a copy inside `outputDir`). `outputDir` is the
 * destination: an empty directory, or one with no prior tlda manifest, is the
 * FIRST incremental run and takes the whole-project branch of this same
 * engine. `changedFiles` are project-relative paths (forward slashes); null
 * or empty means unknown and also takes the whole-project branch.
 *
 * `mainFiles` are the document roots for non-book projects (the service
 * adapter derives them from the project record). `projectMeta` is the plain
 * record the document manifest is built from (`{ format: 'qmd', mainFile }`
 * suffices). `sourceScopeFiles`, when provided, is written as
 * relevant-files.json; null skips it. `onProjectUpdate` receives the
 * build-status patch the service adapter records on the project; the CLI
 * passes null. `figureStamp` busts figure URLs; it defaults to now, and tests
 * pass a fixed value for byte-identical comparisons.
 *
 * Returns `{ manifest, regenerateBookTocs: true }`, the same shape the
 * service adapter has always returned.
 */
/**
 * Remove handout support filters the render tree does not carry.
 *
 * A generated handout names a warning filter inside its own `<stem>.qmd.support/`
 * directory. When a student hands in the document without that directory, pandoc
 * refuses the render after the whole thing has knitted — over a filter whose only
 * effect is a stderr warning for the student's own render. The work is there and
 * the page is lost.
 *
 * Runs over the copy for every qmd build rather than only for submissions: the
 * build worker has no classroom state to ask, and the rule needs none. A project
 * that carries its support directory is untouched, because the filter is only
 * dropped when the file it names is absent.
 *
 * What was dropped is logged. A build that alters a document silently is the
 * failure this guards against, not one to commit.
 */
function dropAbsentSupportFilters(outDir, addLog) {
  const documents = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.qmd$/i.test(entry.name)) documents.push(full)
    }
  }
  try { walk(outDir) } catch { return }

  for (const document of documents) {
    let original
    try { original = readFileSync(document, 'utf8') } catch { continue }
    if (!original.includes('.qmd.support/')) continue
    const base = dirname(document)
    const { text, dropped } = withoutAbsentSupportFilters(original, rel => existsSync(join(base, rel)))
    if (!dropped.length) continue
    try {
      writeFileSync(document, text)
      addLog(`[qmd] ${relative(outDir, document)}: dropped ${dropped.length} absent support filter(s) the render would have died on: ${dropped.join(', ')}`)
    } catch (e) {
      addLog(`[qmd] ${relative(outDir, document)}: could not drop absent support filter(s): ${e.message}`)
    }
  }
}

// Overlay declared source onto a seeded render tree.
//
// A seeded output directory already holds the last complete render; the source
// copy must lay the declared tree over it, not replace it. `cpSync` with
// `recursive` cannot do that: when the source entry is a symlink and the
// destination holds a regular file (the course's `_quarto.yml ->
// _quarto_book.yml` over the seeded `_quarto.yml`), it throws EEXIST, and
// `force: true` does not change that on Node 26. And when the source tree
// contains `.git`, the copy drags its read-only objects into the render tree
// and a later copy dies with EACCES.
//
// Per entry: skip `.git`; a symlink replaces whatever stands at the
// destination; a directory recurses, preserving seeded-only entries; a file
// replaces the destination. Seeded-only outputs survive.
export function copySourceTreeOverSeed(src, out) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const from = join(src, entry.name)
    const to = join(out, entry.name)
    if (entry.isSymbolicLink()) {
      rmSync(to, { force: true })
      symlinkSync(readlinkSync(from), to)
    } else if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copySourceTreeOverSeed(from, to)
    } else {
      rmSync(to, { force: true })
      copyFileSync(from, to)
    }
  }
}

export async function buildIncrementalQmd({
  sourceDir: srcDir,
  outputDir: outDir,
  changedFiles = null,
  seededPriorOutput = null,
  mainFiles,
  name = 'qmd',
  log: addLog = console.log,
  figureStamp = Date.now(),
  projectMeta = {},
  sourceScopeFiles = null,
  onProjectUpdate = null,
}) {
  if (!srcDir || !outDir) throw new Error('buildIncrementalQmd requires sourceDir and outputDir')
  if (!Array.isArray(mainFiles) || mainFiles.length === 0) throw new Error('buildIncrementalQmd requires mainFiles')
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
  copySourceTreeOverSeed(srcDir, outDir)
  const copyMs = Math.round(Number(process.hrtime.bigint() - copyStart) / 1e6)
  addLog(`[qmd] copied source tree to the output directory in ${copyMs}ms (${describeTreeSize(srcDir)})`)

  // On the COPY, never on the source: a handed-in document keeps the bytes that
  // were validated, and this is the scratch tree the render runs against.
  dropAbsentSupportFilters(outDir, addLog)

  // After the source copy, so the persisted records win over the revision's.
  stageFreezeIntoRender(outDir, addLog)

  await restoreRenv(outDir, addLog)
  const nativeTldaProject = isNativeTldaProject(outDir)
  const priorDocumentManifest = nativeTldaProject ? readDocumentManifest(outDir) : null
  const componentPages = []

  // Before any render decision, and for every build rather than only the
  // incremental ones. Quarto's freeze hash reads the document's own bytes and
  // nothing else, so a changed include or sourced script leaves every dependent
  // document thawing its old results -- on a whole-book render exactly as much
  // as on a one-chapter one. Dropping their records is what makes the change
  // reach the page, and it is the only thing that does.
  let staleByDependency = []
  if (nativeTldaProject) {
    staleByDependency = qmdDocumentsStaleByDependency(outDir, changedFiles)
    for (const document of staleByDependency) clearQmdFreeze(outDir, document)
    if (staleByDependency.length > 0) {
      // Dropping, not re-executing: these records are gone and the documents
      // re-execute only if the scope below renders them. The old line said
      // "re-executing" unconditionally, including for documents the render set
      // then omitted — the log claimed work the build never did.
      addLog(`[qmd] dropping frozen results for ${staleByDependency.length} document(s) whose dependencies changed (they re-execute when rendered): ${staleByDependency.join(', ')}`)
    }
  }

  const bookRoots = nativeTldaProject ? quartoBookRoots(outDir) : []
  // A qmd project whose one configured document is a book component other
  // than the book's own entrypoint is a standalone view of that component.
  // Compare the two configured entrypoints directly: filenames do not define
  // the behavior, and multi-root projects retain the existing book build.
  const scopedNativeProject = nativeTldaProject
    && mainFiles.length === 1
    && bookRoots.includes(mainFile)
    && mainFile !== bookRoots[0]
  const effectiveChangedFiles = changedFilesWithSeedFallback(changedFiles, seededPriorOutput)
  if (effectiveChangedFiles !== changedFiles) {
    addLog(`[qmd] no prior output to seed from; rendering the whole project instead of incremental ${JSON.stringify(changedFiles)}`)
  }
  // The rule is total — every changed file maps to a render, a sync, or a
  // widening — so a set that omits a changed root is never built. The old code
  // returned null on any non-root here and let a stale-fallback below
  // substitute the wrong set: chapter + `_quarto.yml` rendered only index.qmd
  // while the chapter edit sat missing from its page, build green. That
  // substitution is deleted, not repaired: no fallback may narrow past a file
  // it cannot place.
  const incrementalRoots = nativeTldaProject && !scopedNativeProject
    ? qmdIncrementalRenderRoots(outDir, effectiveChangedFiles)
    : null
  addLog(`[qmd] render scope: changed=${JSON.stringify(effectiveChangedFiles)} incremental=${JSON.stringify(incrementalRoots)}`)
  if (scopedNativeProject) {
    // The null above reads as whole-project and is not: a scoped project view
    // renders its one configured root. Said here so the next scope diagnosis
    // does not chase a widening that never happened.
    addLog(`[qmd] scoped single-root project view: rendering ${mainFiles.join(', ')}`)
  }
  if (nativeTldaProject && !scopedNativeProject && incrementalRoots === null && (effectiveChangedFiles?.length ?? 0) > 0) {
    const configFiles = effectiveChangedFiles.filter(isQuartoConfigFile)
    addLog(configFiles.length > 0
      ? `[qmd] full-project scope because project configuration changed: ${configFiles.join(', ')}`
      : '[qmd] full-project scope: the change set resolved to no renderable scope')
  }
  const deckPairs = nativeTldaProject ? qmdDeckChapterPairs(outDir, addLog) : []
  const deckRoots = new Set(deckPairs.map(({ deck }) => deck))
  const chapterRoots = incrementalRoots?.filter((root) => !deckRoots.has(root)) || null
  const incrementalDecks = incrementalRoots?.filter((root) => deckRoots.has(root)) || null
  // The scope in words, on the live stream as well as in the log. The log's
  // JSON line above is the record; this is what a watching person reads while
  // the render runs — including which case this build is, since a whole-book
  // render after a one-line edit is otherwise indistinguishable from a hang.
  if (nativeTldaProject && !scopedNativeProject) {
    const sink = getBuildOutputSink()
    if (sink) {
      if (incrementalRoots === null) {
        const configFiles = (effectiveChangedFiles || []).filter(isQuartoConfigFile)
        sink(name, `rendering the whole book (${bookRoots.length} chapters, ${deckPairs.length} decks)`
          + (configFiles.length > 0 ? `: ${configFiles.join(', ')} changed` : ': change set unreported'), 0)
      } else if (incrementalRoots.length === 0) {
        sink(name, 'no documents to render — syncing changed artifacts only', 0)
      } else {
        sink(name, `rendering ${incrementalRoots.length} document(s): ${incrementalRoots.join(', ')}`, 0)
      }
    }
  }
  // Changed files no document renders (a regenerated handout zip: linked, never
  // inlined). Computed only on the incremental path — whole-project renders
  // republish every artifact themselves — and only when the scope resolved
  // narrow, since a widened scope has no unplaced files by construction.
  const unplacedChangedFiles = nativeTldaProject && !scopedNativeProject && incrementalRoots !== null
    ? qmdUnplacedChangedFiles(outDir, effectiveChangedFiles)
    : []
  // A direct edit to a declared book component re-renders that component over
  // a private copy of the last complete output. Publication still swaps a
  // complete output tree. A changed shared input re-renders the documents that
  // read it; only project configuration and unreported changes render the whole
  // project, because only their fan-out is unknowable.
  if (scopedNativeProject) {
    for (const root of mainFiles) {
      clearQmdFreeze(outDir, root)
      await renderInOutput(quarto, outDir, root, addLog, { project: name })
    }
  } else if (nativeTldaProject && incrementalRoots) {
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
      try {
        const renderStart = process.hrtime.bigint()
        await renderInOutput(quarto, outDir, root, addLog, { project: name })
        const renderMs = Math.round(Number(process.hrtime.bigint() - renderStart) / 1e6)
        // Measured, per document, on both channels: this duration is a fact
        // about this render, safe for any surface to show. Whole-book renders
        // report per-document lines from quarto instead, whose arrival times
        // are NOT render durations and must never be shown as such.
        addLog(`[qmd] ${root}: rendered in ${renderMs}ms`)
        getBuildOutputSink()?.(name, `${root}: rendered in ${renderMs}ms`, 0)
        publishIncrementalQmdOutput(outDir, root)
        componentPages.push(successfulChapterPage(outDir, root))
      } catch (error) {
        const message = error?.message || String(error)
        addLog(`[qmd] ${root}: failed independently: ${message}`)
        componentPages.push(failedChapterPage(outDir, root, message))
      }
    }
  } else if (nativeTldaProject) {
    await renderInOutput(quarto, outDir, mainFile, addLog, { wholeProject: true, project: name })
  } else {
    for (const root of mainFiles) await renderInOutput(quarto, outDir, root, addLog, { project: name })
  }

  // Publish what no render produces. A second `readTldaManifest` rather than
  // the tail's: the tail reads after the deck pass, and a deck-profile render
  // must not move where artifacts land. Component renders never rewrite the
  // manifest, so both reads agree.
  if (unplacedChangedFiles.length > 0) {
    const renderedManifest = readTldaManifest(outDir)
    const bookDir = renderedManifest ? dirname(renderedManifest.path) : join(outDir, '_book')
    const referenced = qmdFilesReferencedByDocuments(outDir)
    const synced = syncUnplacedChangedFiles(outDir, bookDir, unplacedChangedFiles, referenced, addLog)
    // The refusal: a change set with renderable scope never reaches it (its
    // roots render above), so arriving here with nothing synced means nothing
    // in the set maps to anything — a typo'd `--changed` path, not a chapter.
    // Publishing the seed green would report success on a change that landed
    // nowhere, which is the failure the scope rule exists to prevent.
    if ((incrementalRoots?.length ?? 0) === 0 && synced === 0
      && unplacedChangedFiles.some(file => existsSync(join(outDir, file)))) {
      throw new Error(
        `[qmd] refusing scope: ${unplacedChangedFiles.join(', ')} match no chapter, deck, configuration, or referenced artifact — nothing to render or sync`,
      )
    }
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
  const decksToRender = scopedNativeProject
    ? []
    : incrementalRoots
      ? deckPairs.filter(({ deck }) => incrementalDecks.includes(deck))
      : deckPairs
  const failedDecks = await renderDeckSet(quarto, outDir, decksToRender.map(({ deck }) => deck), addLog, { project: name })

  if (nativeTldaProject && !scopedNativeProject) {
    const renderedProject = readTldaManifest(outDir)
    const seededPageList = renderedProject
      ? resolveQuartoBookPageSources(outDir, renderedProject.pageInfo)
      : (priorDocumentManifest?.pages || []).filter(page => quartoBookRoots(outDir).includes(normalizedBookSource(page.source?.file)))
    const seededSources = new Set(seededPageList.map(page => normalizedBookSource(page.source?.file)))
    const renderedPageInfo = renderedProject
      ? joinRenderedButUnmanifestedChapters(outDir, seededPageList, dirname(renderedProject.path), addLog)
      : seededPageList
    for (const page of componentPages) {
      const index = renderedPageInfo.findIndex(existing => normalizedBookSource(existing.source?.file) === normalizedBookSource(page.source?.file))
      if (index === -1) renderedPageInfo.push(page)
      else renderedPageInfo[index] = page
    }
    for (const root of quartoBookRoots(outDir)) {
      if (renderedPageInfo.some(page => normalizedBookSource(page.source?.file) === normalizedBookSource(root))) continue
      renderedPageInfo.push(failedChapterPage(outDir, root, 'This chapter has not built successfully yet.'))
    }
    // Pages this build rendered, by source. Everything else rode in on the
    // seed, already injected, marked and stamped by the build that rendered
    // it — reprocessing it is not free (JSDOM over every page) and not stable
    // (source-line marking accretes attributes across passes: measured +184
    // bytes on an untouched chapter between incremental builds). Seeded pages
    // pass through byte-identical; only their titles refresh, read-only, from
    // the page the seed already holds.
    const freshSources = qmdFreshPageSources(renderedPageInfo, componentPages, seededSources, incrementalRoots)
    orderQuartoBookPages(outDir, renderedPageInfo)
    for (const page of renderedPageInfo) {
      const path = join(outDir, page.file)
      const html = readFileSync(path, 'utf8')
      // Titles come from the rendered page itself, never from manifest
      // strings alone: a manifest once carried the sidebar's first chapter
      // span onto nine pages, duplicating one label across the TOC.
      const renderedTitle = manifestTitleFromHtml(html, page.file)
      if (renderedTitle) page.title = renderedTitle
      if (!freshSources.has(normalizedBookSource(page.source?.file))) continue
      const sourceFile = page.source.file
      const source = readFileSync(join(outDir, sourceFile), 'utf8')
      const withProvenance = injectQuartoOutputProvenance(html, source, sourceFile)
      writeFileSync(path, stampFigureUrls(markQuartoSourceLines(withProvenance, source), figureStamp))
    }
    // Every deck the profile declares that HAS a render — the ones built just
    // now, and the ones the seeded output already carried. Deriving the set
    // from the profile rather than from what this build rendered is what keeps
    // a component build's output tree complete.
    const bookDir = renderedProject ? dirname(renderedProject.path) : join(outDir, '_book')
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
    // Declared decks that produced nothing. A render failure removes the deck's
    // page, and a deck with no page had no row, so the ONE state most worth
    // seeing -- this deck is broken -- was the state that deleted the place it
    // would have been seen. The chapter half cannot reach here: `quartoBookToc`
    // throws when a declared chapter has no render, so a missing chapter fails
    // the build loudly. A missing deck was silent.
    const missingDecks = []
    for (const { deck, chapter } of deckPairs) {
      const rendered = deck.replace(/\.qmd$/i, '.html')
      const path = join(bookDir, rendered)
      if (!existsSync(path)) {
        addLog(`[qmd] ${deck}: declared and not rendered — listed in the contents with no page`)
        missingDecks.push({ deck, chapter })
        continue
      }
      const html = stampFigureUrls(injectQuartoOutputProvenance(
        readFileSync(path, 'utf8'),
        readFileSync(join(outDir, deck), 'utf8'),
        deck,
      ), figureStamp)
      writeFileSync(path, html)
      const info = deckPageInfo(html, prefix ? `${prefix}/${rendered}` : rendered)
      if (info.slides.length === 0) {
        addLog(`[qmd] ${deck}: rendered without reveal slides, not published as a deck`)
        missingDecks.push({ deck, chapter })
        continue
      }
      // `map` is the CHAPTER's root, which puts a deck in the same spatial
      // world without turning it into a side-by-side comparison group;
      // `source.file` stays the deck's own root, because that is the file an
      // edit to this document lands in. An unpaired deck maps under itself and
      // stands alone.
      deckPages.push({ ...qmdDeckPageInfo(deck, info, 'slides'), map: chapter || deck })
    }
    // `map` on the chapter too, not only on decks. It is the map layer's key:
    // an entry with no `map` keeps its
    // positional page, so keying on `source.file` instead would have re-keyed
    // every markdown project, whose column builder emits `source.file` as well.
    // A chapter maps under itself, which is the spec's model — one map per
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
    retainNativeTldaRender(outDir, join(bookDir, 'tlda-manifest.json'))
    const bookTitleByPage = new Map(bookToc.map(entry => [entry.page, entry.title]))
    const nativePageInfo = [
      ...renderedPageInfo.map((page, i) => ({
        ...page,
        working: page.working !== false,
        title: bookTitleByPage.get(i + 1) || page.title,
        map: page.source.file,
      })),
      ...deckPages.map(page => ({ ...page, title: `${page.title} — Slides` })),
    ]
    writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(nativePageInfo, null, 2))
    const toc = assembleQuartoBookToc(bookToc, renderedPageInfo, deckPages, missingDecks)
    writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))
    writeSourceScopeFile(outDir, sourceScopeFiles)
    await onProjectUpdate?.({
      buildStatus: nativePageInfo.some(page => page.working === false) ? 'partial' : 'success',
      pages: nativePageInfo.length,
      renderedFormat: 'html',
      lastBuild: new Date().toISOString(),
    })
    addLog(`[qmd] ${name}: rendered tlda project with ${renderedPageInfo.length} chapter(s) and ${deckPages.length} deck(s)`)
    // A tlda Quarto project is always the scrolling document, which is why the
    // patch above hardcodes renderedFormat 'html'. Both return paths describe
    // themselves or the cutover would work for one kind of qmd and not the
    // other — and this one returns early, so it is the one easy to miss.
    return { manifest: qmdManifest(projectMeta, nativePageInfo, 'html'), regenerateBookTocs: true }
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
      ), figureStamp)
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
  if (scopedNativeProject) {
    retainFreezeOutsideRender(outDir, addLog)
    retainNativeTldaRender(outDir, join(outDir, pageInfo[0].file))
  }
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  const chapterPages = pageInfo.filter((entry) => entry.variant !== 'slides')
  const toc = extractHtmlToc(outDir, chapterPages)
  if (pageInfo.some((entry) => entry.variant === 'slides') && chapterPages.length > 0) {
    toc.push({ title: 'Slides', level: 'section', page: 1, variant: 'slides' })
  }
  writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))

  writeSourceScopeFile(outDir, sourceScopeFiles)
  // Computed once and used twice, deliberately. This condition decides both
  // what the project records and what the manifest's view says, and two copies
  // of it would be two answers to "is this a deck" that can drift apart —
  // exactly the split `renderedFormat` was added to stop.
  const renderedFormat = mainFiles.length === 1 && anyDeck && pageInfo.every((entry) => entry.variant !== 'chapter') ? 'slides' : 'html'
  await onProjectUpdate?.({
    buildStatus: 'success',
    pages: pageInfo.length,
    renderedFormat,
    lastBuild: new Date().toISOString(),
  })
  addLog(`[qmd] ${name}: rendered ${mainFiles.length} document root(s)`)

  return { manifest: qmdManifest(projectMeta, pageInfo, renderedFormat), regenerateBookTocs: true }
}
