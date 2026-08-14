import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { completePenCorrection, PEN_CORRECTION_EVENT } from '../src/tools/PenTool/penCorrectionTarget.ts'

test('pen correction crosses to the current chat message and word under the stroke', () => {
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
    completePenCorrection(
      { inputs: { getCurrentScreenPoint: () => ({ x: 90, y: 65 }) } },
      () => { strokeCompleted = true },
    )

    const delivered = { shapeId: 'shape:chat', messageId: '42', word: 'target' }
    assert.equal(strokeCompleted, true)
    assert.equal(received.target, actual)
    assert.deepEqual(received.detail, delivered)
    assert.equal(documentReceived, false)
  } finally {
    globalThis.document = previous.document
    globalThis.Node = previous.Node
    globalThis.NodeFilter = previous.NodeFilter
    globalThis.CustomEvent = previous.CustomEvent
    dom.window.close()
  }
})
