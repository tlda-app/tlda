/**
 * useFleetTheme — restores custom theme from localStorage on mount
 * so the theme is applied before DarkModeToggle renders (no flash).
 */

import { useEffect } from 'react'

const THEME_CLASSES = ['warm-mode', 'fog-dark-mode', 'fog-light-mode'] as const

export type TldaTheme = 'warm' | 'fog-dark' | 'fog-light' | null

export function getStoredTheme(): TldaTheme {
  const v = localStorage.getItem('tlda-theme')
  if (v === 'warm' || v === 'fog-dark' || v === 'fog-light') return v
  if (localStorage.getItem('tlda-warm-mode') === 'true') return 'warm'
  return null
}

export function applyThemeClass(theme: TldaTheme) {
  for (const cls of THEME_CLASSES) document.body.classList.remove(cls)
  if (theme === 'warm') document.body.classList.add('warm-mode')
  else if (theme === 'fog-dark') document.body.classList.add('fog-dark-mode')
  else if (theme === 'fog-light') document.body.classList.add('fog-light-mode')
}

export function useFleetTheme() {
  useEffect(() => {
    applyThemeClass(getStoredTheme())
  }, [])
}
