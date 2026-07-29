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

export type HlSlot = { id: string; color: string; label: string; svgIcon?: string }

export function hlMaskUrl(slot: HlSlot): string {
  if (slot.svgIcon) return slot.svgIcon
  return `${TLDRAW_ICON_BASE}#tool-highlight`
}

export const HL_SLOTS: HlSlot[] = [
  { id: 'eraser', color: '#888', label: 'eraser', svgIcon: `${TLDRAW_ICON_BASE}#tool-eraser` },
  { id: 'black', color: '#1d1d1d', label: 'cut' },
  { id: 'light-red', color: '#dc2626', label: 'wrong' },
  { id: 'orange', color: '#ff8c40', label: 'expand' },
  { id: 'yellow', color: '#ffc940', label: 'question' },
  { id: 'grey', color: '#9fa1a4', label: 'compress' },
  { id: 'light-violet', color: '#e0d4f5', label: 'outline' },
  { id: 'light-blue', color: '#4ea2e2', label: 'notation' },
  { id: 'light-green', color: '#65c365', label: 'approve' },
  { id: 'violet', color: '#c77cff', label: 'personal' },
  { id: 'draw', color: '#666', label: 'pen', svgIcon: `${TLDRAW_ICON_BASE}#tool-pencil` },
  { id: 'select', color: '#888', label: 'browse', svgIcon: BROWSE_ICON_URL },
]
