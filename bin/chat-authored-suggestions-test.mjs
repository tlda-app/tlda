import { parseChatAuthoredSuggestions } from '../mcp-server/fleet-tools.mjs'

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exit(1)
}

const assert = (cond, m) => { if (!cond) fail(m) }
const eq = (actual, expected, m) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) fail(`${m}\nexpected ${e}\nactual   ${a}`)
}

{
  const input = 'Plain markdown\n\nNo chips here.'
  const out = parseChatAuthoredSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, input, 'no block should leave markdown unchanged')
  eq(out.suggestions, [], 'no block should yield no suggestions')
}

{
  const input = [
    'Please choose.',
    '',
    '<suggestions>',
    '- ship it | Proceed with the reviewed change | /ship now | group:decision',
    '- revise | Ask for another pass | /revise | group:decision',
    '</suggestions>',
  ].join('\n')
  const out = parseChatAuthoredSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, 'Please choose.', 'suggestions block should be stripped')
  eq(out.suggestions, [
    { label: 'ship it', text: 'Proceed with the reviewed change', command: '/ship now', group: 'decision' },
    { label: 'revise', text: 'Ask for another pass', command: '/revise', group: 'decision' },
  ], 'suggestion fields should map correctly')
}

{
  const input = [
    '```',
    '<suggestions>',
    '- ignored | in fence | /noop | group:x',
    '</suggestions>',
    '```',
    'Inline `<suggestions>` is code.',
  ].join('\n')
  const out = parseChatAuthoredSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, input, 'fenced and inline-code markers should be ignored')
  eq(out.suggestions, [], 'ignored markers should not yield suggestions')
}

{
  const out = parseChatAuthoredSuggestions([
    '<suggestions>',
    '-   | missing label',
    '</suggestions>',
  ].join('\n'))
  assert(out.error && out.error.includes('missing a label'), 'missing label should error')
}

{
  const out = parseChatAuthoredSuggestions([
    '<suggestions>',
    'ship it | missing dash',
    '</suggestions>',
  ].join('\n'))
  assert(out.error && out.error.includes('Malformed suggestion'), 'malformed entry should error')
}

{
  const out = parseChatAuthoredSuggestions([
    '<suggestions>',
    '- ship it | ok',
  ].join('\n'))
  assert(out.error && out.error.includes('Unclosed'), 'unclosed block should error')
}

console.log('ALL CHECKS PASSED')
