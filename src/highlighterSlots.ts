export const TLDRAW_ICON_BASE = 'https://cdn.tldraw.com/4.3.1/icons/icon/0_merged.svg'

const _browseStarburst = (() => {
  const cx = 12.5, cy = 5.5, rOuter = 5, rInner = 1.8, spikes = 8
  const pts = []
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes - Math.PI / 2
    const r = i % 2 === 0 ? rOuter : rInner
    pts.push(`${+(cx + Math.cos(angle) * r).toFixed(1)},${+(cy + Math.sin(angle) * r).toFixed(1)}`)
  }
  return pts.join(' ')
})()

export const BROWSE_ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M2 4.5l1 11 2.8-3.5 4.2 1.8L2 4.5z" fill="currentColor"/><polygon points="${_browseStarburst}" fill="currentColor"/></svg>`
)}`

// The light-violet "outline" highlighter isn't a marking color — it extracts the
// highlighted region into a sticky note. To stay in-family with the other highlighters
// (same tldraw `tool-highlight` glyph), it's the identical marker with a little note
// inscribed on its body — the way a marker carries a band of its own color to say what
// it is. Here the band is a note, hinting "this is the note-creation marker." Rendered
// as a CSS mask, so it's a solid lilac silhouette like the rest.
export const OUTLINE_HL_ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="m13.102 25.123 13.593-14.711a2 2 0 0 0-.055-2.771l-3.275-3.276a2 2 0 0 0-2.777-.05L5.983 17.919m7.118 7.205-7.118-7.206m7.118 7.206c-.5-.167-1.8-.586-3-.586s-2.5 1-3 1.5m-1.118-8.12c.167.5.619 1.92.619 3.12s-1 2.5-1.5 3m2 2-1-1-1-1m2 2-1 1L2 27.14l3.103-3.103"/>` +
  `<path fill="currentColor" stroke="none" d="m2 26 2-2 2 2-1 1z"/>` +
  `<g transform="translate(15.17 12.0)"><path fill="currentColor" stroke="none" d="M0.8 0 H3.7 L5.2 1.5 V4.4 a0.8 0.8 0 0 1 -0.8 0.8 H0.8 a0.8 0.8 0 0 1 -0.8 -0.8 V0.8 a0.8 0.8 0 0 1 0.8 -0.8 Z"/></g>` +
  `</svg>`
)}`

export type HlSlot = { id: string; color: string; label: string; svgIcon?: string }

export const HL_SLOTS: HlSlot[] = [
  { id: 'eraser', color: '#888', label: 'eraser', svgIcon: `${TLDRAW_ICON_BASE}#tool-eraser` },
  { id: 'black', color: '#1d1d1d', label: 'cut' },
  { id: 'light-red', color: '#dc2626', label: 'wrong' },
  { id: 'orange', color: '#ff8c40', label: 'expand' },
  { id: 'yellow', color: '#ffc940', label: 'question' },
  { id: 'grey', color: '#9fa1a4', label: 'compress' },
  { id: 'light-blue', color: '#4ea2e2', label: 'notation' },
  { id: 'light-green', color: '#65c365', label: 'approve' },
  { id: 'violet', color: '#c77cff', label: 'personal' },
  { id: 'select', color: '#888', label: 'browse', svgIcon: BROWSE_ICON_URL },
  { id: 'draw', color: '#666', label: 'pen', svgIcon: `${TLDRAW_ICON_BASE}#tool-pencil` },
  // Outline highlighter: behavior differs from the marking colors (it extracts a
  // clause-outline of the highlighted region), so it sits apart at the bottom edge.
  { id: 'light-violet', color: '#e0d4f5', label: 'outline' },
]
