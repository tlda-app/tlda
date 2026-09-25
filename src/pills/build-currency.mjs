/**
 * Build currency for the document viewer — display only.
 *
 * Compares the revision the viewer rendered (the doc-version sentinel's
 * sourceRevision/acceptSeq, written by every successful build) against the
 * latest saved revision (GET /api/projects/:name's sourceRevision/acceptSeq,
 * from the same durable status the build routes already report). Nothing here
 * writes, polls the build queue, or starts anything: it names what is on
 * screen so "old pages shown as new" is impossible to miss.
 *
 * States:
 *   current        rendered == saved — quiet
 *   building       equal but a build is running — quiet
 *   stale-building diverged while a build runs — LOUD (a newer save is on its way)
 *   stale-dead     diverged with no build running — LOUD (a save has no
 *                  following build, as far as display can tell)
 *   failed         the newest revision's build settled as failed — LOUD
 *   unbuilt        saves exist but nothing rendered yet — LOUD
 *   unknown        neither side is known — quiet
 */

/** @param {unknown} revision */
export function shortRevision(revision) {
  if (revision == null) return null
  const s = String(revision).trim()
  if (!s || s === 'unknown') return null
  return s.slice(0, 7)
}

/** @param {unknown} lastBuild @param {number} [now] */
export function buildAgeLabel(lastBuild, now = Date.now()) {
  if (!lastBuild) return 'never built'
  const t = Date.parse(lastBuild)
  if (Number.isNaN(t)) return 'built at unknown time'
  const ms = now - t
  if (ms < 0) return 'built just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `built ${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `built ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `built ${h}h ago`
  return `built ${Math.floor(h / 24)}d ago`
}

function diverged(renderedRevision, renderedSeq, savedRevision, savedSeq) {
  if (Number.isInteger(renderedSeq) && Number.isInteger(savedSeq)) {
    return renderedSeq !== savedSeq
  }
  const r = shortRevision(renderedRevision)
  const s = shortRevision(savedRevision)
  if (r && s) return r !== s
  // One side names a sequence and the other does not: that is a lag the
  // display can see, not a match it can claim.
  if (Number.isInteger(savedSeq) && !Number.isInteger(renderedSeq)) return true
  return false
}

/**
 * @param {object} [options]
 * @param {unknown} [options.renderedRevision]
 * @param {unknown} [options.renderedSeq]
 * @param {unknown} [options.savedRevision]
 * @param {unknown} [options.savedSeq]
 * @param {unknown} [options.status]
 * @param {unknown} [options.lastBuild]
 * @param {number} [options.now]
 */
export function describeBuildCurrency({
  renderedRevision = null,
  renderedSeq = null,
  savedRevision = null,
  savedSeq = null,
  status = null,
  lastBuild = null,
  now = Date.now(),
} = {}) {
  const rendered = shortRevision(renderedRevision)
  const saved = shortRevision(savedRevision)
  const age = buildAgeLabel(lastBuild, now)
  const renderedName = rendered
    ? `rendered ${rendered}${Number.isInteger(renderedSeq) ? ` ·${renderedSeq}` : ''}`
    : 'rendered nothing yet'
  const savedName = saved
    ? `saved ${saved}${Number.isInteger(savedSeq) ? ` ·${savedSeq}` : ''}`
    : Number.isInteger(savedSeq)
      ? `saved ·${savedSeq}`
      : 'no save recorded'
  const base = `${renderedName} → ${savedName} · ${age}`

  if (status === 'error') {
    return {
      state: 'failed',
      loud: true,
      label: `BUILD FAILED — showing last success · ${base}`,
      title: 'The newest build failed, so these pages are the last success, not the current source.',
    }
  }
  if (!rendered && !Number.isInteger(renderedSeq)) {
    if (saved || Number.isInteger(savedSeq)) {
      return {
        state: 'unbuilt',
        loud: true,
        label: `NOTHING RENDERED — ${savedName} has no following build · ${age}`,
        title: 'Saves exist but no render does. Nothing on screen can be current.',
      }
    }
    return { state: 'unknown', loud: false, label: `build state unknown · ${age}`, title: 'Neither a render nor a save is recorded.' }
  }
  if (!saved && !Number.isInteger(savedSeq)) {
    return { state: 'unknown', loud: false, label: `${renderedName} · save state unknown · ${age}`, title: 'A render is on screen but no save is recorded.' }
  }
  if (diverged(renderedRevision, renderedSeq, savedRevision, savedSeq)) {
    if (status === 'building') {
      return {
        state: 'stale-building',
        loud: true,
        label: `STALE — newer save building · ${base}`,
        title: 'These pages lag the latest save; a build for it is running.',
      }
    }
    return {
      state: 'stale-dead',
      loud: true,
      label: `STALE — save has no following build · ${base}`,
      title: 'These pages lag the latest save and no build is running, as far as display can tell.',
    }
  }
  if (status === 'building') {
    return {
      state: 'building',
      loud: false,
      label: `building… · ${base}`,
      title: 'A build is running; these pages are the previous render until it lands.',
    }
  }
  return {
    state: 'current',
    loud: false,
    label: `${base}`,
    title: 'The render on screen matches the latest save.',
  }
}
