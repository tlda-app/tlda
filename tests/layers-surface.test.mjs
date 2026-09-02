import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Two facts about where the layers control lives, asserted against source
// because both are about what a surface mounts rather than what a function
// returns — and both were wrong in a way nobody could see from a green suite.
//
// Skip, 2026-09-02 03:44-03:45 EDT: "ps the layers ui is complete bullshit /
// it's like / 'draft mode' / an old fucking thing / so get me real fking layers
// please", and "yeah, the draft mode layer icons were suppsoed to be borrowed;
// not the fking mode itself."
//
// He was right and it was not the control's fault. The control he specified
// existed; on his surface it could not render, and draft mode was the only
// thing in that row.

const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('an ordinary document or deck renders the layers surface, not the bare editor', () => {
  const app = read('App.tsx')
  // The `svg` case is every project whose format is not `book` — every document
  // he opens by name, and every deck he presents. It used to render
  // SvgDocumentEditor directly, which is why there were no layers on it at all:
  // no overlay rooms, and a control with nothing to offer.
  assert.match(app, /<DocumentWithLayers\b/, 'the svg path mounts the layers surface')
  assert.doesNotMatch(
    app,
    /<SvgDocumentEditor\b/,
    'nothing renders the editor without layers around it; that is what left the control unreachable',
  )
})

test('the rejected draft-mode pills are not beside the real layers control', () => {
  const doc = read('SvgDocument.tsx')
  assert.match(doc, /<BookLayersSlot\s*\/>/, 'the real control is in the pills row')
  // AnnotationVisibilityPill is a pill with a stacked-layers glyph whose
  // "layers" are own-versus-others' annotations at three opacities. That is the
  // thing he read as the layers UI. DraftPill is the other half of the same
  // mode. Neither belongs beside the control that replaced them.
  assert.doesNotMatch(doc, /<AnnotationVisibilityPill\b/, 'the fake layers pill is off this surface')
  assert.doesNotMatch(doc, /<DraftPill\b/, 'the draft-mode pill is off this surface')
})

test('the draft mechanism itself is untouched', () => {
  // "Do not expand this into deleting the underlying draft mechanism." Removing
  // a control is not the same as removing what it controlled, and this is the
  // line between the two — if this assertion ever fails, the change went wider
  // than it was scoped to.
  const visibility = read('annotationVisibility.ts')
  for (const symbol of ['publishAllDrafts', 'publishDrafts', 'setDraftMode', 'setVisibilityMode']) {
    assert.match(visibility, new RegExp(`export function ${symbol}\\b`), `${symbol} still exists`)
  }
})
