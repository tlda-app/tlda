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
// highlighted region into a sticky note. Its glyph says exactly that: a highlighter
// with a little note card peeling off the corner. Rendered as a CSS mask, so it's a
// solid silhouette tinted lilac like the rest. A gap separates the card from the
// marker so the two read as distinct (mask alpha can't draw an outline between them).
export const OUTLINE_HL_ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
  `<g transform="rotate(-42 11 13)">` +
  `<rect x="8.2" y="9" width="5.6" height="8" rx="1.3" fill="currentColor"/>` +
  `<rect x="8.2" y="6.9" width="5.6" height="2.4" rx="0.8" fill="currentColor"/>` +
  `<polygon points="8.2,17 13.8,17 11,21" fill="currentColor"/>` +
  `</g>` +
  `<g transform="rotate(14 18 6)">` +
  `<rect x="14.3" y="2.6" width="7.4" height="7.4" rx="1.4" fill="currentColor"/>` +
  `</g>` +
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
