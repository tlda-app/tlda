export type BulletContext = {
  text: string
  noteShapeId: string
  owner?: string
  backingFile?: string
  bulletIndex: number
}

let _current: BulletContext | null = null
const _listeners = new Set<() => void>()

export function setBulletContext(ctx: BulletContext | null) {
  _current = ctx
  for (const cb of _listeners) cb()
}

export function getBulletContext(): BulletContext | null {
  return _current
}

export function subscribeBulletContext(cb: () => void): () => void {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

export function consumeBulletContext(): BulletContext | null {
  const ctx = _current
  _current = null
  for (const cb of _listeners) cb()
  return ctx
}
