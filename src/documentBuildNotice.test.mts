/**
 * A failed newest build over a still-served older render must say so.
 *
 * `emptyDocumentNotice` owns pages === 0. When pages > 0 and the newest
 * build failed, the viewer loaded the stale render with no failure
 * indication at all — measured on testing 2026-09-24: a project whose
 * dispatches died at the executor revision check kept serving its old
 * pages and reported nothing. `staleBuildNotice` is the banner half.
 */
import { staleBuildNotice } from './documentBuildNotice'

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

// 1. FAILED NEWEST BUILD OVER STALE PAGES — the banner fires.
{
  const notice = staleBuildNotice('deck', 'error', 48)
  if (!notice) throw new Error('error + pages > 0: expected a banner notice, got null')
  equal(notice.kind, 'stale-build-failed', 'kind')
  if (!notice.message.includes('deck')) throw new Error(`banner names the document: got ${notice.message}`)
}

// 2. NO PAGES — the empty-document path owns this; no banner.
equal(staleBuildNotice('deck', 'error', 0), null, 'error + 0 pages')

// 3. BUILD IN FLIGHT OVER STALE PAGES — a render is on its way, not a failure.
equal(staleBuildNotice('deck', 'building', 48), null, 'building + pages')

// 4. HEALTHY — nothing to report.
equal(staleBuildNotice('deck', 'success', 48), null, 'success + pages')
equal(staleBuildNotice('deck', undefined, 48), null, 'unknown + pages')

console.log('staleBuildNotice: 5 checks passed')
