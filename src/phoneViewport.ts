export function isPhoneViewport(): boolean {
  if (typeof window === 'undefined') return false
  const w = window.visualViewport?.width || window.innerWidth
  const h = window.visualViewport?.height || window.innerHeight
  if (Number.isFinite(w) && Number.isFinite(h) && Math.min(w, h) <= 600) return true
  return !!window.matchMedia?.('(max-width: 600px), (max-height: 600px)').matches
}
