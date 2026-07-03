import fs from 'fs'

export function createRearmableFsWatcher({
  label,
  dir,
  options = {},
  onEvent,
  shouldWatch = () => true,
  log = console,
  watch = fs.watch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelayMs = 1000,
} = {}) {
  if (!label) throw new TypeError('label is required')
  if (!dir) throw new TypeError('dir is required')
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required')

  let watcher = null
  let retryTimer = null
  let closing = false

  function clearRetry() {
    if (!retryTimer) return
    clearTimer(retryTimer)
    retryTimer = null
  }

  function scheduleRearm(reason) {
    if (closing || !shouldWatch()) return
    if (retryTimer) return
    log.warn?.(`fs.watch for ${label} ${reason}; rearming in ${retryDelayMs}ms`)
    retryTimer = setTimer(() => {
      retryTimer = null
      start('retry')
    }, retryDelayMs)
  }

  function closeCurrent({ intentional = false } = {}) {
    if (!watcher) return
    const current = watcher
    watcher = null
    const wasClosing = closing
    if (intentional) closing = true
    try { current.close() } catch (e) { log.warn?.(`fs.watch close for ${label} failed: ${e?.message || e}`) }
    if (intentional) closing = wasClosing
  }

  function start(reason = 'start') {
    if (closing || !shouldWatch()) return false
    clearRetry()
    closeCurrent({ intentional: true })
    try {
      const next = watch(dir, options, (eventType, filename) => onEvent(eventType, filename))
      watcher = next
      next.on?.('error', (e) => {
        if (watcher !== next || closing) return
        log.warn?.(`fs.watch error for ${label}: ${e?.message || e}`)
        closeCurrent({ intentional: true })
        scheduleRearm('errored')
      })
      next.on?.('close', () => {
        if (watcher !== next || closing) return
        watcher = null
        scheduleRearm('closed unexpectedly')
      })
      log.info?.(`fs.watch started for ${label}${reason ? ` (${reason})` : ''}`)
      return true
    } catch (e) {
      log.error?.(`fs.watch failed for ${label}: ${e?.message || e}`)
      scheduleRearm('failed to start')
      return false
    }
  }

  function stop() {
    closing = true
    clearRetry()
    closeCurrent({ intentional: true })
    closing = false
  }

  function rearm(reason = 'requested') {
    if (closing || !shouldWatch()) return false
    log.warn?.(`fs.watch rearm for ${label}: ${reason}`)
    return start(reason)
  }

  return {
    start,
    stop,
    rearm,
    isWatching: () => !!watcher,
    hasPendingRetry: () => !!retryTimer,
  }
}
