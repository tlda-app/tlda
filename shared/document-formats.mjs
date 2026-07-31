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
