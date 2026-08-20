import assert from 'node:assert/strict'
import test from 'node:test'

const { adaptiveInnerColumnWidth, projectedDocumentSpan } = await import('../src/shapes/fleet-layout-sizing.ts')
const { planFleetLayoutShapes } = await import('../src/shapes/fleet-layout-plan.ts')

test('inner column keeps its preferred width when document and column fit', () => {
  assert.equal(adaptiveInnerColumnWidth({
    viewportWidth: 1600,
    documentWidth: 800,
    marginGap: 40,
    preferredWidth: 560,
    minimumWidth: 175,
  }), 560)
})

test('inner column narrows within its aspect range to share the viewport', () => {
  assert.equal(adaptiveInnerColumnWidth({
    viewportWidth: 1200,
    documentWidth: 800,
    marginGap: 40,
    preferredWidth: 560,
    minimumWidth: 175,
  }), 360)
})

test('realized width follows the projected document span rather than canonical page width', () => {
  const input = {
    viewportWidth: 1200,
    marginGap: 40,
    preferredWidth: 560,
    minimumWidth: 175,
  }
  assert.equal(adaptiveInnerColumnWidth({ ...input, documentWidth: 700 }), 460)
  assert.equal(adaptiveInnerColumnWidth({ ...input, documentWidth: 900 }), 260)
})

test('projected document geometry changes the realized inner-column width', () => {
  const bounds = {
    minLeft: 100,
    minTop: 0,
    maxRight: 900,
    maxBottom: 1000,
  }
  const realizedForScale = scale => adaptiveInnerColumnWidth({
    viewportWidth: 1200,
    documentWidth: projectedDocumentSpan(
      point => ({ x: point.x * scale, y: point.y * scale }),
      bounds,
      'x',
    ),
    marginGap: 42,
    preferredWidth: 560,
    minimumWidth: 175,
  })

  assert.equal(realizedForScale(0.875), 458)
  assert.equal(realizedForScale(1.125), 258)
})

test('below its minimum aspect the column keeps normal geometry for one-at-a-time access', () => {
  assert.equal(adaptiveInnerColumnWidth({
    viewportWidth: 950,
    documentWidth: 800,
    marginGap: 40,
    preferredWidth: 560,
    minimumWidth: 175,
  }), 560)
})

test('three-column layout adapts only the document-facing normal column', () => {
  const plan = planFleetLayoutShapes({
    variant: '3-col',
    myId: 'fleet:self',
    myDevice: 'device',
    anchorX: 0,
    anchorY: 0,
    docMaxRight: 800,
    docMaxBottom: 1000,
    flowAxis: 'y',
    dx: 0,
    gap: 10,
    leftW: 200,
    columnW: 500,
    innerColumnW: 300,
    marginGap: 40,
    totalH: 700,
    agentsH: 280,
    searchH: 410,
    rightChatH: 525,
    docviewH: 165,
    viewport: { w: 1200, h: 1000 },
    makeSlotId: slot => slot,
    filters: [[], [], [], []],
  })

  const outer = plan.shapes.find(shape => shape.id === 'chat-0')
  const innerChat = plan.shapes.find(shape => shape.id === 'chat-1')
  const innerDoc = plan.shapes.find(shape => shape.id === 'docview')
  assert.equal(outer?.props.w, 500)
  assert.equal(innerChat?.props.w, 300)
  assert.equal(innerDoc?.props.w, 300)
  assert.equal(outer?.props.h, 700)
})

test('two-margin layout leaves the far column at configured width', () => {
  const plan = planFleetLayoutShapes({
    variant: 'both-margins',
    myId: 'fleet:self',
    myDevice: 'device',
    anchorX: 0,
    anchorY: 0,
    docMaxRight: 800,
    docMaxBottom: 1000,
    flowAxis: 'y',
    dx: 0,
    gap: 10,
    leftW: 200,
    columnW: 500,
    innerColumnW: 300,
    marginGap: 40,
    totalH: 700,
    agentsH: 280,
    searchH: 410,
    rightChatH: 525,
    docviewH: 165,
    viewport: { w: 1200, h: 1000 },
    makeSlotId: slot => slot,
    filters: [[], [], [], []],
  })

  assert.equal(plan.shapes.find(shape => shape.id === 'chat-0')?.props.w, 550)
  assert.equal(plan.shapes.find(shape => shape.id === 'source-editor')?.props.w, 750)
})
