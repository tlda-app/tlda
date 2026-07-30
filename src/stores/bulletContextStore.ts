export type BulletContext = {
  id: string
  text: string
  noteShapeId: string
  tuplePath: number[]
  owner?: string
  bulletIndex: number
}

let _current: BulletContext[] = []
const _listeners = new Set<() => void>()

function notify() { for (const cb of _listeners) cb() }

export function addBulletContext(ctx: BulletContext) {
  const idx = _current.findIndex(b => b.noteShapeId === ctx.noteShapeId && b.bulletIndex === ctx.bulletIndex)
  if (idx >= 0) {
    _current = _current.filter((_, i) => i !== idx)
  } else {
    _current = [..._current, ctx]
  }
  notify()
}

export function genBulletId(): string {
  return crypto.randomUUID()
}

export function removeBulletContext(noteShapeId: string, bulletIndex: number) {
  _current = _current.filter(b => !(b.noteShapeId === noteShapeId && b.bulletIndex === bulletIndex))
  notify()
}

export function getBulletContexts(): BulletContext[] {
  return _current
}

export function subscribeBulletContext(cb: () => void): () => void {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

export function consumeBulletContexts(): BulletContext[] {
  const ctx = _current
  _current = []
  notify()
  return ctx
}

export function clearBulletContexts() {
  _current = []
  notify()
}
