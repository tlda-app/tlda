import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('terminal composer Enter uses its voice-aware submission boundary', () => {
  const source = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const submitStart = source.indexOf('const submitCurrent =', source.indexOf('function TerminalHoverPane'))
  const submitEnd = source.indexOf('\n\n  // Make this field', submitStart)
  const submit = source.slice(submitStart, submitEnd)
  const handlerStart = source.indexOf('const handleInputKeyDown =')
  const handlerEnd = source.indexOf('\n  const handleResizePointerDown', handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)

  assert.ok(submitStart >= 0 && submitEnd > submitStart)
  assert.match(submit, /submitInput\(text\)[\s\S]*el\.value = ''[\s\S]*completeMessageSend\(submittedText \?\? text\)/)
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
  assert.match(handler, /e\.key === 'Enter'[\s\S]*submitCurrent\(\)/)
  assert.doesNotMatch(handler, /completeMessageSend/)
})

test('terminal voice target uses the same submission boundary as Enter', () => {
  const source = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const registerStart = source.indexOf('const registerVoice =', source.indexOf('function TerminalHoverPane'))
  const registerEnd = source.indexOf('\n\n  const handleInputKeyDown', registerStart)
  const register = source.slice(registerStart, registerEnd)

  assert.ok(registerStart >= 0 && registerEnd > registerStart)
  assert.match(register, /setVoiceTarget\(el, \{[\s\S]*submitCurrent,[\s\S]*\}\)/)
  assert.doesNotMatch(register, /sendVoice/)
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
