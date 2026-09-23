/**
 * What one ToC row is, and what to say about it.
 *
 * Two axes reach a row. The publication axis (here-only / preview /
 * published) says where the page is on the way to the class site; the
 * build axis (the currency below, plus the project's build state) says
 * whether the render is what he wrote. This resolves the two into one
 * light, one sentence, and at most one span.
 *
 * Pure: no editor, no fetch, tested directly.
 */

/**
 * Whether the render of a row is as new as the source it came from. The stage
 * before the publication one: that one is about the class site, this one is
 * about the build, and a row can be behind at either.
 */
export type PageCurrency = 'current' | 'stale' | 'unrendered' | 'unknown'

/**
 * The light a row wears. The stage rings say where the page is on the way to
 * the class; the flat colours say something is standing between what he wrote
 * and the page — a build that did not succeed, a page never rendered, a page
 * older than its source, or a build still running.
 */
export type TocRowLight =
  | 'here-only' | 'preview' | 'published'
  | 'green' | 'yellow' | 'red'

export type TocTimingRow = {
  stage: 'here-only' | 'preview' | 'published' | null
  /** The comparison's own sentence — the publication axis, carried verbatim. */
  why: string
  currency?: PageCurrency | null
  sourceEditedAt?: number | null
  renderedAt?: number | null
  behindMs?: number | null
  flipMs?: number | null
}

/**
 * The last build of the project these rows belong to. Not per page: nothing
 * records that. `lastBuild` is when the build BEGAN — it is rewritten at the
 * start of every run — and `logModified` is when it stopped, which is the one
 * that dates a failure.
 */
export type TocBuildState = { status: string | null; lastBuild: string | null; logModified: string | null }
export const NO_BUILD: TocBuildState = { status: null, lastBuild: null, logModified: null }

// A render that followed an edit by longer than this did not follow THAT edit:
// it is a rebuild of a page nobody touched, and the gap between them measures
// how long ago he last wrote it rather than how long the turnaround took. Long
// enough to cover a slow book build, short enough that nothing else lands in it.
export const FLIP_WINDOW_MS = 10 * 60 * 1000

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function span(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export type TocRowState = {
  light: TocRowLight
  /** The bad cases, where the bullet becomes a caution glyph. */
  caution: boolean
  title: string
  /** What is shown on the row itself, when there is a span worth reading. */
  timing: string | null
}

/**
 * What one row is, and what to say about it.
 *
 * The order is the order things go wrong in: a build that did not succeed, then
 * a page the build never wrote, then a page older than its source, then a build
 * still running, and only then the class site. A row stops at the first of
 * those that is true, because that is the thing standing between what he wrote
 * and what he is looking at.
 *
 * Every line names the condition and carries the clock times it was read from.
 * Skip, 2026-09-19: "tooltips explaining issues on the toc would be cool btw
 * like is red just timing or a build error; is yellow that deoloy" — so the
 * text answers that question rather than spelling out the colour.
 */
export function rowState(row: TocTimingRow | undefined, build: TocBuildState): TocRowState | null {
  const rendered = row?.renderedAt != null ? `rendered ${clockTime(row.renderedAt)}` : 'never rendered'
  const edited = row?.sourceEditedAt != null ? `edited ${clockTime(row.sourceEditedAt)}` : null

  if (build.status === 'error') {
    // Not "the build failed": a compile killed by the OS, one stopped for
    // running past its limit, and a document that does not compile all arrive
    // here as this one recorded state. The runner holds the child's exit code
    // and signal at the moment it fails and stores neither, so naming a cause
    // would be inventing one. A build that was CANCELLED is a different durable
    // state and is deliberately not drawn as this one — a newer revision taking
    // over is not a failure, and the row falls through to what its render
    // actually is.
    const when = build.logModified ? ` at ${clockTime(new Date(build.logModified).getTime())}` : ''
    return {
      light: 'red',
      caution: true,
      title: `The last build did not succeed${when} — the system does not record why. This page: ${rendered}.`,
      timing: null,
    }
  }
  if (row?.currency === 'unrendered') {
    return {
      light: 'red',
      caution: true,
      title: edited
        ? `No render of this page exists. Its source was ${edited}.`
        : 'No render of this page exists.',
      timing: null,
    }
  }
  if (row?.currency === 'stale' && row.behindMs != null) {
    return {
      light: 'yellow',
      caution: true,
      title: `Older than what you wrote: ${edited}, ${rendered} — ${span(row.behindMs)} behind.`,
      timing: `${span(row.behindMs)} behind`,
    }
  }
  if (build.status === 'building') {
    const since = build.lastBuild ? ` since ${clockTime(new Date(build.lastBuild).getTime())}` : ''
    return { light: 'yellow', caution: false, title: `A build is running${since}. This page: ${rendered}.`, timing: null }
  }

  // Nothing is between him and this page, so the row goes back to saying where
  // it is on the way to the class. `current` is the weaker claim it sounds
  // like: modification time is the only oracle, so it means not detectably
  // stale rather than certainly current.
  const flip = row?.flipMs != null && row.flipMs <= FLIP_WINDOW_MS ? span(row.flipMs) : null
  const turnaround = flip ? ` Rendered ${flip} after you saved.` : ''
  if (!row || !row.stage) {
    if (row?.currency !== 'current') return null
    return { light: 'green', caution: false, title: `Not detectably stale: ${edited}, ${rendered}.${turnaround}`, timing: flip }
  }
  return {
    light: row.stage,
    caution: false,
    title: `${row.why}. This page: ${rendered}.${turnaround}`,
    timing: flip,
  }
}
