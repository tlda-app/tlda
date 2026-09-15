import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Composer unification (fleet:2438-mu23re2j): the chat composer and the terminal
// hover composer share one ComposerField primitive. Smallest focused coverage:
// one keyboard policy, both consumers, anchoring, and the terminal carryovers.

test('one recording-gated keyboard policy lives in ComposerField', () => {
  const field = fs.readFileSync(new URL('../src/shapes/ComposerField.tsx', import.meta.url), 'utf8')
  assert.match(field, /export function composerInputMode\(isTouchDevice: boolean, recording: boolean\)/)
  assert.match(field, /return isTouchDevice && recording \? 'none' : undefined/)
  assert.match(field, /const inputMode = composerInputMode\(isTouchDevice, recording\)/)
  // Neither consumer computes inputMode itself any more.
  for (const file of ['../src/shapes/ChatComposer.tsx', '../src/shapes/FleetChatShape.tsx']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /inputMode=\{_isTouchDevice \? 'none'/)
    assert.doesNotMatch(source, /inputMode = isTouchDevice && recording/)
  }
})

test('ChatComposer is the shared primitive with the chat policy', () => {
  const source = fs.readFileSync(new URL('../src/shapes/ChatComposer.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ ComposerField \} from '\.\/ComposerField'/)
  assert.match(source, /<ComposerField[\s\S]*keyPolicy="chat"/)
  assert.match(source, /voiceKind="chat"/)
})

test('terminal pane anchors against visualViewport so the raised keyboard cannot drag it', () => {
  const source = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const paneStart = source.indexOf('function TerminalHoverPane')
  const pane = source.slice(paneStart, source.indexOf('// ---- Skill-state hover popover', paneStart))
  assert.match(pane, /visualViewport/)
  assert.match(pane, /addEventListener\('resize', remeasure\)/)
  assert.match(pane, /addEventListener\('scroll', remeasure\)/)
})

test('terminal side carries draft, history, and the empty-guard; PTY bytes stay terminal-only', () => {
  const shape = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const paneStart = shape.indexOf('function TerminalHoverPane')
  const pane = shape.slice(paneStart, shape.indexOf('// ---- Skill-state hover popover', paneStart))
  assert.match(pane, /draftKey=\{terminalDraftKey\}/)
  assert.match(pane, /const terminalDraftKey = `terminal:\$\{agentId\}`/)

  const field = fs.readFileSync(new URL('../src/shapes/ComposerField.tsx', import.meta.url), 'utf8')
  const termKey = field.slice(field.indexOf("keyPolicy === 'terminal'"))
  // Empty-guard on Enter, history on arrows, control bytes preserved.
  assert.match(termKey, /val\.trim\(\) === ''[\s\S]*suppress on empty/)
  assert.match(termKey, /ArrowUp[\s\S]*walkHistory\(ta, 1\)/)
  assert.match(termKey, /ArrowDown[\s\S]*walkHistory\(ta, -1\)/)
  assert.match(termKey, /onTerminalControl\?\.\('\\x03'\)/)
  assert.match(termKey, /onTerminalControl\?\.\('\\t'\)/)
  assert.match(termKey, /onTerminalControl\?\.\('\\x1b'\)/)
  // The chat policy keeps its own Escape-clears and command hook; the terminal
  // policy never touches them.
  assert.match(field, /onCommand\?\.\(text, sendTargets, ta\)/)
})

test('deliberately unshared surfaces stay where they were', () => {
  const shape = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  // Traffic filter lives on the chat rail, not in the pane or the primitive.
  assert.match(shape, /ComposerTrafficFilterMode/)
  assert.ok(shape.indexOf('ComposerTrafficFilterMode') < shape.indexOf('function TerminalHoverPane'))
  const field = fs.readFileSync(new URL('../src/shapes/ComposerField.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(field, /TrafficFilter/)
  assert.doesNotMatch(field, /terminalTransport/)
})
