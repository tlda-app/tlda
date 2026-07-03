import chokidar from 'chokidar'
import path from 'path'

export function createFileWatcher({
  label,
  paths = [],
  cwd = null,
  persistent = false,
  usePolling = false,
  interval = undefined,
  binaryInterval = undefined,
  depth = undefined,
  ignoreInitial = true,
  followSymlinks = true,
  onEvent,
  onError,
  onReady,
  log = console,
} = {}) {
  if (!label) throw new TypeError('label is required')
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required')

  const initialPaths = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean)
  const watcher = chokidar.watch(initialPaths, {
    cwd: cwd || undefined,
    persistent,
    ignoreInitial,
    followSymlinks,
    usePolling,
    interval,
    binaryInterval,
    depth,
    awaitWriteFinish: false,
  })

  let closed = false
  let readySent = false

  function normalize(event, changedPath, stats) {
    const rawPath = changedPath ? String(changedPath) : ''
    const relPath = cwd && rawPath
      ? rawPath
      : rawPath ? path.relative(cwd || path.dirname(rawPath), rawPath) : ''
    const absPath = cwd && rawPath ? path.resolve(cwd, rawPath) : rawPath
    return { event, path: rawPath, relPath, absPath, stats }
  }

  watcher.on('all', (event, changedPath, stats) => {
    if (closed) return
    onEvent(normalize(event, changedPath, stats))
  })
  watcher.on('error', (error) => {
    if (closed) return
    const message = error?.message || String(error)
    log.warn?.(`file watcher error for ${label}: ${message}`)
    onError?.(error)
  })
  function markReady() {
    if (closed) return
    if (readySent) return
    readySent = true
    log.info?.(`file watcher ready for ${label}`)
    onReady?.()
  }

  watcher.on('ready', markReady)
  if (initialPaths.length === 0) {
    queueMicrotask(markReady)
  }

  return {
    add(nextPaths) {
      const list = Array.isArray(nextPaths) ? nextPaths.filter(Boolean) : [nextPaths].filter(Boolean)
      if (!closed && list.length) watcher.add(list)
    },
    unwatch(nextPaths) {
      const list = Array.isArray(nextPaths) ? nextPaths.filter(Boolean) : [nextPaths].filter(Boolean)
      if (!closed && list.length) watcher.unwatch(list)
    },
    async close() {
      if (closed) return
      closed = true
      await watcher.close()
    },
    stop() {
      void this.close()
    },
    isWatching() {
      return !closed
    },
  }
}
