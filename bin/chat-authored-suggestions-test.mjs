import { parseChatAuthoredSuggestions, parseInlineSuggestions } from '../mcp-server/fleet-tools.mjs'

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

// ---- inline `.suggest` section (the forget-proof authoring surface) ----

{
  // Pure-markdown items: bold=name(+default send), description, optional italic=command.
  // Body renders as normal markdown (only the {.suggest} attr is stripped from the heading).
  const input = [
    'Here is my recommendation.',
    '',
    '## Pick one {.suggest}',
    '- **ship it** — proceed with the reviewed change */ship*',
    '- **revise** — ask for another pass',
    '',
    'Let me know.',
  ].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, [
    'Here is my recommendation.',
    '',
    '## Pick one',
    '- **ship it** — proceed with the reviewed change */ship*',
    '- **revise** — ask for another pass',
    '',
    'Let me know.',
  ].join('\n'), 'only the {.suggest} attr is stripped; items stay as authored markdown')
  eq(out.suggestions, [
    { label: 'ship it', command: '/ship', text: 'proceed with the reviewed change', group: 'Pick one#1' },
    { label: 'revise', command: 'revise', text: 'ask for another pass', group: 'Pick one#1' },
  ], 'bold=name+default-send; italic=explicit command; description harvested')
}

{
  // Forgiving separator: dash / period / nothing / bold-only all parse.
  const input = ['## S {.suggest}', '- **a** — desc *cmd*', '- **b**. desc *cmd*', '- **c** desc', '- **d**'].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.suggestions, [
    { label: 'a', command: 'cmd', text: 'desc', group: 'S#1' },
    { label: 'b', command: 'cmd', text: 'desc', group: 'S#1' },
    { label: 'c', command: 'c', text: 'desc', group: 'S#1' },
    { label: 'd', command: 'd', group: 'S#1' },
  ], 'dash / period / no-sep / bold-only all parse; no-italic → command defaults to name')
}

{
  // Multi-section → multi-group: each `.suggest` section is its own group.
  const input = [
    '## Deploy? {.suggest}',
    '- **ship it** */ship*',
    '- **hold** */hold*',
    '',
    'and separately:',
    '',
    '## Reviewer {.suggest}',
    '- **ask dmitry** */assign dmitry*',
  ].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.suggestions, [
    { label: 'ship it', command: '/ship', group: 'Deploy?#1' },
    { label: 'hold', command: '/hold', group: 'Deploy?#1' },
    { label: 'ask dmitry', command: '/assign dmitry', group: 'Reviewer#2' },
  ], 'two sections → two distinct groups')
  const groups = [...new Set(out.suggestions.map(s => s.group))]
  assert(groups.length === 2, `expected 2 groups, got ${groups.length}: ${groups}`)
}

{
  // No-bold → graceful degrade: first word = name (don't error).
  const out = parseInlineSuggestions(['## S {.suggest}', '- look at page 3'].join('\n'))
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.suggestions, [{ label: 'look', command: 'look', text: 'at page 3', group: 'S#1' }], 'no bold → first word is the name')
}

{
  // No false-fire: a plain "## Suggestions" heading (no `.suggest`) is untouched.
  const input = ['## Suggestions', '- be nicer', '- add a figure'].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, input, 'a heading without {.suggest} must not be rewritten')
  eq(out.suggestions, [], 'a heading without {.suggest} must not harvest')
}

{
  // Extra heading classes still fire the section.
  const input = ['### Next steps {.suggest .foo}', '- **page 3** look here'].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, ['### Next steps', '- **page 3** look here'].join('\n'), 'extra classes still fire; item stays markdown')
  eq(out.suggestions, [{ label: 'page 3', command: 'page 3', text: 'look here', group: 'Next steps#1' }], 'fires with extra classes')
}

{
  // A `.suggest` heading inside a code fence is ignored.
  const input = ['```', '## Suggestions {.suggest}', '- **ignored** */noop*', '```'].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, input, 'fenced content must be left verbatim')
  eq(out.suggestions, [], 'fenced markers must not harvest')
}

{
  // The list ends at the first blank / non-list / next heading; trailing prose stays.
  const input = ['## S {.suggest}', '- **a** */a*', 'not a list item', '- **b** */b*'].join('\n')
  const out = parseInlineSuggestions(input)
  assert(!out.error, `unexpected error: ${out.error}`)
  eq(out.body, ['## S', '- **a** */a*', 'not a list item', '- **b** */b*'].join('\n'), 'list stops at the first non-list line')
  eq(out.suggestions, [{ label: 'a', command: '/a', group: 'S#1' }], 'only items before the break are harvested')
}

console.log('ALL CHECKS PASSED')
