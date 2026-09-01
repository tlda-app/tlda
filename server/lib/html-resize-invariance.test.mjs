import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { injectBridge, injectSlidesBridge } from './html-injector.mjs'

function injectedFunction(html, name) {
  const start = html.indexOf(`function ${name}()`)
  assert.notEqual(start, -1, `${name} is present in the generated bridge`)
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    if (html[i] !== '}') continue
    depth--
    if (depth === 0) return html.slice(start, i + 1)
  }
  throw new Error(`${name} has no closing brace`)
}

function reportedHeights(functionSource, makeContext, appliedHeights) {
  return appliedHeights.map(appliedHeight => {
    const reports = []
    const context = makeContext(appliedHeight, reports)
    vm.runInNewContext(`(${functionSource})()`, context)
    assert.equal(reports.length, 1)
    return reports[0].height
  })
}

function assertInvariant(heights) {
  assert.equal(new Set(heights).size, 1, `reported heights moved with the parent: ${heights.join(', ')}`)
}

const sweep = [700, 1000, 1500, 2000, 2500, 3000, 1000]

test('both generated resize emitters are invariant to the parent-applied height', () => {
  const chapter = injectedFunction(injectBridge('<html><body><main></main></body></html>'), 'reportHeight')
  const chapterHeights = reportedHeights(chapter, (appliedHeight, reports) => {
    const parent = { postMessage: report => reports.push(report) }
    const window = { parent, scrollY: 0 }
    return {
      shapeId: 'chapter',
      window,
      document: {
        querySelector: selector => selector === 'main' ? { getBoundingClientRect: () => ({ bottom: 1420 }) } : null,
        body: { scrollHeight: appliedHeight / 2 + 1562, offsetHeight: appliedHeight },
        documentElement: { scrollHeight: appliedHeight / 2 + 1562 },
      },
      Math,
    }
  }, sweep)
  assertInvariant(chapterHeights)

  const slides = injectedFunction(injectSlidesBridge('<html><head></head><body></body></html>'), 'reportSlideHeight')
  const slideHeights = reportedHeights(slides, (appliedHeight, reports) => {
    const parent = { postMessage: report => reports.push(report) }
    const window = { parent }
    return {
      shapeId: 'slide',
      window,
      document: { body: { scrollHeight: appliedHeight / 2 + 1562 } },
      Reveal: {
        getCurrentSlide: () => ({ scrollHeight: 1762, offsetHeight: 702 }),
        getScale: () => 1.1057,
      },
      Math,
    }
  }, sweep)
  assertInvariant(slideHeights)
})

test('the invariance gate goes red on the Thursday document-height counterfactual', () => {
  const oldReports = sweep.map(appliedHeight => Math.ceil(appliedHeight / 2 + 1562))
  assert.throws(() => assertInvariant(oldReports), /reported heights moved with the parent/)
})
