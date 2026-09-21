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
export function markForRow({
  app,
  preview,
  live,
  failure = null,
  target = 'the published site',
  reasons = {},
  previewConfigured = true,
  publishedConfigured = true,
}) {
  // A DESTINATION NOBODY CONFIGURED IS NOT A DESTINATION THAT FAILED.
  //
  // Skip, 2026-09-20: "on projects with no preview target, disable the preview
  // related checks/ui; similarly with publish" — and, on what he was seeing:
  // "if there is no preview or publish destination, why would i be troubled by
  // that. that's most projects".
  //
  // The defect this removes: an unconfigured address arrived here as
  // `undefined`, which this file reserves for NOBODY COULD ASK — an error about
  // us. So every project that had never opted into preview or publishing wore a
  // complaint about failing to reach somewhere it was never pointed. Absent and
  // broken were sharing one value, which is the exact mistake the `undefined` /
  // `null` split above exists to prevent, one level down.
  //
  // Configured-but-dead is untouched and still named: a preview address that
  // does not answer is a real failure and says which address and why.
  if (!previewConfigured && !publishedConfigured) {
    return { stage: null, error: failure || null, errorAt: null, why: failure || null, destinations: false }
  }

  const unreachable = [
    ['the app', app, reasons.app, true],
    ['preview', preview, reasons.preview, previewConfigured],
    [target, live, reasons.live, publishedConfigured],
  ]
    .filter(([, value, , configured]) => configured && value === undefined)
    .map(([label, , reason]) => (reason ? `${label} (${reason})` : label))
  if (unreachable.length > 0) {
    // WHY THE REASON IS IN THE SENTENCE. "preview could not be asked" was the
    // identical text for a field nobody had set and for a host the server
    // cannot resolve, and telling those apart cost three measurements and a
    // probe from inside the machine on 2026-09-20. The fetch already knows
    // which it was; discarding it and making the reader rediscover it is the
    // same defect this column exists to remove.
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
  //
  // A surface nobody configured is not a step the page failed to reach — but
  // it is not a step it PASSED either. With no publish destination the chain
  // ends at preview: the furthest real stage, never `published`, because
  // claiming a page is published to a place that does not exist is a worse lie
  // than the complaint this change removes.
  const stage = previewConfigured
    ? (app !== preview ? 'here-only'
      : publishedConfigured ? (app === live ? 'published' : 'preview')
      : 'preview')
    : (app === live ? 'published' : 'here-only')

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
    // NAME THE TARGET RATHER THAN CALLING IT "the class site". Where a course
    // publishes is configured, and on 2026-09-20 it was his test site while he
    // reviewed it -- so "the class site is serving what you wrote" was a
    // sentence reading as reassurance about a site he did not mean. A row that
    // names what it compared stays true when somebody flips `publication.url`,
    // and a reader who was not there can tell which surface answered.
    // Do not name a destination this project does not have. "on preview, not
    // yet on the published site" is the same lie as the complaint above, in a
    // calmer voice: it tells the reader a step remains when there is no such
    // step. With nowhere to publish, reaching preview is arriving.
    why: error || (
      stage === 'published' ? `${target} is serving what you wrote`
      : stage === 'preview' ? (publishedConfigured ? `on preview, not yet on ${target}` : 'on preview')
      : previewConfigured ? 'not on preview yet'
      : `not on ${target} yet`
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

/**
 * Where the course publishes, from the course itself.
 *
 * NOT a second hand-set field. A project that publishes somewhere already knows
 * where it publishes — `course-release.json`'s `publication.url`, the same
 * block `build-site.py` refuses on — so asking it also to be told where its
 * class site is makes two facts that must agree and one that nobody sets. That
 * is exactly how this went invisible: the marks needed a field only I had ever
 * set, so every other course had none and drew nothing. Skip, on a different
 * duplication the same night: "whatever suits you just tryimg ti make sure we
 * dont du-licate shit".
 *
 * The published tree sits under `static/` beneath that URL on both sites, which
 * is the publication layout rather than a guess: the publication root is a
 * redirect stub to `static/` (`course-publication-build.mjs`), and both the
 * class site and the test site serve `<publication.url>/static/book/index.html`
 * — measured on each, with an invented filename returning 404 as a control.
 */
export function publishedBaseFromCourse(courseRelease) {
  const url = courseRelease?.publication?.url
  if (typeof url !== 'string' || !url) return null
  return `${url.replace(/\/$/, '')}/static`
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
  target = 'the published site',
  // Whether this project HAS each destination. Defaulted from the addresses so
  // a caller that knows no better still gets the right answer, and passed
  // explicitly by one that does — `readPreview` is a function either way, so
  // its presence says nothing about whether a preview address exists.
  previewConfigured = true,
  publishedConfigured = Boolean(publishedBase),
}) {
  // The reason travels with the value, and per row rather than shared. An
  // empty catch here is what made "could not be asked" mean both "nobody
  // configured it" and "the host does not resolve" -- see markForRow -- and a
  // shared record would report one page's failure against another's row.
  const probe = reasons => {
    const fingerprintOf = async (read, surface) => {
      try {
        const html = await read()
        if (html === undefined) return undefined
        return html === null ? null : documentTextFingerprint(html)
      } catch (e) {
        reasons[surface] = String(e?.message || e).slice(0, 200)
        return undefined
      }
    }
    const fetched = (url, surface) => fingerprintOf(async () => {
      if (!url) {
        reasons[surface] = 'no address configured'
        return undefined
      }
      const response = await fetchImpl(url)
      if (response.status === 404) return null
      if (!response.ok) {
        reasons[surface] = `${url} answered ${response.status}`
        return undefined
      }
      return await response.text()
    }, surface)
    return { fingerprintOf, fetched }
  }
  return marksForRows(await Promise.all(pages.map(async (page, index) => {
    const path = publicationPathForPage(page.file)
    const reasons = {}
    const { fingerprintOf, fetched } = probe(reasons)
    // DISABLE THE CHECK, not just the message. Skip: "disable the preview
    // related checks/ui". An unconfigured destination is not fetched at all —
    // asking and then discarding the answer would still spend a round trip per
    // row, per read, on most projects in the fleet, to learn something the
    // configuration already said.
    const [app, preview, live] = await Promise.all([
      fingerprintOf(() => readApp(path), 'app'),
      previewConfigured ? fingerprintOf(() => readPreview(path), 'preview') : undefined,
      publishedConfigured ? fetched(publishedUrlForPage(page.file, publishedBase), 'live') : undefined,
    ])
    return {
      page: index + 1,
      source: page.source?.file || null,
      app,
      preview,
      live,
      target,
      reasons,
      previewConfigured,
      publishedConfigured,
      failure: failureFor(page) || null,
    }
  })))
}
