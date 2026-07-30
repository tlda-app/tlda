import { log } from './logger'

type BuildInfo = {
  gitSha?: string | null
  sha?: string | null
  ref?: string | null
  branch?: string | null
  dirty?: boolean | null
  builtAt?: string | null
}

type FreshnessStatus =
  | 'current'
  | 'stale'
  | 'missing-loaded-stamp'
  | 'missing-live-stamp'
  | 'check-failed'

type FreshnessState = {
  loaded: BuildInfo | null
  latest: BuildInfo | null
  status: FreshnessStatus
  checks: number
  lastCheckAt: string | null
  lastReason: string | null
  lastError: string | null
  staleDetectedAt: string | null
}

type InstallOptions = {
  fetcher?: typeof fetch
  intervalMs?: number
  initialDelayMs?: number
  endpoint?: string
}

declare const __TLDA_APP_BUILD_INFO__: BuildInfo | null

declare global {
  interface Window {
    __tldaAppShellFreshness?: {
      summary: typeof getAppShellFreshnessSummary
      check: typeof checkAppShellFreshness
    }
  }
}

const DEFAULT_CHECK_INTERVAL_MS = 30_000
const DEFAULT_INITIAL_DELAY_MS = 5_000

let state: FreshnessState = {
  loaded: normalizeBuildInfo(typeof __TLDA_APP_BUILD_INFO__ !== 'undefined' ? __TLDA_APP_BUILD_INFO__ : null),
  latest: null,
  status: 'missing-live-stamp',
  checks: 0,
  lastCheckAt: null,
  lastReason: null,
  lastError: null,
  staleDetectedAt: null,
}

let installed = false
let inFlight: Promise<FreshnessState> | null = null

function shaOf(info: BuildInfo | null) {
  return info?.gitSha || info?.sha || null
}

function normalizeBuildInfo(info: BuildInfo | null | undefined): BuildInfo | null {
  if (!info || typeof info !== 'object') return null
  const sha = typeof info.gitSha === 'string' && info.gitSha ? info.gitSha
    : typeof info.sha === 'string' && info.sha ? info.sha
      : null
  if (!sha) return null
  return {
    gitSha: sha,
    sha,
    ref: typeof info.ref === 'string' ? info.ref : null,
    branch: typeof info.branch === 'string' ? info.branch : null,
    dirty: typeof info.dirty === 'boolean' ? info.dirty : null,
    builtAt: typeof info.builtAt === 'string' ? info.builtAt : null,
  }
}

export function classifyAppShellFreshness(loaded: BuildInfo | null, latest: BuildInfo | null): FreshnessStatus {
  const loadedSha = shaOf(loaded)
  const latestSha = shaOf(latest)
  if (!loadedSha) return 'missing-loaded-stamp'
  if (!latestSha) return 'missing-live-stamp'
  return loadedSha === latestSha ? 'current' : 'stale'
}

export function getAppShellFreshnessSummary() {
  return {
    ...state,
    loadedSha: shaOf(state.loaded),
    latestSha: shaOf(state.latest),
  }
}

async function fetchLatestBuildInfo(fetcher: typeof fetch, endpoint: string) {
  const res = await fetcher(endpoint, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`build-info HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.ok) throw new Error(json?.error || 'build-info response not ok')
  return normalizeBuildInfo(json)
}

export async function checkAppShellFreshness(reason = 'manual', options: InstallOptions = {}) {
  if (typeof window === 'undefined') return state
  if (inFlight) return inFlight

  const fetcher = options.fetcher || fetch
  const endpoint = options.endpoint || '/api/build-info'

  inFlight = (async () => {
    state = {
      ...state,
      checks: state.checks + 1,
      lastCheckAt: new Date().toISOString(),
      lastReason: reason,
      lastError: null,
    }
    try {
      const latest = await fetchLatestBuildInfo(fetcher, endpoint)
      const status = classifyAppShellFreshness(state.loaded, latest)
      state = { ...state, latest, status }
      if (status === 'stale') {
        state = { ...state, staleDetectedAt: state.staleDetectedAt || new Date().toISOString() }
        log.metric('app-shell', 'stale app shell detected', {
          reason,
          loadedSha: shaOf(state.loaded),
          latestSha: shaOf(latest),
          loaded: state.loaded,
          latest,
        })
      }
    } catch (err) {
      state = {
        ...state,
        status: 'check-failed',
        lastError: err instanceof Error ? err.message : String(err),
      }
    }
    return state
  })().finally(() => {
    inFlight = null
  })

  return inFlight
}

export function installAppShellFreshnessProbe(options: InstallOptions = {}) {
  if (typeof window === 'undefined' || installed) return
  installed = true
  window.__tldaAppShellFreshness = {
    summary: getAppShellFreshnessSummary,
    check: checkAppShellFreshness,
  }

  const intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  window.setTimeout(() => { void checkAppShellFreshness('startup', options) }, initialDelayMs)
  window.setInterval(() => { void checkAppShellFreshness('periodic', options) }, intervalMs)
  window.addEventListener('online', () => { void checkAppShellFreshness('online', options) })
  window.addEventListener('focus', () => { void checkAppShellFreshness('focus', options) })
  window.addEventListener('pageshow', () => { void checkAppShellFreshness('pageshow', options) })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkAppShellFreshness('visibility', options)
  })
}
