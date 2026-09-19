/**
 * Which rendering of a homework page a reader gets.
 *
 * One homework occupies ONE slot, and what renders into it depends on who is
 * asking: the handout for a student who has not handed in and for the static
 * site, the solutions for an instructor and for a student after their own
 * hand-in. Same URL, substituted body. It is a substitute, not an additional
 * chapter.
 *
 * The decision lives here, apart from the file reading it drives, because it is
 * the part that can leak. A rule about who sees answers has to be reachable by
 * a test that can fail for the leak, and a function that opens files on a
 * server module is not.
 */

/**
 * The page-info `file` of the solutions rendering to serve instead, or null.
 *
 * Null means "serve what was asked for", and every exit returns it. That
 * direction is deliberate: a fault here shows the handout to an instructor,
 * which is a disappointment, rather than the answers to a class that has not
 * handed in, which cannot be taken back.
 *
 * The page is identified through page-info rather than by trimming the served
 * path, because the published prefix is not one thing — a course publication
 * puts its pages under `_book/` and an app publication under `app/book/`, while
 * the assignment records the page the CLI derived from the homework source,
 * with no prefix at all. Going via the entry's `source.file` asks the build what
 * this page was made from and lands on that same prefix-less form.
 */
export function solutionsVariantFileFor({ store, principal, pageInfo, servedFilePath, isStaticPage = false }) {
  if (!store) return null
  // The static site never substitutes. It is also principal-less, so the
  // courseId test below would catch it anyway — this is the explicit statement
  // of a standing ruling, kept where someone changing this will read it.
  if (isStaticPage) return null
  if (!principal?.courseId) return null
  if (!Array.isArray(pageInfo)) return null

  const entry = pageInfo.find(page => page.file === servedFilePath)
  const sourceFile = entry?.source?.file
  if (!sourceFile || !/\.qmd$/i.test(sourceFile)) return null

  const assignment = store.assignmentForBookPage(sourceFile.replace(/\.qmd$/i, '.html'), principal.courseId)
  if (!store.maySeeSolutionsFor(assignment, principal)) return null

  // `<stem>.solutions.qmd` is what the handout generator writes beside the
  // master, so the rendered sibling is found by asking page-info which output
  // that source produced rather than by guessing at the output's name.
  const solutionsSource = sourceFile.replace(/\.qmd$/i, '.solutions.qmd')
  return pageInfo.find(page => page.source?.file === solutionsSource)?.file || null
}
