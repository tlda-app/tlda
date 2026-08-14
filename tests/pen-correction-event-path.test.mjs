import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { completePenCorrection, PEN_CORRECTION_EVENT } from '../src/tools/PenTool/penCorrectionTarget.ts'
import { installPenCorrectionConsumer } from '../src/tools/PenTool/penCorrectionConsumer.ts'

test('pen correction crosses from stroke completion through the row consumer', async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-shape-id="shape:document"><div id="document"></div></div>
    <div data-shape-id="shape:chat"><div class="fleet-chat-shape">
      <div data-msg-id="41"><span>older word</span></div>
      <div data-msg-id="42"><span>actual target</span></div>
    </div></div>
  </body>`)
  const previous = {
    document: globalThis.document,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    CustomEvent: globalThis.CustomEvent,
  }
  globalThis.document = dom.window.document
  globalThis.Node = dom.window.Node
  globalThis.NodeFilter = dom.window.NodeFilter
  globalThis.CustomEvent = dom.window.CustomEvent

  try {
    const older = dom.window.document.querySelector('[data-msg-id="41"]')
    const actual = dom.window.document.querySelector('[data-msg-id="42"]')
    const documentSurface = dom.window.document.querySelector('#document')
    older.getBoundingClientRect = () => ({ left: 10, top: 10, right: 190, bottom: 40, width: 180, height: 30 })
    actual.getBoundingClientRect = () => ({ left: 10, top: 50, right: 190, bottom: 80, width: 180, height: 30 })

    const originalCreateRange = dom.window.document.createRange.bind(dom.window.document)
    dom.window.document.createRange = () => {
      const range = originalCreateRange()
      let start = 0
      range.setStart = (_node, offset) => { start = offset }
      range.setEnd = () => {}
      range.getClientRects = () => start === 7
        ? [{ left: 70, top: 50, right: 120, bottom: 80, width: 50, height: 30 }]
        : [{ left: 10, top: 50, right: 60, bottom: 80, width: 50, height: 30 }]
      return range
    }

    let received = null
    let documentReceived = false
    actual.addEventListener(PEN_CORRECTION_EVENT, event => {
      received = { target: event.target, detail: event.detail }
    })
    documentSurface.addEventListener(PEN_CORRECTION_EVENT, () => { documentReceived = true })

    let strokeCompleted = false
    let shapes = new Set()
    const sent = []
    const removeConsumer = installPenCorrectionConsumer({
      element: actual.closest('.fleet-chat-shape'),
      messages: () => [{ _dbId: 42, from: 'fleet:agent', recipients: ['fleet:skip'] }],
      humanId: () => 'fleet:skip',
      recognize: async inkShapeId => inkShapeId === 'shape:ink' ? 'correct' : null,
      send: async (to, text) => { sent.push({ to, text }) },
    })
    completePenCorrection(
      {
        inputs: { getCurrentScreenPoint: () => ({ x: 90, y: 65 }) },
        getCurrentPageShapeIds: () => shapes,
        getShape: id => id === 'shape:ink' ? { type: 'draw' } : undefined,
      },
      () => { strokeCompleted = true; shapes = new Set(['shape:ink']) },
    )

    await new Promise(resolve => setTimeout(resolve, 0))

    const delivered = { shapeId: 'shape:chat', messageId: '42', word: 'target', inkShapeId: 'shape:ink' }
    assert.equal(strokeCompleted, true)
    assert.equal(received.target, actual)
    assert.deepEqual(received.detail, delivered)
    assert.deepEqual(sent, [{
      to: 'fleet:agent',
      text: 'Correction to message 42: “target” was meant to be “correct”.',
    }])
    assert.equal(documentReceived, false)
    removeConsumer()
  } finally {
    globalThis.document = previous.document
    globalThis.Node = previous.Node
    globalThis.NodeFilter = previous.NodeFilter
    globalThis.CustomEvent = previous.CustomEvent
    dom.window.close()
  }
})
