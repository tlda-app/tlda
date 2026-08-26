import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const editorSetup = readFileSync(new URL('../src/editorSetup.ts', import.meta.url), 'utf8')
const highlighterSlider = readFileSync(new URL('../src/shapes/HighlighterSliderShape.tsx', import.meta.url), 'utf8')

test('ordinary highlights do not become HTML paragraph sticky notes', () => {
  assert.doesNotMatch(editorSetup, /applyHtmlSelectionToHighlight/)
})

test('the right side of the viewport does not cancel drawing tools', () => {
  assert.doesNotMatch(editorSetup, /SLIDER_ZONE_WIDTH/)
  assert.doesNotMatch(editorSetup, /event\.point\.x\s*>=\s*w\s*-/)
})

test('the right-side slider overlay does not intercept drawing tools', () => {
  assert.match(highlighterSlider, /activeToolId === 'highlight' \|\| activeToolId === 'draw' \|\| activeToolId === 'eraser'/)
  assert.match(highlighterSlider, /pointerEvents: isDrawingTool \? 'none' : 'all'/)
})
