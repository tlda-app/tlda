import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('temporary markdown html-page surfaces do not paint a hardcoded page background', () => {
  const source = read('src/shapes/HtmlPageShape.tsx')
  assert.equal(source.includes('temporaryMarkdownBackground'), false)
  assert.equal(source.includes('#ffffff'), false)
  assert.equal(source.includes('#111318'), false)
  assert.match(source, /background:\s*'transparent'/)
})

test('rendered markdown documents explicitly keep the iframe document transparent', () => {
  const source = read('server/lib/build-markdown.mjs')
  assert.match(source, /html,\s*body\s*\{\s*background:\s*transparent;\s*\}/)
  assert.doesNotMatch(source, /body\s*\{[^}]*background:\s*#fff/i)
})

test('annotation viewer stays opaque and uses the canvas background variable', () => {
  const css = read('src/overlays/AnnotationViewer.css')
  assert.match(css, /annotation-viewer--pinned,[\s\S]*annotation-viewer--navigated,[\s\S]*annotation-viewer--phone-pane\s*\{[\s\S]*opacity:\s*1;/)
  assert.match(css, /\.annotation-viewer\s*\{[\s\S]*background:\s*var\(--tlda-canvas-background/)
  assert.match(css, /\.annotation-viewer-canvas\s*\{[\s\S]*background:\s*var\(--tlda-canvas-background/)
  assert.match(css, /\.annotation-viewer-clip\s*\{[\s\S]*background:\s*var\(--tlda-canvas-background/)
  assert.match(css, /\.annotation-viewer \.clip-panel,[\s\S]*\.annotation-viewer \.clip-panel-canvas\s*\{[\s\S]*background:\s*var\(--tlda-canvas-background/)
})

test('canvas theme sources publish the same variable annotation viewer consumes', () => {
  const appCss = read('src/App.css')
  const themesCss = read('src/themes.css')
  const documentPanelCss = read('src/DocumentPanel.css')

  assert.match(appCss, /--tlda-canvas-background:\s*#fff;/)
  assert.match(appCss, /\.tl-theme__dark\s*\{[\s\S]*--tlda-canvas-background:\s*#0f0f1a;/)
  assert.match(themesCss, /body\.fog-dark-mode,[\s\S]*body\.fog-dark-mode \.tl-theme__dark\s*\{[\s\S]*--tlda-canvas-background:\s*#1a2024;/)
  assert.match(themesCss, /body\.fog-light-mode,[\s\S]*body\.fog-light-mode \.tl-theme__dark\s*\{[\s\S]*--tlda-canvas-background:\s*#d2dfe3;/)
  assert.match(documentPanelCss, /body\.warm-mode,[\s\S]*body\.warm-mode \.tl-theme__dark\s*\{[\s\S]*--tlda-canvas-background:\s*#f5f0e8;/)
})
