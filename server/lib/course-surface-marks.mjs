/**
 * What each declared row of a course is, across the surfaces that serve it.
 *
 * The question this answers is Skip's: is what I'm teaching what I wrote. It is
 * answered by ASKING THE SURFACES AND COMPARING WHAT COMES BACK. Nothing here
 * reads a release manifest, a deploy log, or a build record — a record saying a
 * thing was published is exactly what put stale solutions in front of a class,
 * so a mark computed from one would report on the publishing process rather
 * than on the pages. A process can be changed; these marks must not change with
 * it.
 */

import { createHash } from 'node:crypto'

/**
 * A document's visible text, as one short hash.
 *
 * NOT the bytes. Both app hosts carry a `static/` tree that is the same render
 * GitHub Pages publishes, and the two never match byte-for-byte: tlda stamps
 * `data-source-line` into every block for source mapping and `?v=<ms>` onto
 * every figure URL, and the two builds differ in Quarto asset hashes, in a
 * MathJax macro block, in `rel="prev"`, and in attribute order. All of that is
 * chrome, and a comparator that fires on it reports a difference on every row
 * forever, which is the same as reporting nothing.
 *
 * Stripping to visible text ignores every bit of that and still catches a
 * changed word, a changed number, and a changed answer — which is the whole of
 * what the question is about.
 */
export function documentTextFingerprint(html) {
  const scoped = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const text = (scoped ? scoped[1] : html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * The mark for one declared row: WHERE IN THE CHAIN it has got to, and WHICH
 * LINK OF THE CHAIN IS BROKEN.
 *
 * THREE SURFACES IN ORDER, not two compared. Skip:
 *
 *   "the stage where thye disagree"
 *   "if they disagree on preview its an error on preview"
 *   "if they agree on preview but disagree on live its an error on live"
 *
 * So the chain is what he wrote → preview → live, and the error names the FIRST
 * link that broke. An earlier version of this took two arguments and said in
 * its own comment that there was "no third to reconcile"; there is, and the
 * question changed shape rather than answer. A two-surface comparison cannot
 * tell "preview never got it" from "preview got it and live did not", and those
 * are different failures belonging to different people.
 *
 * `undefined` and `null` are different answers throughout. `null` means THE
 * SURFACE WAS ASKED AND DOES NOT SERVE THIS PAGE, which is part of the chain.
 * `undefined` means NOBODY COULD ASK, which is an error about us — and now it
 * can say which surface could not be reached, rather than only that one could
 * not. Saying nothing was the bug that kept this invisible for three weeks.
 */
export function markForRow({ app, preview, live, failure = null }) {
  const unreachable = [['the app', app], ['preview', preview], ['the class site', live]]
    .filter(([, value]) => value === undefined)
    .map(([label]) => label)
  if (unreachable.length > 0) {
    const named = unreachable.join(' and ')
    return { stage: null, error: `${named} could not be asked`, errorAt: null, why: `${named} could not be asked` }
  }

  // HOW FAR THE CURRENT VERSION HAS GOT. The word doing the work is *current*:
  // stale content on live is not arrival. He does not care what is on live if
  // it is not what he wrote, so a class site serving an old page is YELLOW —
  // the current thing is sitting on preview — and not green-with-a-problem.
  //
  //   red     the current version has not reached preview
  //   yellow  the current version is on preview, not on live
  //   green   the current version is on live
  const stage = app === preview
    ? (app === live ? 'published' : 'preview')
    : 'here-only'

  // WHETHER WE KNOW IT BROKE. Skip, after revising this twice in three minutes:
  //
  //   don't know   → try (backed off, not hammered).   no triangle.
  //   try failed   → now you know.                     triangle.
  //   known error  → stop retrying; the triangle IS the action.
  //   cause fixed  → the next check clears it by itself.
  //
  // "its mot an error until you know there is an error". So the triangle is
  // never derived — not from absence, not from staleness, not from an attempt
  // that finished without delivering. Ambiguity is not an error; it is a reason
  // to try again, and trying is somebody else's job.
  //
  // This is why the mark holds no state and nothing is ever acknowledged: it is
  // recomputed from the surfaces and the current build outcome on every read,
  // so a fixed cause takes its own triangle down. A mark that needs a person to
  // clear it goes stale and then gets ignored, which is how this column became
  // invisible the first time.
  const error = failure || null
  const errorAt = failure ? (app === preview ? 'live' : 'preview') : null

  return {
    stage,
    error,
    errorAt,
    why: error || (
      stage === 'published' ? 'the class site is serving what you wrote'
      : stage === 'preview' ? 'on preview, not yet on the class site'
      : 'not on preview yet'
    ),
  }
}

/**
 * Every declared row's mark, from fingerprints already gathered.
 *
 * Gathering is the caller's job so that this stays a comparison and nothing
 * else: the surfaces are asked over HTTP, which is slow, fallible, and the part
 * that needs a credential for the app. None of that belongs in the rule that
 * decides what colour a row is.
 */
export function marksForRows(rows) {
  return rows.map(row => ({ ...row, ...markForRow(row) }))
}

/**
 * Where one built page sits, within the publication both surfaces carry.
 *
 * A publication build writes both trees from one render, so every page is
 * recorded once — under `app/` — and exists in `static/` beside it under the
 * same remaining path. That common path is what addresses the class site and
 * what names the file on disk.
 *
 * The `app/` tree is never the one compared, and that is deliberate:
 * `/docs/<project>/app/…` answers 200 with the reader shell for ANY path,
 * invented ones included, so a comparison addressed there fingerprints the same
 * shell for every row and reports a book in perfect agreement with itself.
 */
export function publicationPathForPage(file) {
  return String(file).replace(/^app\//, '')
}

export function publishedUrlForPage(file, publishedBase) {
  if (!publishedBase) return null
  return `${publishedBase.replace(/\/$/, '')}/${publicationPathForPage(file)}`
}

/**
 * Ask all three surfaces for every page and return each row's mark.
 *
 * THREE, IN ORDER: what he wrote, preview, live. Two of them cannot tell
 * "preview never got it" from "preview got it and live did not", and those are
 * different failures belonging to different steps.
 *
 * How each side is obtained is the caller's business; what matters here is that
 * none of them is assumed. A side nobody could ask yields `undefined` and the
 * row says which one, rather than quietly falling back to something local that
 * would answer a different question in the same shape.
 *
 * Failure outcomes are passed through untouched. Nothing here derives a failure
 * from an absence — that is the whole point of taking them separately.
 */
export async function compareCourseSurfaces(pages, {
  readApp,
  readPreview,
  publishedBase,
  fetchImpl = fetch,
  failureFor = () => null,
}) {
  const fingerprintOf = async read => {
    try {
      const html = await read()
      if (html === undefined) return undefined
      return html === null ? null : documentTextFingerprint(html)
    } catch {
      return undefined
    }
  }
  const fetched = url => fingerprintOf(async () => {
    if (!url) return undefined
    const response = await fetchImpl(url)
    if (response.status === 404) return null
    if (!response.ok) return undefined
    return await response.text()
  })
  return marksForRows(await Promise.all(pages.map(async (page, index) => {
    const path = publicationPathForPage(page.file)
    const [app, preview, live] = await Promise.all([
      fingerprintOf(() => readApp(path)),
      fingerprintOf(() => readPreview(path)),
      fetched(publishedUrlForPage(page.file, publishedBase)),
    ])
    return {
      page: index + 1,
      source: page.source?.file || null,
      app,
      preview,
      live,
      failure: failureFor(page) || null,
    }
  })))
}
