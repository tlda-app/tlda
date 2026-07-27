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

export const FORMATS_WITH_OWN_PAGE_INFO = new Set(['markdown', 'html', 'slides'])
