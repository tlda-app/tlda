/**
 * Share the orientation of rgl WebGL figures inside a slides deck across everyone
 * in the room, over the deck shape's Yjs-backed record.
 *
 * A Quarto deck built with `#| webgl: true` renders each 3D figure as an
 * rglwidget: a `.rglWebGL` div whose `.rglinstance` is the live widget object.
 * The deck is served from the same origin as the app, so the host frame reaches
 * those instances directly through `iframe.contentDocument` — no postMessage
 * protocol involved.
 *
 * WHY SHAPE STATE AND NOT A SIGNAL. Figure orientation must converge: someone
 * opening the deck after the rotating has started has to arrive at the orientation
 * everyone else is looking at, and nothing later corrects them if they don't
 * (nobody is obliged to touch the figure again). `broadcastSignal` is
 * fire-and-forget; its `fire-if-recent` replay looks like late-joiner support but
 * only replays the last message inside a time window, so a friend joining ninety
 * seconds in would sit at the render-time default. A shape record rides the room's
 * Yjs document, so it converges, persists, and is handed to a client on connect.
 *
 * WHY ONE KEY PER FIGURE. tldraw merges concurrent edits at the granularity of
 * the key: two clients patching `rglPose0` and `rglPose1` both survive, but two
 * clients read-modify-writing one JSON blob clobber each other, because each
 * computes its new value from its own stale copy. Several friends rotating
 * *different* figures at once is the normal case here, so the storage granularity
 * has to match the contention granularity. Hence one key per figure.
 *
 * WHY `meta` AND NOT PROPS — READ THIS BEFORE "FIXING" IT BACK.
 * The TLDraw-native rule in AGENTS.md says shape state lives in shape props,
 * "not in meta fields *coordinated across multiple shapes*". That qualifier is
 * the whole rule: its hazard is state smeared across several records that can
 * disagree with each other. This is one shape, one owner, one writer per key, so
 * that hazard does not exist here.
 *
 * Props were tried first and were worse in three concrete ways. Props are a fixed
 * schema, so figures need a fixed number of slots (`figureView0..7`) and a deck
 * with more figures silently loses them — a cap that has to be policed. Props
 * must be mirrored exactly in `server/lib/sync-rooms.mjs`, and a mismatch is not
 * a bug you find later, it is a `TLSyncError` outage for everyone in the room.
 * And `html-page` is shared by every markdown, HTML and Quarto document, so those
 * slots would appear on pages that have no figures at all.
 *
 * `meta` is free-form, so there is no cap, no mirror, and no schema change — the
 * same per-key merge behaviour with two failure modes and a limit deleted rather
 * than managed. If you are about to move this to props, you are reintroducing
 * all three.
 *
 * WHO MAY DRIVE: anyone in the room, deliberately. No capability check and no
 * permission UI — the demo is "you can do this". Don't harden this without Skip
 * asking for it.
 */

import type { Editor, TLShapeId } from 'tldraw'
import { log } from './logger'

/** Meta key holding figure `index`'s shared pose. Position-keyed — see `bind`. */
export const figurePoseMetaKey = (index: number) => `rglPose${index}` as const

/** The complete viewing state of one rgl subscene: 34 numbers plus a timestamp. */
type FigurePose = {
  /** par3d.userMatrix — rotation / trackball. */
  m: number[]
  /** par3d.userProjection — pan. Empty when the widget has none. */
  p: number[]
  /** par3d.zoom */
  z: number
  /** par3d.FOV */
  f: number
  /** Wall-clock of the write, for humans reading the room — not used for ordering. */
  t: number
}

/** Minimal shape of the rgl widget internals we touch. */
type CanvasMatrix4 = {
  getAsArray(): number[]
  load(values: number[] | CanvasMatrix4): void
}
type Par3d = {
  userMatrix: CanvasMatrix4
  userProjection?: CanvasMatrix4
  zoom: number
  FOV: number
  listeners?: number[]
}
type RglSubscene = { par3d: Par3d }
type RglInstance = {
  scene: { rootSubscene: number }
  getObj(id: number): RglSubscene | undefined
  drawScene(): void
}

const POSE_EPSILON = 1e-6

function posesDiffer(a: FigurePose | null, b: FigurePose | null) {
  if (!a || !b) return a !== b
  if (Math.abs(a.z - b.z) > POSE_EPSILON) return true
  if (Math.abs(a.f - b.f) > POSE_EPSILON) return true
  for (let i = 0; i < 16; i++) {
    if (Math.abs((a.m[i] ?? 0) - (b.m[i] ?? 0)) > POSE_EPSILON) return true
    if (Math.abs((a.p[i] ?? 0) - (b.p[i] ?? 0)) > POSE_EPSILON) return true
  }
  return false
}

function readPose(rgl: RglInstance): FigurePose | null {
  const sub = rgl.getObj(rgl.scene.rootSubscene)
  if (!sub?.par3d) return null
  const { par3d } = sub
  return {
    m: par3d.userMatrix.getAsArray(),
    p: par3d.userProjection ? par3d.userProjection.getAsArray() : [],
    z: par3d.zoom,
    f: par3d.FOV,
    t: Date.now(),
  }
}

/**
 * Write a pose onto every subscene that listens to the root, which is what rgl's
 * own mouse handlers do. Skip's figures are single-subscene today; walking the
 * listeners means a multi-subscene figure updates as a whole instead of halfway.
 */
function writePose(rgl: RglInstance, pose: FigurePose) {
  const root = rgl.getObj(rgl.scene.rootSubscene)
  if (!root?.par3d) return
  const targets = root.par3d.listeners?.length ? root.par3d.listeners : [rgl.scene.rootSubscene]
  for (const id of targets) {
    const sub = rgl.getObj(id)
    if (!sub?.par3d) continue
    sub.par3d.userMatrix.load(pose.m)
    if (pose.p.length === 16 && sub.par3d.userProjection) sub.par3d.userProjection.load(pose.p)
    sub.par3d.zoom = pose.z
    sub.par3d.FOV = pose.f
  }
}

/**
 * An absent key is the normal "nobody has rotated this yet" case and reads as
 * null. Unparseable content is not normal — it means something wrote a pose we
 * can't honour, so it is reported rather than swallowed.
 */
function parsePose(raw: unknown, shapeId: string, index: number): FigurePose | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') {
    log.metric('rgl-sync', 'figure pose was not a string', { shapeId, index, type: typeof raw })
    console.error('[rgl-sync] figure pose was not a string', { shapeId, index })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log.metric('rgl-sync', 'figure pose was not valid JSON', { shapeId, index, raw: raw.slice(0, 120) })
    console.error('[rgl-sync] unparseable figure pose', { shapeId, index }, error)
    return null
  }
  const pose = parsed as Partial<FigurePose>
  if (!pose || !Array.isArray(pose.m) || typeof pose.z !== 'number' || typeof pose.f !== 'number') {
    log.metric('rgl-sync', 'figure pose had unexpected shape', { shapeId, index })
    console.error('[rgl-sync] figure pose missing required fields', { shapeId, index })
    return null
  }
  return { m: pose.m, p: Array.isArray(pose.p) ? pose.p : [], z: pose.z, f: pose.f, t: pose.t ?? 0 }
}

type FigureBinding = {
  index: number
  rgl: RglInstance
  /** Set while we are applying someone else's pose, so we don't republish it as ours. */
  applyingRemote: boolean
  lastPublished: FigurePose | null
  pendingFrame: number | null
}

const attached = new WeakMap<HTMLIFrameElement, () => void>()

/**
 * Bind every rgl figure in a deck iframe to the deck shape's props.
 * Returns a teardown. Calling it twice on the same iframe returns the first one.
 */
export function attachRglFigureSync(editor: Editor, shapeId: TLShapeId, iframe: HTMLIFrameElement) {
  const existing = attached.get(iframe)
  if (existing) return existing

  const bindings: FigureBinding[] = []
  let disposed = false
  let removeStoreListener: (() => void) | null = null

  const readStoredPose = (index: number): FigurePose | null => {
    const shape = editor.store.get(shapeId) as { meta?: Record<string, unknown> } | undefined
    return parsePose(shape?.meta?.[figurePoseMetaKey(index)], shapeId, index)
  }

  const publish = (binding: FigureBinding) => {
    binding.pendingFrame = null
    if (disposed || binding.applyingRemote) return
    const pose = readPose(binding.rgl)
    if (!pose || !posesDiffer(pose, binding.lastPublished)) return
    binding.lastPublished = pose
    const shape = editor.store.get(shapeId) as { type?: string; meta?: Record<string, unknown> } | undefined
    if (!shape) return
    // Spread-then-set writes one key; tldraw diffs meta per key, so a peer
    // rotating a different figure is not clobbered by this write.
    editor.updateShape({
      id: shapeId,
      type: shape.type,
      meta: { ...shape.meta, [figurePoseMetaKey(binding.index)]: JSON.stringify(pose) },
    } as Parameters<typeof editor.updateShape>[0])
  }

  const applyStored = (binding: FigureBinding) => {
    const stored = readStoredPose(binding.index)
    if (!stored) return
    const current = readPose(binding.rgl)
    if (!posesDiffer(stored, current)) return
    binding.applyingRemote = true
    try {
      writePose(binding.rgl, stored)
      binding.rgl.drawScene()
      binding.lastPublished = stored
    } finally {
      binding.applyingRemote = false
    }
  }

  const bind = () => {
    const doc = iframe.contentDocument
    if (!doc) return false
    // Position, NOT element id, is the key. rgl regenerates widget ids on every
    // render (rgl52642 today, something else after the next Quarto build), so
    // keying on them would look correct in every test and then silently orphan
    // every stored orientation the first time the deck is rebuilt. Do not
    // "clean this up" to use ids because ids look more stable.
    const widgets = Array.from(doc.querySelectorAll('.rglWebGL'))
    const live = widgets.filter(el => !!(el as { rglinstance?: RglInstance }).rglinstance)
    if (live.length === 0) return false

    // Every figure binds — meta keys are free-form, so there is no slot limit and
    // no deck can quietly end up with an unshareable figure.
    live.forEach((el, index) => {
      const rgl = (el as { rglinstance?: RglInstance }).rglinstance
      if (!rgl) return
      const binding: FigureBinding = { index, rgl, applyingRemote: false, lastPublished: null, pendingFrame: null }

      // Every rgl interaction path — mouse, wheel, touch, and any mode we haven't
      // enumerated — ends in drawScene(). Wrapping it is the one observation point
      // that cannot miss a gesture, which listening for pointer events can.
      const inner = rgl.drawScene.bind(rgl)
      rgl.drawScene = () => {
        inner()
        if (disposed || binding.applyingRemote) return
        // Coalesce to one write per frame: a drag fires drawScene far faster.
        if (binding.pendingFrame === null) {
          binding.pendingFrame = requestAnimationFrame(() => publish(binding))
        }
      }

      bindings.push(binding)
      applyStored(binding)
    })

    // A local rotation and a remote one both land as prop changes; applyStored's
    // epsilon check makes reacting to our own write a no-op.
    removeStoreListener = editor.store.listen(
      ({ changes }) => {
        if (disposed) return
        if (!Object.keys(changes.updated ?? {}).includes(shapeId)) return
        for (const binding of bindings) applyStored(binding)
      },
      { scope: 'document' },
    )

    return true
  }

  // htmlwidgets binds instances asynchronously after the iframe's load event, so
  // the widgets may not exist yet on the first attempt.
  let attempts = 0
  const tryBind = () => {
    if (disposed || bind()) return
    if (++attempts > 40) {
      // Only decks that actually contain rgl figures are expected to bind, so a
      // deck without them timing out here is normal and not worth reporting.
      return
    }
    setTimeout(tryBind, 250)
  }
  tryBind()

  const teardown = () => {
    disposed = true
    removeStoreListener?.()
    for (const binding of bindings) {
      if (binding.pendingFrame !== null) cancelAnimationFrame(binding.pendingFrame)
    }
    attached.delete(iframe)
  }
  attached.set(iframe, teardown)
  return teardown
}
