import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './frame-probe'  // perf-probe frame timing (inactive unless ?perf=1)
import App from './App.tsx'
import { isPhoneViewport } from './phoneViewport'
import { installAppShellFreshnessProbe } from './appShellFreshness'

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

const DEFAULT_FLEET_LAYOUT_PRESET = '3-col'
const PHONE_FLEET_LAYOUT_PRESET = 'phone'

function getDefaultFleetLayoutPreset() {
  return isPhoneViewport() ? PHONE_FLEET_LAYOUT_PRESET : DEFAULT_FLEET_LAYOUT_PRESET
}

// Automated browsers (playwright, etc.) get a forced dark theme, camera-link
// OFF, and a surface-appropriate default fleet layout when none was requested.
// Avoids three concrete failure modes:
//   1. White-themed playwright windows flash on the user's screen at night
//   2. The agent's pan/zoom hijacks the human's view via the camera-link sync
//   3. Agents test against stale localStorage fleet layouts instead of real usage
// Detection: navigator.webdriver OR ?pw=1 in the URL. playwright-mcp sets
// --disable-features=AutomationControlled which hides the webdriver flag, so
// the URL param is the reliable signal; agents must add &pw=1 to their URLs.
{
  const url = new URL(window.location.href)
  const isAuto = (navigator as any).webdriver || url.searchParams.get('pw') === '1'
  const cameraLinkOverride = url.searchParams.get('cameraLink')
  if (isAuto && !url.searchParams.get('fleetLayout')) {
    url.searchParams.set('fleetLayout', getDefaultFleetLayoutPreset())
    window.history.replaceState(window.history.state, '', url)
  }
  if (isAuto && cameraLinkOverride !== '1') {
    try {
      localStorage.setItem('tlda-theme', 'fog-dark')
      localStorage.setItem('tlda-camera-linked', 'false')
    } catch { /* localStorage may be unavailable */ }
  }
}

installAppShellFreshnessProbe()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
