/**
 * document-formats.mjs — which document formats own their own page-info.json.
 *
 * `output/page-info.json` is a single slot with two different meanings. For a
 * format in this set the file is the DOCUMENT'S OWN page listing, written by
 * that format's build pipeline. For every other format (svg, png, diff, ...)
 * the document has no page-info of its own, so the same slot holds the
 * project's markdown PARTS listing instead.
 *
 * So a reader has to know which meaning it is looking at, and the server and
 * the viewer have to agree. They didn't. The server's set named all three
 * formats and honoured it in five places, refusing to write a parts listing
 * that "would clobber it." The viewer spelled the same rule out inline as
 * "not html and not markdown" — the same set minus slides. So the viewer read
 * a deck's own page-info as if it were a parts manifest and rendered every
 * slide a second time, stacked on the real deck and swallowing every click in
 * it. One set, imported by both sides, is what keeps that from drifting apart
 * again.
 */

export const FORMATS_WITH_OWN_PAGE_INFO = new Set(['markdown', 'html', 'slides', 'qmd'])

/**
 * Formats whose pages are HTML documents in iframes, scrolled rather than paged.
 *
 * This is a DIFFERENT question from the one above, and conflating them is how
 * `qmd` shipped with a document that rebuilt correctly on the server and never
 * changed on screen: reloadPages routes these formats to the iframe reloader
 * and everything else to the LaTeX page reloader, so a format missing from the
 * set silently took the path that reloads SVG pages a .qmd does not have.
 *
 * `slides` is deliberately NOT here. Its pages are also iframes, but one deck
 * addressed by slide coordinates rather than a scrolling document, so it takes
 * its own reload path — which is why the sites below test for it separately.
 *
 * The same set answers "does this document have synctex/proof data" (it does
 * not — those come from a LaTeX build) and "is the source a line-addressed
 * text file the anchor code can resolve against."
 */
export const HTML_PAGE_FORMATS = new Set(['html', 'markdown', 'qmd'])

/**
 * What a project's pages ARE, as against who rendered them.
 *
 * For every other format those are the same answer, which is why one `format`
 * field carried both. `qmd` is the first one where they come apart: it names
 * the fact that THIS server runs quarto, and quarto renders a .qmd to a
 * scrolling document or to a reveal deck depending on the `format:` the author
 * wrote. Both arrive as one .html file, and they want opposite treatment — an
 * iframe per slide addressed by reveal coordinates and the slides bridge, or
 * one scrolling page with the html bridge and chapter navigation.
 *
 * So the builder records which it produced and the viewing sites ask here.
 * `format` stays the build-side fact: it is what routes the next rebuild back
 * to quarto, which is why setting it to `slides` after a deck render would
 * break the loop this exists to serve.
 *
 * The default is html because quarto's own default output format is html — an
 * unbuilt project has no pages to view either way.
 */
export function viewFormat(project) {
  if (project?.format !== 'qmd') return project?.format
  return project?.renderedFormat || 'html'
}

/**
 * The three document axes, ADDED BESIDE the `format` API above rather than
 * replacing it.
 *
 * This is a transitional state inside an unfinished RC and it is not the end
 * state. Everything above is what `main` reads today; everything below is what
 * the new modules read. Nothing calls the axes yet, so this file currently adds
 * and removes nothing. The removals are the point of the RC and they come as
 * their own commits, each one moving a set of callers over — see
 * `docs/document-formats.md` for where it is going.
 *
 * Recorded so nobody reads the duplication as the design: two encodings of one
 * fact living side by side is the exact disease this RC exists to cure, and it
 * is tolerable here only because it is scaffolding with a scheduled demolition.
 *
 *   source format  tex, qmd, md, pdf, html   the authored root and source discovery
 *   renderer       latex, quarto, markdown, identity   build routing
 *   document format  paged, html, slides     the viewer and interaction model
 */

/**
 * Every value a stored `format` can hold, onto the axes.
 *
 * Restored from `db61cefd4`, the RC's own first commit, which carried it and
 * then dropped it two commits later. Without it there is no route from a
 * project written before the RC to one the RC can read, and the RC's startup
 * assertion rejects every such project — which is why the RC has never been
 * run against a store that already had anything in it.
 *
 * Total over the whole project-format set, and it handles the one case where
 * the axes are not a function of `format` alone: a `qmd` that rendered a deck.
 */
const LEGACY_AXES = {
  svg:      { sourceFormat: 'tex',  renderer: 'latex',    documentFormat: 'paged' },
  markdown: { sourceFormat: 'md',   renderer: 'markdown', documentFormat: 'html' },
  html:     { sourceFormat: 'html', renderer: 'identity', documentFormat: 'html' },
  slides:   { sourceFormat: 'html', renderer: 'identity', documentFormat: 'slides' },
  qmd:      { sourceFormat: 'qmd',  renderer: 'quarto',   documentFormat: 'html' },
  png:      { sourceFormat: 'png',  renderer: 'identity', documentFormat: 'paged' },
  book:     { sourceFormat: 'book', renderer: 'identity', documentFormat: 'book' },
}

export function legacyDocumentAxes(project = {}) {
  const fallback = LEGACY_AXES[project?.format] || LEGACY_AXES.svg
  return {
    sourceFormat: project?.sourceFormat || fallback.sourceFormat,
    renderer: project?.renderer || fallback.renderer,
    documentFormat: project?.documentFormat
      || (project?.format === 'qmd' && project?.renderedFormat === 'slides' ? 'slides' : fallback.documentFormat),
  }
}

/**
 * The axes of a project, reading a pre-RC record through the table above rather
 * than refusing it.
 *
 * The RC's own version threw `Project document axes have not been migrated`
 * here, and its `assertStoredProjectAxes` walked the whole store at startup and
 * threw on the first project still carrying `format`. Measured: a store with one
 * such project stops `initProjectStore` outright, so the server does not start —
 * and a project carrying BOTH the axes and `format` was rejected too, which
 * means the conversion could not even be staged across two passes.
 *
 * Deriving instead of asserting is what makes that whole class go away: there is
 * no migration to run once, nothing to get half-done, and re-running converges
 * because nothing was ever stored. `AGENTS.md` §"Idempotence is what makes a
 * messy environment survivable" is the reason to prefer it, and Skip's rule that
 * document roots are a computed property of the branch is the same move one
 * field over.
 */
export function documentAxes(project = {}) {
  return legacyDocumentAxes(project)
}

export const sourceFormat = project => documentAxes(project).sourceFormat
export const renderer = project => documentAxes(project).renderer
export const documentFormat = project => documentAxes(project).documentFormat

export function isHtmlDocument(project) {
  return documentFormat(project) === 'html'
}

export function isSlidesDocument(project) {
  return documentFormat(project) === 'slides'
}

/**
 * Whether a document can map a rendered position back to a source location.
 *
 * Only a LaTeX build produces synctex, which is why this is a question about the
 * source format and the renderer together rather than about the pages.
 */
export function hasSourceMapping(project) {
  const axes = documentAxes(project)
  return axes.sourceFormat === 'tex' && axes.renderer === 'latex'
}
