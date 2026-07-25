import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('Lilac is registered as a selectable persistent theme family', () => {
  const hook = read('src/hooks/useFleetTheme.ts')
  const toc = read('src/panels/TocTab.tsx')

  assert.match(hook, /export type ThemeFamily = 'fog' \| 'warm' \| 'lilac' \| null/)
  assert.match(hook, /lilac:\s*\{\s*dark:\s*'lilac-dark-mode',\s*light:\s*'lilac-light-mode'\s*\}/)
  assert.match(hook, /ALL_BODY_CLASSES = \[[^\]]*'lilac-dark-mode'[^\]]*'lilac-light-mode'[^\]]*\]/s)
  assert.match(hook, /v === 'fog' \|\| v === 'warm' \|\| v === 'lilac'/)

  assert.match(toc, /value:\s*'lilac',[^}]*label:\s*'Lilac'/s)
})

test('Lilac themes publish canvas variables and surface colors', () => {
  const css = read('src/themes.css')

  assert.match(css, /body\.lilac-dark-mode,\s*body\.lilac-dark-mode \.tl-theme__dark\s*\{[^}]*--tlda-canvas-background:\s*#1c1a21;/s)
  assert.match(css, /body\.lilac-light-mode,\s*body\.lilac-light-mode \.tl-theme__dark\s*\{[^}]*--tlda-canvas-background:\s*#dcd9e3;/s)
  assert.match(css, /body\.lilac-dark-mode \.fleet-chat-shape,[^{]*\{[^}]*--accent:\s*#9384a6;/s)
  assert.match(css, /body\.lilac-light-mode \.fleet-chat-shape,[^{]*\{[^}]*--accent:\s*#6d6086;/s)
})
