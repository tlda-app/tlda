import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('the marking answer pane opts back into pointer events without opening the panel container', () => {
  const paneCss = readFileSync(new URL('../src/classroom/AnswerPane.css', import.meta.url), 'utf8')
  const paneSource = readFileSync(new URL('../src/classroom/AnswerPane.tsx', import.meta.url), 'utf8')
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  // The iframe is the smallest unit hit-testing can land on for the pair
  // header inside it; without this the header inherits `none` from
  // `.bottom-panels` and Return/plus/Send/Layers are unpressable by pointer.
  assert.match(paneCss, /\.tlda-marking-answer-pane\s*\{\s*pointer-events:\s*auto;/)
  assert.match(paneSource, /import '\.\/AnswerPane\.css'/)
  assert.match(paneSource, /className="tlda-marking-answer-pane"/)
  // ... and the container keeps declining, so the panel overlay still falls
  // through to the canvas everywhere else.
  assert.match(indexCss, /\.bottom-panels\s*\{[^}]*pointer-events:\s*none;/)
})
