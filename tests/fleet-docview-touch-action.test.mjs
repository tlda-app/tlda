import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// One-finger touch drags on a fleet-docview panel must reach the native
// touch-drag-pan listeners in CanvasClipPanel. With touch-action:auto Mobile
// Safari may claim the drag as a scroll/zoom gesture and fire pointercancel
// before the JS pan commits; touch-action:none on the panel chain commits the
// compositor to the JS path (DocClipShape doc-clip-body precedent).
test('fleet-docview panel chain commits one-finger touch to the JS pan path', () => {
  const css = readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.fleet-docview .clip-panel,'))
  assert.notEqual(
    css.indexOf('.fleet-docview .clip-panel,'),
    -1,
    'fleet-chat.css must scope a touch-action rule to the docview panel chain',
  )
  for (const selector of [
    '.fleet-docview .clip-panel',
    '.fleet-docview .clip-panel-canvas',
    '.fleet-docview .clip-panel-wheel-capture',
  ]) {
    assert.ok(block.includes(selector), `touch-action rule must cover ${selector}`)
  }
  assert.match(block, /touch-action:\s*none/, 'panel chain must set touch-action: none')
})

test('docview touch-action rule is scoped to the panel chain, not the shape root', () => {
  const css = readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')
  const rootBlock = css.match(/\.fleet-docview\s*\{[^}]*\}/)?.[0] ?? ''
  assert.ok(!rootBlock.includes('touch-action'), 'rule must not sit on .fleet-docview itself')
})
