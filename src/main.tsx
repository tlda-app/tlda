import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// High-res display compensation: macOS "More Space" gives huge CSS viewports
// (e.g. 3412x2056). Add a CSS class so we can scale up UI chrome.
// Uses screen.width (display resolution) instead of innerWidth (window size)
// because innerWidth varies with window state, sidebars, etc. — causing
// inconsistent toolbar sizes on each page load.
{
  function updateHiresScale() {
    const refWidth = 1440
    const ratio = screen.width / refWidth
    if (ratio > 1.3) {
      document.documentElement.classList.add('hires')
      document.documentElement.style.setProperty('--hires-scale', String(ratio))
    } else {
      document.documentElement.classList.remove('hires')
      document.documentElement.style.removeProperty('--hires-scale')
    }
  }
  updateHiresScale()
  // Re-check when window moves to a different monitor
  window.addEventListener('resize', updateHiresScale)
}

// Global mousemove class — visible while cursor is moving, fades after 1.5s idle
{
  let timer: ReturnType<typeof setTimeout>
  window.addEventListener('mousemove', () => {
    document.documentElement.classList.add('mousemove')
    clearTimeout(timer)
    timer = setTimeout(() => document.documentElement.classList.remove('mousemove'), 1500)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
