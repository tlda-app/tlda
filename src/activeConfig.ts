// THE client-side config — read synchronously from the server-injected global.
//
// The server injects `window.__TLDA_CONFIG__` (the resolved active config from
// shared/config.mjs resolveConfig()) into index.html *before* this bundle runs,
// so these values are available at module-eval with no async fetch and no race.
//
// There is NO fallback. If the global is missing the app throws — guessing the
// server from the page origin / build-time env is exactly the unpredictable
// behavior this whole design exists to remove. A served page always has it.
export interface ActiveConfig {
  name: string
  database: { http: string; ws: string }  // fleet / chat / registry / agents
  store: { http: string; ws: string }      // shapes + doc assets sync
  licenseKey: string                        // tldraw license ("" = unlicensed)
}

const injected = (typeof window !== 'undefined'
  ? (window as { __TLDA_CONFIG__?: ActiveConfig }).__TLDA_CONFIG__
  : undefined)

if (!injected) {
  throw new Error(
    'tlda: window.__TLDA_CONFIG__ is missing. The server injects the active ' +
    'config into index.html; this page was not served by a tlda server. ' +
    'There is no fallback by design.'
  )
}

export const ACTIVE_CONFIG: ActiveConfig = injected
export const DATABASE_HTTP = injected.database.http
export const DATABASE_WS = injected.database.ws
export const STORE_HTTP = injected.store.http
export const STORE_WS = injected.store.ws
export const LICENSE_KEY = injected.licenseKey
