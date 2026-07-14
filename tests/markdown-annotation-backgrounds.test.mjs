import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `missing CSS block for ${selector}`)
  return match[1]
}

function cssDeclaration(css, selector, property) {
  const block = cssBlock(css, selector)
  const match = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))
  assert.ok(match, `missing ${property} declaration in ${selector}`)
  return match[1].trim()
}

function assertDeclaration(css, selector, property, value) {
  assert.equal(cssDeclaration(css, selector, property), value)
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
  const canvasBackground = 'var(--tlda-canvas-background, var(--color-background, var(--tl-color-background, #f8fafb)))'
  const darkCanvasBackground = 'var(--tlda-canvas-background, var(--color-background, var(--tl-color-background, #0f0f1a)))'

  assertDeclaration(css, '.annotation-viewer--hovering', 'opacity', '1')
  assertDeclaration(css, '.annotation-viewer--pinned,\n.annotation-viewer--navigated,\n.annotation-viewer--phone-pane', 'opacity', '1')
  assertDeclaration(css, '.annotation-viewer', 'background', canvasBackground)
  assertDeclaration(css, '.tl-theme__dark .annotation-viewer', 'background', darkCanvasBackground)
  assertDeclaration(css, '.annotation-viewer-canvas', 'background', canvasBackground)
  assertDeclaration(css, '.annotation-viewer-clip', 'background', canvasBackground)
  assertDeclaration(css, '.annotation-viewer .clip-panel,\n.annotation-viewer .clip-panel-canvas', 'background', canvasBackground)
  assertDeclaration(css, '.tl-theme__dark .annotation-viewer .clip-panel,\n.tl-theme__dark .annotation-viewer .clip-panel-canvas', 'background', darkCanvasBackground)
})

test('annotation viewer CSS is loaded after the generic clip panel CSS it overrides', () => {
  const source = read('src/overlays/AnnotationViewer.tsx')
  const clipPanelImport = source.indexOf("import { CanvasClipPanel")
  const annotationCssImport = source.indexOf("import './AnnotationViewer.css'")
  assert.notEqual(clipPanelImport, -1)
  assert.notEqual(annotationCssImport, -1)
  assert.ok(clipPanelImport < annotationCssImport)
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
