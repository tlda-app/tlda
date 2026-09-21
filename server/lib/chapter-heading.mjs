import { stripPositionPrefix } from './html-toc-extractor.mjs'

/**
 * The heading and neighbours a page gets when it is shown in the canvas.
 *
 * Extracted from the `/docs/:project/*` file handler so a published copy can
 * write the same bridge in at publish time rather than growing a second answer
 * to "what chapter is this". The server has no server here on purpose: it takes
 * the page list and the page, and returns what the bridge needs.
 *
 * `pageInfo` is the document's `page-info.json`; `servedFile` is the entry's
 * `file` as that list records it. A page the list does not contain gets the
 * empty heading and no neighbours, which is what the handler did when the
 * lookup missed.
 */
export function chapterHeadingFor(pageInfo, servedFile) {
  const pages = Array.isArray(pageInfo) ? pageInfo : []
  const idx = pages.findIndex(p => p.file === servedFile)
  const heading = { chapterTitle: '', isFirstPage: idx === 0, navPrev: null, navNext: null }
  // Prev/next name the neighbouring CHAPTERS, so they carry the same
  // no-position rule as the chapter heading below.
  if (idx > 0) heading.navPrev = stripPositionPrefix(pages[idx - 1].title) || pages[idx - 1].title
  if (idx >= 0 && idx < pages.length - 1) heading.navNext = stripPositionPrefix(pages[idx + 1].title) || pages[idx + 1].title
  if (idx < 0 || !pages[idx].title) return heading

  const entry = pages[idx]
  if (entry.tocLevel === 'part') {
    // Parts keep their title as-is
    heading.chapterTitle = entry.title
    return heading
  }
  // Count chapter number within the current part
  // Pages before the first part don't get chapter numbers
  let chapterNum = 0
  let inPart = false
  for (let i = 0; i <= idx; i++) {
    if (pages[i].tocLevel === 'part') {
      chapterNum = 0
      inPart = true
    } else if (!pages[i].tocLevel && inPart) {
      chapterNum++
    }
  }
  // One encoding of "a chapter is not named after its position", shared with
  // the TOC extractor. This site had its own copy of the regex and applied it
  // only inside a part, so a page outside one was served headed `Lab 1: ...`
  // while the TOC beside it said something else.
  const stripped = stripPositionPrefix(entry.title)
  heading.chapterTitle = chapterNum > 0 && stripped
    ? `Chapter ${chapterNum}: ${stripped}`
    : chapterNum > 0
      ? `Chapter ${chapterNum}`
      : stripped || entry.title
  return heading
}
