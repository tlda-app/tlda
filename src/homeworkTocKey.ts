// Joining a table-of-contents row to its homework assignment.
//
// Kept in its own module, free of imports, because the join is the part worth
// testing and `synctexLookup` — where `HtmlTocEntry` lives — pulls in the yjs
// sync client and the injected runtime config, so it cannot be loaded outside a
// browser.

/** The shape this join needs. A subset of `HtmlTocEntry`. */
export interface TocRowForHomework {
  level: string
  page?: number
  targetFile?: string
}

/**
 * The key a TOC row uses to find its homework assignment, or undefined.
 *
 * An assignment records the rendered page it lives on as `bookPageFile`, which
 * is how a chapter row reaches a submission without either side inferring the
 * other from a project name. The two kinds of row get there differently.
 *
 * A BOOK row carries `targetFile`, written by `aggregateBookToc` as the member
 * key. That is the pre-existing path and is returned unchanged.
 *
 * A COURSE row — the multi-page project, which is the model in use — carries
 * only `level`, `page` and `title`. There is no file on it, so the join runs
 * through the project's own ordered `pageFiles`, and `page` indexes that
 * 1-based. Measured 2026-09-13 on `qtm285-course`: `page` runs 1..85 against 85
 * files, and every row resolves in the 1-based column.
 *
 * **The offset is stated here rather than left to the call site because getting
 * it wrong is not a miss.** Read 0-based, the "Homework 0" row resolves to
 * `homework-descriptive-solutions.html` — the next file along is that homework's
 * SOLUTIONS. A wrong answer that looks like a right one.
 *
 * `pageFiles` carries the `_book/` prefix and `bookPageFile` does not. The
 * server already strips it when it matches, so stripping here keeps the stored
 * value the single spelling both sides agree on.
 */
export function homeworkKeyForTocRow(
  row: TocRowForHomework,
  pageFiles: readonly string[] = [],
): string | undefined {
  if (row.level !== 'chapter') return undefined
  if (row.targetFile) return row.targetFile
  if (typeof row.page !== 'number') return undefined
  const file = pageFiles[row.page - 1]
  return file ? file.replace(/^_book\//, '') : undefined
}
