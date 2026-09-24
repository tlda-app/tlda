/**
 * What the app says about a project that has no rendered pages.
 *
 * `pages === 0` has two causes that look identical on screen and call for
 * opposite things: a build that has not finished yet, and a build that failed.
 * The config already carries which one it is — `buildStatus` is `error` the
 * moment the newest revision's build phase settles as failed — and the loader
 * said `Waiting for …` to both, forever, because the poll it starts only ever
 * breaks on pages appearing.
 *
 * Measured on `testing` at `cfcb83bb2`: a project whose Quarto render failed
 * reported `buildStatus: error` and `pages: 0`, and a reader following a link
 * to it sat on a waiting screen past two minutes with nothing in the console.
 * A reader told the build failed can say so to whoever owns the document; a
 * reader watching a spinner cannot tell that from a slow network, and assumes
 * the fault is theirs.
 */

export type EmptyDocumentNotice =
  | { kind: 'waiting'; message: string }
  | { kind: 'build-failed'; message: string }

/**
 * Only `error`. `building` and `unknown` are a document on its way, and
 * `cancelled`, `superseded` and `not_required` all mean some other revision is
 * the live one — none of those is a render that went wrong, and reporting them
 * as failure would put a red screen in front of a document that is about to
 * arrive.
 */
export function emptyDocumentNotice(label: string, buildStatus?: string): EmptyDocumentNotice {
  if (buildStatus === 'error') {
    return { kind: 'build-failed', message: `The last build of "${label}" failed, so it has no pages to show.` }
  }
  return {
    kind: 'waiting',
    message: buildStatus === 'building' ? `Building ${label}...` : `Waiting for ${label}...`,
  }
}

/**
 * The reason to put under that sentence, from `GET /:name/build/errors`.
 *
 * `logMissing` is not decoration: an empty `errors` is only good news when it
 * is false, and without it "failed" and "failed for a reason nobody kept" read
 * the same. Saying the reason was not recorded is worth a line of its own.
 */
export function buildFailureReason(errors?: unknown[], logMissing?: boolean): string | null {
  const first = (errors || []).map(entry => String(entry ?? '').trim()).find(Boolean)
  if (first) return first
  if (logMissing) return 'No build log was kept, so the reason was not recorded.'
  return null
}
