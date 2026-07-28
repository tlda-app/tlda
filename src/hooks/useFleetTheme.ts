/**
 * useFleetTheme — restores theme on mount before DarkModeToggle renders (no flash).
 *
 * Two orthogonal axes:
 *   family  — 'fog' | 'warm' | 'lilac' | null (default tldraw)
 *   scheme  — 'dark' | 'light' | 'system'
 *
 * Body class is derived from family + resolved dark/light at runtime.
 * When scheme='system', re-applies on prefers-color-scheme change.
 */

import { useEffect, useState } from 'react'

export type ThemeFamily = 'fog' | 'warm' | 'lilac' | null
export type ColorScheme = 'dark' | 'light' | 'system'

export const FAMILY_KEY = 'tlda-theme-family'
export const SCHEME_KEY = 'tlda-color-scheme'

const FAMILY_BODY_CLASS: Record<string, { dark: string | null; light: string | null }> = {
  fog:  { dark: 'fog-dark-mode',  light: 'fog-light-mode' },
  warm: { dark: null,             light: 'warm-mode' },
  lilac: { dark: 'lilac-dark-mode', light: 'lilac-light-mode' },
}

const ALL_BODY_CLASSES = ['fog-dark-mode', 'fog-light-mode', 'warm-mode', 'lilac-dark-mode', 'lilac-light-mode']

function migrate() {
  if (localStorage.getItem(FAMILY_KEY) !== null) return
  const old = localStorage.getItem('tlda-theme')
  if (old === 'fog-dark') {
    localStorage.setItem(FAMILY_KEY, 'fog');  localStorage.setItem(SCHEME_KEY, 'dark')
  } else if (old === 'fog-light') {
    localStorage.setItem(FAMILY_KEY, 'fog');  localStorage.setItem(SCHEME_KEY, 'light')
  } else if (old === 'warm' || localStorage.getItem('tlda-warm-mode') === 'true') {
    localStorage.setItem(FAMILY_KEY, 'warm'); localStorage.setItem(SCHEME_KEY, 'light')
  } else {
    localStorage.setItem(FAMILY_KEY, '');     localStorage.setItem(SCHEME_KEY, 'system')
  }
}

export function getStoredFamily(): ThemeFamily {
  migrate()
  const v = localStorage.getItem(FAMILY_KEY)
  if (v === 'fog' || v === 'warm' || v === 'lilac') return v
  return null
}

export function setStoredFamily(f: ThemeFamily) {
  localStorage.setItem(FAMILY_KEY, f ?? '')
}

export function getStoredScheme(): ColorScheme {
  migrate()
  const v = localStorage.getItem(SCHEME_KEY)
  if (v === 'dark' || v === 'light' || v === 'system') return v
  return 'system'
}

export function setStoredScheme(s: ColorScheme) {
  localStorage.setItem(SCHEME_KEY, s)
}

export function resolveIsDark(scheme: ColorScheme): boolean {
  if (scheme === 'dark') return true
  if (scheme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyThemeClass(family: ThemeFamily, scheme: ColorScheme) {
  const isDark = resolveIsDark(scheme)
  const entry = family ? FAMILY_BODY_CLASS[family] : null
  const cls = entry ? (isDark ? entry.dark : entry.light) : null
  for (const c of ALL_BODY_CLASSES) document.body.classList.remove(c)
  if (cls) document.body.classList.add(cls)
}

export function useFleetTheme() {
  const [isDark, setIsDark] = useState(() => resolveIsDark(getStoredScheme()))

  useEffect(() => {
    const applyStoredTheme = () => {
      const scheme = getStoredScheme()
      applyThemeClass(getStoredFamily(), scheme)
      setIsDark(resolveIsDark(scheme))
    }
    applyStoredTheme()

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyStoredTheme)
    return () => mq.removeEventListener('change', applyStoredTheme)
  }, [])

  return isDark
}
