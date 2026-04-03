// tldaUrl.mjs — centralized tlda URL detection

/**
 * Returns the base URL of this tlda instance.
 * Falls back to window.location.origin so worktrees on any port work automatically.
 */
export function myTldaUrl() {
  return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TLDA_URL)
    || window.location.origin
}

/**
 * Returns true if the given URL belongs to this tlda instance.
 */
export function isTldaUrl(url) {
  try {
    return new URL(url).origin === myTldaUrl()
  } catch {
    return false
  }
}
