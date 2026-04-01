/**
 * useFleetTheme — subscribes to fleet's theme SSE stream and applies
 * warm-mode class on body to match fleet's current theme.
 *
 * Fleet broadcasts: { theme: "warm" | "dark" | "light" }
 * tlda applies: body.warm-mode (on for "warm", off otherwise)
 */

import { useEffect } from 'react'

const FLEET_URL = 'http://localhost:5199/api/theme/stream'

export function useFleetTheme() {
  useEffect(() => {
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function applyTheme(theme: string) {
      if (theme === 'warm') {
        document.body.classList.add('warm-mode')
        localStorage.setItem('tlda-warm-mode', 'true')
      } else {
        document.body.classList.remove('warm-mode')
        localStorage.setItem('tlda-warm-mode', 'false')
      }
    }

    // Apply cached theme immediately (before SSE fires) so there's no flash on reload
    const cached = localStorage.getItem('tlda-warm-mode')
    if (cached !== null) applyTheme(cached === 'true' ? 'warm' : 'default')

    function connect() {
      es = new EventSource(FLEET_URL)
      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.theme) applyTheme(msg.theme)
        } catch {}
      }
      es.onerror = () => {
        es?.close()
        retryTimer = setTimeout(connect, 5000)
      }
    }

    connect()

    return () => {
      es?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])
}
