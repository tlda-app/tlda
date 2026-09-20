// The layers of a book, and which one you are writing.
//
// Skip, 02:08 EDT: "so like in photoshop or whatever, you select any number of
// layers to be visible and one to be the current write target."
//
// Two independent selections with different cardinalities, and that is the whole
// model:
//
//   visible       many   a set
//   write target  one    a choice among the visible
//
// The notation is borrowed and so is its meaning. AGENTS.md: when a source can
// be named, the unstated answers are already decided by it. From a graphics
// editor's layers panel, without asking anything further — hiding a layer hides
// it and deletes nothing; the write target is one of the visible layers;
// switching it is a selection rather than a mode; and the tool never changes the
// destination, so pen, highlighter and eraser all act on the write target.
//
// There is no access model here. Skip, asked whether a student may write the
// common layer: "yes", and "xommon means fucking common dude." Everyone who can
// see the book can write its layer.

/** `common` is the book's own room — the layer everyone in the class shares. */
export type BookLayerId = 'common' | 'mine' | `student:${string}` | `marking:${string}`

export interface BookLayer {
  id: BookLayerId
  /** Shown in the layer control. */
  label: string
  visible: boolean
  /** Whose overlay room, for the layers that have one. `common` has none. */
  studentId?: string
  /** False for a layer you may look at but not write, e.g. a student's, to a teacher. */
  targetable: boolean
  /**
   * False for a layer that may not receive a moved selection.
   *
   * Separate from `targetable`, which is about writing NEW ink here. A marking
   * layer is written into and is still not somewhere you may move existing ink
   * TO: the move converts through the layer's declared frame, and a marking
   * layer's frame is the answer's wrapper rather than the page. Offering the
   * move and landing the ink at the origin is worse than not offering it.
   */
  movable?: boolean
  /**
   * Registered by whatever owns the thing, rather than seeded by role.
   *
   * The seed rows are the book's own; these come and go as work is opened. A
   * new reader's seed replaces the seed and re-applies these, because who is
   * reading changing is not the same event as what is open changing.
   */
  registered?: boolean
  /** Whose work this layer hangs off. Null for the book's own layers. */
  owner?: string | null
  /** The group that may also reach it, e.g. `instructors:<courseId>`. */
  group?: string | null
  /** Whether a person is ever offered this row, as against plumbing. */
  offerable?: boolean
  /**
   * `draft` denies everyone but an instructor member, the owner included;
   * `returned` admits the owner read-only; `open` is the ordinary check.
   *
   * As registered this is per-reader — a marking layer is `draft` in the
   * instructor's view and `returned` in the student's, because each is bound to
   * the room they actually read. A server-side registry would carry one row per
   * object and evaluate membership at query time instead.
   */
  draftState?: 'open' | 'draft' | 'returned'
}

export interface BookLayerState {
  layers: BookLayer[]
  target: BookLayerId
}

/**
 * Add a layer, or replace it where it already is.
 *
 * Registration is the act that says a thing is shown to a person — which is why
 * the list is what has been registered rather than a set someone maintains.
 * Skip: *"the idea that we have static lists is fling stupid"*.
 *
 * Position is preserved on replace so a re-register does not reorder the
 * control under someone's cursor, and neither the write target nor any other
 * row's visibility is touched: opening a new thing is not a reason to change
 * what someone was looking at or writing into.
 */
export function registerLayer(state: BookLayerState, layer: BookLayer): BookLayerState {
  const row = { ...layer, registered: true }
  const at = state.layers.findIndex(existing => existing.id === layer.id)
  if (at < 0) return { ...state, layers: [...state.layers, row] }
  const layers = [...state.layers]
  layers[at] = row
  return { ...state, layers }
}

/**
 * Remove a registered layer.
 *
 * Writing falls back to `common` if the layer being removed was the target —
 * the book's own layer is the one that is always there, and leaving the target
 * pointing at something gone would make the next stroke land nowhere.
 */
export function unregisterLayer(state: BookLayerState, id: BookLayerId): BookLayerState {
  const layers = state.layers.filter(layer => layer.id !== id)
  if (layers.length === state.layers.length) return state
  return { layers, target: state.target === id ? 'common' : state.target }
}

/** The rows something registered, as against the seed for this reader. */
export function registeredLayers(state: BookLayerState): BookLayer[] {
  return state.layers.filter(layer => layer.registered)
}

/**
 * The layers a reader has with no second room of their own: just the book's.
 *
 * One layer is no choice, so the control that offers the choice does not appear
 * — which is a fact about the layers, not about who is reading. An instructor
 * reading the book alone is in this state for the same reason an unenrolled
 * reader is, and both may write the common layer: "xommon means fucking common."
 */
export function readerLayers(): BookLayerState {
  return {
    layers: [{ id: 'common', label: 'Class', visible: true, targetable: true }],
    target: 'common',
  }
}

/**
 * The layers an enrolled student has: the book's, and their own.
 *
 * Default write target is the common layer, because that is the book's normal
 * layer and it is what a reader who never touches the control should get.
 */
export function studentLayers(): BookLayerState {
  return {
    layers: [
      { id: 'common', label: 'Class', visible: true, targetable: true },
      { id: 'mine', label: 'Mine', visible: true, targetable: true },
    ],
    target: 'common',
  }
}

/**
 * The layers a teacher has while reading one student: the book's, and theirs.
 *
 * The student's layer is visible and not targetable. Marking is returned to a
 * student deliberately and is written where marking already writes it; a teacher
 * who landed in a student's layer drawing live would be a different feature.
 */
export function teacherLayers(students: readonly { id: string; displayName: string }[]): BookLayerState {
  return {
    layers: [
      { id: 'common', label: 'Class', visible: true, targetable: true },
      ...students.map(student => ({
        id: `student:${student.id}` as const,
        label: student.displayName,
        visible: true,
        studentId: student.id,
        targetable: false,
      })),
    ],
    target: 'common',
  }
}

/** Show or hide one layer. The write target is never hidden — it is what you are writing. */
export function setLayerVisible(state: BookLayerState, id: BookLayerId, visible: boolean): BookLayerState {
  if (!visible && id === state.target) return state
  return { ...state, layers: state.layers.map(l => (l.id === id ? { ...l, visible } : l)) }
}

/**
 * Choose the write target.
 *
 * Targeting a hidden layer shows it, rather than being refused: the write target
 * is one of the visible layers, so the two selections cannot contradict, and
 * writing somewhere you cannot see is the state this rules out.
 */
export function setWriteTarget(state: BookLayerState, id: BookLayerId): BookLayerState {
  const layer = state.layers.find(l => l.id === id)
  if (!layer?.targetable) return state
  return {
    target: id,
    layers: state.layers.map(l => (l.id === id ? { ...l, visible: true } : l)),
  }
}
