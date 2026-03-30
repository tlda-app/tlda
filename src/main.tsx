import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Chrome detection — Chrome renders fixed-position UI inside tldraw's
// InFrontOfTheCanvas at half size on retina displays compared to Safari.
// Add a body class so CSS can compensate with zoom on the in-front container.
const isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent)
if (isChrome) {
  document.body.classList.add('is-chrome')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
