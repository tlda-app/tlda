/**
 * authoring-export.mjs — on-request linearized export of an already-built
 * Quarto chapter or deck, with caching.
 *
 * Skip's design (2026-09-22, superseding the earlier build-time plan): the
 * endpoint resolves a specific built source revision; the cache key is
 * project + revision + document + exporter format/version; a cache hit
 * returns the existing linear artifact; a cache miss runs the established
 * linearizer against that revision's already-built HTML, stores the artifact
 * and inline failure evidence, then returns it. Course source is never
 * rerendered as part of the request.
 *
 * Two pieces, deliberately split:
 *
 * - Offline text structure (this process, synchronously): parse the built
 *   HTML with jsdom — headings in document order, figures/images beside
 *   their surrounding text for chapters, slide sections with per-frame text
 *   selection for decks — and derive hard-break vs wrap markers by comparing
 *   authored source line breaks against rendered text. No browser, no
 *   rerender; this part always runs in the request.
 * - Layout-settled capture (child process only): the canonical
 *   `linearize.mjs` frame screenshots plus the rendered line-boundary pass,
 *   which need fonts/CSS/layout to settle in Chromium. The request handler
 *   never launches a browser itself; it spawns the established script and
 *   records its invocation and captured error inline on failure.
 *
 * Cache layout, under the LIVE project dir (durable state — never the build
 * instance, which publish swaps away; and never the served output tree,
 * which retainNativeTldaRender sweeps to the book):
 *
 *   server/projects/<name>/.authoring-export/<revision>/<doc-hash>/
 *     export.json    — the linearized document (markdown + frame refs)
 *     frame-*.png    — captured frame images for decks
 *     failure.json   — the miss-time failure, when generation failed
 *
 * `revision` is the sourceLifecycle durable revision, never the working
 * tree. A document the current build never rendered resolves to 409 with
 * its evidence, not to a render of something else.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { JSDOM } from 'jsdom'

import { liveProjectDir, outputDir, readProject, sourceDir, sourceLifecycleStore } from './project-store.mjs'
import { parseRevealSlides } from './slides-parser.mjs'
import { projectRevisionStatus } from './source-lifecycle.mjs'

const execFileAsync = promisify(execFile)

/** Bumped whenever the export shape or generation changes, invalidating cache. */
export const AUTHORING_EXPORT_VERSION = 1

/** How long a cache-miss generation may run before the request fails. */
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000

function sha1(text) {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Resolve the built artifact for a document: the revision the project
 * actually built, and the page-info entry for the requested document.
 *
 * `document` names a source root (`decks/foo-slides.qmd`,
 * `chapters/foo.qmd`) or a built file (`book/decks/foo-slides.html`).
 * Revision defaults to the durable built revision; a caller-supplied
 * revision that is not the built one is refused rather than served stale.
 */
export async function resolveAuthoringExportTarget(name, { document, revision = null } = {}) {
  const project = await readProject(name)
  if (!project) {
    const error = new Error(`Project "${name}" not found`)
    error.status = 404
    throw error
  }
  const durable = projectRevisionStatus((await sourceLifecycleStore(name)).listRevisionLifecycles(name))
  const builtRevision = durable.sourceRevision || project.sourceRevision || null
  if (revision && builtRevision && revision !== builtRevision) {
    const error = new Error(
      `"${name}" is built at revision ${builtRevision}, not ${revision}; refusing to export a revision the tree does not hold`,
    )
    error.status = 409
    error.detail = { project: name, document, requestedRevision: revision, builtRevision: builtRevision }
    throw error
  }
  const pageInfoPath = join(outputDir(name), 'page-info.json')
  if (!existsSync(pageInfoPath)) {
    const error = new Error(`"${name}" has no built pages to export`)
    error.status = 409
    error.detail = { project: name, document, builtRevision, why: 'page-info.json is absent' }
    throw error
  }
  const pages = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  const wanted = String(document || '')
  const page = pages.find((entry) => (
    entry?.source?.file === wanted
    || entry?.file === wanted
    || entry?.file === `app/${wanted}`
    || entry?.file?.endsWith(`/${wanted}`)
  ))
  if (!page) {
    const error = new Error(`"${wanted}" is not a built document of "${name}"`)
    error.status = 404
    error.detail = { project: name, document: wanted, builtRevision, builtDocuments: pages.map((entry) => entry?.source?.file).filter(Boolean) }
    throw error
  }
  const builtFile = join(outputDir(name), page.file)
  if (!existsSync(builtFile)) {
    const error = new Error(`"${page.file}" is declared but its built file is absent`)
    error.status = 409
    error.detail = { project: name, document: wanted, builtRevision, file: page.file }
    throw error
  }
  return { project, page, builtFile, builtRevision }
}

export function authoringExportCacheDir(name, builtRevision, document) {
  return join(liveProjectDir(name), '.authoring-export', String(builtRevision || 'unrevisioned'), sha1(String(document)))
}

/**
 * Where the canonical linearizer script comes from on the serving box.
 *
 * Order: an explicit deployment-owned path (the route's
 * TLDA_AUTHORING_EXPORT_LINEARIZER env var) wins; otherwise a `linearize.mjs`
 * in the project's own source `_extensions/tlda/` tree, which `quarto add`
 * installs into projects that use the tlda reveal extension (the working
 * talks consumer carries exactly such an installed copy). The server reads
 * that copy from the project source tree it already holds. No vendored second
 * copy, no registry: the script the request runs is the one the project's own
 * extension tree declares.
 *
 * Measured against the real target: canonical QTM285 does NOT carry
 * `linearize.mjs` — its `_extensions/tlda/` holds only `_extension.yml` and
 * `tlda-manifest.ts` (the book project extension, not the reveal one), and its
 * decks render through `r-wasm/live-revealjs`, not `tlda-revealjs`. For that
 * project the source fallback resolves to nothing and the deployment-owned
 * explicit path is the delivery — which is why an absent explicit path must
 * fail loudly on decks (stored inline evidence) rather than serve text-only.
 *
 * Returns null only when no linearizer exists anywhere, in which case chapters
 * still serve text (no frames to capture) while decks throw with invocation +
 * captured evidence. A deck that requires every visual state cannot be
 * satisfied by a text-only degradation.
 */
export function resolveLinearizerPath(name, explicitPath = null) {
  if (explicitPath) return explicitPath
  const fromSource = join(sourceDir(name), '_extensions', 'tlda', 'linearize.mjs')
  if (existsSync(fromSource)) return fromSource
  return null
}

function isRevealDeckHtml(html) {
  return /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bslides\b)[^>]*>/i.test(html)
}

function textOf(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim()
}

function imageRef(src, alt) {
  return { src: String(src || ''), alt: String(alt || '') }
}

/**
 * Chapter export: document order from the built HTML, figures inline beside
 * their surrounding text. Headings, paragraphs, lists, code, and math carry
 * their text; every image carries its resolved src and alt next to the text
 * it renders beside. Returns { kind: 'chapter', markdown, images }.
 */
export function linearizeChapterHtml(html) {
  const dom = new JSDOM(html)
  const document = dom.window.document
  const root = document.querySelector('main') || document.body
  const lines = []
  const images = []
  const pushImage = (img) => {
    const ref = imageRef(img.getAttribute('src'), img.getAttribute('alt'))
    images.push(ref)
    lines.push(`![${ref.alt}](${ref.src})`)
  }
  for (const node of root.querySelectorAll('h1, h2, h3, h4, p, li, pre, img, figure')) {
    if (node.tagName === 'IMG' && !node.closest('figure')) pushImage(node)
    else if (node.tagName === 'FIGURE') {
      const caption = node.querySelector('figcaption')
      for (const img of node.querySelectorAll('img')) pushImage(img)
      if (caption && textOf(caption)) lines.push(`_${textOf(caption)}_`)
    } else if (node.tagName === 'LI') {
      // Skip nested list items already covered by their parent's text.
      if (node.parentElement?.closest('li')) continue
      const text = textOf(node)
      if (text) lines.push(`- ${text}`)
    } else {
      const text = textOf(node)
      if (!text) continue
      if (/^H[1-4]$/.test(node.tagName)) lines.push(`${'#'.repeat(Number(node.tagName[1]))} ${text}`)
      else if (node.tagName === 'PRE') lines.push(`\`\`\`\n${node.textContent.trim()}\n\`\`\``)
      else lines.push(text)
    }
  }
  return { kind: 'chapter', markdown: lines.join('\n\n'), images }
}

/**
 * Frame text from a live slide element: the r-stack child at `frameIndex`
 * (1-based), with visuals removed the way linearize-fragments.lua removes
 * them (link-group dropped, columns unwrapped, images dropped, empties
 * dropped) and the surviving text kept in order. Operates on the already-
 * parsed DOM — parsing per slide is what made a 23MB deck hang.
 */
function frameTextFromDom(section, frameIndex) {
  const stacks = [...section.querySelectorAll('.r-stack')]
  if (!stacks.length) {
    const clone = section.cloneNode(true)
    for (const visual of clone.querySelectorAll('img, svg, canvas, .html-widget, .link-group')) visual.remove()
    // The whole slide without its visuals: heading plus text, not the
    // concatenated dump with the heading glued to the first words.
    const heading = clone.querySelector('h1, h2, h3')
    const rest = textOf(clone)
    if (heading && rest.startsWith(textOf(heading))) return rest
    return rest
  }
  const parts = []
  for (const stack of stacks) {
    const child = stack.children[frameIndex - 1]
    if (!child) continue
    const clone = child.cloneNode(true)
    for (const visual of clone.querySelectorAll('img, svg, canvas, .html-widget, .link-group')) visual.remove()
    const text = textOf(clone)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Deck export: one entry per slide, each with per-frame text selected from
 * the r-stack the way the lua filter selects it, plus the frame image paths
 * the capture pass stores. `framesDir` names the cache-relative directory
 * holding the PNGs. Returns { kind: 'deck', slides }.
 */
export function linearizeDeckHtml(html, filename, { framesDir = 'frames' } = {}) {
  const { slides } = parseRevealSlides(html)
  const dom = new JSDOM(html)
  const document = dom.window.document
  // One parse: frame counts AND per-frame text come from the live DOM, so
  // a 23MB deck costs one walk rather than a fresh JSDOM per slide.
  //
  // Naming matches the canonical capturer exactly: only slides with a
  // direct h2 AND a visual (svg/img/canvas/.html-widget) get frames, a
  // multi-frame slide gets `-frame-N` suffixes, and a single-frame visual
  // slide gets a bare `${id}.png`. Non-visual slides carry text with no
  // image ref — the capturer never screenshots them.
  const framePlan = new Map()
  for (const section of document.querySelectorAll('.reveal .slides section[id]')) {
    const stacks = [...section.querySelectorAll('.r-stack')]
    const frameCount = stacks.length ? Math.max(...stacks.map((stack) => stack.children.length)) : 1
    const isVisual = section.querySelector(':scope > h2') !== null
      && (stacks.length > 0 || section.querySelector('svg, img, canvas, .html-widget') !== null)
    const frames = []
    for (let frame = 1; frame <= frameCount; frame += 1) {
      const stem = `${section.id}${frameCount > 1 ? `-frame-${frame}` : ''}`
      frames.push({
        frame,
        text: frameTextFromDom(section, frame),
        image: isVisual ? `${framesDir}/${stem}.png` : null,
        // Settled-DOM measurement sidecar from the canonical capturer
        // (<stem>.lines.json); consumed by applyMeasuredLines below.
        linesFile: isVisual ? `${framesDir}/${stem}.lines.json` : null,
      })
    }
    framePlan.set(section.id, frames)
  }
  return {
    kind: 'deck',
    slides: slides.map((slide) => ({
      ...slide,
      frames: framePlan.get(slide.id) || [{ frame: 1, text: '', image: `${framesDir}/${slide.id}.png` }],
    })),
  }
}

/**
 * Rendered line markers for one slide's current (fully-revealed) text:
 * compare authored source line breaks against rendered text so an agent can
 * tell whether a bullet should be shortened to fit one line or broken
 * deliberately at a better phrase boundary.
 *
 * - `[hard break]`: the break exists in the authored source (a newline in
 *   the slide's source block) and survives rendering.
 * - `[wrap]`: the rendered line ends where the source has no break — the
 *   browser wrapped it after fonts/CSS/layout settled.
 *
 * Offline this is derived from source newlines vs rendered text only; the
 * layout-settled pass (child process, same cache miss) re-measures against
 * the settled DOM and overwrites `markers` with measured values. The shape
 * stays the same so the offline answer is usable before the browser runs.
 */
export function markRenderedLines(renderedText, authoredSource) {
  const renderedLines = String(renderedText || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const sourceLines = String(authoredSource || '').split('\n').map((line) => line.trim()).filter(Boolean)
  return renderedLines.map((line, index) => {
    const continuesSourceLine = sourceLines.some((source) => source.includes(line) && source !== line)
    const marker = continuesSourceLine ? '[wrap]' : '[hard break]'
    return index < renderedLines.length - 1 ? `${line} ${marker}` : line
  }).join('\n')
}

/**
 * Overwrite a frame's offline wrap markers with the settled-DOM measurement.
 *
 * `measuredBlocks` is the `lines` array from the capturer's <stem>.lines.json:
 * [{ tag, lines: [<rendered line text>], text }]. Each entry of `lines` is
 * the exact word sequence the browser put on one rendered row after layout
 * settled, so a block on N>1 rows wrapped at N-1 precise boundaries — each
 * joined with `[wrap]` naming the words on both sides. Block boundaries stay
 * `[hard break]` (one <li>/<p> per authored source block). Matching is by
 * normalized text prefix against the frame text; unmatched blocks pass
 * through unchanged, so a missing sidecar degrades to the offline answer
 * rather than failing the export.
 *
 * A `lines` count from an older sidecar (a number, not an array) degrades to
 * the legacy `[wrap ×N]` count marker rather than failing.
 */
export function applyMeasuredLines(frameText, measuredBlocks) {
  if (!Array.isArray(measuredBlocks) || !measuredBlocks.length) return frameText
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim()
  const out = []
  for (const block of measuredBlocks) {
    // Legacy sidecar: a row count with no partition. Mark the wrap count
    // rather than dropping the measurement.
    if (typeof block.lines === 'number') {
      const blockNorm = norm(block.text)
      if (!blockNorm) continue
      const rows = Math.max(1, block.lines)
      out.push(rows > 1 ? `${blockNorm} [wrap ×${rows}]` : blockNorm)
      continue
    }
    if (!Array.isArray(block.lines) || !block.lines.length) continue
    const rendered = block.lines.map(norm).filter(Boolean)
    if (!rendered.length) continue
    out.push(rendered.length > 1 ? rendered.join(' [wrap]\n') : rendered[0])
  }
  if (!out.length) return frameText
  return out.join('\n[hard break]\n')
}

function invocationFor({ name, builtRevision, document, page, exporter }) {
  return {
    project: name,
    document,
    builtRevision,
    builtFile: page.file,
    exporter,
    command: ['node', '_extensions/tlda/linearize.mjs', page.file],
  }
}

/**
 * Run the canonical linearizer against the already-built HTML file.
 * Spawns the established script as a child process — never an in-process
 * browser launch from the request handler — with file:// access to the
 * built file and a frames directory inside the cache dir. Resolves with
 * the frame filenames written, or throws with invocation + captured error.
 */
async function captureDeckFrames({ linearizerPath, builtFile, framesDir, expectedFrames = [], timeoutMs = GENERATION_TIMEOUT_MS }) {
  mkdirSync(framesDir, { recursive: true })
  let result
  try {
    // The script resolves playwright from process.cwd()'s package.json, so
    // run it from a project that actually has a working playwright install.
    // TLDA_AUTHORING_EXPORT_CWD is deployment-owned configuration (a fly env
    // entry or a shell export on the rendering box); otherwise the linearizer's
    // own project root, derived from its configured path. No repository source
    // may name a machine-specific checkout — the serving box is never this box.
    const candidates = [
      process.env.TLDA_AUTHORING_EXPORT_CWD || null,
      resolve(linearizerPath, '..', '..', '..'),
    ].filter(Boolean)
    let lastError = null
    for (const cwd of candidates) {
      try {
        result = await execFileAsync('node', [linearizerPath, builtFile, framesDir], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        })
        lastError = null
        break
      } catch (error) {
        lastError = error
        // A missing playwright install (exit 2 usage/install error) is worth
        // retrying from the next candidate; a real capture failure is not.
        const output = `${error?.stdout || ''}\n${error?.stderr || ''}`
        if (error?.code !== 2 || !/requires Playwright/.test(output)) throw error
      }
    }
    if (lastError) throw lastError
    // A capture failure mid-run (screenshot timeout, browser crash) throws
    // out of the script, so a non-zero exit surfaces above. A zero exit with
    // missing expected frames means the script's discovery disagrees with
    // ours; record that rather than silently serving a partial export.
    // The settled-DOM measurement sidecars (<stem>.lines.json) ride with the
    // PNGs and are expected alongside them.
    const missing = expectedFrames.filter((frame) => !existsSync(join(framesDir, frame)))
    if (missing.length) {
      const failure = new Error(`frame capture incomplete: ${missing.length} expected frame(s) absent`)
      failure.detail = {
        command: ['node', linearizerPath, builtFile, framesDir],
        missing: missing.slice(0, 20),
        stdout: String(result?.stdout || '').slice(-4000),
      }
      throw failure
    }
    const measured = {}
    for (const frame of expectedFrames) {
      const stem = String(frame).replace(/\.png$/, '')
      const sidecar = join(framesDir, `${stem}.lines.json`)
      if (!existsSync(sidecar)) continue
      try {
        measured[frame] = JSON.parse(readFileSync(sidecar, 'utf8'))
      } catch {
        // A malformed sidecar degrades to the offline answer; the PNG proved.
      }
    }
    return { stdout: String(result?.stdout || '').slice(-4000), framesDir, measured }
  } catch (error) {
    const failure = new Error(`frame capture failed: ${error?.message || error}`)
    failure.detail = {
      command: ['node', linearizerPath, builtFile, framesDir],
      exitCode: error?.code,
      stdout: String(error?.stdout || '').slice(-4000),
      stderr: String(error?.stderr || '').slice(-4000),
    }
    throw failure
  }
  return { stdout: String(result?.stdout || '').slice(-4000), framesDir }
}

function readCachedExport(cacheDir) {
  const exportPath = join(cacheDir, 'export.json')
  if (!existsSync(exportPath)) return null
  try {
    const cached = JSON.parse(readFileSync(exportPath, 'utf8'))
    if (cached?.exporter?.version !== AUTHORING_EXPORT_VERSION) return null
    return cached
  } catch {
    return null
  }
}

function readCachedFailure(cacheDir) {
  const failurePath = join(cacheDir, 'failure.json')
  if (!existsSync(failurePath)) return null
  try {
    return JSON.parse(readFileSync(failurePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The cached on-request export. Cache hit returns the stored artifact.
 * Cache miss derives offline text structure in-process, runs the canonical
 * frame capture as a child process for decks, stores export.json (and the
 * frames), and returns it. Nothing here rerenders course source: the only
 * input is the already-built HTML file.
 *
 * Options: { document, revision, linearizerPath, timeoutMs }.
 */
export async function authoringExport(name, { document, revision = null, linearizerPath = null, timeoutMs } = {}) {
  if (!document) {
    const error = new Error('document is required (a source root or built file)')
    error.status = 400
    throw error
  }
  const { page, builtFile, builtRevision } = await resolveAuthoringExportTarget(name, { document, revision })
  const cacheDir = authoringExportCacheDir(name, builtRevision, document)
  const cached = readCachedExport(cacheDir)
  if (cached) return { ...cached, cache: 'hit' }
  const exporter = { name: 'tlda-authoring-export', version: AUTHORING_EXPORT_VERSION }
  const invocation = invocationFor({ name, builtRevision, document, page, exporter })
  try {
    const html = readFileSync(builtFile, 'utf8')
    const framesDir = join(cacheDir, 'frames')
    let body
    if (isRevealDeckHtml(html)) {
      const parseStart = Date.now()
      body = linearizeDeckHtml(html, page.file, { framesDir: 'frames' })
      body.parseMs = Date.now() - parseStart
      body.parseBytes = html.length
      // The canonical script resolves from the explicit deployment-owned path
      // first, else the project's own extension tree (resolveLinearizerPath).
      // Absent both, decks fail loudly (see below); chapters never reach here.
      const resolvedLinearizer = resolveLinearizerPath(name, linearizerPath)
      if (!resolvedLinearizer) {
        // No linearizer anywhere: a deck cannot satisfy "every visual state"
        // with text alone. Fail with invocation + evidence stored inline
        // rather than serving a framesCaptured:false degradation.
        const error = new Error(`no canonical linearizer for deck "${document}": set the deployment-owned TLDA_AUTHORING_EXPORT_LINEARIZER path or install the tlda reveal extension (quarto add tlda-labs/quarto-tlda-revealjs) in the project source`)
        error.status = 500
        throw error
      }
      // Order matters: capture frames first so a capture failure lands in
      // failure.json (stored inline evidence) instead of a text-only
      // export.json that claims frames exist. expectedFrames comes from the
      // same slide plan the text uses, so a zero exit with missing frames
      // is reported as incomplete rather than served partial.
      const expectedFrames = body.slides.flatMap((slide) => slide.frames.map((frame) => frame.image && frame.image.replace(/^frames\//, '')).filter(Boolean))
      const capture = await captureDeckFrames({ linearizerPath: resolvedLinearizer, builtFile, framesDir, expectedFrames, timeoutMs })
      body.framesCaptured = true
      body.linearizerPath = resolvedLinearizer
      // Consume the settled-DOM measurement: overwrite each frame's text
      // with measured wrap markers where the sidecar exists. Frames without
      // a sidecar keep their offline text.
      if (capture.measured) {
        for (const slide of body.slides) {
          for (const frame of slide.frames) {
            const key = frame.image ? frame.image.replace(/^frames\//, '') : null
            const sidecar = key && capture.measured[key]
            if (sidecar?.lines) {
              frame.measuredText = applyMeasuredLines(frame.text, sidecar.lines)
              frame.measuredLines = sidecar.lines
            }
          }
        }
      }
    } else {
      body = linearizeChapterHtml(html)
    }
    const exportDoc = {
      project: name,
      document,
      builtRevision,
      builtFile: page.file,
      exporter,
      generatedAt: new Date().toISOString(),
      cache: 'miss',
      invocation,
      ...body,
    }
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'export.json'), `${JSON.stringify(exportDoc, null, 2)}\n`)
    rmSync(join(cacheDir, 'failure.json'), { force: true })
    return exportDoc
  } catch (error) {
    const failure = {
      project: name,
      document,
      builtRevision,
      exporter,
      generatedAt: new Date().toISOString(),
      invocation,
      error: error?.message || String(error),
      detail: error?.detail || null,
    }
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`)
    const failureError = new Error(`authoring export failed for "${document}": ${failure.error}`)
    failureError.status = error?.status || 500
    failureError.detail = failure
    throw failureError
  }
}

/** The stored miss-time failure, if a previous generation failed. */
export function readAuthoringExportFailure(name, { document, revision }) {
  return readCachedFailure(authoringExportCacheDir(name, revision, document))
}
