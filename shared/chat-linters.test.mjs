import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lintChatOutbound,
  lintOutlineDepth,
  lintOutlineFileBacked,
  normalizeChatLintersConfig,
} from './chat-linters.mjs'

const FILE_SOURCE = { file: '/tmp/notes.md', selector: '#plan' }
const ON = { outlineFileBacked: { enabled: true }, outlineDepth: { enabled: true } }

test('absent or misshapen config disables every linter', () => {
  for (const config of [undefined, null, false, 'on', [], 42, { outlineFileBacked: 'yes' }]) {
    const flatMarked = lintChatOutbound({ text: '- a\n- b\n', source: null, outline: true, config })
    assert.equal(flatMarked.pass, true, `config ${JSON.stringify(config)} should pass`)
  }
})

test('each flag requires an explicit true', () => {
  const normalized = normalizeChatLintersConfig({ outlineFileBacked: { enabled: 'yes' }, outlineDepth: { enabled: 1 } })
  assert.equal(normalized.outlineFileBacked.enabled, false)
  assert.equal(normalized.outlineDepth.enabled, false)
  assert.equal(normalizeChatLintersConfig(ON).outlineFileBacked.enabled, true)
  assert.equal(normalizeChatLintersConfig(ON).outlineDepth.enabled, true)
})

test('a marked outline with no source file fails file backing first', () => {
  for (const source of [null, {}, { file: '' }, { file: '   ' }, { selector: '#x' }]) {
    const verdict = lintChatOutbound({ text: '- a\n- b\n', source, outline: true, config: ON })
    assert.equal(verdict.pass, false, `source ${JSON.stringify(source)} should fail`)
    assert.equal(verdict.linter, 'outline-file-backed')
    assert.match(verdict.error, /no source file/)
    assert.ok(!verdict.error.endsWith('.'), 'no trailing period: the refusal template appends one')
  }
})

test('a marked flat list with a file fails depth as a list', () => {
  const verdict = lintChatOutbound({ text: '## plan\n\n- one\n- two\n', source: FILE_SOURCE, outline: true, config: ON })
  assert.equal(verdict.pass, false)
  assert.equal(verdict.linter, 'outline-depth')
  assert.match(verdict.error, /single structural depth/)
  assert.match(verdict.error, /nesting|unmarked/)
  assert.ok(!verdict.error.endsWith('.'))
})

test('marked flat beats with a file fail depth', () => {
  const beats = ['**One.** a', '**Two.** b', '**Three.** c'].join('\n')
  const verdict = lintChatOutbound({ text: beats, source: FILE_SOURCE, outline: true, config: ON })
  assert.equal(verdict.pass, false)
  assert.equal(verdict.linter, 'outline-depth')
})

test('marked nested outlines pass', () => {
  assert.equal(lintChatOutbound({ text: '# A\n\n## B\n\n## C\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ text: '- a\n  - a1\n- b\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ text: '1. a\n1.1. a1\n2. b\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ text: '**A.** x\n- detail\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
})

test('a single structural line is a note, not a failed outline', () => {
  assert.equal(lintChatOutbound({ text: '**Only.** one\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
  assert.equal(lintChatOutbound({ text: '- only\n', source: FILE_SOURCE, outline: true, config: ON }).pass, true)
})

test('marked prose-heavy messages pass depth', () => {
  const message = ['- a', '- b', 'context one.', 'context two.', 'context three.'].join('\n')
  assert.equal(lintChatOutbound({ text: message, source: FILE_SOURCE, outline: true, config: ON }).pass, true)
})

test('depth ignores fenced structure signals', () => {
  const fenced = ['```md', '- a', '- b', '**One.** x', '**Two.** y', '```'].join('\n')
  assert.equal(lintChatOutbound({ text: fenced, source: FILE_SOURCE, outline: true, config: ON }).pass, true)
})

test('unmarked messages are never scanned', () => {
  // Length, flat lists, bold beats, single depth — none of it matters without
  // the marker. The depth linter additionally pins marked === true.
  const shapes = [
    'x'.repeat(5000),
    '- a\n- b\n- c\n',
    ['**One.** a', '**Two.** b', '**Three.** c', '**Four.** d', '**Five.** e'].join('\n'),
    '## plan\n\n- one\n- two\n',
  ]
  for (const text of shapes) {
    assert.equal(lintChatOutbound({ text, source: null, outline: false, config: ON }).pass, true)
    assert.equal(lintChatOutbound({ text, source: null, config: ON }).pass, true)
    assert.equal(lintOutlineDepth(text, { enabled: true }).pass, true)
    assert.equal(lintOutlineDepth(text, { enabled: true, marked: false }).pass, true)
  }
})

test('only an explicit true marks a message', () => {
  for (const outline of ['yes', 1, 'outline', {}, []]) {
    assert.equal(lintChatOutbound({ text: '- a\n- b\n', source: null, outline, config: ON }).pass, true)
  }
  assert.equal(lintChatOutbound({ text: '- a\n- b\n', source: null, outline: true, config: ON }).pass, false)
})

test('each linter gates independently', () => {
  const fileOnly = { outlineFileBacked: { enabled: true }, outlineDepth: { enabled: false } }
  assert.equal(lintChatOutbound({ text: '- a\n- b\n', source: FILE_SOURCE, outline: true, config: fileOnly }).pass, true)
  assert.equal(lintChatOutbound({ text: '- a\n- b\n', source: null, outline: true, config: fileOnly }).pass, false)
  const depthOnly = { outlineFileBacked: { enabled: false }, outlineDepth: { enabled: true } }
  assert.equal(lintChatOutbound({ text: '- a\n- b\n', source: null, outline: true, config: depthOnly }).pass, false)
  assert.equal(lintChatOutbound({ text: '- a\n  - a1\n', source: null, outline: true, config: depthOnly }).pass, true)
})
