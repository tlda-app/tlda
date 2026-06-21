import { atom, transact } from '@tldraw/state'

export type Id = string
export interface Rec {
  id: Id
}

export type Delta<T extends Rec> =
  | { kind: 'add'; rec: T }
  | { kind: 'update'; id: Id; rec: T; prev: T }
  | { kind: 'remove'; id: Id; prev: T }

export type Filter<T> = (rec: T) => boolean

export interface Index<T extends Rec, K> {
  get(key: K): readonly T[]
  keys(): IterableIterator<K>
}

export interface LiveView<T extends Rec> {
  readonly list: readonly T[]
  get(): readonly T[]
  subscribe(cb: (list: readonly T[], delta: Delta<T>) => void): () => void
  readonly size: number
  dispose(): void
}

export interface LiveStore<T extends Rec> {
  upsert(rec: T): Delta<T>
  remove(id: Id): Delta<T> | null
  get(id: Id): T | undefined
  has(id: Id): boolean
  all(): readonly T[]
  readonly size: number
  index<K>(name: string, keyOf: (rec: T) => K | readonly K[]): Index<T, K>
  view(filter: Filter<T>, opts?: { key?: string }): LiveView<T>
  listen(cb: (delta: Delta<T>) => void): () => void
  bulk(fn: (s: LiveStore<T>) => void): void
  dispose(): void
}

type AtomLike<V> = {
  get(): V
  set(value: V): V
}

const EMPTY: readonly never[] = Object.freeze([])

function makeAtom<V>(name: string, value: V): AtomLike<V> {
  return atom(name, value) as AtomLike<V>
}

function toKeySet<K>(keys: K | readonly K[]): Set<K> {
  return new Set(Array.isArray(keys) ? keys : [keys])
}

function removeById<T extends Rec>(list: readonly T[], id: Id): readonly T[] {
  const index = list.findIndex((rec) => rec.id === id)
  if (index === -1) return list
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

function replaceById<T extends Rec>(list: readonly T[], rec: T): readonly T[] {
  const index = list.findIndex((item) => item.id === rec.id)
  if (index === -1) return list
  const next = list.slice()
  next[index] = rec
  return next
}

type Bucket<T extends Rec> = {
  list: readonly T[]
  atom: AtomLike<readonly T[]>
}

class MaintainedIndex<T extends Rec, K> implements Index<T, K> {
  private readonly name: string
  private readonly keyOf: (rec: T) => K | readonly K[]
  private readonly orderOf: (id: Id) => number
  private readonly buckets = new Map<K, Bucket<T>>()

  constructor(name: string, keyOf: (rec: T) => K | readonly K[], orderOf: (id: Id) => number) {
    this.name = name
    this.keyOf = keyOf
    this.orderOf = orderOf
  }

  get(key: K): readonly T[] {
    return this.buckets.get(key)?.atom.get() ?? EMPTY
  }

  keys(): IterableIterator<K> {
    return this.buckets.keys()
  }

  add(rec: T): void {
    for (const key of toKeySet(this.keyOf(rec))) {
      this.addToBucket(key, rec)
    }
  }

  update(prev: T, rec: T): void {
    const oldKeys = toKeySet(this.keyOf(prev))
    const newKeys = toKeySet(this.keyOf(rec))

    for (const key of oldKeys) {
      if (!newKeys.has(key)) this.removeFromBucket(key, prev.id)
    }
    for (const key of newKeys) {
      if (oldKeys.has(key)) this.replaceInBucket(key, rec)
      else this.insertIntoBucket(key, rec)
    }
  }

  remove(prev: T): void {
    for (const key of toKeySet(this.keyOf(prev))) {
      this.removeFromBucket(key, prev.id)
    }
  }

  clear(): void {
    for (const bucket of this.buckets.values()) bucket.atom.set(EMPTY)
    this.buckets.clear()
  }

  private addToBucket(key: K, rec: T): void {
    const bucket = this.getOrCreateBucket(key)
    bucket.list = [...bucket.list, rec]
    bucket.atom.set(bucket.list)
  }

  private insertIntoBucket(key: K, rec: T): void {
    const bucket = this.getOrCreateBucket(key)
    const recOrder = this.orderOf(rec.id)
    const index = bucket.list.findIndex((item) => this.orderOf(item.id) > recOrder)
    if (index === -1) {
      bucket.list = [...bucket.list, rec]
    } else {
      bucket.list = [...bucket.list.slice(0, index), rec, ...bucket.list.slice(index)]
    }
    bucket.atom.set(bucket.list)
  }

  private replaceInBucket(key: K, rec: T): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    bucket.list = replaceById(bucket.list, rec)
    bucket.atom.set(bucket.list)
  }

  private removeFromBucket(key: K, id: Id): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    bucket.list = removeById(bucket.list, id)
    if (bucket.list.length === 0) {
      bucket.atom.set(EMPTY)
      this.buckets.delete(key)
    } else {
      bucket.atom.set(bucket.list)
    }
  }

  private getOrCreateBucket(key: K): Bucket<T> {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { list: EMPTY, atom: makeAtom(`${this.name}:${String(key)}`, EMPTY) }
      this.buckets.set(key, bucket)
    }
    return bucket
  }
}

type ViewSubscriber<T extends Rec> = (list: readonly T[], delta: Delta<T>) => void

class MaintainedView<T extends Rec> implements LiveView<T> {
  readonly filter: Filter<T>
  private readonly atom: AtomLike<readonly T[]>
  private readonly subscribers = new Set<ViewSubscriber<T>>()
  private readonly onZeroRefs: (view: MaintainedView<T>) => void
  private readonly orderOf: (id: Id) => number
  private disposed = false
  private refCount = 1
  private current: readonly T[]

  constructor(
    filter: Filter<T>,
    initial: readonly T[],
    onZeroRefs: (view: MaintainedView<T>) => void,
    orderOf: (id: Id) => number,
    key?: string
  ) {
    this.filter = filter
    this.onZeroRefs = onZeroRefs
    this.orderOf = orderOf
    this.current = initial
    this.atom = makeAtom(`live-view:${key ?? 'anon'}`, initial)
  }

  get list(): readonly T[] {
    return this.atom.get()
  }

  get size(): number {
    return this.list.length
  }

  get(): readonly T[] {
    return this.atom.get()
  }

  subscribe(cb: ViewSubscriber<T>): () => void {
    if (this.disposed) return () => {}
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.refCount -= 1
    if (this.refCount > 0) return
    this.forceDispose()
    this.onZeroRefs(this)
  }

  forceDispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.refCount = 0
    this.subscribers.clear()
    this.current = EMPTY
    this.atom.set(EMPTY)
  }

  retain(): void {
    if (this.disposed) return
    this.refCount += 1
  }

  applyAdd(rec: T): boolean {
    if (!this.filter(rec)) return false
    this.current = [...this.current, rec]
    this.atom.set(this.current)
    return true
  }

  applyUpdate(prev: T, rec: T): boolean {
    const was = this.filter(prev)
    const now = this.filter(rec)
    if (!was && !now) return false
    if (!was && now) {
      this.current = this.insertByOrder(rec)
    } else if (was && !now) {
      this.current = removeById(this.current, prev.id)
    } else {
      this.current = replaceById(this.current, rec)
    }
    this.atom.set(this.current)
    return true
  }

  private insertByOrder(rec: T): readonly T[] {
    const recOrder = this.orderOf(rec.id)
    const index = this.current.findIndex((item) => this.orderOf(item.id) > recOrder)
    if (index === -1) return [...this.current, rec]
    return [...this.current.slice(0, index), rec, ...this.current.slice(index)]
  }

  applyRemove(prev: T): boolean {
    if (!this.filter(prev)) return false
    this.current = removeById(this.current, prev.id)
    this.atom.set(this.current)
    return true
  }

  notify(delta: Delta<T>): void {
    if (this.disposed) return
    const list = this.atom.get()
    for (const cb of [...this.subscribers]) cb(list, delta)
  }
}

export function createLiveStore<T extends Rec>(opts?: { initial?: Iterable<T> }): LiveStore<T> {
  return new LiveStoreImpl(opts)
}

class LiveStoreImpl<T extends Rec> implements LiveStore<T> {
  private readonly byId = new Map<Id, T>()
  private readonly insertionOrder = new Map<Id, number>()
  private readonly allAtom = makeAtom<readonly T[]>('live-store:all', EMPTY)
  private nextOrder = 0
  private indexes = new Map<string, MaintainedIndex<T, unknown>>()
  private views = new Set<MaintainedView<T>>()
  private keyedViews = new Map<string, MaintainedView<T>>()
  private listeners = new Set<(delta: Delta<T>) => void>()
  private pendingDeltas: Delta<T>[] = []
  private changedViews = new Map<MaintainedView<T>, Delta<T>>()
  private notifyDepth = 0
  private bulkDepth = 0
  private disposed = false

  constructor(opts?: { initial?: Iterable<T> }) {
    if (opts?.initial) {
      const initial = Array.from(opts.initial)
      for (const rec of initial) {
        this.byId.set(rec.id, rec)
        if (!this.insertionOrder.has(rec.id)) this.insertionOrder.set(rec.id, this.nextOrder++)
      }
      this.allAtom.set(Array.from(this.byId.values()))
    }
  }

  get size(): number {
    return this.byId.size
  }

  upsert(rec: T): Delta<T> {
    this.assertActive()
    const prev = this.byId.get(rec.id)
    const delta: Delta<T> = prev
      ? { kind: 'update', id: rec.id, rec, prev }
      : { kind: 'add', rec }
    this.applyDelta(delta)
    return delta
  }

  remove(id: Id): Delta<T> | null {
    this.assertActive()
    const prev = this.byId.get(id)
    if (!prev) return null
    const delta: Delta<T> = { kind: 'remove', id, prev }
    this.applyDelta(delta)
    return delta
  }

  get(id: Id): T | undefined {
    return this.byId.get(id)
  }

  has(id: Id): boolean {
    return this.byId.has(id)
  }

  all(): readonly T[] {
    return this.allAtom.get()
  }

  index<K>(name: string, keyOf: (rec: T) => K | readonly K[]): Index<T, K> {
    this.assertActive()
    const existing = this.indexes.get(name)
    if (existing) return existing as Index<T, K>
    const index = new MaintainedIndex<T, K>(
      `live-index:${name}`,
      keyOf,
      (id) => this.insertionOrder.get(id) ?? Number.MAX_SAFE_INTEGER
    )
    for (const rec of this.all()) index.add(rec)
    this.indexes.set(name, index as MaintainedIndex<T, unknown>)
    return index
  }

  view(filter: Filter<T>, opts?: { key?: string }): LiveView<T> {
    this.assertActive()
    const key = opts?.key
    if (key) {
      const existing = this.keyedViews.get(key)
      if (existing) {
        existing.retain()
        return existing
      }
    }

    const view = new MaintainedView<T>(
      filter,
      this.all().filter(filter),
      (deadView) => {
        this.views.delete(deadView)
        if (key) this.keyedViews.delete(key)
      },
      (id) => this.insertionOrder.get(id) ?? Number.MAX_SAFE_INTEGER,
      key
    )
    this.views.add(view)
    if (key) this.keyedViews.set(key, view)
    return view
  }

  listen(cb: (delta: Delta<T>) => void): () => void {
    this.assertActive()
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  bulk(fn: (s: LiveStore<T>) => void): void {
    this.assertActive()
    this.bulkDepth += 1
    try {
      transact(() => fn(this))
    } finally {
      this.bulkDepth -= 1
      if (this.bulkDepth === 0) this.flushNotifications()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.byId.clear()
    this.allAtom.set(EMPTY)
    for (const index of this.indexes.values()) index.clear()
    this.indexes.clear()
    for (const view of this.views) view.forceDispose()
    this.views.clear()
    this.keyedViews.clear()
    this.listeners.clear()
    this.pendingDeltas = []
    this.changedViews.clear()
  }

  private applyDelta(delta: Delta<T>): void {
    transact(() => {
      if (delta.kind === 'add') this.applyAdd(delta.rec)
      else if (delta.kind === 'update') this.applyUpdate(delta.prev, delta.rec)
      else this.applyRemove(delta.prev)
    })
    this.queueNotifications(delta)
  }

  private applyAdd(rec: T): void {
    this.byId.set(rec.id, rec)
    this.insertionOrder.set(rec.id, this.nextOrder++)
    this.allAtom.set([...this.allAtom.get(), rec])
    for (const index of this.indexes.values()) index.add(rec)
    for (const view of this.views) {
      if (view.applyAdd(rec)) this.changedViews.set(view, { kind: 'add', rec })
    }
  }

  private applyUpdate(prev: T, rec: T): void {
    this.byId.set(rec.id, rec)
    this.allAtom.set(replaceById(this.allAtom.get(), rec))
    for (const index of this.indexes.values()) index.update(prev, rec)
    for (const view of this.views) {
      if (view.applyUpdate(prev, rec)) this.changedViews.set(view, { kind: 'update', id: rec.id, rec, prev })
    }
  }

  private applyRemove(prev: T): void {
    this.byId.delete(prev.id)
    this.insertionOrder.delete(prev.id)
    this.allAtom.set(removeById(this.allAtom.get(), prev.id))
    for (const index of this.indexes.values()) index.remove(prev)
    for (const view of this.views) {
      if (view.applyRemove(prev)) this.changedViews.set(view, { kind: 'remove', id: prev.id, prev })
    }
  }

  private queueNotifications(delta: Delta<T>): void {
    this.pendingDeltas.push(delta)
    if (this.bulkDepth === 0) this.flushNotifications()
  }

  private flushNotifications(): void {
    if (this.notifyDepth > 0) return
    this.notifyDepth += 1
    try {
      while (this.pendingDeltas.length > 0 && !this.disposed) {
        const deltas = this.pendingDeltas
        this.pendingDeltas = []
        const changedViews = this.changedViews
        this.changedViews = new Map()
        const notificationDelta = deltas[deltas.length - 1]
        for (const listener of [...this.listeners]) listener(notificationDelta)
        for (const [view, delta] of changedViews) view.notify(delta)
      }
    } finally {
      this.notifyDepth -= 1
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('LiveStore has been disposed')
  }
}
