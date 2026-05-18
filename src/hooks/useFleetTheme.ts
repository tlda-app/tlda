/**
 * useFleetTheme — restores custom theme from localStorage on mount
 * so the theme is applied before DarkModeToggle renders (no flash).
 */

import { useEffect } from 'react'

export type TldaTheme = 'warm' | 'fog-dark' | 'fog-light' | null

export const THEME_FAMILY: Record<string, 'dark' | 'light'> = {
  dark: 'dark',
  'fog-dark': 'dark',
  light: 'light',
  'fog-light': 'light',
  warm: 'light',
}

const THEME_BODY_CLASS: Record<string, string> = {
  warm: 'warm-mode',
  'fog-dark': 'fog-dark-mode',
  'fog-light': 'fog-light-mode',
}

const ALL_THEME_CLASSES = Object.values(THEME_BODY_CLASS)

export function getStoredTheme(): TldaTheme {
  const v = localStorage.getItem('tlda-theme')
  if (v && v in THEME_BODY_CLASS) return v as TldaTheme
  if (localStorage.getItem('tlda-warm-mode') === 'true') return 'warm'
  return null
}

export function applyThemeClass(theme: TldaTheme) {
  for (const cls of ALL_THEME_CLASSES) document.body.classList.remove(cls)
  if (theme) document.body.classList.add(THEME_BODY_CLASS[theme])
}

export function useFleetTheme() {
  useEffect(() => {
    applyThemeClass(getStoredTheme())
  }, [])
}
