import test from 'node:test'
import assert from 'node:assert/strict'
import { studentLayers, teacherLayers, setLayerVisible, setWriteTarget } from '../src/classroom/bookLayers.ts'

// The two cardinalities, from Skip 02:08 EDT: "you select any number of layers
// to be visible and one to be the current write target."
//
// These are the rules that rot quietly. A write target that is hidden, or two
// layers that both take marks, does not throw — it puts someone's work
// somewhere they are not looking.

test('the default write target is the book layer, so an untouched control writes where it already did', () => {
  const state = studentLayers()
  assert.equal(state.target, 'common')
  assert.ok(state.layers.every(l => l.visible), 'a layer started hidden')
})

test('visibility is many and independent of the write target', () => {
  let state = studentLayers()
  state = setWriteTarget(state, 'mine')
  state = setLayerVisible(state, 'common', false)

  assert.equal(state.target, 'mine', 'hiding a layer moved the write target')
  assert.equal(state.layers.find(l => l.id === 'common').visible, false)
  // Hiding hides. It does not remove the layer or change what it holds.
  assert.equal(state.layers.length, 2, 'hiding a layer removed it')
})

test('the write target cannot be hidden — it is what you are writing', () => {
  let state = studentLayers()
  const hidden = setLayerVisible(state, 'common', false)
  assert.equal(hidden.layers.find(l => l.id === 'common').visible, true, 'the write target was hidden')

  // And the same layer hides freely once it is no longer the target.
  state = setWriteTarget(state, 'mine')
  state = setLayerVisible(state, 'common', false)
  assert.equal(state.layers.find(l => l.id === 'common').visible, false)
})

test('targeting a hidden layer shows it rather than being refused', () => {
  let state = studentLayers()
  state = setWriteTarget(state, 'mine')
  state = setLayerVisible(state, 'common', false)
  state = setWriteTarget(state, 'common')

  assert.equal(state.target, 'common')
  assert.equal(state.layers.find(l => l.id === 'common').visible, true, 'the write target ended up invisible')
})

test('exactly one layer is the write target, always', () => {
  let state = studentLayers()
  for (const id of ['mine', 'common', 'mine']) {
    state = setWriteTarget(state, id)
    assert.equal(state.target, id)
  }
  // The target is a single field rather than a flag per layer, so two targets
  // are unrepresentable — this asserts the shape stayed that way.
  assert.equal(typeof state.target, 'string')
  assert.ok(!('isTarget' in state.layers[0]), 'a per-layer target flag reappeared and can disagree with state.target')
})

test("a teacher sees a student's layer and cannot write it", () => {
  let state = teacherLayers('ada', 'Ada')
  assert.equal(state.target, 'common')

  const student = state.layers.find(l => l.id === 'student')
  assert.equal(student.visible, true, 'the student layer was not visible to read')
  assert.equal(student.targetable, false)

  state = setWriteTarget(state, 'student')
  assert.equal(state.target, 'common', "a teacher took a student's layer as their write target")
})
