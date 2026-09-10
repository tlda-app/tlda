import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerMoveFailed, moveShapesToLayer, sameFrame } from '../src/classroom/moveBetweenLayers.ts'
import { gradingDraftRoomId } from '../shared/classroom-rooms.mjs'
import { markingLayerCaptures } from '../src/classroom/markingCapture.ts'
import { releaseHeldEnd, resolveReturnEnds as resolveEnds } from '../src/classroom/returnEnds.ts'

// The Return transition, at the composition boundary the browser cannot make
// deterministic: what happens when the server half succeeds and the move half
// does not.
//
// The two halves cannot commit together — one is a row in the classroom store,
// the other is shapes in a sync room. Server first fails CLOSED: the record runs
// ahead of itself, and nothing the student should not see has been published.
// These are the controls for that claim, and for the retry that clears it.

function fakeStore(shapes = [], { refuseCreate = false } = {}) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  return {
    getShape: id => byId.get(id),
    createShapes: incoming => { if (refuseCreate) return; for (const s of incoming) byId.set(s.id, s) },
    deleteShapes: ids => { for (const id of ids) byId.delete(id) },
    getCurrentPageId: () => 'page:main',
    ids: () => [...byId.keys()].sort(),
  }
}

const mark = id => ({ id, type: 'draw', parentId: 'page:main', index: 'a1', meta: {} })

// --- the failure the ordering exists to survive ---

test('a move that fails after the server recorded the return leaves the marks private', () => {
  const draft = fakeStore([mark('shape:m1'), mark('shape:m2')])
  const submission = fakeStore([], { refuseCreate: true })

  assert.throws(
    () => moveShapesToLayer(draft, submission, ['shape:m1', 'shape:m2'], sameFrame),
    LayerMoveFailed,
  )
  // Nothing published...
  assert.deepEqual(submission.ids(), [], 'marks reached the student despite a failed move')
  // ...and nothing lost: they are still on the private layer, which is what
  // makes the retry able to finish the job.
  assert.deepEqual(draft.ids(), ['shape:m1', 'shape:m2'], 'marks were deleted before the destination took them')
})

test('retrying after that failure publishes exactly once', () => {
  const draft = fakeStore([mark('shape:m1'), mark('shape:m2')])
  const refusing = fakeStore([], { refuseCreate: true })
  assert.throws(() => moveShapesToLayer(draft, refusing, draft.ids(), sameFrame), LayerMoveFailed)

  // The retry, against a destination that now accepts.
  const submission = fakeStore()
  const moved = moveShapesToLayer(draft, submission, draft.ids(), sameFrame)
  assert.deepEqual(moved.sort(), ['shape:m1', 'shape:m2'])
  assert.deepEqual(submission.ids(), ['shape:m1', 'shape:m2'])
  assert.deepEqual(draft.ids(), [], 'the draft still holds marks that were published')
})

test('pressing Return twice does not duplicate', () => {
  const draft = fakeStore([mark('shape:m1')])
  const submission = fakeStore()
  moveShapesToLayer(draft, submission, draft.ids(), sameFrame)
  // Second press: the draft is empty, so there is nothing to move and nothing
  // to duplicate. This is what makes the preserved retry path safe.
  const again = moveShapesToLayer(draft, submission, draft.ids(), sameFrame)
  assert.deepEqual(again, [])
  assert.deepEqual(submission.ids(), ['shape:m1'])
})

// --- positive control: the instrument can tell success from failure ---

test('control — an accepting destination does publish', () => {
  const draft = fakeStore([mark('shape:m1')])
  const submission = fakeStore()
  assert.deepEqual(moveShapesToLayer(draft, submission, ['shape:m1'], sameFrame), ['shape:m1'])
  assert.deepEqual(submission.ids(), ['shape:m1'])
  assert.deepEqual(draft.ids(), [])
})

// --- the pairing that decides WHOSE marks move ---

test("each student's draft layer is a different room, and hangs off their own submission", () => {
  // Flicking to the next student must change the draft room with the submission,
  // or one student's marks would be published onto another's work.
  const ada = gradingDraftRoomId('doc-submission-hw1-ada')
  const bo = gradingDraftRoomId('doc-submission-hw1-bo')
  assert.notEqual(ada, bo)
  assert.ok(ada.startsWith('doc-submission-hw1-ada'), 'the draft layer is not named off its own submission')
  assert.ok(bo.startsWith('doc-submission-hw1-bo'))
})

// --- what the marking layer takes the pointer for ---
//
// Skip: capture only while drawing; otherwise pointer, selection and scroll
// reach the surface underneath. The direction of this rule is the whole point —
// an exception-list captured every non-drawing tool in the app, which is the
// opposite of what he asked for.

test('the marking layer captures for mark-making tools', () => {
  for (const tool of ['draw', 'highlight', 'eraser', 'math-note', 'voice-note']) {
    assert.equal(markingLayerCaptures(tool), true, `${tool} should reach the marking layer`)
  }
})

test('every other tool reaches the surface underneath', () => {
  // These are real tools in this app, not hypotheticals: the pane would be
  // frozen under the layer for each one of them.
  for (const tool of ['select', 'hand', 'text-select', 'browse', 'terminal', 'cluster',
                      'playback-frame', 'fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-inbox']) {
    assert.equal(markingLayerCaptures(tool), false, `${tool} must pass through to the pane`)
  }
})

test('a tool nobody has written yet passes through rather than capturing', () => {
  // The failure this ordering prevents: a tool added later silently swallowing
  // the pane's pointer because it was not on an exception list.
  assert.equal(markingLayerCaptures('some-tool-added-next-year'), false)
})

// --- the two ways a held editor goes wrong ---
//
// Both were measured, not imagined. Pressing Return re-renders, the overlay is
// replaced, and a handler holding the editor from render time deleted from a
// disposed one — silently, reporting success, because the dead editor's last
// store state still listed the marks. The second is the same shape of bug with
// a worse outcome: flick to the next student while the request is in flight and
// the return recorded for one student would publish onto another's work.
//
// `resolveEnds` is the rule those two cases turn on: read both ends now, and
// require both to still belong to the room this return was started for.

// The PRODUCTION rule, imported — not a copy of it defined here. A local
// reimplementation would assert this file's opinion and pass no matter what
// `ProblemMarking` actually does, which is exactly how the six deleted marking
// tests stayed green while nothing was ever withheld.
const ADA_ROOM = 'doc-submission-hw1-ada'
const BO_ROOM = 'doc-submission-hw1-bo'

test('an editor replaced between invocation and move is the one used, not the dead one', () => {
  // The live refs at move time hold the REPLACEMENT. Reading them now is what
  // makes the move act on the editor that exists, rather than on whatever was
  // captured when the button was pressed.
  const dead = { editor: 'editor-disposed', roomId: ADA_ROOM }
  const live = { editor: 'editor-live', roomId: ADA_ROOM }
  let refs = { draft: dead, destination: { editor: 'dest', roomId: ADA_ROOM } }
  refs = { draft: live, destination: refs.destination }   // remount, mid-flight

  const ends = resolveEnds({ ...refs, intendedRoomId: ADA_ROOM })
  assert.equal(ends.draft, 'editor-live', 'the move used the disposed editor')
})

test('a student switch mid-flight publishes nothing rather than onto the wrong student', () => {
  // Ada's return is recorded; the screen has moved to Bo. Publishing here would
  // put Ada's marks on Bo's work — silently, and on the student-visible side.
  const ends = resolveEnds({
    draft: { editor: 'bo-draft', roomId: BO_ROOM },
    destination: { editor: 'bo-submission', roomId: BO_ROOM },
    intendedRoomId: ADA_ROOM,
  })
  assert.equal(ends, null, "a return begun on one student was allowed to finish on another")
})

test('a half-switched pair is refused too', () => {
  // Only one end moved on. Checking a single end would have let this through.
  assert.equal(resolveEnds({
    draft: { editor: 'ada-draft', roomId: ADA_ROOM },
    destination: { editor: 'bo-submission', roomId: BO_ROOM },
    intendedRoomId: ADA_ROOM,
  }), null, 'the destination was stale and the move proceeded')
  assert.equal(resolveEnds({
    draft: { editor: 'bo-draft', roomId: BO_ROOM },
    destination: { editor: 'ada-submission', roomId: ADA_ROOM },
    intendedRoomId: ADA_ROOM,
  }), null, 'the draft was stale and the move proceeded')
})

test('an unmounted end refuses rather than throwing past the guard', () => {
  assert.equal(resolveEnds({ draft: null, destination: { editor: 'd', roomId: ADA_ROOM }, intendedRoomId: ADA_ROOM }), null)
  assert.equal(resolveEnds({ draft: { editor: 'd', roomId: ADA_ROOM }, destination: null, intendedRoomId: ADA_ROOM }), null)
})

test('control — the ordinary case still resolves both ends', () => {
  // Without this the four refusals above would pass on a rule that refuses
  // everything, which "fixes" Return by making it never publish.
  const ends = resolveEnds({
    draft: { editor: 'ada-draft', roomId: ADA_ROOM },
    destination: { editor: 'ada-submission', roomId: ADA_ROOM },
    intendedRoomId: ADA_ROOM,
  })
  assert.deepEqual(ends, { draft: 'ada-draft', destination: 'ada-submission' })
})

// --- the late release, which is a live-reference bug and not a tidy-up ---
//
// A remount runs the OLD editor's teardown after the replacement has already
// registered. `SvgDocumentEditor` reports teardown as `onEditorMount(null)`,
// which does not say which editor went — so a holder that clears on it erases
// the editor currently on screen, and the next Return finds no destination.
// The room cannot distinguish them: old and new are the same room.

test('an old editor releasing after its replacement mounted does not clear the live one', () => {
  const live = { editor: 'editor-new', roomId: ADA_ROOM }
  // teardown of the editor that was replaced, arriving late
  assert.deepEqual(releaseHeldEnd(live, 'editor-old'), live, 'the live destination was erased by a late release')
})

test('the editor actually held is cleared when it releases', () => {
  // Without this the guard above would pass on a rule that never clears, and a
  // disposed editor would be held forever.
  const held = { editor: 'editor-a', roomId: ADA_ROOM }
  assert.equal(releaseHeldEnd(held, 'editor-a'), null)
})

test('releasing when nothing is held is a no-op', () => {
  assert.equal(releaseHeldEnd(null, 'editor-a'), null)
})
