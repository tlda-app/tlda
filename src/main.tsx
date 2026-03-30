import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// High-res display compensation: macOS "More Space" gives huge CSS viewports
// (e.g. 3412x2056). Add a CSS class so we can scale up UI chrome.
{
  const refWidth = 1440
  const ratio = window.innerWidth / refWidth
  if (ratio > 1.3) {
    document.documentElement.classList.add('hires')
    document.documentElement.style.setProperty('--hires-scale', String(ratio))
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
