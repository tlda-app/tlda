// A marked answer is a thread of append-only annotation layers, each carrying
// its own voice track, each living inside the timeline of the one before it.
// See docs/annotation-threads.md.
//
// **A thread layer is just a local layer.** Skip, asked whether the thread's
// layers were a second kind of thing next to the book's: they are not. So there
// is one layer concept here, the one in `src/classroom/bookLayers.ts` — a set
// you can see and one you are writing — and a thread layer is one of those that
// carries a timeline.
//
// Two things follow, and both are the existing model rather than anything new:
//
//   - **Anyone replies to anything.** Skip: "its a thread anyone can reply to
//     anything". There is no access model on book layers — "xommon means
//     fucking common dude" — so a reply needs no permission to exist, and this
//     file does not contain one.
//   - **No removal.** Skip: "no removal". Hiding a layer hides it and deletes
//     nothing, which is already what the layer model does.
//
// What a layer adds on top of being a layer is a timeline: ink on its own clock
// and one audio track, which `src/recording/recorder.ts` already captures, and
// a warp. The warp exists nowhere else, so it is what this file is mostly about.

/**
 * A warp maps this layer's time onto its parent's.
 *
 * Recorded as control points `{ t, pt }` — layer time to parent time — read as
 * piecewise linear between them. It is sampled while marking, against the
 * parent's actual playhead, and cannot be recovered afterwards: nothing in the
 * ink or the audio says the playhead sat still for nine seconds.
 *
 * Two samples sharing a `t` encode an instantaneous jump — a duplicated
 * breakpoint, the standard way to put a step in a piecewise-linear function.
 * The later one is the value at and after that instant, so scrubbing back is a
 * pair of samples rather than a flag, and the reader of a warp never has a
 * special case to handle:
 *
 *   playing along      slope 1
 *   talking over it    a flat run — `pt` still while `t` advances
 *   scrubbing back     `pt` decreasing across a shared `t`
 *
 * @typedef {{ t: number, pt: number }} WarpSample
 * @typedef {{ samples: WarpSample[] }} Warp
 */

/** The warp of a layer that has not been marked against a parent yet. */
export function emptyWarp() {
  return { samples: [] }
}

/**
 * Where `t` in this layer's time falls in the parent's.
 *
 * Before the first sample and after the last, the warp holds at its end value:
 * a warp says where the parent playhead was while this layer was being
 * recorded, and outside that it is not evidence of anything.
 */
export function warpAt(warp, t) {
  const samples = warp?.samples ?? []
  if (!samples.length) return 0
  if (t <= samples[0].t) return samples[0].pt

  // The LAST sample at or before `t`, so an exact hit on a jump reads the value
  // after the jump rather than before it.
  let i = 0
  for (let k = 0; k < samples.length; k++) {
    if (samples[k].t <= t) i = k
    else break
  }
  if (i === samples.length - 1) return samples[i].pt
  // Not where the jump is handled — the scan above is, by taking the last of a
  // shared `t`. This only keeps a zero span out of the division below, which a
  // warp built by `appendWarpSample` cannot produce but a hand-edited one can.
  if (samples[i].t === t) return samples[i].pt

  const a = samples[i]
  const b = samples[i + 1]
  return a.pt + ((b.pt - a.pt) * (t - a.t)) / (b.t - a.t)
}

/** Whether three points lie on one line, within the slack a clock earns. */
function collinear(a, b, c) {
  // Cross product of (b-a) and (c-a). Scaled by the spans so the tolerance
  // means the same thing for a long flat run as for a short one.
  const cross = (b.t - a.t) * (c.pt - a.pt) - (b.pt - a.pt) * (c.t - a.t)
  return Math.abs(cross) <= 1e-6 * Math.max(1, Math.abs(c.t - a.t))
}

/**
 * Append a reading of the parent's playhead, taken at `t` in this layer's time.
 *
 * Returns a new warp; the layer's recorded warp is never edited in place, which
 * is the same append-only property the thread has one level up.
 *
 * A still playhead would otherwise write a sample per tick, so a reading that
 * continues the line the last two were already on replaces the middle one. That
 * is a compression of the same function, not a simplification of it, and what
 * keeps a recorded jump is the collinearity test itself: a step away from the
 * line the playhead was on is exactly what fails it.
 *
 * Two scrubs inside one instant do collapse to the instant's endpoints, and
 * that is the same function — a position passed through instantaneously is not
 * one the parent was ever shown at.
 */
export function appendWarpSample(warp, t, pt) {
  const samples = warp?.samples ?? []
  const n = samples.length
  if (n >= 2 && collinear(samples[n - 2], samples[n - 1], { t, pt })) {
    return { samples: [...samples.slice(0, n - 1), { t, pt }] }
  }
  return { samples: [...samples, { t, pt }] }
}

/**
 * Records a warp while this layer is being marked.
 *
 * Both clocks are passed in: `layerTime` is the recorder's own on-record
 * elapsed ms, and `parentTime` reads the parent's playhead where it actually
 * sits. Nothing here reaches for a clock of its own, so a marking session and a
 * test drive it the same way.
 *
 * It needs both of its inputs, and neither is redundant:
 *
 *  - `tick()` on a steady beat, because a playhead that is *not* moving leaves
 *    no trace otherwise. Talking over a still answer would then be two samples
 *    nine seconds apart, which reads back as a slow drift through the answer
 *    rather than a stop. The compression in `appendWarpSample` is what keeps
 *    that beat from costing anything: a flat run stays two points.
 *  - `jump()` when the playhead is moved rather than allowed to run, because a
 *    scrub between two ticks would otherwise interpolate — a ramp through every
 *    intervening moment of the answer, none of which were on screen.
 */
export class WarpRecorder {
  #layerTime
  #parentTime
  #warp = emptyWarp()
  #lastPt = null

  constructor({ layerTime, parentTime }) {
    this.#layerTime = layerTime
    this.#parentTime = parentTime
  }

  /** Take a reading of where the parent is now. */
  tick() {
    const pt = this.#parentTime()
    this.#warp = appendWarpSample(this.#warp, this.#layerTime(), pt)
    this.#lastPt = pt
  }

  /**
   * Record that the playhead was moved, not played, to where it now sits.
   *
   * Called after the move has landed: the value it was holding is this
   * recorder's own last reading, so a caller never has to sample the old
   * position before moving and get the ordering right.
   */
  jump() {
    const t = this.#layerTime()
    const pt = this.#parentTime()
    if (this.#lastPt !== null && this.#lastPt !== pt) {
      // Hold the old position right up to this instant, so what follows is a
      // step at a single `t` rather than a slope across the gap.
      this.#warp = appendWarpSample(this.#warp, t, this.#lastPt)
    }
    this.#warp = appendWarpSample(this.#warp, t, pt)
    this.#lastPt = pt
  }

  get warp() {
    return this.#warp
  }
}

/**
 * The layers of one thread: a student's answer to a problem.
 *
 * The address is the pair `shared/classroom-rooms.mjs` already names — the
 * submission room and the problem — so a thread hangs off the same identity the
 * marking layer does rather than a second one invented beside it.
 */
export function isSameAnswer(a, b) {
  return !!a && !!b
    && a.submissionRoomId === b.submissionRoomId
    && a.problemId === b.problemId
}

export function threadLayers(layers, answer) {
  return layers.filter((layer) => isSameAnswer(layer.answer, answer))
}

/** The roots of a thread: layers answering nothing, in the order given. */
export function threadRoots(layers) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  return layers.filter((layer) => !layer.parent || !byId.has(layer.parent.layerId))
}

/** The layers that answer `layerId` directly. A reply may answer any layer. */
export function repliesTo(layers, layerId) {
  return layers.filter((layer) => layer.parent?.layerId === layerId)
}

/**
 * The path from a thread's root down to `leafId`, root first.
 *
 * Walking up and reversing, rather than searching down, because a layer names
 * its parent and nothing names its children.
 */
export function layerPath(layers, leafId) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]))
  const path = []
  const seen = new Set()
  let current = byId.get(leafId)
  if (!current) {
    throw new Error(
      `No layer ${leafId} among the ${layers.length} given (${layers.map((l) => l.id).join(', ') || 'none'})`,
    )
  }
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(
        `Layer ${current.id} is its own ancestor, reached by ${path.map((l) => l.id).join(' -> ')}`,
      )
    }
    seen.add(current.id)
    path.push(current)
    const parentId = current.parent?.layerId
    current = parentId ? byId.get(parentId) : undefined
  }
  return path.reverse()
}

/**
 * Where `t` on the leaf falls in every layer along the path, root first.
 *
 * There is no single timeline for a thread — there is one per path — so this
 * takes the path rather than the thread, and composes that path's warps in
 * order: the leaf's own time, mapped into its parent's, that into its
 * grandparent's, and so on. Two replies warping the same parent differently are
 * not in conflict; they are two paths, and each is played by following it.
 *
 * Returns times aligned with `path`, so `times[i]` is the time to seek layer
 * `path[i]` to while the leaf's audio plays at `t`.
 */
export function composeAlongPath(path, t) {
  const times = new Array(path.length)
  let time = t
  for (let i = path.length - 1; i >= 0; i--) {
    times[i] = time
    const warp = path[i].parent?.warp
    if (i > 0) time = warpAt(warp, time)
  }
  return times
}
