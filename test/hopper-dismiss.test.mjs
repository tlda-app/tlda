// Faithful unit proof of the suggestion-hopper dismissal logic (task #1).
// Skip's bug: the hopper only dismissed on the group's mouseleave, which never
// fires on touch when you tap empty space or scroll, so it stuck until you
// hovered another suggestion. attachHopperDismiss adds the non-hover triggers.
// We exercise the EXACT code path with real DOM events in jsdom — no React,
// no live viewer needed.
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { attachHopperDismiss } from '../src/fleet/hopper-dismiss.mjs'

describe('attachHopperDismiss — hopper dismisses without a hover', () => {
  let dom, doc, win, outside, group, chip, calls, cleanup

  before(() => {
    dom = new JSDOM('<!doctype html><body>' +
      '<div id="outside">empty canvas</div>' +
      '<span class="suggestion-group"><span class="suggestion-chip-label" id="chip">A</span></span>' +
      '</body>')
    doc = dom.window.document
    win = dom.window
    outside = doc.getElementById('outside')
    group = doc.querySelector('.suggestion-group')
    chip = doc.getElementById('chip')
  })

  beforeEach(() => {
    calls = 0
    cleanup = attachHopperDismiss(() => { calls++ }, { doc, win })
  })
  afterEach(() => { cleanup() })

  const fire = (el, type, EventCtor = win.Event, init = {}) =>
    el.dispatchEvent(new EventCtor(type, { bubbles: true, ...init }))

  it('TAP-AWAY: pointerdown on empty canvas dismisses', () => {
    fire(outside, 'pointerdown')
    assert.equal(calls, 1)
  })

  it('TAP-ON-GROUP: pointerdown inside a .suggestion-group does NOT dismiss (chip handles itself)', () => {
    fire(chip, 'pointerdown')   // tapping a chip / the group region
    assert.equal(calls, 0)
  })

  it('SCROLL: a scroll (capture) dismisses', () => {
    fire(doc, 'scroll')
    assert.equal(calls, 1)
  })

  it('WHEEL: a wheel dismisses', () => {
    fire(win, 'wheel')
    assert.equal(calls, 1)
  })

  it('ESCAPE: Escape keydown dismisses; other keys do not', () => {
    fire(doc, 'keydown', win.KeyboardEvent, { key: 'a' })
    assert.equal(calls, 0)
    fire(doc, 'keydown', win.KeyboardEvent, { key: 'Escape' })
    assert.equal(calls, 1)
  })

  it('CLEANUP: after cleanup, none of the triggers dismiss', () => {
    cleanup()
    fire(outside, 'pointerdown')
    fire(doc, 'scroll')
    fire(win, 'wheel')
    fire(doc, 'keydown', win.KeyboardEvent, { key: 'Escape' })
    assert.equal(calls, 0)
    // re-arm so afterEach's cleanup() is a no-op-safe double call
    cleanup = attachHopperDismiss(() => {}, { doc, win })
  })
})
