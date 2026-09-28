import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lintChatOutbound,
  lintOutlineFileBacked,
  normalizeChatLintersConfig,
} from './chat-linters.mjs'

const FILE_SOURCE = { file: '/tmp/notes.md', selector: '#plan' }
const ON = { outlineFileBacked: { enabled: true } }

test('absent or misshapen config disables the linter', () => {
  for (const config of [undefined, null, false, 'on', [], 42, { outlineFileBacked: 'yes' }]) {
    const verdict = lintChatOutbound({ source: null, outline: true, config })
    assert.equal(verdict.pass, true, `config ${JSON.stringify(config)} should pass`)
  }
})

test('the flag requires an explicit true', () => {
  assert.equal(normalizeChatLintersConfig({ outlineFileBacked: { enabled: 'yes' } }).outlineFileBacked.enabled, false)
  assert.equal(normalizeChatLintersConfig({ outlineFileBacked: { enabled: 1 } }).outlineFileBacked.enabled, false)
  assert.equal(normalizeChatLintersConfig(ON).outlineFileBacked.enabled, true)
})

test('a marked outline with no source file fails', () => {
  for (const source of [null, {}, { file: '' }, { file: '   ' }, { selector: '#x' }]) {
    const verdict = lintOutlineFileBacked({ source, outline: true }, { enabled: true })
    assert.equal(verdict.pass, false, `source ${JSON.stringify(source)} should fail`)
    assert.equal(verdict.linter, 'outline-file-backed')
    assert.match(verdict.error, /outline-file-backed/)
    assert.match(verdict.error, /no source file/)
    assert.match(verdict.error, /file.*selector/)
    assert.ok(!verdict.error.endsWith('.'), 'no trailing period: the refusal template appends one')
  }
})

test('a marked outline with a source file passes', () => {
  const verdict = lintOutlineFileBacked({ source: FILE_SOURCE, outline: true }, { enabled: true })
  assert.equal(verdict.pass, true)
})

test('unmarked messages pass: length and shape are not signals', () => {
  // The linter takes no text input at all — only the explicit marker and the
  // source. These cases pin that contract: without outline === true, nothing
  // about the body can fail, so long messages and flat lists pass unmarked.
  assert.equal(lintOutlineFileBacked({ source: null, outline: false }, { enabled: true }).pass, true)
  assert.equal(lintChatOutbound({ source: null, outline: false, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ source: null, outline: undefined, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ source: null, outline: null, config: ON }).pass, true)
})

test('only an explicit true marks a message', () => {
  for (const outline of ['yes', 1, 'outline', {}, []]) {
    const verdict = lintChatOutbound({ source: null, outline, config: ON })
    assert.equal(verdict.pass, true, `outline ${JSON.stringify(outline)} must not gate`)
  }
  assert.equal(lintChatOutbound({ source: null, outline: true, config: ON }).pass, false)
})

test('the linter is inert when disabled', () => {
  assert.equal(lintChatOutbound({ source: null, outline: true, config: null }).pass, true)
  assert.equal(lintChatOutbound({ source: null, outline: true, config: { outlineFileBacked: { enabled: false } } }).pass, true)
})
