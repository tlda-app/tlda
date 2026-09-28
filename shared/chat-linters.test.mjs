import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lintChatOutbound,
  lintFileBackedComposition,
  lintOutlineDepth,
  normalizeChatLintersConfig,
} from './chat-linters.mjs'

const FILE_SOURCE = { file: '/tmp/notes.md', selector: '#plan' }

test('absent or misshapen config disables every linter', () => {
  for (const config of [undefined, null, false, 'on', [], 42]) {
    const verdict = lintChatOutbound({ text: 'x'.repeat(5000), source: null, config })
    assert.equal(verdict.pass, true, `config ${JSON.stringify(config)} should pass`)
  }
})

test('linter flags require an explicit true', () => {
  const normalized = normalizeChatLintersConfig({ fileBackedComposition: { enabled: 'yes' }, outlineDepth: { enabled: 1 } })
  assert.equal(normalized.fileBackedComposition.enabled, false)
  assert.equal(normalized.outlineDepth.enabled, false)
})

test('invalid thresholds fall back to defaults', () => {
  const normalized = normalizeChatLintersConfig({
    fileBackedComposition: { enabled: true, minChars: 'many' },
    outlineDepth: { enabled: true, minSignalLines: -2, maxProseLines: 'few' },
  })
  assert.equal(normalized.fileBackedComposition.minChars, 500)
  assert.equal(normalized.outlineDepth.minSignalLines, 5)
  assert.equal(normalized.outlineDepth.maxProseLines, 2)
})

test('file-backed-composition passes short inline chat', () => {
  const verdict = lintFileBackedComposition('short message', null, { enabled: true, minChars: 500 })
  assert.equal(verdict.pass, true)
})

test('file-backed-composition fails long inline chat at the boundary', () => {
  assert.equal(lintFileBackedComposition('x'.repeat(499), null, { enabled: true, minChars: 500 }).pass, true)
  const verdict = lintFileBackedComposition('x'.repeat(500), null, { enabled: true, minChars: 500 })
  assert.equal(verdict.pass, false)
  assert.equal(verdict.linter, 'file-backed-composition')
  assert.match(verdict.error, /file-backed-composition/)
  assert.match(verdict.error, /500 chars/)
  assert.match(verdict.error, /file.*selector/)
})

test('file-backed-composition passes long chat with a source file', () => {
  const verdict = lintFileBackedComposition('x'.repeat(5000), FILE_SOURCE, { enabled: true, minChars: 500 })
  assert.equal(verdict.pass, true)
})

test('file-backed-composition ignores an empty source file', () => {
  for (const source of [null, {}, { file: '' }, { file: '   ' }, { selector: '#x' }]) {
    const verdict = lintFileBackedComposition('x'.repeat(600), source, { enabled: true, minChars: 500 })
    assert.equal(verdict.pass, false, `source ${JSON.stringify(source)} should fail`)
  }
})

test('file-backed-composition is inert when disabled', () => {
  const verdict = lintFileBackedComposition('x'.repeat(5000), null, { enabled: false, minChars: 10 })
  assert.equal(verdict.pass, true)
})

// The observed failure: bold-label beats handed over as an outline.
const BEATS_MESSAGE = [
  '## the-beats',
  '',
  '**The pitch.** A statistical claim only means something with a coherent account of randomness.',
  '**Why it matters.** Policy evidence comes from panel data.',
  '**The problem.** Intervals refer to a mechanism nobody can think about.',
  '**The answer.** Put the randomness in the adoption instead.',
  '**Why it is right.** Beliefs become claims about the setting.',
  '**It subsumes.** Experiments are the special case.',
  '**It is a program.** Which imaginations are defensible is open.',
  '**What this adds.** Staggered adoption is the work proposed.',
  '**The measure.** The warm-up case took everything I had.',
].join('\n')

test('outline-depth rejects the flat beats shape', () => {
  const verdict = lintOutlineDepth(BEATS_MESSAGE, { enabled: true })
  assert.equal(verdict.pass, false)
  assert.equal(verdict.linter, 'outline-depth')
  assert.match(verdict.error, /outline-depth/)
  assert.match(verdict.error, /single structural depth/)
  assert.match(verdict.error, /nesting|prose/)
})

test('outline-depth rejects an outline heading over flat bullets', () => {
  const verdict = lintOutlineDepth('## Outline\n\n- first\n- second\n- third\n', { enabled: true })
  assert.equal(verdict.pass, false)
  assert.equal(verdict.linter, 'outline-depth')
})

test('outline-depth passes ordinary prose', () => {
  const prose = [
    'The impact box needs a rewrite. Panel data usually has no designed randomness,',
    'so an interval reported from such data gets its probabilities elsewhere.',
    '',
    'Imagined randomization instead supposes each unit had some probability of adopting.',
    'Whether that supposition is reasonable is a question about the setting.',
  ].join('\n')
  assert.equal(lintOutlineDepth(prose, { enabled: true }).pass, true)
})

test('outline-depth passes honest bare lists', () => {
  assert.equal(lintOutlineDepth('- alpha\n- beta\n- gamma\n- delta\n', { enabled: true }).pass, true)
  assert.equal(lintOutlineDepth('1. alpha\n2. beta\n3. gamma\n4. delta\n', { enabled: true }).pass, true)
  assert.equal(lintOutlineDepth('## Plan\n\n- alpha\n- beta\n- gamma\n', { enabled: true }).pass, true)
})

test('outline-depth passes genuinely nested outlines', () => {
  const twoHeadingLevels = '# Part one\n\n## Detail\n\n## More detail\n'
  assert.equal(lintOutlineDepth(twoHeadingLevels, { enabled: true }).pass, true)
  const nestedBullets = '## Outline\n\n- alpha\n  - alpha one\n  - alpha two\n- beta\n'
  assert.equal(lintOutlineDepth(nestedBullets, { enabled: true }).pass, true)
  const subNumbered = '## Outline\n\n1. alpha\n1.1. alpha one\n2. beta\n'
  assert.equal(lintOutlineDepth(subNumbered, { enabled: true }).pass, true)
  const beatsWithBullets = [
    '## the-beats',
    '',
    '**The pitch.** A claim needs a mechanism.',
    '- mechanism one',
    '- mechanism two',
    '**The answer.** Adoption could have gone otherwise.',
    '- detail one',
    '- detail two',
  ].join('\n')
  assert.equal(lintOutlineDepth(beatsWithBullets, { enabled: true }).pass, true)
})

test('outline-depth passes a few bold leads in ordinary chat', () => {
  const status = '**Done.** Shipped the fix today.\n**Next.** Write the test.\nStill deciding the rollout order.'
  assert.equal(lintOutlineDepth(status, { enabled: true }).pass, true)
})

test('outline-depth passes beat-like runs diluted by prose', () => {
  const message = [
    '**One.** First point.',
    '**Two.** Second point.',
    '**Three.** Third point.',
    '**Four.** Fourth point.',
    '**Five.** Fifth point.',
    'Some context on why these matter.',
    'More context on the tradeoffs involved.',
    'And a final note on timing.',
  ].join('\n')
  assert.equal(lintOutlineDepth(message, { enabled: true }).pass, true)
})

test('outline-depth fires on an unheaded run of five beats', () => {
  const message = [
    '**One.** First point with enough substance to read as a section.',
    '**Two.** Second point with enough substance to read as a section.',
    '**Three.** Third point with enough substance to read as a section.',
    '**Four.** Fourth point with enough substance to read as a section.',
    '**Five.** Fifth point with enough substance to read as a section.',
  ].join('\n')
  const verdict = lintOutlineDepth(message, { enabled: true })
  assert.equal(verdict.pass, false)
  assert.equal(
    lintOutlineDepth(message.split('\n').slice(0, 4).join('\n'), { enabled: true }).pass,
    true,
    'four unheaded beats must not trip the default threshold',
  )
})

test('outline-depth ignores fenced and quoted structure signals', () => {
  const fenced = ['```md', '## Outline', '- alpha', '- beta', '**One.** x', '**Two.** y', '```'].join('\n')
  assert.equal(lintOutlineDepth(fenced, { enabled: true }).pass, true)
  const unclosed = ['Some prose here.', '```', '## Outline', '- alpha', '- beta'].join('\n')
  assert.equal(lintOutlineDepth(unclosed, { enabled: true }).pass, true)
  const quoted = ['> **One.** quoted', '> **Two.** quoted', '> **Three.** quoted', '> **Four.** quoted', '> **Five.** quoted'].join('\n')
  assert.equal(lintOutlineDepth(quoted, { enabled: true }).pass, true)
})

test('outline-depth needs at least two structural lines under a headed outline', () => {
  assert.equal(lintOutlineDepth('## Outline\n\n**Only.** one\n', { enabled: true }).pass, true)
})

test('outline-depth is inert when disabled', () => {
  assert.equal(lintOutlineDepth(BEATS_MESSAGE, { enabled: false }).pass, true)
})

test('lintChatOutbound runs file-backed composition before outline depth', () => {
  const config = { fileBackedComposition: { enabled: true, minChars: 100 }, outlineDepth: { enabled: true } }
  const inline = lintChatOutbound({ text: BEATS_MESSAGE, source: null, config })
  assert.equal(inline.pass, false)
  assert.equal(inline.linter, 'file-backed-composition')
  const filed = lintChatOutbound({ text: BEATS_MESSAGE, source: FILE_SOURCE, config })
  assert.equal(filed.pass, false)
  assert.equal(filed.linter, 'outline-depth')
})
