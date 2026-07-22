export function postLivePerf(data: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level: 'info',
    ns: 'live-perf',
    msg: 'live perf sample',
    data,
  }
  try {
    const body = JSON.stringify(payload)
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
      if (ok) return
    }
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Telemetry upload is best effort; asynchronous network failure is intentionally contained.
    })
  } catch (err) {
    // Telemetry upload is best effort; losing it must not break the viewer.
    console.warn('[live-perf] sample upload failed', err)
  }
}
