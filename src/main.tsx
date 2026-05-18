import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// High-res display compensation: macOS "More Space" gives huge CSS viewports
// where CSS pixels are physically tiny (retina display + lots of CSS px = small UI).
// Detection is binary: retina (devicePixelRatio >= 2) AND wide CSS viewport
// (>= 2560px). When true, toggle .hires class and set --hires-scale to a fixed
// 1.5x. CSS rules under .hires bump our chrome's font-size/width/height/padding
// directly via calc(... * var(--hires-scale)) — no `zoom` (which breaks tldraw
// pointer math on draggable elements like sliders).
{
  function updateHiresScale() {
    const isHires = window.devicePixelRatio >= 2 && screen.width >= 2560
    if (isHires) {
      document.documentElement.classList.add('hires')
      document.documentElement.style.setProperty('--hires-scale', '1.5')
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
