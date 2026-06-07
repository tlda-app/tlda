import { createRoot } from 'react-dom/client'
import { OutlineComponent } from './shapes/OutlineShape'

// Harness-only: append the auth token (from this page's ?token=) to /api fetches,
// since the standalone harness has no cookie-login. The real component fetches
// plain same-origin URLs and relies on the cookie set by normal app login.
const token = new URLSearchParams(location.search).get('token')
if (token) {
  const orig = window.fetch.bind(window)
  window.fetch = (input: any, init?: any) => {
    let url = typeof input === 'string' ? input : input?.url
    if (typeof url === 'string' && url.startsWith('/api/') && !url.includes('token=')) {
      url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
      input = url
    }
    return orig(input, init)
  }
}

const shape = { id: 'shape:harness', type: 'outline', props: { doc: 'outline-proto', slug: 'proto', w: 420, h: 520 } }

createRoot(document.getElementById('host')!).render(
  <div style={{ width: 420, height: 520 }}>
    <OutlineComponent shape={shape} />
  </div>
)
