/**
 * Return why the bibliography tool must run after a LaTeX pass, or null when
 * the cached bibliography is current. Biblatex's rerun warning is authoritative:
 * it can be present even when a cached .bbl keeps every citation defined.
 */
export function bibliographyRunReason({ hasBbl, logText }) {
  if (!hasBbl) return 'missing-bbl'
  if (logText.includes('Citation') && logText.includes('undefined')) {
    return 'undefined-citations'
  }
  if (/Please\s+\(re\)run\s+Biber\b/i.test(logText)) {
    return 'biber-rerun-requested'
  }
  return null
}
