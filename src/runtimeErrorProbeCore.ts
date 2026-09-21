export const RUNTIME_PROBE_SETTLE_MS = 1_500
export const RUNTIME_PROBE_TIMEOUT_MS = 5_000
export const RUNTIME_PROBE_CONCURRENCY = 2

type ReloadSignal = { type?: unknown; pages?: unknown; timestamp?: unknown }
type Manifest = { view: { kind: string }; pages: Array<{ file: string }> }

export function hasRuntimeProbeBasePath(document: { basePath?: unknown }): document is { basePath: string } {
  return typeof document.basePath === 'string' && document.basePath.length > 0
}

function pageUrl(basePath: string, file: string, timestamp: number, appendUrlToken: (url: string) => string) {
  const url = new URL(file, new URL(basePath, window.location.origin))
  url.searchParams.set('_tldaReload', String(timestamp))
  return appendUrlToken(`${url.pathname}${url.search}${url.hash}`)
}

export function runtimeProbeUrls(
  basePath: string,
  manifest: Manifest,
  signal: ReloadSignal,
  appendUrlToken: (url: string) => string = url => url,
): string[] {
  if (manifest.view.kind !== 'html-pages' && manifest.view.kind !== 'slides') return []
  const selected = signal.type === 'partial' && Array.isArray(signal.pages)
    ? signal.pages.map(index => manifest.pages[index]).filter(Boolean)
    : manifest.pages
  const timestamp = typeof signal.timestamp === 'number' ? signal.timestamp : Date.now()
  return [...new Set(selected.map(page => pageUrl(basePath, page.file, timestamp, appendUrlToken)))]
}

type FrameDocument = Pick<Document, 'body' | 'createElement'>
type Timer = ReturnType<typeof setTimeout>
type RuntimeProbe = ReturnType<typeof loadRuntimeProbePage>

export function loadRuntimeProbePage(url: string, document: FrameDocument = window.document, settleMs = RUNTIME_PROBE_SETTLE_MS, timeoutMs = RUNTIME_PROBE_TIMEOUT_MS) {
  let frame: HTMLIFrameElement | null = document.createElement('iframe')
  let settled = false
  let loadTimer: Timer | null = null
  let preloadTimer: Timer | null = null
  let postLoadTimer: Timer | null = null
  let resolve!: (loaded: boolean) => void
  const loaded = new Promise<boolean>(done => { resolve = done })
  const finish = (didLoad: boolean) => {
    if (settled) return
    settled = true
    if (loadTimer) clearTimeout(loadTimer)
    if (preloadTimer) clearTimeout(preloadTimer)
    if (postLoadTimer) clearTimeout(postLoadTimer)
    frame?.remove()
    frame = null
    resolve(didLoad)
  }
  frame.style.cssText = 'position:fixed;left:-1px;top:-1px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  frame.setAttribute('aria-hidden', 'true')
  frame.addEventListener('load', () => {
    // Loading late must not consume the post-load capability settle interval.
    // The pre-load bound only protects a frame that never loads.
    if (preloadTimer) clearTimeout(preloadTimer)
    loadTimer = setTimeout(() => finish(true), settleMs)
    postLoadTimer = setTimeout(() => finish(false), Math.max(settleMs, timeoutMs))
  }, { once: true })
  frame.addEventListener('error', () => finish(false), { once: true })
  preloadTimer = setTimeout(() => finish(false), timeoutMs)
  document.body.appendChild(frame)
  frame.src = url
  return { loaded, dispose: () => finish(false) }
}

export async function loadRuntimeProbePages(urls: string[], options: {
  document?: FrameDocument; concurrency?: number; settleMs?: number; timeoutMs?: number; cancelled?: () => boolean
  onProbe?: (probe: RuntimeProbe) => (() => void) | void
} = {}) {
  const concurrency = Math.max(1, options.concurrency ?? RUNTIME_PROBE_CONCURRENCY)
  let next = 0
  const results: boolean[] = []
  const worker = async () => {
    while (!options.cancelled?.()) {
      const index = next++
      if (index >= urls.length) return
      const probe = loadRuntimeProbePage(urls[index], options.document, options.settleMs, options.timeoutMs)
      const unregister = options.onProbe?.(probe)
      try {
        if (options.cancelled?.()) probe.dispose()
        results[index] = await probe.loaded
      } finally {
        unregister?.()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
  return results
}

export function subscribeRuntimeProbe(document: { basePath: string }, dependencies: {
  onReload: (listener: (signal: ReloadSignal) => void) => () => void
  isConnected: () => boolean
  fetchManifest: (basePath: string, signal: AbortSignal) => Promise<Manifest>
  appendUrlToken?: (url: string) => string
  loadPages?: typeof loadRuntimeProbePages
}) {
  let current: { controller: AbortController; dispose: () => void } | null = null
  const stop = dependencies.onReload(signal => {
    // This is client-connected coverage only. With no connected viewer, do not
    // fetch or create an offscreen frame.
    if (!dependencies.isConnected()) return
    current?.dispose()
    const controller = new AbortController()
    const probes = new Set<() => void>()
    const dispose = () => {
      controller.abort()
      for (const disposeProbe of probes) disposeProbe()
      probes.clear()
    }
    current = { controller, dispose }
    void dependencies.fetchManifest(document.basePath, controller.signal)
      .then(manifest => (dependencies.loadPages || loadRuntimeProbePages)(runtimeProbeUrls(
        document.basePath,
        manifest,
        signal,
        dependencies.appendUrlToken,
      ), {
        cancelled: () => controller.signal.aborted,
        onProbe: probe => {
          if (controller.signal.aborted) {
            probe.dispose()
            return
          }
          probes.add(probe.dispose)
          return () => probes.delete(probe.dispose)
        },
      }))
      .catch(error => {
        if (!controller.signal.aborted) console.warn('[runtime-error-probe] could not load rebuilt pages:', error)
      })
  })
  return () => {
    stop()
    current?.dispose()
    current = null
  }
}
