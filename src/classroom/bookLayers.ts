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
export type BookLayerId = 'common' | 'mine' | 'student'

export interface BookLayer {
  id: BookLayerId
  /** Shown in the layer control. */
  label: string
  visible: boolean
  /** Whose overlay room, for the layers that have one. `common` has none. */
  studentId?: string
  /** False for a layer you may look at but not write, e.g. a student's, to a teacher. */
  targetable: boolean
}

export interface BookLayerState {
  layers: BookLayer[]
  target: BookLayerId
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
export function teacherLayers(studentId: string, displayName: string): BookLayerState {
  return {
    layers: [
      { id: 'common', label: 'Class', visible: true, targetable: true },
      { id: 'student', label: displayName, visible: true, studentId, targetable: false },
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
