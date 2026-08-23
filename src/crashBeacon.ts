// The crash that kills the page is precisely the crash that cannot report itself.
//
// `ErrorBoundary` (App.tsx, SvgDocument.tsx) catches render-path errors only, and
// `logger.ts` batches for 250ms before POSTing — so a page that dies takes its
// buffer with it. Everything we knew about these came from Skip telling us.
//
// `navigator.sendBeacon` is the one transport that survives a dying page: the
// browser owns the request after the document is gone. So this is a handler and a
// beacon call, unbatched, and deliberately nothing else — no store, no retry, no
// dedupe, no severity model, no new endpoint. `/api/log` already accepts a bare
// object (`client-log-sink.mjs` treats a non-array body as one entry).
//
// The sibling of this transport is `livePerfUpload.ts`, which does the same
// beacon-then-keepalive-fetch dance for perf samples. They are deliberately not
// shared: one is a 12-line duplication, the other is a drive-by change to working
// telemetry, and the second is the more expensive mistake.
//
// **This module imports nothing.** That is load-bearing, not tidiness. It is the
// first import in `main.tsx`, so anything it pulls in runs before the handler
// exists — and the obvious candidate, `logger.ts`, reads `localStorage` and
// `window.location.search` at module scope with no guard. localStorage throws in
// a sandboxed iframe and with cookies blocked. Importing it here would put the
// most throw-prone module in the bundle in front of the handler whose entire job
// is to survive a throw, and the failure would be a blank page with no report.
//
// The session id therefore arrives the other way round: `logger.ts` pushes it in
// once it has one. If the page dies before that, the field is simply absent,
// which is the honest answer rather than a second id space nothing can join to.

let sessionId: string | undefined

export function setCrashSessionId(id: string) {
  sessionId = id
}

// A beacon is capped by the browser (~64KB) and this is a crash report, not a
// transcript. The cap is also the reason a runaway message cannot carry a
// document's worth of anything off the page.
const MAX_FIELD = 2000

function clip(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = typeof value === 'string' ? value : String(value)
  if (!s) return undefined
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[+${s.length - MAX_FIELD}]` : s
}

// Message, stack, and where it happened. Nothing that reaches into the document:
// his text is not telemetry, and no field here is sourced from document state.
type CrashReport = {
  kind: 'error' | 'unhandledrejection'
  message?: string
  stack?: string
  source?: string
  line?: number
  column?: number
}

function beacon(report: CrashReport) {
  const payload = {
    ts: new Date().toISOString(),
    level: 'error',
    ns: 'client-crash',
    msg: report.message || report.kind,
    ...(sessionId ? { session: sessionId } : {}),
    data: {
      ...report,
      // The page's own URL, which is how a recurrence is identified: which
      // document, which panel state, which query. Same field the rest of the
      // client log carries.
      url: typeof location !== 'undefined' ? location.href : undefined,
    },
  }
  try {
    const body = JSON.stringify(payload)
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
      if (ok) return
    }
    // sendBeacon refuses over its queue limit; keepalive is the same promise on
    // the fetch path and survives unload too.
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Reporting a crash must not raise one.
    })
  } catch {
    // Reporting a crash must not raise one.
  }
}

let installed = false

// Installed on import, not by a call from `main.tsx`. ES imports are hoisted, so
// a call written between imports would run only after every other import had
// already been evaluated — including `App.tsx` — and would miss the errors
// thrown while the app's module graph is still loading. Being the first import
// is the only thing that puts this handler in place before anything can throw.
// Exported anyway so a test can install it into a fabricated window.
export function installCrashBeacon() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      // `error` also fires for failed subresources (img, script, link), where
      // `event.error` is null and the target is the element rather than the
      // window. Those are a different fault with their own handling — see
      // `chat-image-retry.mjs` — and folding them in here would bury the
      // page-killing exception this exists to catch under image 404s.
      const target = event.target as unknown
      if (target && target !== window) return
      beacon({
        kind: 'error',
        message: clip(event.message),
        stack: clip(event.error?.stack),
        source: clip(event.filename),
        line: event.lineno,
        column: event.colno,
      })
    } catch {
      // Reporting a crash must not raise one.
    }
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason as { message?: unknown; stack?: unknown } | undefined
      beacon({
        kind: 'unhandledrejection',
        // A rejection can carry anything, not just an Error. `clip` stringifies
        // whatever it is rather than assuming a shape and silently reporting
        // "[object Object]" for every one of them.
        message: clip(reason?.message ?? event.reason),
        stack: clip(reason?.stack),
      })
    } catch {
      // Reporting a crash must not raise one.
    }
  })
}

installCrashBeacon()
