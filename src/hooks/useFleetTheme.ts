/**
 * useFleetTheme — restores warm-mode from localStorage on mount
 * so the theme is applied before DarkModeToggle renders (no flash).
 */

import { useEffect } from 'react'

export function useFleetTheme() {
  useEffect(() => {
    const cached = localStorage.getItem('tlda-warm-mode')
    if (cached === 'true') {
      document.body.classList.add('warm-mode')
    } else if (cached === 'false') {
      document.body.classList.remove('warm-mode')
    }
  }, [])
}
