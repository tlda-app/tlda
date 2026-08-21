import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/App.css', import.meta.url), 'utf8')
const sourceEditor = await readFile(new URL('../src/shapes/FleetSourceEditorShape.tsx', import.meta.url), 'utf8')

test('tldraw loading uses the theme resolved before editor onMount', () => {
  assert.match(css, /html\[data-theme="dark"\][\s\S]*--tlda-canvas-background: #0f0f1a/)
  assert.match(css, /\.tl-loading\s*\{[\s\S]*background-color: var\(--tlda-canvas-background\) !important;[\s\S]*color: var\(--text-bright\) !important;/)
})

test('document version discovery lists local tips without a network fetch', () => {
  assert.match(sourceEditor, /fetch\(projectApiPath\(doc\.projectName, '\/remotes'\)\)/)
  assert.doesNotMatch(sourceEditor, /\/remotes\?fetch=true/)
})
