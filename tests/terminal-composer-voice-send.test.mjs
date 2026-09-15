import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Composer unification: the terminal pane no longer owns an inline textarea —
// it renders the shared ComposerField primitive (keyPolicy='terminal'), and the
// submission boundary lives in ComposerField.tsx. These tests pin that shape so
// the two composers cannot drift apart again without a test going red.

test('terminal composer Enter uses its voice-aware submission boundary', () => {
  const shape = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const paneStart = shape.indexOf('function TerminalHoverPane')
  assert.ok(paneStart >= 0, 'TerminalHoverPane must exist')
  const pane = shape.slice(paneStart, shape.indexOf('// ---- Skill-state hover popover', paneStart))
  // The pane renders the shared primitive with the terminal policy, and its
  // transport stays PTY: submit goes to submitInput, control bytes to sendInput.
  assert.match(pane, /<ComposerField[\s\S]*keyPolicy="terminal"/)
  assert.match(pane, /onSend=\{\(text\) => \{ submitInput\(text\); return true \}\}/)
  assert.match(pane, /onTerminalControl=\{\(data\) => sendInput\(data\)\}/)
  assert.match(pane, /submitViaVoiceFinal=\{false\}/)
  // No inline submission boundary remains in the pane — it lives in the primitive.
  assert.doesNotMatch(pane, /const submitCurrent =/)
  assert.doesNotMatch(pane, /const handleInputKeyDown =/)
  assert.doesNotMatch(pane, /const registerVoice =/)

  const field = fs.readFileSync(new URL('../src/shapes/ComposerField.tsx', import.meta.url), 'utf8')
  // The shared boundary: empty-guard, submit, clear, voice settlement, history.
  assert.match(field, /const text = rawText\.trim\(\)[\s\S]*if \(!ta \|\| !text/)
  assert.match(field, /const result = onSend\(text, sendTargets\)/)
  assert.match(field, /completeMessageSend\(submittedText \?\? text\)/)
  assert.match(field, /sentHistoryRef\.current = \[\.\.\.sentHistoryRef\.current, text\]/)
  // Terminal Enter carries the empty-guard and submits (no PTY byte on Enter).
  const termKey = field.slice(field.indexOf("keyPolicy === 'terminal'"))
  assert.match(termKey, /e\.key === 'Enter'[\s\S]*val\.trim\(\) === ''[\s\S]*submitOnEnter\(\)/)
})

test('terminal voice target uses the same submission boundary as Enter', () => {
  const shape = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const paneStart = shape.indexOf('function TerminalHoverPane')
  const pane = shape.slice(paneStart, shape.indexOf('// ---- Skill-state hover popover', paneStart))
  assert.match(pane, /voiceKind="terminal"/)

  const field = fs.readFileSync(new URL('../src/shapes/ComposerField.tsx', import.meta.url), 'utf8')
  // Voice registers the field with the ref-backed submitCurrent, so saying
  // "send" runs the same boundary as Enter; terminal kind marks the HUD glyph.
  assert.match(field, /setVoiceTarget\(e\.currentTarget, voiceTargetRef\.current\)/)
  assert.match(field, /submitCurrent\(submittedText\) \{ return submitCurrentRef\.current\(submittedText\) \}/)
  assert.match(field, /getTargetKind = \(\) => 'terminal'/)
  assert.doesNotMatch(field, /sendVoice/)
})

test('voice submits every textarea composer through submitCurrent only', () => {
  const source = fs.readFileSync(new URL('../src/voice.mjs', import.meta.url), 'utf8')
  const magicStart = source.indexOf('function submitTextareaViaMagicWord')
  const magicEnd = source.indexOf('\n\nfunction handleSendMagicWord', magicStart)
  const magic = source.slice(magicStart, magicEnd)

  assert.ok(magicStart >= 0 && magicEnd > magicStart)
  assert.match(magic, /replaceTextareaValue\(cleanText\)[\s\S]*submitCurrent\(submittedText\)/)
  assert.doesNotMatch(source, /sendVoice/)
})
