export function startWsRequest({ pending, id, type, idleTimeoutMs, deadlineMs, send, makeDeadlineError, makeSendError }) {
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
        const error = typeof makeDeadlineError === 'function'
          ? makeDeadlineError({ type, deadlineMs })
          : new Error(`WS request deadline exceeded after ${deadlineMs}ms (type=${type})`)
        settle(reject, error)
      }, deadlineMs)
    }
    if (!send(id)) {
      const error = typeof makeSendError === 'function'
        ? makeSendError({ type })
        : new Error(`WS request send failed (type=${type})`)
      pending.get(id)?.reject(error)
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

export function rejectMatchingWsRequests(pending, predicate, makeError) {
  for (const request of pending.values()) {
    if (predicate(request)) request.reject(makeError(request))
  }
}
