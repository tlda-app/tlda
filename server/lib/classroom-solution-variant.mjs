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

  // Two shapes can carry a solutions rendering and the build has not settled
  // which: an ALTERNATE of the homework chapter, same `source.file` and a
  // second `file`; or a SEPARATE non-chapter source, `<stem>.solutions.qmd`,
  // which is what the one existing solutions page is. Serving does not need to
  // care, so it does not: `variant` is the field page-info already uses to say
  // what a rendering IS — the decks carry `variant: 'slides'` — and a solutions
  // rendering marked the same way is found whichever way the build made it.
  //
  // The source match below is the fallback for the rendering that exists today,
  // which predates any such mark. Neither branch guesses at an output filename.
  const solutionsSource = sourceFile.replace(/\.qmd$/i, '.solutions.qmd')
  const solutions = pageInfo.find(page => (
    page.variant === 'solutions'
    && (page.source?.file === sourceFile || page.source?.file === solutionsSource)
  )) || pageInfo.find(page => page.source?.file === solutionsSource)

  // Never hand back the page that was asked for: that is not a substitution,
  // and returning it would make an entitled reader's request read as satisfied
  // when nothing was substituted.
  return solutions?.file && solutions.file !== servedFilePath ? solutions.file : null
}
