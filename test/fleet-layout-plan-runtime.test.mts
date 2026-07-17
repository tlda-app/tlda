import assert from 'node:assert/strict'
import test from 'node:test'
import type { FleetLayoutPlanInput } from '../src/shapes/fleet-layout-plan.ts'

const { planFleetLayoutShapes } = await import('../src/shapes/fleet-layout-plan.ts')

function baseInput(overrides: Partial<FleetLayoutPlanInput> = {}): FleetLayoutPlanInput {
  return {
    variant: '3-col',
    myId: 'fleet:skip',
    myDevice: 'air',
    anchorX: 1000,
    anchorY: 2000,
    docMaxRight: 5000,
    dx: -4000,
    gap: 10,
    leftW: 320,
    chatW3: 400,
    marginGap: 120,
    totalH: 900,
    agentsH: 330,
    searchH: 560,
    rightChatH: 675,
    docviewH: 215,
    viewport: { w: 390, h: 844 },
    makeSlotId: slot => `shape:${slot}`,
    filters: [
      [[['from', 'alpha']]],
      [[['from', 'beta']]],
      [[['from', 'gamma']]],
      [[['from', 'delta']]],
    ],
    ...overrides,
  }
}

test('2x2 layout plan creates four chats and no docview', () => {
  const plan = planFleetLayoutShapes(baseInput({ variant: '2x2' }))
  const chatShapes = plan.shapes.filter(s => s.type === 'fleet-chat')
  assert.equal(chatShapes.length, 4)
  assert.equal(plan.shapes.some(s => s.type === 'fleet-docview'), false)
  assert.deepEqual(chatShapes.map(s => s.id), ['shape:chat-0', 'shape:chat-1', 'shape:chat-2', 'shape:chat-3'])
  assert.deepEqual(chatShapes.map(s => s.props.filter), [
    [[['from', 'alpha']]],
    [[['from', 'beta']]],
    [[['from', 'gamma']]],
    [[['from', 'delta']]],
  ])
})

test('single-chat plan creates exactly one full-screen chat', () => {
  const plan = planFleetLayoutShapes(baseInput({
    variant: 'single-chat',
    viewport: { w: 390, h: 844 },
  }))
  assert.equal(plan.shapes.length, 1)
  assert.equal(plan.shapes[0].type, 'fleet-chat')
  assert.equal(plan.shapes[0].props.w, 390)
  assert.equal(plan.shapes[0].props.h, 844)
  assert.deepEqual(plan.shapes[0].props.filter, [[['from', 'alpha']]])
})

test('single-chat plan creates exactly one full-screen chat in landscape phone viewport', () => {
  const plan = planFleetLayoutShapes(baseInput({
    variant: 'single-chat',
    viewport: { w: 844, h: 390 },
  }))
  assert.equal(plan.shapes.length, 1)
  assert.equal(plan.shapes[0].type, 'fleet-chat')
  assert.equal(plan.shapes[0].props.w, 844)
  assert.equal(plan.shapes[0].props.h, 390)
  assert.deepEqual(plan.shapes[0].props.filter, [[['from', 'alpha']]])
})

test('3-col plan preserves ordinary multi-shape layout on phone-sized viewports', () => {
  const plan = planFleetLayoutShapes(baseInput({
    variant: '3-col',
    viewport: { w: 390, h: 844 },
  }))
  assert.deepEqual(plan.shapes.map(s => s.type), [
    'fleet-inbox',
    'fleet-agents',
    'fleet-search',
    'fleet-chat',
    'fleet-chat',
    'fleet-docview',
  ])
})

test('both-margins layout plan preserves docview/source editor defaults', () => {
  const plan = planFleetLayoutShapes(baseInput({ variant: 'both-margins' }))
  const docview = plan.shapes.find(s => s.type === 'fleet-docview')!
  const sourceEditor = plan.shapes.find(s => s.type === 'fleet-source-editor')!
  assert.deepEqual(
    {
      mode: docview.props.mode,
      label: docview.props.label,
      page: docview.props.page,
      yTop: docview.props.yTop,
      yBottom: docview.props.yBottom,
      title: docview.props.title,
    },
    { mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
  )
  assert.deepEqual(
    { file: sourceEditor.props.file, line: sourceEditor.props.line, title: sourceEditor.props.title },
    { file: '', line: 1, title: 'Source' },
  )
  assert.equal(sourceEditor.x, 1120)
})
