import path from 'node:path'

const OWNED_SEGMENTS = new Set(['.git', '.tlda-build', '.tlda-cache', '.tlda-output', '.tlda-status', '.tlda-staging'])

export function isProjectSourceEvent(sourceDir, filePath) {
  const rel = path.relative(sourceDir, path.resolve(filePath))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return !rel.split(path.sep).some(segment => OWNED_SEGMENTS.has(segment))
}

export function createEditClusterDebouncer({
  sourceDir,
  quietMs = 3000,
  onSettled,
  clock = globalThis,
  accepts = filePath => isProjectSourceEvent(sourceDir, filePath),
} = {}) {
  if (!sourceDir) throw new Error('sourceDir is required')
  if (typeof onSettled !== 'function') throw new Error('onSettled is required')
  let timer = null
  let open = false
  let mirrorDepth = 0
  const queuedDuringMirror = new Set()

  function arm() {
    if (timer) clock.clearTimeout(timer)
    timer = clock.setTimeout(async () => {
      timer = null
      if (!open || mirrorDepth) return
      open = false
      await onSettled({ project: sourceDir })
    }, quietMs)
    timer?.unref?.()
  }

  function note(filePath) {
    if (!accepts(filePath)) return false
    if (mirrorDepth) {
      queuedDuringMirror.add(path.resolve(filePath))
      return true
    }
    open = true
    arm()
    return true
  }

  async function closeNow() {
    if (timer) clock.clearTimeout(timer)
    timer = null
    if (!open || mirrorDepth) return false
    open = false
    await onSettled({ project: sourceDir })
    return true
  }

  async function serializeMirror(apply, differsFromMirror) {
    await closeNow()
    mirrorDepth += 1
    try {
      return await apply()
    } finally {
      mirrorDepth -= 1
      if (!mirrorDepth) {
        const paths = [...queuedDuringMirror]
        queuedDuringMirror.clear()
        if (await differsFromMirror(paths)) {
          open = true
          arm()
        }
      }
    }
  }

  function close() {
    if (timer) clock.clearTimeout(timer)
    timer = null
    queuedDuringMirror.clear()
  }

  return { note, closeNow, serializeMirror, close, state: () => ({ open, mirrorDepth, queued: queuedDuringMirror.size }) }
}
