export function startWsRequest({ pending, id, type, idleTimeoutMs, deadlineMs, send }) {
  return new Promise((resolve, reject) => {
    let idleTimer = null
    let deadlineTimer = null
    const settle = (fn, value) => {
      pending.delete(id)
      if (idleTimer) clearTimeout(idleTimer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      fn(value)
    }
    const resetIdleTimer = () => {
      if (!idleTimeoutMs) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        settle(reject, new Error(`WS request idle timeout after ${idleTimeoutMs}ms (type=${type})`))
      }, idleTimeoutMs)
    }

    pending.set(id, { resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e), resetIdleTimer, type })
    resetIdleTimer()
    if (deadlineMs) {
      deadlineTimer = setTimeout(() => {
        settle(reject, new Error(`WS request deadline exceeded after ${deadlineMs}ms (type=${type})`))
      }, deadlineMs)
    }
    if (!send(id)) {
      pending.get(id)?.reject(new Error(`WS request send failed (type=${type})`))
    }
  })
}

export function resetWsRequestIdleTimers(pending) {
  for (const request of pending.values()) {
    request.resetIdleTimer?.()
  }
}

export function rejectWsRequests(pending, makeError) {
  for (const request of pending.values()) {
    request.reject(makeError(request))
  }
  pending.clear()
}
