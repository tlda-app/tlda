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
 * The mark for one declared row, from what each surface returned.
 *
 * Two surfaces, because the class site is the frontend: `preview` is what the
 * app is serving and `published` is what the class site is serving. There is no
 * third to reconcile.
 *
 * `undefined` and `null` are different answers and the difference is the whole
 * reason this takes them separately. `null` means THE SURFACE WAS ASKED AND
 * DOES NOT SERVE THIS PAGE, which is one of the states the mark is about.
 * `undefined` means NOBODY COULD ASK — the site was unreachable, the request
 * failed, no published address is known. Collapsing the two paints his entire
 * table of contents yellow the moment his network drops, which is a claim about
 * his book made out of a fact about ours.
 *
 * `alarm` is not a fourth shade and must not be drawn as one. It is the single
 * state that is broken rather than behind: the class site serving a page the
 * app cannot produce. That is not a stage of publishing, so it does not get a
 * place on a traffic light whose colours mean "further along".
 */
export function markForRow({ preview, published }) {
  if (preview === undefined || published === undefined) {
    return { mark: 'unknown', why: 'a surface could not be asked' }
  }
  if (!preview && published) {
    return { mark: 'alarm', why: 'the class site serves this and the app does not produce it' }
  }
  if (!preview && !published) {
    return { mark: 'red', why: 'declared, and no surface serves it' }
  }
  if (!published) {
    return { mark: 'yellow', why: 'written, and not on the class site' }
  }
  if (preview !== published) {
    return { mark: 'yellow', why: 'the class site serves different text' }
  }
  return { mark: 'green', why: 'the app and the class site serve the same text' }
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
 * Compare every page and return each row's mark.
 *
 * The app's side is READ, not fetched. The server holds the very bytes it
 * serves, so asking itself over HTTP would add a request that can fail for
 * reasons having nothing to do with his book — a proxy, a scheme, a busy
 * loopback — and every one of those failures would land as a colour on his
 * contents. The class site is genuinely elsewhere and is genuinely asked.
 *
 * Failures are answers, and which answer matters. A page a surface does not
 * have is `null` — absent, one of the states the mark is about. A surface that
 * could not be consulted at all is `undefined`, which `markForRow` reads as
 * "not asked" and refuses to colour. A slow class site must not repaint his
 * table of contents.
 */
export async function compareCourseSurfaces(pages, { readPreview, publishedBase, fetchImpl = fetch }) {
  const fetched = async url => {
    if (!url) return undefined
    try {
      const response = await fetchImpl(url)
      if (response.status === 404) return null
      if (!response.ok) return undefined
      return documentTextFingerprint(await response.text())
    } catch {
      return undefined
    }
  }
  const read = async path => {
    try {
      const html = await readPreview(path)
      return html == null ? null : documentTextFingerprint(html)
    } catch {
      return undefined
    }
  }
  return marksForRows(await Promise.all(pages.map(async (page, index) => {
    const path = publicationPathForPage(page.file)
    const [preview, published] = await Promise.all([read(path), fetched(publishedUrlForPage(page.file, publishedBase))])
    return { page: index + 1, source: page.source?.file || null, preview, published }
  })))
}
